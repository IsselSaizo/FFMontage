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
    if let Err(e) = b.build() {
        eprintln!("main window: {e}");
    }
}

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
