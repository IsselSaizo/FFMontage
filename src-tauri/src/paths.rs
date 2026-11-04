// Пути программы (M0.5). Где лежат config.json, settings.json, свои шрифты и плагины — зависит от режима:
//   portable — всё рядом с exe (как раньше): рядом с exe есть portable.txt или уже лежит config.json,
//              либо это zip-сборка Windows и её папка доступна на запись (решение D7);
//   system   — системные папки: Windows %APPDATA%\FF Montage (настройки, шрифты, плагины) и %LOCALAPPDATA%\FF Montage (кэш),
//              Linux XDG (~/.config/ff-montage, ~/.local/share/ff-montage, ~/.cache/ff-montage),
//              macOS ~/Library/Application Support/FF Montage и ~/Library/Caches/FF Montage;
//   custom   — задан FFM_CONFIG (автотесты, MCP-клиенты): данные рядом с этим config.json, системные папки не трогаются.
// Переменные окружения сильнее режима: FFM_CONFIG, FFM_SETTINGS, FFM_PLUGINS_DIR, FFM_FONTS_DIR, FFM_APP_DIR;
// FFM_PORTABLE=1/0 — включить/выключить portable-режим принудительно.
// Папки кэша, экспорта и проектов по-прежнему выбираются в окне первого запуска и хранятся в config.json.
// Если config.json нет — программа запускается в режиме первой настройки и показывает окно выбора папок.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Режим хранения данных
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Portable,
    System,
    Custom,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Portable => "portable",
            Mode::System => "system",
            Mode::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Paths {
    pub mode: Mode,
    /// Почему выбран режим: env | marker | config | zip | installed | readonly | platform | nohome
    pub mode_reason: &'static str,
    /// Папка программы (exe, ffmpeg рядом, исходники в dev-сборке)
    pub app_dir: PathBuf,
    /// Папка config.json и settings.json
    pub config_dir: PathBuf,
    /// Папка данных пользователя: user-fonts, plugins
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    pub settings_file: PathBuf,
    pub vendor_dir: PathBuf,
    pub firstrun_dir: PathBuf,
    /// Кэш по умолчанию для окна первого запуска
    pub default_cache: PathBuf,
    pub cache_dir: PathBuf,
    pub output_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub ffmpeg_dir: Option<PathBuf>,
    pub app_cache: PathBuf,
    pub webview: PathBuf,
    pub logs: PathBuf,
    pub temp: PathBuf,
    pub media_cache: PathBuf,
    pub autosave: PathBuf,
    /// Плагины: <data_dir>/plugins/<id>/plugin.json (переопределение — FFM_PLUGINS_DIR, для тестов)
    pub plugins_dir: PathBuf,
    /// Свои шрифты: <data_dir>/user-fonts (переопределение — FFM_FONTS_DIR, см. user_fonts_dir)
    pub fonts_dir: PathBuf,
    pub first_run: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Config {
    #[serde(default, rename = "cacheDir")]
    pub cache_dir: String,
    #[serde(default, rename = "outputDir")]
    pub output_dir: String,
    #[serde(default, rename = "projectsDir")]
    pub projects_dir: String,
    #[serde(default, rename = "ffmpegDir")]
    pub ffmpeg_dir: String,
    /// Старое место настроек интерфейса (до M0.6). Только читается: settings.rs переносит их в settings.json.
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub settings: serde_json::Value,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

pub fn get() -> &'static Paths {
    PATHS.get_or_init(init)
}

fn env_var(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_default()
}

/// Папка программы: FFM_APP_DIR → папка exe; при запуске из src-tauri/target/<профиль> — корень репозитория
pub fn app_dir() -> PathBuf {
    if let Some(d) = env_var("FFM_APP_DIR") {
        return absolute(Path::new(&d), &cwd());
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    // …/src-tauri/target/release/ff-montage.exe → …/
    let mut p = dir.clone();
    for _ in 0..4 {
        if p.join("src-tauri").join("tauri.conf.json").exists() && p.join("src").join("renderer").exists() {
            return p;
        }
        if !p.pop() {
            break;
        }
    }
    dir
}

pub fn absolute(p: &Path, base: &Path) -> PathBuf {
    let joined = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    normalize(&joined)
}

/// Убирает «.» и «..» без обращения к диску (как path.resolve в Node)
pub fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Системные папки и выбор режима
// ---------------------------------------------------------------------------
/// Системные папки программы (режим system)
#[derive(Debug, Clone, PartialEq)]
pub struct SysDirs {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
}

/// Системные папки для ОС `os` (std::env::consts::OS). Переменные окружения берутся через `env` —
/// так тесты проверяют любую ОС, не трогая настоящие %APPDATA% / ~/.config.
pub fn system_dirs_for(os: &str, env: &dyn Fn(&str) -> Option<String>) -> Option<SysDirs> {
    let abs = |v: Option<String>| v.map(PathBuf::from).filter(|p| p.is_absolute());
    match os {
        "windows" => {
            let profile = abs(env("USERPROFILE"));
            let roaming = abs(env("APPDATA")).or_else(|| profile.as_ref().map(|p| p.join("AppData").join("Roaming")))?;
            let local = abs(env("LOCALAPPDATA"))
                .or_else(|| profile.as_ref().map(|p| p.join("AppData").join("Local")))
                .unwrap_or_else(|| roaming.clone());
            let cfg = roaming.join("FF Montage");
            Some(SysDirs { config: cfg.clone(), data: cfg, cache: local.join("FF Montage") })
        }
        "macos" => {
            let home = abs(env("HOME"))?;
            let support = home.join("Library").join("Application Support").join("FF Montage");
            Some(SysDirs { config: support.clone(), data: support, cache: home.join("Library").join("Caches").join("FF Montage") })
        }
        _ => {
            // XDG Base Directory: относительные пути в переменных не считаются (так велит спецификация)
            let home = abs(env("HOME"));
            let xdg = |var: &str, rel: &[&str]| -> Option<PathBuf> {
                abs(env(var)).or_else(|| home.as_ref().map(|h| rel.iter().fold(h.clone(), |p, x| p.join(x))))
            };
            Some(SysDirs {
                config: xdg("XDG_CONFIG_HOME", &[".config"])?.join("ff-montage"),
                data: xdg("XDG_DATA_HOME", &[".local", "share"])?.join("ff-montage"),
                cache: xdg("XDG_CACHE_HOME", &[".cache"])?.join("ff-montage"),
            })
        }
    }
}

/// Можно ли писать в папку (пробный файл создаётся и сразу удаляется)
fn dir_writable(d: &Path) -> bool {
    let test = d.join(format!(".ffm-write-test-{}", std::process::id()));
    let ok = std::fs::write(&test, b"ok").is_ok();
    let _ = std::fs::remove_file(&test);
    ok
}

fn under(p: &Path, dir: &Path) -> bool {
    let (p, d) = (normalize(p).to_string_lossy().to_lowercase(), normalize(dir).to_string_lossy().to_lowercase());
    !d.is_empty() && (p == d || p.starts_with(&format!("{}{}", d.trim_end_matches(['\\', '/']), std::path::MAIN_SEPARATOR)))
}

/// Режим хранения для папки программы `app_dir` (без FFM_CONFIG). Порядок:
/// FFM_PORTABLE → portable.txt → config.json рядом с exe → zip-сборка Windows с папкой на запись → системные папки.
pub fn detect_mode(app_dir: &Path, os: &str, env: &dyn Fn(&str) -> Option<String>) -> (Mode, &'static str) {
    match env("FFM_PORTABLE").as_deref() {
        Some("1") | Some("true") => return (Mode::Portable, "env"),
        Some("0") | Some("false") => return (Mode::System, "env"),
        _ => {}
    }
    if app_dir.join("portable.txt").exists() {
        return (Mode::Portable, "marker");
    }
    if app_dir.join("config.json").exists() {
        return (Mode::Portable, "config");
    }
    if os == "windows" {
        // Установленная версия (установщик кладёт uninstall.exe; Program Files) — системные папки
        let program_files =
            ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].iter().filter_map(|k| env(k)).any(|pf| under(app_dir, Path::new(&pf)));
        if program_files || app_dir.join("uninstall.exe").exists() {
            return (Mode::System, "installed");
        }
        if dir_writable(app_dir) {
            return (Mode::Portable, "zip");
        }
        return (Mode::System, "readonly");
    }
    // Linux (AppImage, Flatpak, пакеты) и macOS — системные папки (D7)
    (Mode::System, "platform")
}

/// Файл config.json: FFM_CONFIG или <config_dir>/config.json
pub fn config_file(config_dir: &Path) -> PathBuf {
    match env_var("FFM_CONFIG") {
        Some(c) => absolute(Path::new(&c), &cwd()),
        None => config_dir.join("config.json"),
    }
}

pub fn load_config(file: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(file).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    let cfg: Config = serde_json::from_str(text).ok()?;
    if cfg.cache_dir.is_empty() || cfg.output_dir.is_empty() {
        return None;
    }
    Some(cfg)
}

fn init() -> Paths {
    let app_dir = app_dir();
    let env = |k: &str| env_var(k);
    let os = std::env::consts::OS;
    let (mut mode, mut reason) = if env_var("FFM_CONFIG").is_some() { (Mode::Custom, "env") } else { detect_mode(&app_dir, os, &env) };
    let sys = system_dirs_for(os, &env);
    if mode == Mode::System && sys.is_none() {
        // Нет HOME / APPDATA — остаётся только папка программы
        mode = Mode::Portable;
        reason = "nohome";
    }
    let (config_dir, data_dir, default_cache) = match (mode, &sys) {
        (Mode::System, Some(s)) => (s.config.clone(), s.data.clone(), s.cache.clone()),
        (Mode::Custom, _) => {
            let d = config_file(&app_dir).parent().map(Path::to_path_buf).unwrap_or_else(|| app_dir.clone());
            (d.clone(), d.clone(), d.join("Cache"))
        }
        _ => (app_dir.clone(), app_dir.clone(), app_dir.join("Cache")),
    };
    let config_file = config_file(&config_dir);
    let settings_file = match env_var("FFM_SETTINGS") {
        Some(f) => absolute(Path::new(&f), &cwd()),
        None => config_file.with_file_name("settings.json"),
    };
    // Относительные пути в config.json: portable/custom — от папки программы (как раньше), system — от папки настроек
    let base = if mode == Mode::System { config_dir.clone() } else { app_dir.clone() };
    let cfg = load_config(&config_file);
    let firstrun_dir = match mode {
        Mode::Portable => app_dir.join(".firstrun"),
        Mode::Custom => config_dir.join(".firstrun"),
        Mode::System => default_cache.join(".firstrun"),
    };
    let (cache_dir, output_dir, projects_dir, ffmpeg_dir, first_run) = match &cfg {
        Some(c) => {
            let cache = absolute(Path::new(&c.cache_dir), &base);
            let out = absolute(Path::new(&c.output_dir), &base);
            let proj = if c.projects_dir.is_empty() {
                normalize(&out.join("..").join("Projects"))
            } else {
                absolute(Path::new(&c.projects_dir), &base)
            };
            let ff = if c.ffmpeg_dir.trim().is_empty() { None } else { Some(absolute(Path::new(c.ffmpeg_dir.trim()), &base)) };
            (cache, out, proj, ff, false)
        }
        None => (firstrun_dir.clone(), firstrun_dir.clone(), firstrun_dir.clone(), None, true),
    };
    let app_cache = cache_dir.join("app");
    let plugins_dir = match env_var("FFM_PLUGINS_DIR") {
        Some(d) => absolute(Path::new(&d), &cwd()),
        None => data_dir.join("plugins"),
    };
    let fonts_dir = match env_var("FFM_FONTS_DIR") {
        Some(d) => absolute(Path::new(&d), &cwd()),
        None => data_dir.join("user-fonts"),
    };
    Paths {
        mode,
        mode_reason: reason,
        plugins_dir,
        fonts_dir,
        vendor_dir: app_dir.join("vendor"),
        webview: app_cache.join("webview"),
        logs: app_cache.join("logs"),
        temp: cache_dir.join("tmp"),
        media_cache: app_cache.join("media"),
        autosave: app_cache.join("autosave.ffproj"),
        app_cache,
        app_dir,
        config_dir,
        data_dir,
        config_file,
        settings_file,
        firstrun_dir,
        default_cache,
        cache_dir,
        output_dir,
        projects_dir,
        ffmpeg_dir,
        first_run,
    }
}

/// Папка своих шрифтов: FFM_FONTS_DIR (читается при каждом вызове — на этом стоят тесты fonts.rs) или <data_dir>/user-fonts
pub fn user_fonts_dir() -> PathBuf {
    match env_var("FFM_FONTS_DIR") {
        Some(d) => absolute(Path::new(&d), &cwd()),
        None => get().data_dir.join("user-fonts"),
    }
}

pub fn ensure_dirs() {
    let p = get();
    for d in [&p.cache_dir, &p.app_cache, &p.webview, &p.logs, &p.temp, &p.media_cache] {
        let _ = std::fs::create_dir_all(d);
    }
}

/// config.json меняется по очереди (setup_save, перенос старых настроек в settings.json)
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn config_lock() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// Запись файла целиком через .tmp (не остаётся полузаписанного файла)
pub fn write_atomic(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, file)
}

/// Записать папки в config.json. Настройки интерфейса сюда больше не пишутся — они в settings.json (M0.6).
pub fn save_config(cfg: &Config) -> std::io::Result<()> {
    let data = json!({
        "_comment": "FF Montage folders. Edit by hand or in the Settings window (☰ → Settings → Folders). Delete this file to see the first-run window again. Interface settings are in settings.json next to this file.",
        "version": 1,
        "cacheDir": cfg.cache_dir,
        "outputDir": cfg.output_dir,
        "projectsDir": cfg.projects_dir,
        "ffmpegDir": cfg.ffmpeg_dir,
    });
    write_atomic(&get().config_file, serde_json::to_string_pretty(&data).unwrap_or_default().as_bytes())
}

/// Настройки интерфейса (объект; пустой, если файла нет) — теперь из settings.json, см. settings.rs
pub fn load_settings() -> serde_json::Value {
    crate::settings::load()
}

/// Предложения для окна первого запуска. Portable: если рядом с программой уже есть папки Cache / Output / Projects — берём их.
/// System: кэш — в системной папке кэша, видео и проекты — в «Видео» и «Документах».
pub fn suggest_defaults(videos: Option<PathBuf>, documents: Option<PathBuf>) -> Config {
    let p = get();
    let s = |p: PathBuf| p.to_string_lossy().to_string();
    if p.mode == Mode::System {
        let videos = videos.unwrap_or_else(|| p.data_dir.clone());
        let documents = documents.unwrap_or_else(|| p.data_dir.clone());
        return Config {
            cache_dir: s(p.default_cache.clone()),
            output_dir: s(videos.join("FF Montage")),
            projects_dir: s(documents.join("FF Montage")),
            ffmpeg_dir: String::new(),
            settings: serde_json::Value::Null,
        };
    }
    let app = if p.mode == Mode::Custom { &p.config_dir } else { &p.app_dir };
    let parent = app.parent().map(Path::to_path_buf).unwrap_or_else(|| app.clone());
    let near = |name: &str| {
        let p = parent.join(name);
        if p.exists() {
            Some(p)
        } else {
            None
        }
    };
    let videos = videos.unwrap_or_else(|| app.join("Output"));
    let documents = documents.unwrap_or_else(|| app.join("Projects"));
    Config {
        cache_dir: s(near("Cache").unwrap_or_else(|| app.join("Cache"))),
        output_dir: s(near("Output").unwrap_or_else(|| videos.join("FF Montage"))),
        projects_dir: s(near("Projects").unwrap_or_else(|| {
            if near("Cache").is_some() {
                parent.join("Projects")
            } else {
                documents.join("FF Montage")
            }
        })),
        ffmpeg_dir: String::new(),
        settings: serde_json::Value::Null,
    }
}

// ---------------------------------------------------------------------------
// Сведения для окна настроек (команда paths_info)
// ---------------------------------------------------------------------------
fn has_user_data(dir: &Path) -> bool {
    ["config.json", "settings.json", "user-fonts", "plugins"].iter().any(|n| dir.join(n).exists())
}

/// Режим и все папки. other — второе возможное место данных (portable ↔ system): если там уже что-то лежит,
/// окно подскажет, что данные можно перенести вручную (автоматически не переносим).
pub fn info() -> Value {
    let p = get();
    let s = |x: &Path| x.to_string_lossy().to_string();
    let env = |k: &str| env_var(k);
    let sys = system_dirs_for(std::env::consts::OS, &env);
    let other = match p.mode {
        Mode::Portable => sys.as_ref().map(|d| {
            json!({
                "mode": "system", "configDir": s(&d.config), "dataDir": s(&d.data), "cacheDir": s(&d.cache),
                "hasData": has_user_data(&d.config) || has_user_data(&d.data),
            })
        }),
        Mode::System => Some(json!({
            "mode": "portable", "configDir": s(&p.app_dir), "dataDir": s(&p.app_dir), "cacheDir": s(&p.app_dir.join("Cache")),
            "hasData": has_user_data(&p.app_dir),
        })),
        Mode::Custom => None,
    };
    json!({
        "mode": p.mode.as_str(),
        "reason": p.mode_reason,
        "platform": std::env::consts::OS,
        "appDir": s(&p.app_dir),
        "configDir": s(&p.config_dir),
        "dataDir": s(&p.data_dir),
        "configFile": s(&p.config_file),
        "settingsFile": s(&p.settings_file),
        "cacheDir": s(&p.cache_dir),
        "outputDir": s(&p.output_dir),
        "projectsDir": s(&p.projects_dir),
        "pluginsDir": s(&p.plugins_dir),
        "fontsDir": s(&user_fonts_dir()),
        "logsDir": s(&p.logs),
        "portableMarker": s(&p.app_dir.join("portable.txt")),
        "firstRun": p.first_run,
        "other": other,
    })
}

// ---------------------------------------------------------------------------
// AppImage (0.4.2). Образ монтируется в /tmp/.mount_XXXX (или распаковывается во временную папку) — эта папка
// существует, только пока жив запустивший её процесс. Поэтому перезапуск, обновление и настройки MCP-клиентов
// запускают сам файл образа ($APPIMAGE), а не exe внутри него. Данные — в папках XDG (detect_mode: Linux → system).
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppImage {
    /// Файл образа ($APPIMAGE) — его подменяет обновление (update.rs install_appimage)
    pub file: PathBuf,
    /// Папка образа ($APPDIR): FFmpeg в usr/bin/ffmpeg, GStreamer в usr/lib/gstreamer-1.0
    pub dir: PathBuf,
}

/// Запуск из AppImage: заданы $APPIMAGE и $APPDIR и сам exe лежит внутри $APPDIR. Последнее важно: переменные
/// наследуются, и программа из tar.gz, запущенная, например, из терминала-AppImage, иначе приняла бы чужой образ за свой.
pub fn appimage_from(appimage: Option<&str>, appdir: Option<&str>, exe: &Path) -> Option<AppImage> {
    let (file, dir) = (PathBuf::from(appimage?), PathBuf::from(appdir?));
    if !file.is_absolute() || !dir.is_absolute() || !under(exe, &dir) || under(&file, &dir) {
        return None;
    }
    Some(AppImage { file, dir })
}

/// Программа запущена из AppImage (только Linux)
pub fn appimage() -> Option<&'static AppImage> {
    static A: OnceLock<Option<AppImage>> = OnceLock::new();
    A.get_or_init(|| {
        if !cfg!(target_os = "linux") {
            return None;
        }
        let exe = std::env::current_exe().ok()?;
        appimage_from(env_var("APPIMAGE").as_deref(), env_var("APPDIR").as_deref(), &exe).filter(|a| a.file.is_file())
    })
    .as_ref()
}

/// Что запускать, чтобы стартовала эта же программа: в AppImage — файл образа, иначе — сам exe
pub fn launch_exe(exe: &Path) -> PathBuf {
    match appimage() {
        Some(a) if under(exe, &a.dir) => a.file.clone(),
        _ => exe.to_path_buf(),
    }
}

/// Окружение новой копии программы, запускаемой из AppImage: переменные, указывающие внутрь папки старого образа
/// ($APPDIR, пути GStreamer и GTK из apprun-hooks, PATH, LD_LIBRARY_PATH…), чистятся — новый образ задаст их сам,
/// а старая папка исчезнет вместе с этим процессом. Списки через «:» чистятся поэлементно.
/// Возвращает (имя, Some(новое значение)) или (имя, None) — убрать переменную.
pub fn env_without_appdir(vars: impl IntoIterator<Item = (String, String)>, dir: &Path) -> Vec<(String, Option<String>)> {
    let d = dir.to_string_lossy().trim_end_matches('/').to_string();
    if d.is_empty() {
        return vec![];
    }
    let inside = |part: &str| part == d || part.starts_with(&format!("{d}/"));
    vars.into_iter()
        .filter(|(_, v)| v.contains(&d))
        .map(|(k, v)| {
            let joined = v.split(':').filter(|p| !inside(p)).collect::<Vec<_>>().join(":");
            (k, (!joined.is_empty()).then_some(joined))
        })
        .collect()
}

/// Команда запуска новой копии программы (перезапуск, обновление, MCP): в AppImage — файл образа без путей
/// в старый образ, папка — рядом с образом; иначе — exe из папки программы.
pub fn launch_command(exe: &Path) -> std::process::Command {
    // exe внутри образа (перезапуск, MCP) или сам файл образа (после обновления)
    let img = appimage().filter(|a| under(exe, &a.dir) || exe == a.file);
    let target = img.map(|a| a.file.clone()).unwrap_or_else(|| exe.to_path_buf());
    let mut c = std::process::Command::new(&target);
    match img {
        Some(a) => {
            c.current_dir(a.file.parent().unwrap_or(Path::new("/")));
            let vars = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)));
            for (k, v) in env_without_appdir(vars, &a.dir) {
                match v {
                    Some(v) => c.env(k, v),
                    None => c.env_remove(k),
                };
            }
        }
        None => {
            c.current_dir(&get().app_dir);
        }
    }
    c
}

/// Папка для юнит-тестов: src-tauri/target/ffm-unit-tests/<имя>-<pid> (не %TEMP%, который лежит в %LOCALAPPDATA%)
#[cfg(test)]
pub fn test_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("ffm-unit-tests").join(format!("{name}-{}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| m.get(k).cloned()
    }

    #[test]
    fn windows_dirs() {
        let e = env_of(&[("APPDATA", r"C:\Users\u\AppData\Roaming"), ("LOCALAPPDATA", r"C:\Users\u\AppData\Local")]);
        if cfg!(windows) {
            let d = system_dirs_for("windows", &e).unwrap();
            assert_eq!(d.config, PathBuf::from(r"C:\Users\u\AppData\Roaming\FF Montage"));
            assert_eq!(d.data, d.config);
            assert_eq!(d.cache, PathBuf::from(r"C:\Users\u\AppData\Local\FF Montage"));
            // Нет LOCALAPPDATA — из USERPROFILE
            let e2 = env_of(&[("USERPROFILE", r"C:\Users\u")]);
            let d2 = system_dirs_for("windows", &e2).unwrap();
            assert_eq!(d2.cache, PathBuf::from(r"C:\Users\u\AppData\Local\FF Montage"));
        }
        assert!(system_dirs_for("windows", &env_of(&[])).is_none());
    }

    #[test]
    fn xdg_dirs() {
        if cfg!(windows) {
            return;
        } // абсолютные пути Unix на Windows не абсолютные
        let d = system_dirs_for("linux", &env_of(&[("HOME", "/home/deck")])).unwrap();
        assert_eq!(d.config, PathBuf::from("/home/deck/.config/ff-montage"));
        assert_eq!(d.data, PathBuf::from("/home/deck/.local/share/ff-montage"));
        assert_eq!(d.cache, PathBuf::from("/home/deck/.cache/ff-montage"));
        let d = system_dirs_for(
            "linux",
            &env_of(&[
                ("HOME", "/home/deck"),
                ("XDG_CONFIG_HOME", "/x/cfg"),
                ("XDG_CACHE_HOME", "rel/ignored"),
                ("XDG_DATA_HOME", "/x/data"),
            ]),
        )
        .unwrap();
        assert_eq!(d.config, PathBuf::from("/x/cfg/ff-montage"));
        assert_eq!(d.data, PathBuf::from("/x/data/ff-montage"));
        assert_eq!(d.cache, PathBuf::from("/home/deck/.cache/ff-montage"));
        let m = system_dirs_for("macos", &env_of(&[("HOME", "/Users/me")])).unwrap();
        assert_eq!(m.config, PathBuf::from("/Users/me/Library/Application Support/FF Montage"));
        assert_eq!(m.cache, PathBuf::from("/Users/me/Library/Caches/FF Montage"));
    }

    #[test]
    fn mode_detection() {
        let base = test_dir("paths");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let none = env_of(&[]);
        // Linux / macOS без маркера — системные папки, с portable.txt или config.json — portable
        assert_eq!(detect_mode(&base, "linux", &none), (Mode::System, "platform"));
        assert_eq!(detect_mode(&base, "macos", &none), (Mode::System, "platform"));
        // Windows: zip-сборка в папке на запись — portable
        assert_eq!(detect_mode(&base, "windows", &none), (Mode::Portable, "zip"));
        // Program Files — установленная версия
        let pf = base.to_string_lossy().to_string();
        assert_eq!(detect_mode(&base.join("FF Montage"), "windows", &env_of(&[("ProgramFiles", &pf)])).0, Mode::System);
        std::fs::write(base.join("config.json"), "{}").unwrap();
        assert_eq!(detect_mode(&base, "linux", &none), (Mode::Portable, "config"));
        std::fs::write(base.join("portable.txt"), "").unwrap();
        assert_eq!(detect_mode(&base, "linux", &none), (Mode::Portable, "marker"));
        // FFM_PORTABLE сильнее всего
        assert_eq!(detect_mode(&base, "linux", &env_of(&[("FFM_PORTABLE", "0")])), (Mode::System, "env"));
        assert_eq!(detect_mode(&base.join("nope"), "linux", &env_of(&[("FFM_PORTABLE", "1")])), (Mode::Portable, "env"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn appimage_detection() {
        if cfg!(windows) {
            return; // пути Unix на Windows не абсолютные
        }
        let exe = Path::new("/tmp/.mount_FFabc/usr/bin/ff-montage");
        let a = appimage_from(Some("/home/deck/Apps/FF.AppImage"), Some("/tmp/.mount_FFabc"), exe).unwrap();
        assert_eq!(a.file, PathBuf::from("/home/deck/Apps/FF.AppImage"));
        assert_eq!(a.dir, PathBuf::from("/tmp/.mount_FFabc"));
        // Переменные унаследованы от чужого AppImage: exe не внутри $APPDIR
        assert_eq!(appimage_from(Some("/a/Other.AppImage"), Some("/tmp/.mount_Other"), exe), None);
        assert_eq!(appimage_from(Some("/a/Other.AppImage"), Some("/tmp/.mount_FF"), exe), None, "name prefix is not a folder");
        // Не заданы / относительные пути / образ внутри собственной папки
        assert_eq!(appimage_from(None, Some("/tmp/.mount_FFabc"), exe), None);
        assert_eq!(appimage_from(Some("/a/FF.AppImage"), None, exe), None);
        assert_eq!(appimage_from(Some("FF.AppImage"), Some("/tmp/.mount_FFabc"), exe), None);
        assert_eq!(appimage_from(Some("/tmp/.mount_FFabc/x.AppImage"), Some("/tmp/.mount_FFabc"), exe), None);
        // Режим путей в AppImage — системный (XDG), даже если бы папка образа была доступна на запись (D7)
        assert_eq!(detect_mode(Path::new("/tmp/.mount_FFabc/usr/bin"), "linux", &env_of(&[])), (Mode::System, "platform"));
    }

    #[test]
    fn appimage_relaunch_env() {
        let vars = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let mut r = env_without_appdir(
            vars(&[
                ("APPDIR", "/tmp/.mount_FFabc"),
                ("APPIMAGE", "/home/deck/FF.AppImage"),
                ("PATH", "/tmp/.mount_FFabc/usr/bin:/usr/bin:/bin"),
                ("GST_PLUGIN_SYSTEM_PATH_1_0", "/tmp/.mount_FFabc/usr/lib/gstreamer-1.0"),
                ("LD_LIBRARY_PATH", "/tmp/.mount_FFabc/usr/lib:/opt/lib"),
                ("XDG_DATA_DIRS", "/tmp/.mount_FFabc/usr/share/:/usr/share"),
                ("HOME", "/home/deck"),
                ("OTHER", "/tmp/.mount_FFabcdef/usr/lib"),
            ]),
            Path::new("/tmp/.mount_FFabc/"),
        );
        r.sort();
        assert_eq!(
            r,
            vec![
                ("APPDIR".to_string(), None),
                ("GST_PLUGIN_SYSTEM_PATH_1_0".to_string(), None),
                ("LD_LIBRARY_PATH".to_string(), Some("/opt/lib".to_string())),
                // Чужая папка с тем же префиксом не трогается (значение остаётся прежним)
                ("OTHER".to_string(), Some("/tmp/.mount_FFabcdef/usr/lib".to_string())),
                ("PATH".to_string(), Some("/usr/bin:/bin".to_string())),
                ("XDG_DATA_DIRS".to_string(), Some("/usr/share".to_string())),
            ]
        );
        assert!(env_without_appdir(vars(&[("PATH", "/usr/bin")]), Path::new("")).is_empty());
    }

    #[test]
    fn under_paths() {
        if cfg!(windows) {
            assert!(under(Path::new(r"C:\Program Files\FF Montage"), Path::new(r"C:\Program Files")));
            assert!(under(Path::new(r"c:\program files\x"), Path::new(r"C:\Program Files\")));
            assert!(!under(Path::new(r"C:\Program Files (x86)\x"), Path::new(r"C:\Program Files")));
        }
    }
}
