// Пути программы. Задаются в config.json рядом с программой (как config-файл у старых игр).
// Если config.json нет — программа запускается в режиме первой настройки и показывает окно выбора папок.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
pub struct Paths {
    pub app_dir: PathBuf,
    pub config_file: PathBuf,
    pub vendor_dir: PathBuf,
    pub firstrun_dir: PathBuf,
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
}

static PATHS: OnceLock<Paths> = OnceLock::new();

pub fn get() -> &'static Paths {
    PATHS.get_or_init(init)
}

/// Папка программы: FFM_APP_DIR → папка exe; при запуске из src-tauri/target/<профиль> — корень репозитория
pub fn app_dir() -> PathBuf {
    if let Ok(d) = std::env::var("FFM_APP_DIR") {
        if !d.is_empty() {
            return absolute(Path::new(&d), &std::env::current_dir().unwrap_or_default());
        }
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

pub fn config_file(app_dir: &Path) -> PathBuf {
    match std::env::var("FFM_CONFIG") {
        Ok(c) if !c.is_empty() => absolute(Path::new(&c), &std::env::current_dir().unwrap_or_default()),
        _ => app_dir.join("config.json"),
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
    let config_file = config_file(&app_dir);
    let cfg = load_config(&config_file);
    let firstrun_dir = app_dir.join(".firstrun");
    let (cache_dir, output_dir, projects_dir, ffmpeg_dir, first_run) = match &cfg {
        Some(c) => {
            let cache = absolute(Path::new(&c.cache_dir), &app_dir);
            let out = absolute(Path::new(&c.output_dir), &app_dir);
            let proj = if c.projects_dir.is_empty() {
                normalize(&out.join("..").join("Projects"))
            } else {
                absolute(Path::new(&c.projects_dir), &app_dir)
            };
            let ff = if c.ffmpeg_dir.trim().is_empty() { None } else { Some(absolute(Path::new(c.ffmpeg_dir.trim()), &app_dir)) };
            (cache, out, proj, ff, false)
        }
        None => (firstrun_dir.clone(), firstrun_dir.clone(), firstrun_dir.clone(), None, true),
    };
    let app_cache = cache_dir.join("app");
    Paths {
        vendor_dir: app_dir.join("vendor"),
        webview: app_cache.join("webview"),
        logs: app_cache.join("logs"),
        temp: cache_dir.join("tmp"),
        media_cache: app_cache.join("media"),
        autosave: app_cache.join("autosave.ffproj"),
        app_cache,
        app_dir,
        config_file,
        firstrun_dir,
        cache_dir,
        output_dir,
        projects_dir,
        ffmpeg_dir,
        first_run,
    }
}

pub fn ensure_dirs() {
    let p = get();
    for d in [&p.cache_dir, &p.app_cache, &p.webview, &p.logs, &p.temp, &p.media_cache] {
        let _ = std::fs::create_dir_all(d);
    }
}

pub fn save_config(cfg: &Config) -> std::io::Result<()> {
    let data = json!({
        "_comment": "Настройки FF Montage. Можно править вручную или через меню → «Настройки папок». Удалите файл, чтобы снова увидеть окно первого запуска.",
        "version": 1,
        "cacheDir": cfg.cache_dir,
        "outputDir": cfg.output_dir,
        "projectsDir": cfg.projects_dir,
        "ffmpegDir": cfg.ffmpeg_dir,
    });
    std::fs::write(&get().config_file, serde_json::to_string_pretty(&data).unwrap_or_default())
}

/// Предложения для окна первого запуска. Если рядом с программой уже есть папки Cache / Output / Projects — берём их.
pub fn suggest_defaults(videos: Option<PathBuf>, documents: Option<PathBuf>) -> Config {
    let app = &get().app_dir;
    let parent = app.parent().map(Path::to_path_buf).unwrap_or_else(|| app.clone());
    let near = |name: &str| {
        let p = parent.join(name);
        if p.exists() { Some(p) } else { None }
    };
    let s = |p: PathBuf| p.to_string_lossy().to_string();
    let videos = videos.unwrap_or_else(|| app.join("Output"));
    let documents = documents.unwrap_or_else(|| app.join("Projects"));
    Config {
        cache_dir: s(near("Cache").unwrap_or_else(|| app.join("Cache"))),
        output_dir: s(near("Output").unwrap_or_else(|| videos.join("FF Montage"))),
        projects_dir: s(near("Projects").unwrap_or_else(|| {
            if near("Cache").is_some() { parent.join("Projects") } else { documents.join("FF Montage") }
        })),
        ffmpeg_dir: String::new(),
    }
}
