// Команды, которые вызывает окно (window.api в src/renderer/js/api.js).
use crate::{cache, control, export, ff, i18n, paths, protocol, tr, windows};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

pub const VIDEO_EXT: &[&str] = &["mp4", "mkv", "mov", "m4v", "webm", "avi", "wmv", "flv", "ts", "mts", "m2ts", "mpg", "mpeg", "3gp"];
pub const AUDIO_EXT: &[&str] = &["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "wma"];

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// Файловая работа команд — в пуле блокирующих задач, а не в главном потоке окна (R-3)
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// config.json меняется по очереди (settings_set / setup_save из разных потоков)
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn config_lock() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

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
        "pluginsDir": s(&p.plugins_dir),
        "sep": std::path::MAIN_SEPARATOR.to_string(),
        "videoExt": VIDEO_EXT, "audioExt": AUDIO_EXT, "imageExt": ff::IMAGE_EXT,
        "selftest": std::env::var("FFM_SELFTEST").map(|v| !v.is_empty()).unwrap_or(false),
    })
}

// ---------------------------------------------------------------------------
// Окно настроек папок / первого запуска
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn setup_info(app: AppHandle) -> Value {
    let (video, docs) = (app.path().video_dir().ok(), app.path().document_dir().ok());
    blocking(move || {
        let p = paths::get();
        let cfg = paths::load_config(&p.config_file).unwrap_or_else(|| paths::suggest_defaults(video, docs));
        json!({ "firstRun": p.first_run, "platform": std::env::consts::OS, "appDir": s(&p.app_dir), "configFile": s(&p.config_file), "config": cfg })
    }).await.unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn setup_pick_folder(window: WebviewWindow, current: Option<String>) -> Option<String> {
    let dir = current.filter(|c| !c.is_empty()).map(PathBuf::from).unwrap_or_else(|| paths::get().app_dir.clone());
    let d = window.dialog().file().set_title(tr!("Выберите папку", "Choose a folder")).set_parent(&window).set_directory(dir);
    tauri::async_runtime::spawn_blocking(move || d.blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .and_then(|f| f.into_path().ok())
        .map(|p| s(&p))
}

#[tauri::command]
pub async fn setup_check_ffmpeg(dir: Option<String>) -> Value {
    ff::check_dir(dir.unwrap_or_default().trim()).await
}

#[tauri::command]
pub async fn setup_encoders(dir: Option<String>) -> Value {
    let dir = dir.unwrap_or_default();
    let bin = if dir.trim().is_empty() { ff::search_binaries(None) } else { ff::search_binaries(Some(Path::new(dir.trim()))) };
    match bin {
        Some(b) => ff::detect_encoders(&b).await,
        None => Value::Null,
    }
}

#[derive(Deserialize)]
pub struct SetupCfg {
    #[serde(default, rename = "cacheDir")]
    cache_dir: String,
    #[serde(default, rename = "outputDir")]
    output_dir: String,
    #[serde(default, rename = "projectsDir")]
    projects_dir: String,
    #[serde(default, rename = "ffmpegDir")]
    ffmpeg_dir: String,
    /// Язык, выбранный в окне первого запуска
    #[serde(default)]
    lang: Option<String>,
    /// false — только сохранить (окно настроек сообщит о перезапуске само)
    #[serde(default)]
    restart: Option<bool>,
}

#[tauri::command]
pub async fn setup_save(app: AppHandle, cfg: SetupCfg) -> Value {
    blocking(move || setup_save_sync(app, cfg)).await.unwrap_or_else(|e| json!({ "ok": false, "error": e }))
}

fn setup_save_sync(app: AppHandle, cfg: SetupCfg) -> Value {
    // Сначала — перенос старых настроек из config.json в settings.json (порядок блокировок: настройки → config.json)
    let _ = crate::settings::load();
    let r = setup_write_config(&cfg);
    if !r["ok"].as_bool().unwrap_or(false) {
        return r;
    }
    if let Some(l) = cfg.lang.as_deref().filter(|l| *l == "ru" || *l == "en") {
        i18n::set(l);
        if let Err(e) = crate::settings::patch(&json!({ "lang": l })) {
            return json!({ "ok": false, "error": e });
        }
    }
    // Новые пути применяются после перезапуска
    if cfg.restart != Some(false) && std::env::var("FFM_SELFTEST").map(|v| v.is_empty()).unwrap_or(true) {
        let a = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Ok(exe) = std::env::current_exe() {
                let _ = crate::update::relaunch(&a, &exe);
            }
        });
    }
    r
}

fn setup_write_config(cfg: &SetupCfg) -> Value {
    let _lock = config_lock();
    let p = paths::get();
    // Относительный путь — от папки программы (portable) или от папки настроек (системные папки)
    let base = if p.mode == paths::Mode::System { &p.config_dir } else { &p.app_dir };
    let mut clean = paths::Config::default();
    for (k, v) in [("cache", &cfg.cache_dir), ("output", &cfg.output_dir), ("projects", &cfg.projects_dir)] {
        let v = v.trim();
        if v.is_empty() {
            return json!({ "ok": false, "error": tr!("Укажите все папки.", "Please fill in all folders.") });
        }
        let abs = paths::absolute(Path::new(v), base);
        let test = abs.join(".ffm-write-test");
        if let Err(e) = std::fs::create_dir_all(&abs).and_then(|_| std::fs::write(&test, b"ok")).and_then(|_| std::fs::remove_file(&test)) {
            return json!({ "ok": false, "error": tr!("Не удалось создать папку или нет прав на запись:\n{}\n{}", "Cannot create the folder or it is not writable:\n{}\n{}", abs.display(), e) });
        }
        let v = s(&abs);
        match k {
            "cache" => clean.cache_dir = v,
            "output" => clean.output_dir = v,
            _ => clean.projects_dir = v,
        }
    }
    clean.ffmpeg_dir = cfg.ffmpeg_dir.trim().to_string();
    if let Err(e) = paths::save_config(&clean) {
        return json!({ "ok": false, "error": tr!("Не удалось записать {}:\n{}", "Cannot write {}:\n{}", p.config_file.display(), e) });
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn setup_open(app: AppHandle) -> bool {
    windows::open_setup(&app);
    true
}

/// Перезапуск программы (новые папки начинают действовать только после него)
#[tauri::command]
pub fn app_restart(app: AppHandle) -> bool {
    if std::env::var("FFM_SELFTEST").map(|v| !v.is_empty()).unwrap_or(false) {
        return false;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if let Ok(exe) = std::env::current_exe() {
            let _ = crate::update::relaunch(&app, &exe);
        }
    });
    true
}

// ---------------------------------------------------------------------------
// Настройки интерфейса (settings.json, M0.6): язык, хоткеи, вид окна, экспорт, кэш, …
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn settings_get() -> Value {
    blocking(|| {
        json!({
            "settings": crate::settings::load(), "lang": i18n::lang(), "systemLang": i18n::system_lang(),
            "file": s(&paths::get().settings_file),
        })
    })
    .await
    .unwrap_or(Value::Null)
}

/// Меняет ключи верхнего уровня (null — удалить ключ) и возвращает все настройки
#[tauri::command]
pub async fn settings_set(patch: Value) -> R<Value> {
    blocking(move || {
        let all = crate::settings::patch(&patch)?;
        if let Some(l) = all["lang"].as_str() {
            i18n::set(l);
        }
        Ok(all)
    })
    .await?
}

/// Один раз при запуске окна: значения из localStorage (ffm.*) → settings.json (уже сохранённое не перезаписывается)
#[tauri::command]
pub async fn settings_migrate_local(values: Value) -> R<Value> {
    blocking(move || crate::settings::migrate_local(&values)).await?
}

/// Режим хранения данных (portable / system / custom) и все папки — для «Настройки → Папки»
#[tauri::command]
pub async fn paths_info() -> Value {
    blocking(paths::info).await.unwrap_or(Value::Null)
}

/// Размеры кэша по категориям (байты)
#[tauri::command]
pub async fn cache_stats() -> Value {
    tauri::async_runtime::spawn_blocking(cache::stats).await.unwrap_or(Value::Null)
}

/// Очистка кэша: cats — thumbs, peaks, proxy, fx, anim, assets, fonts, temp, logs (и старое «media»);
/// keep — ключи кэша и пути медиа открытого проекта (их кэш не трогаем)
#[tauri::command]
pub async fn cache_clear(cats: Vec<String>, keep: Vec<String>) -> R<Value> {
    if export::busy() {
        return Err(tr!("Идёт экспорт — очистите кэш после него.", "Export is running — clear the cache after it finishes.").into());
    }
    tauri::async_runtime::spawn_blocking(move || cache::clear(&cats, &keep)).await.map_err(|e| e.to_string())
}

/// Автоочистка до лимита settings.json → cache.limitGb (окно зовёт после смены лимита). keep — медиа открытого проекта.
/// test{limitBytes, recentSecs} — только в режиме автотеста (FFM_SELFTEST): лимит меньше 1 ГБ и без защиты «недавних».
#[tauri::command]
pub async fn cache_autoclean(keep: Vec<String>, test: Option<Value>) -> Value {
    let selftest = std::env::var("FFM_SELFTEST").map(|v| !v.is_empty()).unwrap_or(false);
    let opts = match test.filter(|_| selftest) {
        Some(t) => cache::AutoOpts { limit_bytes: t["limitBytes"].as_u64(), recent_secs: t["recentSecs"].as_u64() },
        None => cache::AutoOpts::default(),
    };
    tauri::async_runtime::spawn_blocking(move || cache::autoclean(&keep, opts)).await.unwrap_or(Value::Null)
}

#[tauri::command]
pub fn setup_cancel(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.close();
    }
    true
}

// ---------------------------------------------------------------------------
// Медиа
// ---------------------------------------------------------------------------
#[tauri::command]
pub async fn media_pick(window: WebviewWindow) -> Vec<String> {
    let all: Vec<&str> = [VIDEO_EXT, AUDIO_EXT, ff::IMAGE_EXT].concat();
    let d = window
        .dialog()
        .file()
        .set_title(tr!("Импорт медиа", "Import media"))
        .set_parent(&window)
        .add_filter(tr!("Видео, аудио и картинки", "Video, audio and images"), &all)
        .add_filter(tr!("Видео", "Video"), VIDEO_EXT)
        .add_filter(tr!("Аудио", "Audio"), AUDIO_EXT)
        .add_filter(tr!("Картинки и GIF", "Images and GIF"), ff::IMAGE_EXT)
        .add_filter(tr!("Все файлы", "All files"), &["*"]);
    tauri::async_runtime::spawn_blocking(move || d.blocking_pick_files())
        .await
        .ok()
        .flatten()
        .map(|v| v.into_iter().filter_map(|f| f.into_path().ok()).map(|p| s(&p)).collect())
        .unwrap_or_default()
}

async fn info_with_url(file: &Path) -> R<Value> {
    let mut info = ff::probe(file).await?;
    protocol::allow(file);
    info["url"] = json!(protocol::url(file));
    Ok(info)
}

#[tauri::command]
pub async fn media_probe(file: String) -> R<Value> {
    info_with_url(Path::new(&file)).await
}

#[tauri::command]
pub async fn media_thumbs(info: Value) -> R<Value> {
    let key = info["key"].as_str().unwrap_or_default().to_string();
    cache::touch(&key);
    let mut t = ff::thumbs(&info).await?;
    if t.is_null() {
        return Ok(Value::Null);
    }
    // Пути — от текущей папки кэша (B-9); файлов нет — миниатюры делаются заново
    let mut files = cache::thumbs_files(&key, &t);
    if files.is_none() {
        t = ff::thumbs(&info).await?;
        if t.is_null() {
            return Ok(Value::Null);
        }
        files = cache::thumbs_files(&key, &t);
    }
    let urls: Vec<String> = files.unwrap_or_default().iter().map(|f| protocol::url(f)).collect();
    Ok(json!({ "interval": t["interval"], "height": t["height"], "urls": urls }))
}

#[tauri::command]
pub async fn media_peaks(info: Value, stream: Option<usize>) -> R<Value> {
    cache::touch(info["key"].as_str().unwrap_or_default());
    ff::peaks(&info, stream.unwrap_or(0)).await
}

/// Звуковой поток N ≥ 1 отдельным файлом (для предпросмотра) → адрес; channel — только этот канал потока (0.5.1)
#[tauri::command]
pub async fn media_audio_stream(info: Value, stream: usize, channel: Option<usize>) -> R<String> {
    cache::touch(info["key"].as_str().unwrap_or_default());
    let file = ff::audio_stream(&info, stream, channel).await?;
    Ok(protocol::url(&file))
}

#[tauri::command]
pub async fn media_proxy(app: AppHandle, info: Value) -> R<String> {
    let enc = ff::detect_encoders(&ff::find()).await;
    let key = info["key"].as_str().unwrap_or_default().to_string();
    cache::touch(&key);
    let a = app.clone();
    let file = ff::proxy(
        &info,
        &move |fraction| {
            let _ = a.emit("media:proxy-progress", json!({ "key": key, "fraction": fraction }));
        },
        &enc,
    )
    .await?;
    Ok(protocol::url(&file))
}

#[tauri::command]
pub async fn enc_detect() -> Value {
    ff::detect_encoders(&ff::find()).await
}

// --- эффекты: реверс и стоп-кадр (файл в кэш → сведения о нём, как после импорта) ---
#[tauri::command]
pub async fn fx_reverse(app: AppHandle, info: Value, a: f64, b: f64) -> R<Value> {
    let enc = ff::detect_encoders(&ff::find()).await;
    cache::touch(info["key"].as_str().unwrap_or_default());
    let key = format!("reverse:{}:{}:{}", info["key"].as_str().unwrap_or_default(), ff::n3(a), ff::n3(b));
    let ap = app.clone();
    let file = ff::reverse(
        &info,
        a,
        b,
        &move |fraction| {
            let _ = ap.emit("fx:progress", json!({ "key": key, "fraction": fraction }));
        },
        &enc,
    )
    .await?;
    info_with_url(&file).await
}

#[tauri::command]
pub async fn fx_freeze(info: Value, at: f64) -> R<Value> {
    cache::touch(info["key"].as_str().unwrap_or_default());
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
pub async fn export_pick(window: WebviewWindow, suggested: Option<String>, ext: Option<String>) -> Option<String> {
    let ext = export_ext(ext.as_deref());
    let (label, exts): (String, &[&str]) = match ext {
        "mkv" => (tr!("Видео MKV", "MKV video").into(), &["mkv"]),
        "mov" => (tr!("Видео MOV", "MOV video").into(), &["mov"]),
        "gif" => (tr!("Анимация GIF", "GIF animation").into(), &["gif"]),
        "mp3" => (tr!("Звук MP3", "MP3 audio").into(), &["mp3"]),
        "m4a" => (tr!("Звук M4A (AAC)", "M4A audio (AAC)").into(), &["m4a"]),
        "wav" => (tr!("Звук WAV", "WAV audio").into(), &["wav"]),
        "ogg" => (tr!("Звук OGG (Vorbis)", "OGG audio (Vorbis)").into(), &["ogg"]),
        "mxf" => (tr!("Видео MXF (OP1a)", "MXF video (OP1a)").into(), &["mxf"]),
        _ => (tr!("Видео MP4", "MP4 video").into(), &["mp4"]),
    };
    let d = window
        .dialog()
        .file()
        .set_title(tr!("Куда сохранить видео", "Save video as"))
        .set_parent(&window)
        .set_directory(&paths::get().output_dir)
        .set_file_name(suggested.unwrap_or_else(|| format!("{}.{ext}", tr!("Видео", "Video"))))
        .add_filter(label, exts);
    tauri::async_runtime::spawn_blocking(move || d.blocking_save_file())
        .await
        .ok()
        .flatten()
        .and_then(|f| f.into_path().ok())
        // Выбранный пользователем путь — единственный, куда экспорт может писать вне кэша (plancheck, M0.2)
        .map(|p| {
            crate::plancheck::grant_output(&p);
            s(&p)
        })
}

/// Формат экспорта (0.4.1): mp4 (по умолчанию), mkv, mov, gif; только звук — mp3, m4a, wav, ogg; 0.5.2 — mxf
pub fn export_ext(ext: Option<&str>) -> &'static str {
    match ext.map(|e| e.trim_start_matches('.').to_ascii_lowercase()).as_deref() {
        Some("mkv") => "mkv",
        Some("mov") => "mov",
        Some("gif") => "gif",
        Some("mp3") => "mp3",
        Some("m4a") => "m4a",
        Some("wav") => "wav",
        Some("ogg") => "ogg",
        Some("mxf") => "mxf",
        _ => "mp4",
    }
}

pub fn safe_name(base: &str, fallback: &str) -> String {
    let t: String = base.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = t.trim().to_string();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t
    }
}

#[tauri::command]
pub async fn export_default_path(base: Option<String>, ext: Option<String>) -> String {
    let ext = export_ext(ext.as_deref());
    blocking(move || {
        let dir = &paths::get().output_dir;
        let safe = safe_name(&base.unwrap_or_default(), tr!("Видео", "Video"));
        let mut p = dir.join(format!("{safe}.{ext}"));
        let mut i = 2;
        while p.exists() {
            p = dir.join(format!("{safe} ({i}).{ext}"));
            i += 1;
        }
        crate::plancheck::grant_output(&p);
        s(&p)
    })
    .await
    .unwrap_or_default()
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
    let r = export::run(plan, crate::plancheck::Inputs::Window, move |p| {
        if let Some(w) = &w2 {
            use tauri::window::{ProgressBarState, ProgressBarStatus};
            let f = p["fraction"].as_f64().unwrap_or(0.0);
            let _ = w
                .set_progress_bar(ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some((f * 100.0).round() as u64) });
        }
        let _ = a.emit("export:progress", p);
    })
    .await;
    set_bar(None);
    match r {
        Ok(mut v) => {
            if let Some(w) = &win {
                if !w.is_focused().unwrap_or(true) {
                    let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
                }
            }
            v["ok"] = json!(true);
            v
        }
        Err(e) => json!({ "ok": false, "cancelled": e["cancelled"], "error": e["message"] }),
    }
}

/// Первый проход нормализации громкости (0.5.0): plan = { args, filter, duration } (выход @@OUT@@ — в никуда).
/// Прогресс — событие export:progress с phase:'loudness'. Ответ { ok, result: { input_i, … } } | { ok:false, error, cancelled }
#[tauri::command]
pub async fn export_loudness(app: AppHandle, plan: Value) -> Value {
    let args: Vec<String> = serde_json::from_value(plan["args"].clone()).unwrap_or_default();
    let filter = plan["filter"].as_str().unwrap_or_default().to_string();
    let duration = plan["duration"].as_f64().unwrap_or(0.0);
    let a = app.clone();
    let r = export::measure_loudness(args, filter, duration, crate::plancheck::Inputs::Window, move |mut p| {
        p["phase"] = json!("loudness");
        let _ = a.emit("export:progress", p);
    })
    .await;
    match r {
        Ok(v) => json!({ "ok": true, "result": v }),
        Err(e) => json!({ "ok": false, "cancelled": e["cancelled"], "error": e["message"] }),
    }
}

#[tauri::command]
pub fn export_cancel() -> bool {
    export::cancel()
}

// ---------------------------------------------------------------------------
// Проект
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub struct SaveArgs {
    #[serde(rename = "filePath")]
    file_path: Option<String>,
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
            let name = format!("{}.ffproj", safe_name(&args.suggested.unwrap_or_default(), tr!("Проект", "Project")));
            let d = window
                .dialog()
                .file()
                .set_title(tr!("Сохранить проект", "Save project"))
                .set_parent(&window)
                .set_directory(dir)
                .set_file_name(name)
                .add_filter(tr!("Проект FF Montage", "FF Montage project"), &["ffproj"]);
            match tauri::async_runtime::spawn_blocking(move || d.blocking_save_file()).await.ok().flatten().and_then(|f| f.into_path().ok())
            {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    let text = args.text;
    blocking(move || {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        backup_old_project(&p);
        // Сначала во временный файл, потом переименование: сбой посреди записи не портит проект
        let tmp = p.with_extension("ffproj.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        if let Err(e) = std::fs::rename(&tmp, &p) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(Some(s(&p)))
    })
    .await?
}

/// Проект, сохранённый версией до 0.4 (в файле нет appVersion или она меньше 0.4.0), перед первой перезаписью
/// копируется рядом в «<имя> (0.3).ffproj»: 0.3.x не понимает верхние дорожки, текст и субтитры, и так к нему можно вернуться.
fn backup_old_project(p: &Path) {
    let Ok(old) = std::fs::read_to_string(p) else { return };
    let Ok(v) = serde_json::from_str::<Value>(&old) else { return };
    if v.get("project").is_none() && v.get("videoClips").is_none() {
        return;
    }
    let ver = v["appVersion"].as_str().unwrap_or("0.3");
    if !version_lt(ver, "0.4.0") {
        return;
    }
    let stem = p.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let bak = p.with_file_name(format!("{stem} (0.3).ffproj"));
    if !bak.exists() {
        let _ = std::fs::copy(p, &bak);
    }
}

/// a < b для версий вида 0.4.0 (лишние части и суффиксы -beta игнорируются)
pub fn version_lt(a: &str, b: &str) -> bool {
    let parse = |x: &str| -> Vec<u64> { x.split(['.', '-', '+']).take(3).map(|n| n.trim().parse().unwrap_or(0)).collect() };
    let (mut x, mut y) = (parse(a), parse(b));
    x.resize(3, 0);
    y.resize(3, 0);
    x < y
}

#[cfg(test)]
mod project_tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(version_lt("0.3", "0.4.0"));
        assert!(version_lt("0.3.1", "0.4.0"));
        assert!(!version_lt("0.4.0", "0.4.0"));
        assert!(!version_lt("0.4.1", "0.4.0"));
        assert!(version_lt("0.4.0-beta", "0.4.1"));
    }
    #[test]
    fn backup_once_for_old_projects() {
        let d = std::env::temp_dir().join(format!("ffm-bak-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        let p = d.join("Clip.ffproj");
        std::fs::write(&p, r#"{"app":"FF Montage","version":2,"project":{"videoClips":[],"audioTracks":[]}}"#).unwrap();
        backup_old_project(&p);
        let bak = d.join("Clip (0.3).ffproj");
        assert!(bak.exists());
        // новая версия — без копии
        let q = d.join("New.ffproj");
        std::fs::write(&q, r#"{"app":"FF Montage","version":2,"appVersion":"0.4.0","project":{"videoClips":[],"audioTracks":[]}}"#)
            .unwrap();
        backup_old_project(&q);
        assert!(!d.join("New (0.3).ffproj").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}

#[tauri::command]
pub async fn project_open(window: WebviewWindow) -> R<Value> {
    let dir = paths::get().projects_dir.clone();
    let _ = std::fs::create_dir_all(&dir);
    let d = window
        .dialog()
        .file()
        .set_title(tr!("Открыть проект", "Open project"))
        .set_parent(&window)
        .set_directory(dir)
        .add_filter(tr!("Проект FF Montage", "FF Montage project"), &["ffproj"]);
    let Some(p) =
        tauri::async_runtime::spawn_blocking(move || d.blocking_pick_file()).await.ok().flatten().and_then(|f| f.into_path().ok())
    else {
        return Ok(Value::Null);
    };
    read_project(p).await
}

async fn read_project(p: PathBuf) -> R<Value> {
    blocking(move || {
        let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
        Ok(json!({ "filePath": s(&p), "text": text }))
    })
    .await?
}

#[tauri::command]
pub async fn project_read(path: String) -> R<Value> {
    read_project(paths::absolute(Path::new(&path), &std::env::current_dir().unwrap_or_default())).await
}

/// Автосохранения идут по очереди: два одновременных вызова не должны делить один .tmp
static AUTOSAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub async fn autosave_write(text: String) -> R<bool> {
    blocking(move || {
        let _lock = AUTOSAVE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let a = &paths::get().autosave;
        let tmp = a.with_extension("ffproj.tmp");
        std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, a)).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await?
}

#[tauri::command]
pub async fn autosave_read() -> Option<String> {
    blocking(|| std::fs::read_to_string(&paths::get().autosave).ok()).await.ok().flatten()
}

#[tauri::command]
pub async fn shell_show(path: String) -> bool {
    blocking(move || tauri_plugin_opener::reveal_item_in_dir(&path).is_ok()).await.unwrap_or(false)
}

/// Что можно открыть системной программой: существующую папку или медиафайл / проект (.ffproj).
/// Папки самой программы (экспорт, проекты, кэш, журналы, плагины) создаются, если их ещё нет.
fn openable(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(tr!("Можно открыть только папку или медиафайл: {}", "Only a folder or a media file can be opened: {}", path));
    }
    let p = paths::normalize(&p);
    let ps = paths::get();
    let own = [&ps.output_dir, &ps.projects_dir, &ps.cache_dir, &ps.logs, &ps.plugins_dir];
    if !p.exists() && own.iter().any(|d| paths::normalize(d) == p) {
        let _ = std::fs::create_dir_all(&p);
    }
    if p.is_dir() {
        return Ok(p);
    }
    let ext = ff::ext_of(&p);
    let known =
        VIDEO_EXT.contains(&ext.as_str()) || AUDIO_EXT.contains(&ext.as_str()) || ff::IMAGE_EXT.contains(&ext.as_str()) || ext == "ffproj";
    if p.is_file() && known {
        return Ok(p);
    }
    Err(tr!("Можно открыть только папку или медиафайл: {}", "Only a folder or a media file can be opened: {}", path))
}

#[tauri::command]
pub async fn shell_open(path: String) -> String {
    blocking(move || {
        let p = match openable(&path) {
            Ok(p) => p,
            Err(e) => return e,
        };
        match tauri_plugin_opener::open_path(s(&p), None::<&str>) {
            Ok(_) => String::new(),
            Err(e) => e.to_string(),
        }
    })
    .await
    .unwrap_or_else(|e| e)
}

/// Инструменты разработчика (F12): в debug-сборке всегда, в release — только с cargo-feature `devtools`
#[tauri::command]
pub fn win_devtools(window: WebviewWindow) -> bool {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
        true
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let _ = window;
        false
    }
}

#[tauri::command]
pub fn win_title(window: WebviewWindow, title: String) -> bool {
    let _ = window.set_title(&title);
    true
}

#[tauri::command]
pub async fn fs_exists(path: String) -> bool {
    blocking(move || Path::new(&path).exists()).await.unwrap_or(false)
}

// ---------------------------------------------------------------------------
// ИИ-ассистент и журнал
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn mcp_info() -> Value {
    control::info()
}

#[tauri::command]
pub fn mcp_result(window: WebviewWindow, id: String, payload: Value) {
    if window.label() == "main" {
        control::on_result(id, payload);
    }
}

#[tauri::command]
pub async fn log_line(window: WebviewWindow, level: String, message: String) {
    let label = window.label().to_string();
    let _ = blocking(move || {
        use std::io::Write;
        let _lock = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let file = paths::get().logs.join(format!("{}.log", if label == "main" { "renderer" } else { &label }));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
            let _ = writeln!(f, "[{level}] {message}");
        }
    })
    .await;
}

/// Отчёт об ошибке из окна (необработанная ошибка JS, сбой рендера звука) — logs/reports, только локально
#[tauri::command]
pub async fn crash_report(kind: String, message: String, detail: String) -> Option<String> {
    blocking(move || crate::crashlog::report_js(&kind, &message, &detail).map(|p| s(&p))).await.ok().flatten()
}

/// Отчёты об ошибках: { dir, total, fresh, last }; mark_seen — пользователь их увидел
#[tauri::command]
pub async fn crash_reports(mark_seen: bool) -> Value {
    blocking(move || crate::crashlog::list(mark_seen)).await.unwrap_or(Value::Null)
}

/// Строки журнала из разных потоков не перемешиваются
static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
