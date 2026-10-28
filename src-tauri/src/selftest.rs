// Автотесты интерфейса: FFM_SELFTEST=<скрипт.js> — скрипт выполняется в окне после загрузки,
// результат (то, что вернул скрипт) пишется в <FFM_SHOT>.json, снимок окна — в FFM_SHOT (.png).
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

static STARTED: AtomicBool = AtomicBool::new(false);

fn script_path() -> Option<PathBuf> {
    std::env::var("FFM_SELFTEST").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
}

pub fn shot_path() -> PathBuf {
    std::env::var("FFM_SHOT").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::get().temp.join("selftest.png"))
}

pub fn on_loaded(app: AppHandle, label: String) {
    let Some(file) = script_path() else { return };
    if STARTED.swap(true, Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let script = match std::fs::read_to_string(&file) {
            Ok(s) => s,
            Err(e) => { finish(&app, &label, serde_json::json!({ "error": format!("script: {e}") })).await; return; }
        };
        let body = script.trim().trim_end_matches(';').trim().to_string();
        let wrapper = format!(
            "(async () => {{ let __r; try {{ __r = await ({body}\n); }} catch (e) {{ __r = {{ error: String(e && e.stack || e) }}; }} \
             try {{ await window.__TAURI__.core.invoke('test_done', {{ result: __r === undefined ? null : __r }}); }} \
             catch (e) {{ await window.__TAURI__.core.invoke('test_done', {{ result: {{ error: 'result: ' + String(e) }} }}); }} }})();"
        );
        if let Some(w) = app.get_webview_window(&label) {
            if let Err(e) = w.eval(&wrapper) {
                finish(&app, &label, serde_json::json!({ "error": format!("eval: {e}") })).await;
            }
        }
    });
}

async fn finish(app: &AppHandle, label: &str, mut result: Value) {
    tokio::time::sleep(Duration::from_millis(600)).await;
    let shot = shot_path();
    if let Some(w) = app.get_webview_window(label) {
        if let Err(e) = capture(&w, &shot).await {
            if result.is_object() { result["shotError"] = Value::from(e); }
        }
    }
    let json = shot.with_extension("json");
    let _ = std::fs::write(&json, serde_json::to_string_pretty(&result).unwrap_or_default());
    if std::env::var("FFM_KEEP_OPEN").map(|v| v.is_empty()).unwrap_or(true) {
        app.exit(0);
    }
}

#[tauri::command]
pub async fn test_done(window: WebviewWindow, result: Value) {
    let app = window.app_handle().clone();
    finish(&app, window.label(), result).await;
}

#[tauri::command]
pub async fn test_shot(window: WebviewWindow, name: String) -> Result<String, String> {
    if script_path().is_none() { return Err("только в режиме автотеста".into()); }
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    let dir = shot_path().parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let file = dir.join(format!("{safe}.png"));
    capture(&window, &file).await?;
    Ok(file.to_string_lossy().to_string())
}

/// Снимок содержимого окна (WebView2 CapturePreview)
#[cfg(windows)]
pub async fn capture(w: &WebviewWindow, file: &std::path::Path) -> Result<(), String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let tx2 = tx.clone();
    w.with_webview(move |pw| unsafe {
        let send = move |r: Result<Vec<u8>, String>| { if let Some(t) = tx2.lock().unwrap().take() { let _ = t.send(r); } };
        let core = match pw.controller().CoreWebView2() { Ok(c) => c, Err(e) => { send(Err(e.to_string())); return; } };
        let Some(stream) = SHCreateMemStream(None) else { send(Err("SHCreateMemStream".into())); return; };
        let st2: IStream = stream.clone();
        let send2 = send.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
            if let Err(e) = res { send2(Err(e.to_string())); return Ok(()); }
            let mut stat = Default::default();
            if let Err(e) = st2.Stat(&mut stat, STATFLAG_NONAME) { send2(Err(e.to_string())); return Ok(()); }
            let size = stat.cbSize as usize;
            let mut buf = vec![0u8; size];
            let _ = st2.Seek(0, STREAM_SEEK_SET, None);
            let mut read = 0u32;
            let _ = st2.Read(buf.as_mut_ptr() as *mut _, size as u32, Some(&mut read));
            buf.truncate(read as usize);
            send2(Ok(buf));
            Ok(())
        }));
        if let Err(e) = core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) {
            send(Err(e.to_string()));
        }
    }).map_err(|e| e.to_string())?;
    let data = tokio::time::timeout(Duration::from_secs(10), rx).await.map_err(|_| "снимок: нет ответа".to_string())?
        .map_err(|_| "снимок: отменён".to_string())??;
    if let Some(d) = file.parent() { let _ = std::fs::create_dir_all(d); }
    std::fs::write(file, data).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub async fn capture(_w: &WebviewWindow, _file: &std::path::Path) -> Result<(), String> {
    Err("снимок окна поддерживается только в Windows".into())
}
