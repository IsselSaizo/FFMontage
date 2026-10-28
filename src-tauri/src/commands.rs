// Команды, которые вызывает окно (window.api в src/renderer/js/api.js).
use crate::{control, export, ff, paths, protocol, windows};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

pub const VIDEO_EXT: &[&str] = &["mp4", "mkv", "mov", "m4v", "webm", "avi", "wmv", "flv", "ts", "mts", "m2ts", "mpg", "mpeg", "3gp"];
pub const AUDIO_EXT: &[&str] = &["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "wma"];

fn s(p: &Path) -> String { p.to_string_lossy().to_string() }

#[tauri::command]
pub async fn app_info(app: AppHandle) -> Value {
    let p = paths::get();
    let bin = ff::find();
    let ver = ff::version_info(&bin).await;
    json!({
        "version": app.package_info().version.to_string(),
        "shell": "Tauri",
        "tauri": tauri::VERSION,
        "webview": tauri::webview_version().unwrap_or_default(),
        "platform": std::env::consts::OS,
        "ffmpeg": s(&bin.ffmpeg),
        "ffmpegMissing": bin.missing,
        "ffmpegVersion": ver.as_ref().map(|v| v.0.clone()),
        "ffMajor": ver.as_ref().map(|v| v.1).unwrap_or(99),
        "outputDir": s(&p.output_dir),
        "projectsDir": s(&p.projects_dir),
        "cacheDir": s(&p.cache_dir),
        "logsDir": s(&p.logs),
        "configFile": s(&p.config_file),
        "appDir": s(&p.app_dir),
        "sep": std::path::MAIN_SEPARATOR.to_string(),
        "videoExt": VIDEO_EXT, "audioExt": AUDIO_EXT, "imageExt": ff::IMAGE_EXT,
        "selftest": std::env::var("FFM_SELFTEST").map(|v| !v.is_empty()).unwrap_or(false),
    })
}

// ---------------------------------------------------------------------------
// Окно настроек папок / первого запуска
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn setup_info(app: AppHandle) -> Value {
    let p = paths::get();
    let cfg = paths::load_config(&p.config_file)
        .unwrap_or_else(|| paths::suggest_defaults(app.path().video_dir().ok(), app.path().document_dir().ok()));
    json!({ "firstRun": p.first_run, "platform": std::env::consts::OS, "appDir": s(&p.app_dir), "configFile": s(&p.config_file), "config": cfg })
}

#[tauri::command]
pub async fn setup_pick_folder(window: WebviewWindow, current: Option<String>) -> Option<String> {
    let dir = current.filter(|c| !c.is_empty()).map(PathBuf::from).unwrap_or_else(|| paths::get().app_dir.clone());
    let d = window.dialog().file().set_title("Выберите папку").set_parent(&window).set_directory(dir);
    tauri::async_runtime::spawn_blocking(move || d.blocking_pick_folder()).await.ok().flatten().and_then(|f| f.into_path().ok()).map(|p| s(&p))
}

#[tauri::command]
pub async fn setup_check_ffmpeg(dir: Option<String>) -> Value { ff::check_dir(dir.unwrap_or_default().trim()).await }

#[tauri::command]
pub async fn setup_encoders(dir: Option<String>) -> Value {
    let dir = dir.unwrap_or_default();
    let bin = if dir.trim().is_empty() { ff::search_binaries(None) } else { ff::search_binaries(Some(Path::new(dir.trim()))) };
    match bin { Some(b) => ff::detect_encoders(&b).await, None => Value::Null }
}

#[derive(Deserialize)]
pub struct SetupCfg {
    #[serde(default, rename = "cacheDir")] cache_dir: String,
    #[serde(default, rename = "outputDir")] output_dir: String,
    #[serde(default, rename = "projectsDir")] projects_dir: String,
    #[serde(default, rename = "ffmpegDir")] ffmpeg_dir: String,
}

#[tauri::command]
pub fn setup_save(app: AppHandle, cfg: SetupCfg) -> Value {
    let p = paths::get();
    let mut clean = paths::Config::default();
    for (k, v) in [("cache", &cfg.cache_dir), ("output", &cfg.output_dir), ("projects", &cfg.projects_dir)] {
        let v = v.trim();
        if v.is_empty() { return json!({ "ok": false, "error": "Укажите все папки." }); }
        let abs = paths::absolute(Path::new(v), &p.app_dir);
        let test = abs.join(".ffm-write-test");
        if let Err(e) = std::fs::create_dir_all(&abs).and_then(|_| std::fs::write(&test, b"ok")).and_then(|_| std::fs::remove_file(&test)) {
            return json!({ "ok": false, "error": format!("Не удалось создать папку или нет прав на запись:\n{}\n{e}", abs.display()) });
        }
        let v = s(&abs);
        match k { "cache" => clean.cache_dir = v, "output" => clean.output_dir = v, _ => clean.projects_dir = v }
    }
    clean.ffmpeg_dir = cfg.ffmpeg_dir.trim().to_string();
    if let Err(e) = paths::save_config(&clean) {
        return json!({ "ok": false, "error": format!("Не удалось записать {}:\n{e}", p.config_file.display()) });
    }
    // Новые пути применяются после перезапуска
    if std::env::var("FFM_SELFTEST").map(|v| v.is_empty()).unwrap_or(true) {
        let a = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Ok(exe) = std::env::current_exe() { let _ = crate::update::relaunch(&a, &exe); }
        });
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn setup_open(app: AppHandle) -> bool { windows::open_setup(&app); true }

#[tauri::command]
pub fn setup_cancel(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("setup") { let _ = w.close(); }
    true
}

// ---------------------------------------------------------------------------
// Медиа
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn media_pick(window: WebviewWindow) -> Vec<String> {
    let all: Vec<&str> = [VIDEO_EXT, AUDIO_EXT, ff::IMAGE_EXT].concat();
    let d = window.dialog().file().set_title("Импорт медиа").set_parent(&window)
        .add_filter("Видео, аудио и картинки", &all)
        .add_filter("Видео", VIDEO_EXT).add_filter("Аудио", AUDIO_EXT).add_filter("Картинки и GIF", ff::IMAGE_EXT)
        .add_filter("Все файлы", &["*"]);
    tauri::async_runtime::spawn_blocking(move || d.blocking_pick_files()).await.ok().flatten()
        .map(|v| v.into_iter().filter_map(|f| f.into_path().ok()).map(|p| s(&p)).collect()).unwrap_or_default()
}

async fn info_with_url(file: &Path) -> R<Value> {
    let mut info = ff::probe(file).await?;
    protocol::allow(file);
    info["url"] = json!(protocol::url(file));
    Ok(info)
}

#[tauri::command]
pub async fn media_probe(file: String) -> R<Value> { info_with_url(Path::new(&file)).await }

#[tauri::command]
pub async fn media_thumbs(info: Value) -> R<Value> {
    let t = ff::thumbs(&info).await?;
    if t.is_null() { return Ok(Value::Null); }
    let urls: Vec<String> = t["files"].as_array().map(|a| a.iter().filter_map(|f| f.as_str()).map(|f| protocol::url(Path::new(f))).collect()).unwrap_or_default();
    Ok(json!({ "interval": t["interval"], "height": t["height"], "urls": urls }))
}

#[tauri::command]
pub async fn media_peaks(info: Value) -> R<Value> { ff::peaks(&info).await }

#[tauri::command]
pub async fn media_proxy(app: AppHandle, info: Value) -> R<String> {
    let enc = ff::detect_encoders(&ff::find()).await;
    let key = info["key"].as_str().unwrap_or_default().to_string();
    let a = app.clone();
    let file = ff::proxy(&info, &move |fraction| { let _ = a.emit("media:proxy-progress", json!({ "key": key, "fraction": fraction })); }, &enc).await?;
    Ok(protocol::url(&file))
}

#[tauri::command]
pub async fn enc_detect() -> Value { ff::detect_encoders(&ff::find()).await }

// --- эффекты: реверс и стоп-кадр (файл в кэш → сведения о нём, как после импорта) ---
#[tauri::command]
pub async fn fx_reverse(app: AppHandle, info: Value, a: f64, b: f64) -> R<Value> {
    let enc = ff::detect_encoders(&ff::find()).await;
    let key = format!("reverse:{}:{}:{}", info["key"].as_str().unwrap_or_default(), ff::n3(a), ff::n3(b));
    let ap = app.clone();
    let file = ff::reverse(&info, a, b, &move |fraction| { let _ = ap.emit("fx:progress", json!({ "key": key, "fraction": fraction })); }, &enc).await?;
    info_with_url(&file).await
}

#[tauri::command]
pub async fn fx_freeze(info: Value, at: f64) -> R<Value> {
    let enc = ff::detect_encoders(&ff::find()).await;
    let file = ff::freeze(&info, at, &enc).await?;
    info_with_url(&file).await
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[tauri::command]
pub async fn fx_frame(file: String, t: f64, width: Option<f64>) -> R<String> {
    Ok(base64(&ff::frame_jpeg(Path::new(&file), t, width.unwrap_or(640.0)).await?))
}

#[tauri::command]
pub async fn fx_silence(file: String, threshold_db: Option<f64>, min_dur: Option<f64>) -> R<Value> {
    ff::silence(Path::new(&file), threshold_db.unwrap_or(-35.0), min_dur.unwrap_or(0.5)).await
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn export_pick(window: WebviewWindow, suggested: Option<String>) -> Option<String> {
    let d = window.dialog().file().set_title("Куда сохранить видео").set_parent(&window)
        .set_directory(&paths::get().output_dir).set_file_name(suggested.unwrap_or_else(|| "Видео.mp4".into()))
        .add_filter("Видео MP4", &["mp4"]);
    tauri::async_runtime::spawn_blocking(move || d.blocking_save_file()).await.ok().flatten().and_then(|f| f.into_path().ok()).map(|p| s(&p))
}

pub fn safe_name(base: &str, fallback: &str) -> String {
    let t: String = base.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = t.trim().to_string();
    if t.is_empty() { fallback.to_string() } else { t }
}

#[tauri::command]
pub fn export_default_path(base: Option<String>) -> String {
    let dir = &paths::get().output_dir;
    let safe = safe_name(&base.unwrap_or_default(), "Видео");
    let mut p = dir.join(format!("{safe}.mp4"));
    let mut i = 2;
    while p.exists() { p = dir.join(format!("{safe} ({i}).mp4")); i += 1; }
    s(&p)
}

#[tauri::command]
pub async fn export_start(app: AppHandle, plan: export::Plan) -> Value {
    let win = app.get_webview_window("main");
    let set_bar = |v: Option<f64>| {
        if let Some(w) = &win {
            use tauri::window::{ProgressBarState, ProgressBarStatus};
            let _ = w.set_progress_bar(match v {
                Some(f) => ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some((f * 100.0).round() as u64) },
                None => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
            });
        }
    };
    set_bar(Some(0.0));
    let a = app.clone();
    let w2 = win.clone();
    let r = export::run(plan, move |p| {
        if let Some(w) = &w2 {
            use tauri::window::{ProgressBarState, ProgressBarStatus};
            let f = p["fraction"].as_f64().unwrap_or(0.0);
            let _ = w.set_progress_bar(ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some((f * 100.0).round() as u64) });
        }
        let _ = a.emit("export:progress", p);
    }).await;
    set_bar(None);
    match r {
        Ok(mut v) => {
            if let Some(w) = &win {
                if !w.is_focused().unwrap_or(true) { let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational)); }
            }
            v["ok"] = json!(true);
            v
        }
        Err(e) => json!({ "ok": false, "cancelled": e["cancelled"], "error": e["message"] }),
    }
}

#[tauri::command]
pub fn export_cancel() -> bool { export::cancel() }

// ---------------------------------------------------------------------------
// Проект
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub struct SaveArgs {
    #[serde(rename = "filePath")] file_path: Option<String>,
    text: String,
    suggested: Option<String>,
}

#[tauri::command]
pub async fn project_save(window: WebviewWindow, args: SaveArgs) -> R<Option<String>> {
    let p = match args.file_path.filter(|x| !x.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = paths::get().projects_dir.clone();
            let _ = std::fs::create_dir_all(&dir);
            let name = format!("{}.ffproj", safe_name(&args.suggested.unwrap_or_default(), "Проект"));
            let d = window.dialog().file().set_title("Сохранить проект").set_parent(&window).set_directory(dir).set_file_name(name)
                .add_filter("Проект FF Montage", &["ffproj"]);
            match tauri::async_runtime::spawn_blocking(move || d.blocking_save_file()).await.ok().flatten().and_then(|f| f.into_path().ok()) {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    std::fs::write(&p, args.text).map_err(|e| e.to_string())?;
    Ok(Some(s(&p)))
}

#[tauri::command]
pub async fn project_open(window: WebviewWindow) -> R<Value> {
    let dir = paths::get().projects_dir.clone();
    let _ = std::fs::create_dir_all(&dir);
    let d = window.dialog().file().set_title("Открыть проект").set_parent(&window).set_directory(dir).add_filter("Проект FF Montage", &["ffproj"]);
    let Some(p) = tauri::async_runtime::spawn_blocking(move || d.blocking_pick_file()).await.ok().flatten().and_then(|f| f.into_path().ok()) else {
        return Ok(Value::Null);
    };
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(json!({ "filePath": s(&p), "text": text }))
}

#[tauri::command]
pub fn project_read(path: String) -> R<Value> {
    let p = paths::absolute(Path::new(&path), &std::env::current_dir().unwrap_or_default());
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(json!({ "filePath": s(&p), "text": text }))
}

#[tauri::command]
pub fn autosave_write(text: String) -> R<bool> {
    let a = &paths::get().autosave;
    let tmp = a.with_extension("ffproj.tmp");
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, a)).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn autosave_read() -> Option<String> { std::fs::read_to_string(&paths::get().autosave).ok() }

#[tauri::command]
pub fn shell_show(path: String) -> bool { tauri_plugin_opener::reveal_item_in_dir(&path).is_ok() }

#[tauri::command]
pub fn shell_open(path: String) -> String {
    let p = PathBuf::from(&path);
    if p.is_dir() || path.ends_with('\\') || path.ends_with('/') { let _ = std::fs::create_dir_all(&p); }
    match tauri_plugin_opener::open_path(&path, None::<&str>) { Ok(_) => String::new(), Err(e) => e.to_string() }
}

#[tauri::command]
pub fn win_devtools(window: WebviewWindow) -> bool {
    if window.is_devtools_open() { window.close_devtools(); } else { window.open_devtools(); }
    true
}

#[tauri::command]
pub fn win_title(window: WebviewWindow, title: String) -> bool { let _ = window.set_title(&title); true }

#[tauri::command]
pub fn fs_exists(path: String) -> bool { Path::new(&path).exists() }

// ---------------------------------------------------------------------------
// ИИ-ассистент и журнал
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn mcp_info() -> Value { control::info() }

#[tauri::command]
pub fn mcp_result(window: WebviewWindow, id: String, payload: Value) {
    if window.label() == "main" { control::on_result(id, payload); }
}

#[tauri::command]
pub fn log_line(window: WebviewWindow, level: String, message: String) {
    use std::io::Write;
    let file = paths::get().logs.join(format!("{}.log", if window.label() == "main" { "renderer" } else { window.label() }));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "[{level}] {message}");
    }
}
