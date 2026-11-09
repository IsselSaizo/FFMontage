// Окна программы: главное и окно настроек папок (первый запуск).
use crate::{control, paths, selftest, tr};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

static MAIN_SHOWN: AtomicBool = AtomicBool::new(false);

/// Новый журнал окна; прошлый остаётся как <name>.prev.log (в нём следы падения прошлого запуска)
fn start_log(name: &str) {
    let p = paths::get();
    crate::crashlog::rotate_log(name);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(
        p.logs.join(format!("{name}.log")),
        format!("--- {} · FF Montage {} ({}) ---\n", crate::crashlog::utc_text(now), env!("CARGO_PKG_VERSION"), std::env::consts::OS),
    );
}

/// Язык интерфейса при запуске: (язык, выбран ли пользователем). Не выбран — язык системы
/// (в автотестах — русский, чтобы проверки не зависели от машины).
pub fn boot_lang() -> (String, bool) {
    let s = paths::load_settings();
    match s["lang"].as_str() {
        Some(l @ ("ru" | "en")) => (l.to_string(), true),
        _ if std::env::var("FFM_SELFTEST").map(|v| !v.is_empty()).unwrap_or(false) => ("ru".into(), false),
        _ => (crate::i18n::system_lang().to_string(), false),
    }
}

/// Скрипт до загрузки страницы: язык нужен модулям окна синхронно, ещё до первой строки интерфейса
fn boot_script() -> String {
    let (lang, chosen) = boot_lang();
    let selftest = std::env::var("FFM_SELFTEST").map(|v| !v.is_empty()).unwrap_or(false);
    format!(
        "window.__FFM_BOOT = {};",
        serde_json::json!({
            "lang": lang, "langChosen": chosen, "systemLang": crate::i18n::system_lang(), "selftest": selftest,
        })
    )
}

pub fn open_main(app: &AppHandle) {
    start_log("renderer");
    let b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .initialization_script(boot_script())
        .title("FF Montage")
        .inner_size(1500.0, 900.0)
        .min_inner_size(1100.0, 680.0)
        .decorations(false)
        .visible(false)
        .background_color(tauri::window::Color(18, 18, 22, 255))
        .data_directory(paths::get().webview.clone())
        .on_new_window(panel_window(app.clone()));
    match b.build() {
        Ok(w) => watch_crash(&w),
        Err(e) => eprintln!("main window: {e}"),
    }
    if gst_audio_sink_missing() {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        app.dialog().message(tr!("Не установлен GStreamer good (autoaudiosink). Без него окно падает, как только в предпросмотре появляется звук.\n\n{}", "GStreamer good (autoaudiosink) is not installed. Without it the window crashes as soon as sound appears in the preview.\n\n{}", gst_hint()))
            .title(tr!("FF Montage — не хватает пакета", "FF Montage — missing package")).kind(MessageDialogKind::Warning).show(|_| {});
    }
}

/// Окна панелей (0.5.0, js/popout.js): главное окно делает window.open('about:blank') — создаём для него обычное окно
/// Tauri с той же средой WebView (window_features), чтобы окно-открыватель могло перенести туда свою панель.
/// Любые другие адреса (ссылки, плагины) не открываются.
fn panel_window(
    app: AppHandle,
) -> impl Fn(tauri::Url, tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<tauri::Wry> + Send + 'static {
    use std::sync::atomic::AtomicUsize;
    static N: AtomicUsize = AtomicUsize::new(0);
    move |url, features| {
        if url.as_str() != "about:blank" {
            return tauri::webview::NewWindowResponse::Deny;
        }
        let label = format!("panel-{}", N.fetch_add(1, Ordering::SeqCst));
        let b = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
            .window_features(features)
            .title("FF Montage")
            .min_inner_size(280.0, 180.0)
            .background_color(tauri::window::Color(18, 18, 22, 255))
            .on_document_title_changed(|w, title| {
                let _ = w.set_title(&title);
            });
        match b.build() {
            Ok(window) => tauri::webview::NewWindowResponse::Create { window },
            Err(e) => {
                eprintln!("panel window: {e}");
                tauri::webview::NewWindowResponse::Deny
            }
        }
    }
}

fn gst_hint() -> &'static str {
    tr!("Установите: sudo apt install gstreamer1.0-plugins-good (Ubuntu/Debian), sudo dnf install gstreamer1-plugins-good (Fedora), sudo pacman -S gst-plugins-good (Arch) и перезапустите программу.",
        "Install it: sudo apt install gstreamer1.0-plugins-good (Ubuntu/Debian), sudo dnf install gstreamer1-plugins-good (Fedora), sudo pacman -S gst-plugins-good (Arch), then restart the program.")
}

/// Папки плагинов GStreamer, которые он сам просмотрит: GST_PLUGIN_PATH(_1_0) и GST_PLUGIN_SYSTEM_PATH(_1_0); если
/// системный путь задан (так делает AppImage — apprun-hooks GStreamer указывают в образ), стандартные папки
/// системы GStreamer не смотрит — и мы тоже.
pub fn gst_plugin_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<std::path::PathBuf> {
    let split = |k: &str| env(k).filter(|v| !v.is_empty()).map(|v| std::env::split_paths(&v).collect::<Vec<_>>());
    let mut dirs: Vec<std::path::PathBuf> = ["GST_PLUGIN_PATH_1_0", "GST_PLUGIN_PATH"].iter().filter_map(|k| split(k)).flatten().collect();
    match split("GST_PLUGIN_SYSTEM_PATH_1_0").or_else(|| split("GST_PLUGIN_SYSTEM_PATH")) {
        Some(sys) => dirs.extend(sys),
        None => {
            for lib in ["/usr/lib", "/usr/lib64", "/usr/local/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu"] {
                dirs.push(std::path::Path::new(lib).join("gstreamer-1.0"));
            }
        }
    }
    dirs
}

/// Плагины GStreamer, без которых окно на Linux не играет медиа: autodetect — autoaudiosink, playback — playbin,
/// isomp4 — MP4/MOV, libav — декодеры H.264/AAC/MP3 (в AppImage кладутся из gstreamer1.0-libav)
pub const GST_NEEDED: [&str; 7] = ["coreelements", "autodetect", "playback", "typefindfunctions", "app", "isomp4", "libav"];

/// Каких плагинов из GST_NEEDED нет в папках dirs
pub fn gst_missing(dirs: &[std::path::PathBuf]) -> Vec<&'static str> {
    GST_NEEDED.iter().copied().filter(|p| !dirs.iter().any(|d| d.join(format!("libgst{p}.so")).exists())).collect()
}

/// Linux: WebKitGTK выводит звук через autoaudiosink (gst-plugins-good). Ищем плагин рядом с базовыми плагинами GStreamer;
/// если не нашли и базовых — путь нестандартный, молчим, чтобы не пугать зря.
#[cfg(target_os = "linux")]
pub fn gst_audio_sink_missing() -> bool {
    static MISSING: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *MISSING.get_or_init(|| {
        let dirs = gst_plugin_dirs(&|k| std::env::var(k).ok());
        let has = |f: &str| dirs.iter().any(|d| d.join(f).exists());
        has("libgstcoreelements.so") && !has("libgstautodetect.so")
    })
}

#[cfg(not(target_os = "linux"))]
pub fn gst_audio_sink_missing() -> bool {
    false
}

/// Сведения о GStreamer для «ff-montage --engine info» (дымовой тест AppImage в CI)
pub fn gst_info() -> serde_json::Value {
    if !cfg!(target_os = "linux") {
        return serde_json::json!({ "used": false, "dirs": [], "missing": [], "audioSinkMissing": false });
    }
    let dirs = gst_plugin_dirs(&|k| std::env::var(k).ok());
    let found: Vec<String> = dirs.iter().filter(|d| d.is_dir()).map(|d| d.to_string_lossy().to_string()).collect();
    serde_json::json!({ "used": true, "dirs": found, "missing": gst_missing(&dirs), "audioSinkMissing": gst_audio_sink_missing() })
}

/// Процесс окна упал: команды ИИ-ассистента сразу получают ошибку (а не ждут до таймаута).
/// Возвращает true, если окно стоит перезагрузить — не чаще раза в 30 с, чтобы не крутиться, если оно падает сразу при загрузке.
fn on_web_crash(reason: &str) -> bool {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let hint = if gst_audio_sink_missing() {
        tr!(" Похоже, не хватает GStreamer good. {}", " GStreamer good seems to be missing. {}", gst_hint())
    } else {
        String::new()
    };
    let msg = tr!("Окно FF Montage упало ({}).{}", "The FF Montage window crashed ({}).{}", reason, hint);
    eprintln!("{msg}");
    use std::io::Write;
    let log = paths::get().logs.join("renderer.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log) {
        let _ = writeln!(f, "[crash] {msg}");
    }
    crate::crashlog::report("window-crash", "WebView process crashed", reason, Some(&log));
    control::set_ready(false);
    control::fail_all(&tr!("{} Окно перезагружается — повторите команду.", "{} The window is reloading — repeat the command.", msg));
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    let reload = last.is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(30));
    *last = Some(std::time::Instant::now());
    reload
}

#[cfg(target_os = "linux")]
fn watch_crash(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|pw| {
        use webkit2gtk::{SecurityManagerExt, WebContextExt, WebViewExt};
        // Плеер ставит <video crossOrigin="anonymous"> (иначе Web Audio даёт тишину), а страница — tauri://localhost:
        // запрос к media://localhost — чужой источник. WebKitGTK разрешает CORS только схемам, отмеченным как
        // cors-enabled (wry отмечает свои схемы лишь как secure) — без этого любое видео даёт MEDIA_ERR_SRC_NOT_SUPPORTED.
        if let Some(sm) = pw.inner().context().and_then(|c| c.security_manager()) {
            sm.register_uri_scheme_as_cors_enabled("media");
        }
        pw.inner().connect_web_process_terminated(|v, reason| {
            if on_web_crash(&format!("{reason:?}")) {
                v.reload();
            }
        });
    });
}

#[cfg(windows)]
fn watch_crash(w: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::ProcessFailedEventHandler;
    let _ = w.with_webview(|pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let handler = ProcessFailedEventHandler::create(Box::new(|sender, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(a) = args {
                let _ = a.ProcessFailedKind(&mut kind);
            }
            // Остальные процессы (GPU, утилиты, фреймы) WebView2 поднимает сам — окно живо
            let (name, reload) = match kind {
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => ("browser process exited", false),
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => ("render process exited", true),
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => ("render process unresponsive", true),
                _ => return Ok(()),
            };
            if on_web_crash(name) && reload {
                if let Some(s) = sender {
                    let _ = s.Reload();
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_ProcessFailed(&handler, &mut token);
    });
}

#[cfg(not(any(target_os = "linux", windows)))]
fn watch_crash(_w: &tauri::WebviewWindow) {}

pub fn open_setup(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.set_focus();
        return;
    }
    start_log("setup");
    let first = paths::get().first_run;
    let make = || {
        WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("setup.html".into()))
            .initialization_script(boot_script())
            .title(if first {
                tr!("FF Montage — первый запуск", "FF Montage — first run")
            } else {
                tr!("FF Montage — настройки папок", "FF Montage — folders")
            })
            .inner_size(680.0, 720.0)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .background_color(tauri::window::Color(29, 29, 35, 255))
            .data_directory(paths::get().webview.clone())
    };
    let b = match app.get_webview_window("main") {
        Some(main) => make().parent(&main).unwrap_or_else(|_| make()),
        None => make(),
    };
    match b.build() {
        Ok(w) => {
            if first {
                let a = app.clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        a.exit(0);
                    }
                });
            }
        }
        Err(e) => eprintln!("setup window: {e}"),
    }
}

pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    let label = webview.label().to_string();
    match payload.event() {
        PageLoadEvent::Started => {
            if label == "main" {
                control::set_ready(false);
                control::fail_all(tr!(
                    "Окно FF Montage перезагрузилось — повторите команду.",
                    "The FF Montage window reloaded — repeat the command."
                ));
            }
        }
        PageLoadEvent::Finished => {
            if label == "main" && !MAIN_SHOWN.swap(true, Ordering::SeqCst) {
                if let Some(w) = webview.app_handle().get_webview_window("main") {
                    let _ = w.maximize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            let is_test_window = if paths::get().first_run { label == "setup" } else { label == "main" };
            if is_test_window {
                selftest::on_loaded(webview.app_handle().clone(), label);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn gst_dirs_follow_appimage_env() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        // AppImage: системный путь — только образ, стандартные папки системы не смотрятся
        let img = format!("/tmp/.mount_FF/usr/lib/gstreamer-1.0{sep}/tmp/.mount_FF/usr/lib/extra");
        let env = |k: &str| match k {
            "GST_PLUGIN_SYSTEM_PATH_1_0" => Some(img.clone()),
            "GST_PLUGIN_PATH_1_0" => Some("/opt/gst".to_string()),
            _ => None,
        };
        let d = gst_plugin_dirs(&env);
        assert_eq!(
            d,
            vec![
                PathBuf::from("/opt/gst"),
                PathBuf::from("/tmp/.mount_FF/usr/lib/gstreamer-1.0"),
                PathBuf::from("/tmp/.mount_FF/usr/lib/extra")
            ]
        );
        // Без переменных — стандартные папки (Ubuntu/Debian, Arch/SteamOS, Fedora)
        let d = gst_plugin_dirs(&|_| None);
        assert!(d.contains(&PathBuf::from("/usr/lib/x86_64-linux-gnu/gstreamer-1.0")));
        assert!(d.contains(&PathBuf::from("/usr/lib/gstreamer-1.0")));
        assert!(d.contains(&PathBuf::from("/usr/lib64/gstreamer-1.0")));
        // Пустой GST_PLUGIN_SYSTEM_PATH не отменяет стандартные папки
        assert_eq!(gst_plugin_dirs(&|k| (k == "GST_PLUGIN_SYSTEM_PATH").then(String::new)).len(), d.len());
    }

    #[test]
    fn gst_missing_plugins() {
        let dir = paths::test_dir("gst");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(gst_missing(std::slice::from_ref(&dir)), GST_NEEDED.to_vec());
        for p in GST_NEEDED.iter().filter(|p| **p != "libav") {
            std::fs::write(dir.join(format!("libgst{p}.so")), b"").unwrap();
        }
        assert_eq!(gst_missing(std::slice::from_ref(&dir)), vec!["libav"]);
        std::fs::write(dir.join("libgstlibav.so"), b"").unwrap();
        assert!(gst_missing(&[PathBuf::from("/nope"), dir.clone()]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
