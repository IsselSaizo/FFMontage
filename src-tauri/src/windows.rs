// Окна программы: главное и окно настроек папок (первый запуск).
use crate::{control, paths, selftest};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

static MAIN_SHOWN: AtomicBool = AtomicBool::new(false);

fn start_log(name: &str) {
    let p = paths::get();
    let _ = std::fs::create_dir_all(&p.logs);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(p.logs.join(format!("{name}.log")), format!("--- {now} (unix) ---\n"));
}

pub fn open_main(app: &AppHandle) {
    start_log("renderer");
    let b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("FF Montage")
        .inner_size(1500.0, 900.0)
        .min_inner_size(1100.0, 680.0)
        .decorations(false)
        .visible(false)
        .background_color(tauri::window::Color(18, 18, 22, 255))
        .data_directory(paths::get().webview.clone());
    match b.build() {
        Ok(w) => watch_crash(&w),
        Err(e) => eprintln!("main window: {e}"),
    }
    if gst_audio_sink_missing() {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        app.dialog().message(format!("Не установлен GStreamer good (autoaudiosink). Без него окно падает, как только в предпросмотре появляется звук.\n\n{GST_HINT}"))
            .title("FF Montage — не хватает пакета").kind(MessageDialogKind::Warning).show(|_| {});
    }
}

const GST_HINT: &str = "Установите: sudo apt install gstreamer1.0-plugins-good (Ubuntu/Debian), sudo dnf install gstreamer1-plugins-good (Fedora), sudo pacman -S gst-plugins-good (Arch) и перезапустите программу.";

/// Linux: WebKitGTK выводит звук через autoaudiosink (gst-plugins-good). Ищем плагин рядом с базовыми плагинами GStreamer;
/// если не нашли и базовых — путь нестандартный, молчим, чтобы не пугать зря.
#[cfg(target_os = "linux")]
pub fn gst_audio_sink_missing() -> bool {
    static MISSING: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *MISSING.get_or_init(|| {
        let mut dirs: Vec<std::path::PathBuf> = ["GST_PLUGIN_SYSTEM_PATH_1_0", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_PATH_1_0", "GST_PLUGIN_PATH"]
            .iter().filter_map(std::env::var_os).flat_map(|v| std::env::split_paths(&v).collect::<Vec<_>>()).collect();
        for lib in ["/usr/lib", "/usr/lib64", "/usr/local/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu"] {
            dirs.push(std::path::Path::new(lib).join("gstreamer-1.0"));
        }
        let has = |f: &str| dirs.iter().any(|d| d.join(f).exists());
        has("libgstcoreelements.so") && !has("libgstautodetect.so")
    })
}

#[cfg(not(target_os = "linux"))]
pub fn gst_audio_sink_missing() -> bool { false }

/// Процесс окна упал: команды ИИ-ассистента сразу получают ошибку (а не ждут до таймаута).
/// Возвращает true, если окно стоит перезагрузить — не чаще раза в 30 с, чтобы не крутиться, если оно падает сразу при загрузке.
fn on_web_crash(reason: &str) -> bool {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let hint = if gst_audio_sink_missing() { format!(" Похоже, не хватает GStreamer good. {GST_HINT}") } else { String::new() };
    let msg = format!("Окно FF Montage упало ({reason}).{hint}");
    eprintln!("{msg}");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(paths::get().logs.join("renderer.log")) {
        let _ = writeln!(f, "[crash] {msg}");
    }
    control::set_ready(false);
    control::fail_all(&format!("{msg} Окно перезагружается — повторите команду."));
    let mut last = LAST.lock().unwrap();
    let reload = last.is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(30));
    *last = Some(std::time::Instant::now());
    reload
}

#[cfg(target_os = "linux")]
fn watch_crash(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|pw| {
        use webkit2gtk::WebViewExt;
        pw.inner().connect_web_process_terminated(|v, reason| {
            if on_web_crash(&format!("{reason:?}")) { v.reload(); }
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
            if let Some(a) = args { let _ = a.ProcessFailedKind(&mut kind); }
            // Остальные процессы (GPU, утилиты, фреймы) WebView2 поднимает сам — окно живо
            let (name, reload) = match kind {
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => ("browser process exited", false),
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => ("render process exited", true),
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => ("render process unresponsive", true),
                _ => return Ok(()),
            };
            if on_web_crash(name) && reload {
                if let Some(s) = sender { let _ = s.Reload(); }
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
    let make = || WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("setup.html".into()))
        .title(if first { "FF Montage — первый запуск" } else { "FF Montage — настройки папок" })
        .inner_size(680.0, 720.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .background_color(tauri::window::Color(29, 29, 35, 255))
        .data_directory(paths::get().webview.clone());
    let b = match app.get_webview_window("main") {
        Some(main) => make().parent(&main).unwrap_or_else(|_| make()),
        None => make(),
    };
    match b.build() {
        Ok(w) => {
            if first {
                let a = app.clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::Destroyed = e { a.exit(0); }
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
                control::fail_all("Окно FF Montage перезагрузилось — повторите команду.");
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
