// Работа с FFmpeg: поиск бинарников, анализ файлов, миниатюры, волна звука, прокси, эффекты, проверка кодеков.
// Фоновые задачи идут через очередь queue.rs (лимит процессора и видеокарты); у каждого запуска — лимит времени
// (Limits, M0.9): зависший процесс убивается с понятной ошибкой.
use crate::{paths, tr};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::{Duration, UNIX_EPOCH};
use tokio::io::AsyncReadExt;

pub type Res<T> = Result<T, String>;

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

// ---------------------------------------------------------------------------
// Поиск ffmpeg / ffprobe
// ---------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct Bin {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub dir: Option<PathBuf>,
    pub missing: bool,
}

static BIN: RwLock<Option<Bin>> = RwLock::new(None);

fn bin_in(dir: &Path) -> Option<Bin> {
    for d in [dir.to_path_buf(), dir.join("bin")] {
        let ff = d.join(format!("ffmpeg{EXE}"));
        let fp = d.join(format!("ffprobe{EXE}"));
        if ff.is_file() && fp.is_file() {
            return Some(Bin { ffmpeg: ff, ffprobe: fp, dir: Some(d), missing: false });
        }
    }
    None
}

/// Порядок поиска: папка из настроек → $FFMONTAGE_FFMPEG_DIR → FFmpeg внутри AppImage ($APPDIR/usr/bin/ffmpeg) →
/// ffmpeg рядом с программой → ffmpeg-* рядом с программой → vendor/ffmpeg (старые установки 0.2) → PATH
pub fn search_binaries(configured: Option<&Path>) -> Option<Bin> {
    if let Some(c) = configured {
        return bin_in(c);
    }
    let p = paths::get();
    let env_dir = std::env::var("FFMONTAGE_FFMPEG_DIR").ok();
    let cands = candidate_dirs(env_dir.as_deref(), paths::appimage().map(|a| a.dir.as_path()), &p.app_dir, &p.vendor_dir);
    first_bin(&cands, std::env::var_os("PATH").as_deref())
}

/// Папки, где искать FFmpeg (без PATH), по порядку — см. search_binaries
fn candidate_dirs(env_dir: Option<&str>, appimage_dir: Option<&Path>, app_dir: &Path, vendor_dir: &Path) -> Vec<PathBuf> {
    let mut cands: Vec<PathBuf> = vec![];
    if let Some(e) = env_dir.filter(|e| !e.is_empty()) {
        cands.push(PathBuf::from(e));
    }
    // AppImage: FFmpeg кладёт в образ .github/appimage.conf.json — usr/bin/ffmpeg/bin/ffmpeg
    if let Some(d) = appimage_dir {
        cands.push(d.join("usr").join("bin").join("ffmpeg"));
    }
    cands.push(app_dir.join("ffmpeg"));
    if let Some(parent) = app_dir.parent() {
        if let Ok(rd) = std::fs::read_dir(parent) {
            let mut names: Vec<PathBuf> =
                rd.flatten().filter(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("ffmpeg")).map(|e| e.path()).collect();
            names.sort();
            cands.extend(names);
        }
    }
    cands.push(vendor_dir.join("ffmpeg"));
    cands
}

/// Первая папка с ffmpeg и ffprobe: сначала кандидаты, потом PATH
fn first_bin(cands: &[PathBuf], path: Option<&std::ffi::OsStr>) -> Option<Bin> {
    cands.iter().find_map(|d| bin_in(d)).or_else(|| path.and_then(|p| std::env::split_paths(p).find_map(|d| bin_in(&d))))
}

/// FFmpeg взят из самого AppImage (для «--engine info» и дымового теста CI)
pub fn bundled_in_appimage(bin: &Bin) -> bool {
    match (paths::appimage(), &bin.dir) {
        (Some(a), Some(d)) => d.starts_with(&a.dir),
        _ => false,
    }
}

pub fn find() -> Bin {
    if let Some(b) = BIN.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
        return b.clone();
    }
    let b = search_binaries(paths::get().ffmpeg_dir.as_deref()).unwrap_or_else(|| Bin {
        ffmpeg: PathBuf::from(format!("ffmpeg{EXE}")),
        ffprobe: PathBuf::from(format!("ffprobe{EXE}")),
        dir: None,
        missing: true,
    });
    *BIN.write().unwrap_or_else(|e| e.into_inner()) = Some(b.clone());
    b
}

// ---------------------------------------------------------------------------
// Запуск процессов
// ---------------------------------------------------------------------------
pub fn command(prog: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(prog);
    #[cfg(windows)]
    {
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    c
}

fn fail_message(prog: &Path, code: Option<i32>, stderr: &str) -> String {
    let name = prog.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let tail: Vec<&str> = stderr.trim().lines().collect();
    let last = tail[tail.len().saturating_sub(3)..].join(" | ");
    tr!("{} завершился с кодом {}: {}", "{} exited with code {}: {}", name, code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()), last)
}

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Сколько ждать процесс (M0.9, R-7): total — всего, stall — без единого байта в stdout/stderr
/// (имеет смысл, только если процесс пишет прогресс: -progress pipe:1). Зависший процесс убивается.
#[derive(Clone, Copy, Default, Debug)]
pub struct Limits {
    pub total: Option<Duration>,
    pub stall: Option<Duration>,
}

/// ffprobe и короткие запуски (кадр, проверка кодировщика)
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// Процесс с -progress молчит дольше — завис
pub const STALL_TIMEOUT: Duration = Duration::from_secs(120);

impl Limits {
    pub fn total(d: Duration) -> Self {
        Limits { total: Some(d), stall: None }
    }
    /// По длительности медиа: 5 мин + 3 × длительность (декодирование 4K на слабом процессоре — около реального времени)
    pub fn for_media(seconds: f64) -> Self {
        let s = if seconds.is_finite() { seconds.clamp(0.0, 48.0 * 3600.0) } else { 0.0 };
        Self::total(Duration::from_secs(300) + Duration::from_secs_f64(s * 3.0))
    }
}

fn prog_name(prog: &Path) -> String {
    prog.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| prog.display().to_string())
}

/// Запуск с захватом вывода. on_chunk — потоковая обработка stdout (тогда stdout в результате пуст).
pub async fn run_with<F: FnMut(&[u8]) + Send>(prog: &Path, args: &[String], on_chunk: Option<F>, timeout: Option<Duration>) -> Res<Output> {
    run_limited(prog, args, on_chunk, Limits { total: timeout, stall: None }).await
}

pub async fn run_limited<F: FnMut(&[u8]) + Send>(prog: &Path, args: &[String], mut on_chunk: Option<F>, limits: Limits) -> Res<Output> {
    let mut child =
        command(prog).args(args).spawn().map_err(|e| tr!("Не удалось запустить {}: {}", "Cannot start {}: {}", prog.display(), e))?;
    let _tracked = crate::procs::track(&child);
    let (Some(mut so), Some(mut se)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill().await;
        return Err(tr!("Не удалось запустить {}: нет вывода", "Cannot start {}: no output pipes", prog.display()));
    };
    let started = std::time::Instant::now();
    // мс от запуска до последнего байта вывода
    let last = std::sync::atomic::AtomicU64::new(0);
    let touch = || last.store(started.elapsed().as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
    let read_out = async {
        let mut all = Vec::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match so.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    touch();
                    match on_chunk.as_mut() {
                        Some(f) => f(&buf[..n]),
                        None => all.extend_from_slice(&buf[..n]),
                    }
                }
            }
        }
        all
    };
    let read_err = async {
        let mut s = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match se.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    touch();
                    s.extend_from_slice(&buf[..n]);
                    if s.len() > 200_000 {
                        s.drain(..s.len() - 100_000);
                    }
                }
            }
        }
        String::from_utf8_lossy(&s).to_string()
    };
    let work = async {
        let (out, err) = tokio::join!(read_out, read_err);
        let st = child.wait().await;
        (out, err, st)
    };
    // Сторож: Some((true, d)) — нет вывода d, Some((false, d)) — общий лимит d
    let watchdog = async {
        if limits.total.is_none() && limits.stall.is_none() {
            return std::future::pending::<(bool, Duration)>().await;
        }
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let el = started.elapsed();
            if let Some(t) = limits.total {
                if el >= t {
                    return (false, t);
                }
            }
            if let Some(s) = limits.stall {
                let idle = el.saturating_sub(Duration::from_millis(last.load(std::sync::atomic::Ordering::Relaxed)));
                if idle >= s {
                    return (true, s);
                }
            }
        }
    };
    let res = tokio::select! {
        r = work => Ok(r),
        w = watchdog => Err(w),
    };
    let (out, err, st) = match res {
        Ok(r) => r,
        Err((stalled, d)) => {
            // Зависший процесс — убить и дождаться (kill_on_drop не ждёт)
            let _ = child.kill().await;
            let name = prog_name(prog);
            return Err(if stalled {
                tr!("{} завис (нет ответа {} с) и был остановлен", "{} hung (no response for {} s) and was stopped", name, d.as_secs())
            } else {
                tr!("{} не уложился в {} с и был остановлен", "{} did not finish in {} s and was stopped", name, d.as_secs())
            });
        }
    };
    let st = st.map_err(|e| e.to_string())?;
    if st.success() {
        Ok(Output { stdout: out, stderr: err })
    } else {
        Err(fail_message(prog, st.code(), &err))
    }
}

/// Запуск с заданными лимитами (у каждого запуска свой лимит — бессрочных запусков нет)
pub async fn run_t(prog: &Path, args: &[String], limits: Limits) -> Res<Output> {
    run_limited::<fn(&[u8])>(prog, args, None, limits).await
}

pub fn sv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

// ---------------------------------------------------------------------------
// Анализ файла
// ---------------------------------------------------------------------------
const BROWSER_VIDEO_CODECS: &[&str] = &["h264", "av1", "hevc", "vp8", "vp9"];
const BROWSER_AUDIO_CODECS: &[&str] =
    &["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"];
const BROWSER_CONTAINERS: &[&str] =
    &[".mp4", ".m4v", ".mov", ".webm", ".mkv", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"];
pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "bmp", "webp", "gif", "tif", "tiff"];

/// Нужен ли прокси, чтобы окно сыграло файл в <video> (ext — без точки). linux — окно WebKitGTK: видео декодирует
/// GStreamer (в AppImage — свой, с gst-libav: H.264, AAC, MP3; VP8/VP9 — libvpx), а HEVC и AV1 есть не везде
/// (нет патентного декодера / dav1d в образе, VA-API GStreamer не кладём) — для них сразу прокси, как и для H.264
/// не 8 бит 4:2:0. Если окно всё же не сыграет файл, media.js переспросит <video> и перейдёт на прокси сам.
fn browser_needs_proxy(ext: &str, vcodec: Option<&str>, acodec: Option<&str>, pix: Option<&str>, linux: bool) -> bool {
    let ext = format!(".{}", ext.to_lowercase());
    if !BROWSER_CONTAINERS.contains(&ext.as_str()) {
        return true;
    }
    if vcodec.is_some_and(|c| !BROWSER_VIDEO_CODECS.contains(&c)) || acodec.is_some_and(|c| !BROWSER_AUDIO_CODECS.contains(&c)) {
        return true;
    }
    if linux && matches!(vcodec, Some("hevc" | "av1")) {
        return true;
    }
    vcodec == Some("h264") && pix.is_some_and(|p| !matches!(p, "yuv420p" | "yuvj420p" | "nv12"))
}

fn parse_rate(r: Option<&str>) -> f64 {
    let r = match r {
        Some(r) if r != "0/0" => r,
        _ => return 0.0,
    };
    let mut it = r.split('/');
    let a: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    match it.next().and_then(|x| x.parse::<f64>().ok()) {
        Some(b) if b != 0.0 => a / b,
        _ => a,
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// Ключ кэша совместим с версией 0.2 (кэш миниатюр и прокси старых установок сохраняется)
pub fn cache_key(file: &Path, meta: &std::fs::Metadata) -> String {
    let abs = paths::absolute(file, &std::env::current_dir().unwrap_or_default());
    let s = format!("{}|{}|{}", abs.to_string_lossy().to_lowercase(), meta.len(), mtime_ms(meta).round() as i64);
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    let d = h.finalize();
    d.iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_string()
}

pub fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub async fn probe(file: &Path) -> Res<Value> {
    let bin = find();
    let out = run_t(
        &bin.ffprobe,
        &[sv(&["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]), vec![file.to_string_lossy().to_string()]]
            .concat(),
        Limits::total(PROBE_TIMEOUT),
    )
    .await?;
    let j: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe: {e}"))?;
    let empty = vec![];
    let streams = j["streams"].as_array().unwrap_or(&empty);
    let v = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 0);
    let a = streams.iter().find(|s| s["codec_type"] == "audio");
    let fmt = &j["format"];
    let num = |x: &Value| -> Option<f64> { x.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| x.as_f64()) };
    let ext = ext_of(file);
    let is_image = IMAGE_EXT.contains(&ext.as_str())
        || v.map(|v| {
            matches!(v["codec_name"].as_str(), Some("png" | "mjpeg" | "bmp" | "webp" | "tiff" | "gif"))
                && fmt["format_name"]
                    .as_str()
                    .map(|f| f.contains("pipe") || f.contains("image2") || f == "gif" || f == "webp_pipe")
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    let mut duration = num(&fmt["duration"])
        .filter(|d| d.is_finite())
        .unwrap_or_else(|| v.and_then(|v| num(&v["duration"])).or_else(|| a.and_then(|a| num(&a["duration"]))).unwrap_or(0.0));
    let meta = std::fs::metadata(file).map_err(|e| e.to_string())?;
    let mut fps = v
        .map(|v| {
            let f = parse_rate(v["avg_frame_rate"].as_str());
            if f > 0.0 {
                f
            } else {
                parse_rate(v["r_frame_rate"].as_str())
            }
        })
        .unwrap_or(0.0);
    if fps > 240.0 {
        let r = v.map(|v| parse_rate(v["r_frame_rate"].as_str())).unwrap_or(0.0);
        fps = if r > 0.0 && r <= 240.0 { r } else { 60.0 };
    }
    let mut width = v.and_then(|v| v["width"].as_i64()).unwrap_or(0);
    let mut height = v.and_then(|v| v["height"].as_i64()).unwrap_or(0);
    // Поворот (запись с телефона): меняем местами ширину и высоту
    if let Some(list) = v.and_then(|v| v["side_data_list"].as_array()) {
        if let Some(rot) = list.iter().find_map(|s| s["rotation"].as_f64()) {
            if (rot.abs() as i64) % 180 == 90 {
                std::mem::swap(&mut width, &mut height);
            }
        }
    }
    let vcodec = v.and_then(|v| v["codec_name"].as_str()).map(str::to_string);
    let acodec = a.and_then(|a| a["codec_name"].as_str()).map(str::to_string);
    let pix = v.and_then(|v| v["pix_fmt"].as_str()).map(str::to_string);
    // Анимация (GIF/WebP) — видео; картинка — один кадр
    let animated = is_image
        && v.map(|v| v["nb_frames"].as_str().and_then(|n| n.parse::<i64>().ok()).unwrap_or(0) > 1 || ext == "gif").unwrap_or(false)
        && duration > 0.05;
    let still = is_image && !animated;
    if still {
        duration = 0.0;
        fps = 0.0;
    }
    let mut needs_proxy = browser_needs_proxy(&ext, vcodec.as_deref(), acodec.as_deref(), pix.as_deref(), cfg!(target_os = "linux"));
    if still {
        needs_proxy = false; // картинка показывается как <img>
    }
    if animated {
        needs_proxy = true; // анимация играет через короткое видео
    }
    let channels = a.and_then(|a| a["channels"].as_i64());
    // Все звуковые потоки (записи NVIDIA/OBS: игра, микрофон… — отдельными дорожками)
    let audio_streams: Vec<Value> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .map(|s| {
            json!({
                "channels": s["channels"].as_i64().unwrap_or(2),
                "codec": s["codec_name"],
                "title": s["tags"]["title"].as_str().or_else(|| s["tags"]["name"].as_str()).or_else(|| s["tags"]["handler_name"].as_str())
                    .filter(|t| !t.is_empty() && !t.contains("SoundHandler") && !t.contains("Sound Media Handler")),
                "language": s["tags"]["language"].as_str().filter(|l| *l != "und"),
            })
        })
        .collect();
    Ok(json!({
        "audioStreams": audio_streams,
        "path": file.to_string_lossy(),
        "name": file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "size": meta.len(),
        "mtime": mtime_ms(&meta),
        "duration": duration,
        "hasVideo": v.is_some(),
        "hasAudio": a.is_some(),
        "isImage": still,
        "isAnimation": animated,
        "width": width, "height": height,
        "fps": (fps * 1000.0).round() / 1000.0,
        "vcodec": vcodec, "acodec": acodec, "pixFmt": pix,
        "vbitrate": v.and_then(|v| num(&v["bit_rate"])),
        "bitrate": num(&fmt["bit_rate"]),
        "sampleRate": a.and_then(|a| num(&a["sample_rate"])),
        "channels": channels,
        "needsProxy": needs_proxy,
        "key": cache_key(file, &meta),
    }))
}

pub fn media_cache_dir(key: &str) -> PathBuf {
    let d = paths::get().media_cache.join(key);
    let _ = std::fs::create_dir_all(&d);
    d
}

// Один и тот же файл кэша делается один раз, даже если его просят несколько раз одновременно
// (R-7) Отравленный Mutex не роняет программу; записи, которые никто не держит, убираются — карта не растёт.
static LOCKS: StdMutex<Option<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = StdMutex::new(None);
fn key_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut g = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if m.len() > 64 {
        m.retain(|_, l| Arc::strong_count(l) > 1);
    }
    m.entry(key.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

/// Кодирует ли фоновая задача на видеокарте (fx_video_args / proxy выбирают h264_nvenc) — для слота очереди
fn gpu_job(enc: &Value) -> bool {
    enc["h264_nvenc"].as_bool().unwrap_or(false)
}

/// Поля сведений о файле, присланные окном
pub struct Info<'a>(pub &'a Value);
impl Info<'_> {
    pub fn path(&self) -> PathBuf {
        PathBuf::from(self.0["path"].as_str().unwrap_or_default())
    }
    pub fn key(&self) -> Res<String> {
        let k = self.0["key"].as_str().unwrap_or_default();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(tr!("Неверный ключ кэша", "Invalid cache key").into());
        }
        Ok(k.to_string())
    }
    pub fn f(&self, k: &str) -> f64 {
        self.0[k].as_f64().unwrap_or(0.0)
    }
    pub fn b(&self, k: &str) -> bool {
        self.0[k].as_bool().unwrap_or(false)
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}
pub fn n3(x: f64) -> String {
    format!("{x:.3}")
}

// ---------------------------------------------------------------------------
// Миниатюры для таймлайна
// ---------------------------------------------------------------------------
const THUMB_HEIGHT: i64 = 90;
const MAX_THUMBS: f64 = 240.0;

pub async fn thumbs(info: &Value) -> Res<Value> {
    let i = Info(info);
    let key = i.key()?;
    let lock = key_lock(&format!("thumbs:{key}"));
    let _g = lock.lock().await;
    let dir = media_cache_dir(&key).join("thumbs");
    let meta = dir.join("thumbs.json");
    if let Ok(t) = std::fs::read_to_string(&meta) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            return Ok(v);
        }
    }
    if !i.b("hasVideo") {
        return Ok(Value::Null);
    }
    let _slot = crate::queue::slot(false).await;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bin = find();
    let still = i.b("isImage");
    let lim = Limits::for_media(i.f("duration"));
    let interval = if still { 1.0 } else { (i.f("duration") / MAX_THUMBS).max(1.0) };
    let common = sv(&["-hide_banner", "-loglevel", "error", "-y"]);
    let vf = if still { format!("scale=-2:{THUMB_HEIGHT}") } else { format!("fps=1/{interval:.4}:round=near,scale=-2:{THUMB_HEIGHT}") };
    let mut out_args = sv(&["-an", "-sn", "-vf", &vf]);
    if still {
        out_args.extend(sv(&["-frames:v", "1"]));
    }
    out_args.extend(sv(&["-q:v", "6"]));
    out_args.push(s(&dir.join("%04d.jpg")));
    let input = vec!["-i".to_string(), s(&i.path())];
    let fast = [common.clone(), sv(&["-skip_frame", "nokey"]), input.clone(), out_args.clone()].concat();
    if still || run_t(&bin.ffmpeg, &fast, lim).await.is_err() {
        run_t(&bin.ffmpeg, &[common, input, out_args].concat(), lim).await?;
    }
    // B-9: в thumbs.json — только имена файлов (папку кэша можно перенести); пути строит commands::media_thumbs
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".jpg"))
        .collect();
    files.sort();
    let result = json!({ "interval": interval, "height": THUMB_HEIGHT, "files": files });
    let _ = std::fs::write(&meta, result.to_string());
    Ok(result)
}

// ---------------------------------------------------------------------------
// Волна звука: пики (0..1), PEAKS_PER_SEC значений в секунду; для стерео — ещё и по каналам
// ---------------------------------------------------------------------------
const PEAKS_PER_SEC: usize = 50;
const PEAK_SR: usize = 4000;

fn finish_peaks(raw: &[f32]) -> Vec<f64> {
    let max = raw.iter().cloned().fold(0f32, f32::max);
    let max = if max > 0.0 { max } else { 1.0 };
    raw.iter().map(|x| ((x / max).min(1.0).sqrt() as f64 * 100.0).round() / 100.0).collect()
}

fn stream_channels(i: &Info, stream: usize) -> f64 {
    i.0["audioStreams"].as_array().and_then(|a| a.get(stream)).and_then(|s| s["channels"].as_f64()).unwrap_or_else(|| i.f("channels"))
}

pub async fn peaks(info: &Value, stream: usize) -> Res<Value> {
    let i = Info(info);
    let key = i.key()?;
    let lock = key_lock(&format!("peaks:{key}:{stream}"));
    let _g = lock.lock().await;
    let file = media_cache_dir(&key).join(if stream == 0 { "peaks2.json".to_string() } else { format!("peaks2-a{stream}.json") });
    if let Ok(t) = std::fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            return Ok(v);
        }
    }
    if !i.b("hasAudio") {
        return Ok(Value::Null);
    }
    let _slot = crate::queue::slot(false).await;
    let stereo = stream_channels(&i, stream) >= 2.0;
    let ch = if stereo { 2 } else { 1 };
    let bin = find();
    let per = PEAK_SR / PEAKS_PER_SEC;
    // Каналы: [моно-сумма], [левый, правый]
    let mut acc: Vec<Vec<f32>> = vec![vec![]; ch + 1];
    let mut cur = vec![0f32; ch + 1];
    let mut n = 0usize;
    let mut rest: Vec<u8> = vec![];
    let frame = 4 * ch;
    let args = [
        sv(&["-hide_banner", "-loglevel", "error", "-i"]),
        vec![s(&i.path())],
        sv(&["-map", &format!("0:a:{stream}"), "-vn", "-sn", "-ac", &ch.to_string(), "-ar", &PEAK_SR.to_string(), "-f", "f32le", "pipe:1"]),
    ]
    .concat();
    run_limited(
        &bin.ffmpeg,
        &args,
        Some(|chunk: &[u8]| {
            rest.extend_from_slice(chunk);
            let usable = rest.len() - rest.len() % frame;
            let mut k = 0;
            while k < usable {
                let mut mono = 0f32;
                for c in 0..ch {
                    let o = k + c * 4;
                    let v = f32::from_le_bytes([rest[o], rest[o + 1], rest[o + 2], rest[o + 3]]).abs();
                    if v > cur[c + 1] {
                        cur[c + 1] = v;
                    }
                    if v > mono {
                        mono = v;
                    }
                }
                if mono > cur[0] {
                    cur[0] = mono;
                }
                n += 1;
                if n >= per {
                    for c in 0..=ch {
                        acc[c].push(cur[c]);
                        cur[c] = 0.0;
                    }
                    n = 0;
                }
                k += frame;
            }
            rest.drain(..usable);
        }),
        Limits::for_media(i.f("duration")),
    )
    .await?;
    if n > 0 {
        for c in 0..=ch {
            acc[c].push(cur[c]);
        }
    }
    let mut result = json!({ "rate": PEAKS_PER_SEC, "data": finish_peaks(&acc[0]) });
    if stereo {
        result["channels"] = json!([finish_peaks(&acc[1]), finish_peaks(&acc[2])]);
    }
    let _ = std::fs::write(&file, result.to_string());
    Ok(result)
}

// ---------------------------------------------------------------------------
// Прокси для форматов, которые не воспроизводятся в окне (AVI, WMV, GIF и т.п.)
// ---------------------------------------------------------------------------
fn progress_parser<'a>(duration: f64, on_progress: &'a (dyn Fn(f64) + Send + Sync)) -> impl FnMut(&[u8]) + Send + 'a {
    let mut buf = String::new();
    move |d: &[u8]| {
        buf.push_str(&String::from_utf8_lossy(d));
        while let Some(i) = buf.find('\n') {
            let line: String = buf.drain(..=i).collect();
            if let Some(v) = line.trim().strip_prefix("out_time_us=") {
                if let Ok(us) = v.parse::<f64>() {
                    if duration > 0.0 {
                        on_progress((us / 1e6 / duration).clamp(0.0, 1.0));
                    }
                }
            }
        }
    }
}

/// Видео можно переложить в MP4 без перекодирования (0.4.1, H3): кодек окно декодирует, мешает только контейнер
/// (MKV, TS/M2TS, AVI, FLV…). Окно само сообщает, что декодирует кодек (info.remux из media.js).
fn remux_ok(info: &Value) -> bool {
    let i = Info(info);
    if !info["remux"].as_bool().unwrap_or(false) || !i.b("hasVideo") || i.b("isAnimation") {
        return false;
    }
    // Уже MP4/MOV/WebM: не играет декодер, а не контейнер — нужен настоящий прокси
    if matches!(ext_of(Path::new(info["path"].as_str().unwrap_or(""))).as_str(), "mp4" | "m4v" | "mov" | "webm") {
        return false;
    }
    let pix = info["pixFmt"].as_str().unwrap_or("");
    match info["vcodec"].as_str().unwrap_or("") {
        "h264" => matches!(pix, "yuv420p" | "yuvj420p" | "nv12"),
        "hevc" | "av1" | "vp9" => true,
        _ => false,
    }
}

/// Аргументы ремукса: видео копируется, звук — копия (AAC/MP3 стерео) или AAC
fn remux_args(info: &Value) -> Vec<String> {
    let i = Info(info);
    let mut a = sv(&["-map", "0:v:0", "-c:v", "copy"]);
    if info["vcodec"].as_str() == Some("hevc") {
        a.extend(sv(&["-tag:v", "hvc1"]));
    }
    if i.b("hasAudio") {
        a.extend(sv(&["-map", "0:a:0"]));
        let copy = matches!(info["acodec"].as_str(), Some("aac" | "mp3")) && i.f("channels") <= 2.0;
        if copy {
            a.extend(sv(&["-c:a", "copy"]));
        } else {
            a.extend(sv(&["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]));
            if i.f("channels") > 2.0 {
                a.extend(sv(&["-ac", "2"]));
            }
        }
    }
    a
}

pub async fn proxy(info: &Value, on_progress: &(dyn Fn(f64) + Send + Sync), enc: &Value) -> Res<PathBuf> {
    let i = Info(info);
    let key = i.key()?;
    let lock = key_lock(&format!("proxy:{key}"));
    let _g = lock.lock().await;
    let has_video = i.b("hasVideo");
    let remux = remux_ok(info);
    let file = media_cache_dir(&key).join(if remux {
        "proxy.remux.mp4"
    } else if has_video {
        "proxy.mp4"
    } else {
        "proxy.m4a"
    });
    if file.exists() {
        return Ok(file);
    }
    if remux {
        // Без перекодирования — секунды, качество исходника; процессорный слот не нужен
        let tmp = PathBuf::from(format!("{}.part.mp4", file.display()));
        let _part = crate::procs::part(&tmp);
        let bin = find();
        let mut args = sv(&["-hide_banner", "-loglevel", "error", "-y", "-i"]);
        args.push(s(&i.path()));
        args.extend(sv(&["-sn", "-dn"]));
        args.extend(remux_args(info));
        args.extend(sv(&["-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats"]));
        args.push(s(&tmp));
        let lim = Limits { stall: Some(STALL_TIMEOUT), ..Limits::for_media(i.f("duration")) };
        match run_limited(&bin.ffmpeg, &args, Some(progress_parser(i.f("duration"), on_progress)), lim).await {
            Ok(_) => {
                std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
                return Ok(file);
            }
            // Поток не ложится в MP4 (редкие профили) — обычный прокси
            Err(e) => eprintln!("remux failed, transcoding: {e}"), // i18n-ignore
        }
        let mut plain = info.clone();
        plain["remux"] = json!(false);
        drop(_g);
        return Box::pin(proxy(&plain, on_progress, enc)).await;
    }
    let _slot = crate::queue::slot(has_video && gpu_job(enc)).await;
    let tmp = PathBuf::from(format!("{}.part.mp4", file.display()));
    let _part = crate::procs::part(&tmp);
    let bin = find();
    let mut args = sv(&["-hide_banner", "-loglevel", "error", "-y"]);
    if i.b("isAnimation") {
        args.extend(sv(&["-ignore_loop", "1"]));
    }
    args.extend(["-i".to_string(), s(&i.path()), "-sn".into()]);
    if has_video {
        args.extend(sv(&["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,scale=-2:'min(720,ih)':flags=bicubic,format=yuv420p"]));
        if enc["h264_nvenc"].as_bool().unwrap_or(false) {
            args.extend(sv(&["-c:v", "h264_nvenc", "-preset", "p2", "-rc", "vbr", "-cq", "27", "-b:v", "0"]));
        } else {
            args.extend(sv(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]));
        }
        args.extend(sv(&["-g", "30"]));
    } else {
        args.push("-vn".into());
    }
    if i.b("hasAudio") {
        args.extend(sv(&["-c:a", "aac", "-b:a", "160k", "-ar", "48000"]));
        if i.f("channels") > 2.0 {
            args.extend(sv(&["-ac", "2"]));
        }
    }
    args.extend(sv(&["-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats"]));
    args.push(s(&tmp));
    // -progress пишет каждые ~0,5 с: молчит 2 мин — завис
    let lim = Limits { stall: Some(STALL_TIMEOUT), ..Limits::for_media(i.f("duration") * 2.0) };
    run_limited(&bin.ffmpeg, &args, Some(progress_parser(i.f("duration"), on_progress)), lim).await?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Звуковой поток N (N ≥ 1) отдельным файлом для предпросмотра: окно играет только первый поток файла.
/// channel (0.5.1) — один канал потока моно-файлом (клип «разложен по каналам»; прокси сведён в стерео)
pub async fn audio_stream(info: &Value, stream: usize, channel: Option<usize>) -> Res<PathBuf> {
    let i = Info(info);
    let key = i.key()?;
    let channel = channel.filter(|c| (*c as f64) < stream_channels(&i, stream) && *c < 64);
    let tag = channel.map(|c| format!("-c{c}")).unwrap_or_default();
    let lock = key_lock(&format!("astream:{key}:{stream}{tag}"));
    let _g = lock.lock().await;
    let file = media_cache_dir(&key).join(format!("audio-a{stream}{tag}.m4a"));
    if file.exists() {
        return Ok(file);
    }
    let _slot = crate::queue::slot(false).await;
    let tmp = PathBuf::from(format!("{}.part.m4a", file.display()));
    let _part = crate::procs::part(&tmp);
    let bin = find();
    let mut args = sv(&["-hide_banner", "-loglevel", "error", "-y", "-i"]);
    args.push(s(&i.path()));
    args.extend(sv(&["-map", &format!("0:a:{stream}"), "-vn", "-sn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]));
    if let Some(c) = channel {
        args.extend(["-af".to_string(), format!("pan=mono|c0=c{c}"), "-ac".into(), "1".into()]);
    } else if stream_channels(&i, stream) > 2.0 {
        args.extend(sv(&["-ac", "2"]));
    }
    args.extend(sv(&["-movflags", "+faststart", "-f", "mp4"]));
    args.push(s(&tmp));
    run_t(&bin.ffmpeg, &args, Limits::for_media(i.f("duration"))).await?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(file)
}

// ---------------------------------------------------------------------------
// Реверс фрагмента и стоп-кадр: делаются один раз в кэш (H.264, играет в окне)
// ---------------------------------------------------------------------------
fn fx_video_args(enc: &Value, fps: f64) -> Vec<String> {
    let gop = (fps.round() as i64).max(1).to_string();
    if enc["h264_nvenc"].as_bool().unwrap_or(false) {
        sv(&["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "constqp", "-qp", "16", "-profile:v", "high", "-g", &gop, "-pix_fmt", "yuv420p"])
    } else {
        sv(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-profile:v", "high", "-g", &gop, "-pix_fmt", "yuv420p"])
    }
}

struct WorkDir(PathBuf);
impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Фрагмент для реверса (R-7): a < b, оба конечные, в пределах файла; иначе понятная ошибка (раньше b<a давал
/// отрицательную длительность). Короче MIN_REVERSE — тоже ошибка: такой клип окно не создаёт.
const MIN_REVERSE: f64 = 0.04;
fn reverse_range(a: f64, b: f64, dur_all: f64) -> Res<(f64, f64)> {
    if !a.is_finite() || !b.is_finite() {
        return Err(tr!("Неверный фрагмент для реверса", "Invalid fragment to reverse").into());
    }
    let a = a.max(0.0);
    let b = if dur_all > 0.0 { b.min(dur_all) } else { b };
    if b - a < MIN_REVERSE {
        return Err(tr!(
            "Неверный фрагмент для реверса: {} – {} с (конец должен быть позже начала)",
            "Invalid fragment to reverse: {} – {} s (the end must be after the start)",
            n3(a),
            n3(b)
        ));
    }
    Ok((a, b))
}

pub async fn reverse(info: &Value, a: f64, b: f64, on_progress: &(dyn Fn(f64) + Send + Sync), enc: &Value) -> Res<PathBuf> {
    let i = Info(info);
    let key = i.key()?;
    let (a, b) = reverse_range(a, b, i.f("duration"))?;
    let lock = key_lock(&format!("reverse:{key}:{}:{}", n3(a), n3(b)));
    let _g = lock.lock().await;
    let dir = media_cache_dir(&key).join("fx");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = format!("reverse_{}_{}", n3(a), n3(b)).replace('.', "_");
    let has_video = i.b("hasVideo");
    let file = dir.join(format!("{base}{}", if has_video { ".mp4" } else { ".flac" }));
    if file.exists() {
        return Ok(file);
    }
    let _slot = crate::queue::slot(has_video && gpu_job(enc)).await;
    let bin = find();
    let dur = b - a;
    let lim = Limits::for_media(dur);
    let common = sv(&["-hide_banner", "-loglevel", "error", "-y", "-nostdin"]);
    let work = WorkDir(dir.join(format!("{base}_work")));
    let _ = std::fs::remove_dir_all(&work.0);
    std::fs::create_dir_all(&work.0).map_err(|e| e.to_string())?;
    let src = s(&i.path());
    if !has_video {
        let out = work.0.join("out.flac");
        run_t(
            &bin.ffmpeg,
            &[
                common.clone(),
                sv(&["-ss", &n3(a), "-t", &n3(dur), "-i", &src, "-vn", "-sn", "-af", "areverse", "-c:a", "flac"]),
                vec![s(&out)],
            ]
            .concat(),
            lim,
        )
        .await?;
        on_progress(1.0);
        std::fs::rename(&out, &file).map_err(|e| e.to_string())?;
        return Ok(file);
    }
    // Длина куска: чтобы в памяти было не больше ~1,2 ГБ кадров
    let w = if i.f("width") > 0.0 { i.f("width") } else { 1920.0 };
    let h = if i.f("height") > 0.0 { i.f("height") } else { 1080.0 };
    let fps = if i.f("fps") > 0.0 { i.f("fps") } else { 30.0 };
    let chunk = (1.2e9 / (w * h * 3.0 * fps).max(1.0)).clamp(0.5, 20.0);
    let n = ((dur / chunk - 1e-6).ceil() as i64).max(1);
    let has_audio = i.b("hasAudio");
    let steps = (n + if has_audio { 2 } else { 1 }) as f64;
    let mut parts = vec![];
    for k in 0..n {
        let idx = n - 1 - k;
        let ss = a + idx as f64 * chunk;
        let d = chunk.min(b - ss);
        let out = work.0.join(format!("part_{k:04}.mp4"));
        run_t(
            &bin.ffmpeg,
            &[
                common.clone(),
                sv(&["-ss", &n3(ss), "-t", &n3(d), "-i", &src, "-an", "-sn", "-dn", "-vf", "reverse"]),
                fx_video_args(enc, fps),
                vec![s(&out)],
            ]
            .concat(),
            Limits::for_media(d),
        )
        .await?;
        parts.push(out);
        on_progress((k + 1) as f64 / steps);
    }
    let list = work.0.join("list.txt");
    let text: Vec<String> = parts.iter().map(|p| format!("file '{}'", s(p).replace('\\', "/").replace('\'', "'\\''"))).collect();
    std::fs::write(&list, text.join("\n")).map_err(|e| e.to_string())?;
    let mut args = [common.clone(), sv(&["-f", "concat", "-safe", "0", "-i"]), vec![s(&list)]].concat();
    if has_audio {
        let wav = work.0.join("audio.wav");
        run_t(
            &bin.ffmpeg,
            &[
                common.clone(),
                sv(&["-ss", &n3(a), "-t", &n3(dur), "-i", &src, "-vn", "-sn", "-af", "areverse", "-c:a", "pcm_s16le"]),
                vec![s(&wav)],
            ]
            .concat(),
            lim,
        )
        .await?;
        on_progress((n + 1) as f64 / steps);
        args.extend([vec!["-i".to_string(), s(&wav)], sv(&["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "256k"])].concat());
    }
    let tmp = work.0.join("out.mp4");
    args.extend(sv(&["-c:v", "copy", "-t", &n3(dur), "-movflags", "+faststart"]));
    args.push(s(&tmp));
    run_t(&bin.ffmpeg, &args, lim).await?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    on_progress(1.0);
    Ok(file)
}

pub const FREEZE_FILE_SEC: i64 = 20;

pub async fn freeze(info: &Value, at: f64, enc: &Value) -> Res<PathBuf> {
    let i = Info(info);
    let key = i.key()?;
    let dur = i.f("duration");
    let at = at.max(0.0).min(if dur > 0.0 { dur } else { at });
    let lock = key_lock(&format!("freeze:{key}:{}", n3(at)));
    let _g = lock.lock().await;
    let dir = media_cache_dir(&key).join("fx");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = format!("freeze{FREEZE_FILE_SEC}_{}", n3(at)).replace('.', "_");
    let file = dir.join(format!("{base}.mp4"));
    if file.exists() {
        return Ok(file);
    }
    let _slot = crate::queue::slot(gpu_job(enc)).await;
    let bin = find();
    let png = dir.join(format!("{base}.png"));
    let common = sv(&["-hide_banner", "-loglevel", "error", "-y", "-nostdin"]);
    let src = s(&i.path());
    // У самого конца файла кадра может не оказаться — отступаем назад
    for t in [at, at - 0.05, at - 0.25, at - 1.0] {
        if t < 0.0 {
            continue;
        }
        let _ = run_t(
            &bin.ffmpeg,
            &[common.clone(), sv(&["-ss", &n3(t), "-i", &src, "-frames:v", "1", "-an", "-sn"]), vec![s(&png)]].concat(),
            Limits::total(PROBE_TIMEOUT),
        )
        .await;
        if std::fs::metadata(&png).map(|m| m.len() > 0).unwrap_or(false) {
            break;
        }
    }
    if !png.exists() {
        return Err(tr!("Не удалось взять кадр из файла", "Cannot grab a frame from the file").into());
    }
    let tmp = dir.join(format!("{base}.part.mp4"));
    let _part = crate::procs::part(&tmp);
    run_t(
        &bin.ffmpeg,
        &[
            common,
            sv(&["-loop", "1", "-framerate", "10", "-i"]),
            vec![s(&png)],
            sv(&["-t", &FREEZE_FILE_SEC.to_string(), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"]),
            fx_video_args(enc, 10.0),
            sv(&["-movflags", "+faststart"]),
            vec![s(&tmp)],
        ]
        .concat(),
        Limits::for_media(FREEZE_FILE_SEC as f64),
    )
    .await?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&png);
    Ok(file)
}

/// Один кадр в JPEG (для ИИ-ассистента: «посмотреть» на видео)
pub async fn frame_jpeg(file: &Path, t: f64, width: f64) -> Res<Vec<u8>> {
    let bin = find();
    let w = ((width / 2.0).round() * 2.0).clamp(64.0, 1920.0) as i64;
    for tt in [t, t - 0.1, t - 0.5] {
        if tt < 0.0 {
            continue;
        }
        let out = run_t(
            &bin.ffmpeg,
            &[
                sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", &n3(tt), "-i"]),
                vec![s(file)],
                sv(&[
                    "-frames:v",
                    "1",
                    "-an",
                    "-sn",
                    "-vf",
                    &format!("scale={w}:-2"),
                    "-q:v",
                    "4",
                    "-f",
                    "image2pipe",
                    "-c:v",
                    "mjpeg",
                    "pipe:1",
                ]),
            ]
            .concat(),
            Limits::total(PROBE_TIMEOUT),
        )
        .await;
        if let Ok(o) = out {
            if !o.stdout.is_empty() {
                return Ok(o.stdout);
            }
        }
    }
    Err(tr!("Не удалось получить кадр", "Cannot get the frame").into())
}

/// Поиск тишины: [{ start, end }] в секундах файла
pub async fn silence(file: &Path, threshold_db: f64, min_dur: f64) -> Res<Value> {
    let bin = find();
    let _slot = crate::queue::slot(false).await;
    // без -nostats FFmpeg пишет строку статистики ~2 раза в секунду: молчит дольше STALL_TIMEOUT — завис
    let out = run_limited::<fn(&[u8])>(
        &bin.ffmpeg,
        &[
            sv(&["-hide_banner", "-nostdin", "-i"]),
            vec![s(file)],
            sv(&["-vn", "-sn", "-af", &format!("silencedetect=noise={threshold_db}dB:d={min_dur}"), "-f", "null", "-"]),
        ]
        .concat(),
        None,
        Limits { total: Some(Duration::from_secs(4 * 3600)), stall: Some(STALL_TIMEOUT) },
    )
    .await?;
    let mut list = vec![];
    let mut cur: Option<f64> = None;
    for line in out.stderr.lines() {
        if let Some(p) = line.find("silence_start:") {
            let v = line[p + 14..].split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0);
            cur = Some(v.max(0.0));
            continue;
        }
        if let Some(p) = line.find("silence_end:") {
            let v = line[p + 12..].split_whitespace().next().and_then(|x| x.parse::<f64>().ok());
            if let (Some(st), Some(en)) = (cur, v) {
                list.push(json!({ "start": st, "end": en }));
                cur = None;
            }
        }
    }
    if let Some(st) = cur {
        list.push(json!({ "start": st, "end": Value::Null })); // тишина до конца файла
    }
    Ok(Value::Array(list))
}

// ---------------------------------------------------------------------------
// Какие кодировщики реально работают (NVENC может быть в сборке, но без драйвера)
// ---------------------------------------------------------------------------
// M0.4 (R-1): результат кэшируется в памяти и на диске (<app_cache>/encoders.json, ключ — путь, размер и время
// изменения ffmpeg); другой ffmpeg или его обновление — проверка заново. Сброс — reset_encoders (кнопка в окне экспорта).
// Проверка идёт один раз, даже если её попросили несколько задач одновременно (DETECT).
static ENC_CACHE: StdMutex<Option<HashMap<PathBuf, Value>>> = StdMutex::new(None);
static DETECT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Версия формата encoders.json: меняется вместе со списком encoders_list — старый кэш тогда не используется
const ENC_FILE_VERSION: u64 = 2;
/// Устройство VAAPI (как VAAPI_DEVICE в exportPlan.js)
pub const VAAPI_DEVICE: &str = "/dev/dri/renderD128";

/// Кодировщики для проверки на этой ОС: программные, NVIDIA, Intel Quick Sync, AMD AMF, VAAPI (только Linux)
pub fn encoders_list() -> Vec<&'static str> {
    let mut v = vec!["libx264", "libx265", "libsvtav1"];
    if !cfg!(target_os = "macos") {
        v.extend(["av1_nvenc", "hevc_nvenc", "h264_nvenc", "h264_qsv", "hevc_qsv", "av1_qsv", "h264_amf", "hevc_amf", "av1_amf"]);
    }
    if cfg!(target_os = "linux") {
        v.extend(["h264_vaapi", "hevc_vaapi"]);
    }
    v
}

pub fn is_gpu_encoder(enc: &str) -> bool {
    ["_nvenc", "_qsv", "_amf", "_vaapi"].iter().any(|s| enc.ends_with(s))
}

/// Пробное кодирование 0,2 с — с теми же параметрами качества, что у exportPlan.js encoderArgs
/// (кодировщик может запускаться, но не уметь нужный режим, например ICQ у старых Intel)
fn probe_encoder_args(enc: &str) -> Vec<String> {
    let mut a = sv(&["-hide_banner", "-loglevel", "error"]);
    let hw_new = enc.ends_with("_qsv") || enc.ends_with("_amf") || enc.ends_with("_vaapi");
    if enc.ends_with("_vaapi") {
        a.extend(sv(&["-vaapi_device", VAAPI_DEVICE]));
    }
    let size = if hw_new { "640x360" } else { "320x240" };
    a.extend(sv(&["-f", "lavfi", "-i", &format!("color=c=black:s={size}:r=30:d=0.2")]));
    if enc.ends_with("_vaapi") {
        a.extend(sv(&["-vf", "format=nv12,hwupload"]));
    }
    a.extend(sv(&["-c:v", enc]));
    let h264 = enc.starts_with("h264_");
    if enc.ends_with("_qsv") {
        a.extend(sv(&["-preset", "slow", "-global_quality", "25"]));
    } else if enc.ends_with("_amf") {
        a.extend(sv(&["-usage", "transcoding", "-quality", "quality", "-rc", "cqp", "-qp_i", "25", "-qp_p", "27"]));
        if h264 {
            a.extend(sv(&["-qp_b", "29"]));
        }
    } else if enc.ends_with("_vaapi") {
        a.extend(sv(&["-rc_mode", "CQP", "-qp", "24"]));
    }
    if h264 && hw_new {
        a.extend(sv(&["-profile:v", "high"]));
    }
    a.extend(sv(&["-f", "null", "-"]));
    a
}

/// Ключ кэша на диске: путь, размер и время изменения ffmpeg
fn enc_file_key(bin: &Bin) -> Option<Value> {
    if bin.missing || !bin.ffmpeg.is_absolute() {
        return None;
    }
    let meta = std::fs::metadata(&bin.ffmpeg).ok()?;
    let path = s(&bin.ffmpeg);
    Some(
        json!({ "ffmpeg": if cfg!(windows) { path.to_lowercase() } else { path }, "size": meta.len(), "mtime": mtime_ms(&meta).round() as i64 }),
    )
}

fn enc_file() -> PathBuf {
    paths::get().app_cache.join("encoders.json")
}

fn enc_disk_read(key: &Value) -> Option<Value> {
    let j: Value = serde_json::from_str(&std::fs::read_to_string(enc_file()).ok()?).ok()?;
    if j["version"].as_u64() != Some(ENC_FILE_VERSION) {
        return None;
    }
    j["entries"]
        .as_array()?
        .iter()
        .find(|e| e["ffmpeg"] == key["ffmpeg"] && e["size"] == key["size"] && e["mtime"] == key["mtime"])
        .map(|e| e["encoders"].clone())
        .filter(|v| v.is_object() && encoders_list().iter().all(|k| v.get(*k).is_some_and(Value::is_boolean)))
}

fn enc_disk_write(key: &Value, encoders: &Value) {
    let file = enc_file();
    let mut entries: Vec<Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|j| j["version"].as_u64() == Some(ENC_FILE_VERSION))
        .and_then(|j| j["entries"].as_array().cloned())
        .unwrap_or_default();
    // запись для этого ffmpeg (и его прежних версий) заменяется; держим не больше 4 разных ffmpeg
    entries.retain(|e| e["ffmpeg"] != key["ffmpeg"]);
    let mut e = key.clone();
    e["encoders"] = encoders.clone();
    entries.insert(0, e);
    entries.truncate(4);
    let data = json!({ "version": ENC_FILE_VERSION, "os": std::env::consts::OS, "entries": entries });
    if let Some(d) = file.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = file.with_extension(format!("json.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string_pretty(&data).unwrap_or_default()).is_ok() && std::fs::rename(&tmp, &file).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// FFM_NO_GPU=1 — вести себя как компьютер без видеокарты (проверка и CI): все аппаратные кодировщики — false
fn apply_no_gpu(mut v: Value) -> Value {
    if std::env::var("FFM_NO_GPU").map(|x| x == "1").unwrap_or(false) {
        if let Some(m) = v.as_object_mut() {
            for (k, x) in m.iter_mut() {
                if is_gpu_encoder(k) {
                    *x = json!(false);
                }
            }
        }
    }
    v
}

fn enc_mem(bin: &Bin) -> Option<Value> {
    ENC_CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(&bin.ffmpeg).cloned())
}

pub async fn detect_encoders(bin: &Bin) -> Value {
    if let Some(v) = enc_mem(bin) {
        return apply_no_gpu(v);
    }
    let _one = DETECT.lock().await;
    if let Some(v) = enc_mem(bin) {
        return apply_no_gpu(v);
    }
    let key = enc_file_key(bin);
    let disk = match &key {
        Some(k) => {
            let k = k.clone();
            tokio::task::spawn_blocking(move || enc_disk_read(&k)).await.ok().flatten()
        }
        None => None,
    };
    let v = match disk {
        Some(v) => v,
        None => {
            let futs = encoders_list().into_iter().map(|enc: &'static str| {
                let ff = bin.ffmpeg.clone();
                async move {
                    let ok = run_with::<fn(&[u8])>(&ff, &probe_encoder_args(enc), None, Some(Duration::from_secs(15))).await.is_ok();
                    (enc.to_string(), ok)
                }
            });
            let res = futures_join_all(futs).await;
            let mut m = serde_json::Map::new();
            for (k, ok) in res {
                m.insert(k, json!(ok));
            }
            let v = Value::Object(m);
            // На диск — только полный результат (проверка не сорвалась целиком: ffmpeg запустился хотя бы раз)
            if let Some(k) = &key {
                if v.as_object().is_some_and(|m| m.len() == encoders_list().len() && m.values().any(|x| x == true)) {
                    let (k, v2) = (k.clone(), v.clone());
                    let _ = tokio::task::spawn_blocking(move || enc_disk_write(&k, &v2)).await;
                }
            }
            v
        }
    };
    ENC_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(bin.ffmpeg.clone(), v.clone());
    apply_no_gpu(v)
}

/// Забыть результат проверки (в памяти и на диске) — следующий detect_encoders проверит заново
pub fn reset_encoders() {
    *ENC_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let _ = std::fs::remove_file(enc_file());
}

/// Окно: «Проверить кодировщики заново» (после смены видеокарты или драйвера)
#[tauri::command]
pub async fn enc_reset() -> Value {
    let _ = tauri::async_runtime::spawn_blocking(reset_encoders).await;
    detect_encoders(&find()).await
}

async fn futures_join_all<F>(futs: impl IntoIterator<Item = F>) -> Vec<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let handles: Vec<_> = futs.into_iter().map(tokio::spawn).collect();
    let mut out = vec![];
    for h in handles {
        if let Ok(v) = h.await {
            out.push(v);
        }
    }
    out
}

/// Версия FFmpeg: (первая строка, major). major нужен для совместимости со старыми сборками.
static VER_CACHE: StdMutex<Option<HashMap<PathBuf, Option<(String, u32)>>>> = StdMutex::new(None);

pub async fn version_info(bin: &Bin) -> Option<(String, u32)> {
    if let Some(v) = VER_CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(&bin.ffmpeg).cloned()) {
        return v;
    }
    let r =
        run_with::<fn(&[u8])>(&bin.ffmpeg, &sv(&["-hide_banner", "-version"]), None, Some(Duration::from_secs(15))).await.ok().map(|o| {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let line = text.lines().next().unwrap_or("").trim().to_string();
            let mut major = 99; // сборки из master («N-12345-g…») считаем самыми новыми
            let low = line.to_lowercase();
            if let Some(p) = low.find("version ") {
                let rest = low[p + 8..].trim_start_matches('n');
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if rest[digits.len()..].starts_with('.') {
                    if let Ok(m) = digits.parse() {
                        major = m;
                    }
                }
            }
            (line, major)
        });
    VER_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(bin.ffmpeg.clone(), r.clone());
    r
}

/// Для окна настроек: проверить конкретную папку (или автопоиск, если пусто)
pub async fn check_dir(dir: &str) -> Value {
    let bin = if dir.is_empty() { search_binaries(None) } else { bin_in(Path::new(dir)) };
    let Some(bin) = bin else {
        return json!({ "ok": false, "error": if dir.is_empty() { tr!("FFmpeg не найден", "FFmpeg not found") } else { tr!("В этой папке нет ffmpeg и ffprobe", "This folder has no ffmpeg and ffprobe") } });
    };
    match version_info(&bin).await {
        None => {
            json!({ "ok": false, "error": tr!("ffmpeg найден, но не запускается", "ffmpeg was found but does not start"), "path": s(&bin.ffmpeg) })
        }
        Some((line, major)) => {
            json!({ "ok": true, "path": s(&bin.ffmpeg), "dir": bin.dir.as_deref().map(s), "version": line, "major": major })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Долгий процесс без вывода: Windows — ping в nul, Unix — sleep
    fn silent_sleeper() -> (PathBuf, Vec<String>) {
        if cfg!(windows) {
            (PathBuf::from("cmd"), sv(&["/c", "ping -n 30 127.0.0.1 >nul"]))
        } else {
            (PathBuf::from("sleep"), sv(&["30"]))
        }
    }

    #[tokio::test]
    async fn hung_process_is_killed() {
        let (p, a) = silent_sleeper();
        let t0 = std::time::Instant::now();
        let e = run_t(&p, &a, Limits::total(Duration::from_millis(800))).await.err().unwrap();
        assert!(t0.elapsed() < Duration::from_secs(10), "{e}");
        assert!(e.contains("800") || e.contains("0 "), "{e}");
        let e = run_t(&p, &a, Limits { total: None, stall: Some(Duration::from_secs(1)) }).await.err().unwrap();
        assert!(t0.elapsed() < Duration::from_secs(15), "{e}");
        // нормальный процесс укладывается
        let ok = if cfg!(windows) {
            run_t(Path::new("cmd"), &sv(&["/c", "echo ok"]), Limits::total(PROBE_TIMEOUT)).await
        } else {
            run_t(Path::new("echo"), &sv(&["ok"]), Limits::total(PROBE_TIMEOUT)).await
        };
        assert!(String::from_utf8_lossy(&ok.unwrap().stdout).contains("ok"));
    }

    #[test]
    fn ffmpeg_from_appimage_first() {
        // Образ AppImage (usr/bin/ffmpeg/bin) и подставной ffmpeg в PATH: берётся из образа
        let base = paths::test_dir("ffsearch");
        let _ = std::fs::remove_dir_all(&base);
        let appdir = base.join("mount_FF");
        let img_bin = appdir.join("usr").join("bin").join("ffmpeg").join("bin");
        let decoy = base.join("decoy");
        for d in [&img_bin, &decoy] {
            std::fs::create_dir_all(d).unwrap();
            for n in ["ffmpeg", "ffprobe"] {
                std::fs::write(d.join(format!("{n}{EXE}")), b"").unwrap();
            }
        }
        let app_dir = appdir.join("usr").join("bin");
        let path = std::env::join_paths([&decoy]).unwrap();
        let c = candidate_dirs(None, Some(&appdir), &app_dir, &base.join("vendor"));
        let b = first_bin(&c, Some(&path)).unwrap();
        assert_eq!(b.dir.as_deref(), Some(img_bin.as_path()));
        assert_eq!(b.ffprobe, img_bin.join(format!("ffprobe{EXE}")));
        // Без сведений об AppImage тот же образ находится как «ffmpeg рядом с программой»
        let c = candidate_dirs(Some(""), None, &app_dir, &base.join("vendor"));
        assert_eq!(first_bin(&c, Some(&path)).unwrap().dir.as_deref(), Some(img_bin.as_path()));
        // FFMONTAGE_FFMPEG_DIR сильнее образа
        let c = candidate_dirs(Some(decoy.to_str().unwrap()), Some(&appdir), &app_dir, &base.join("vendor"));
        assert_eq!(first_bin(&c, None).unwrap().dir.as_deref(), Some(decoy.as_path()));
        // Нигде нет — только PATH
        let c = candidate_dirs(None, None, &base.join("nope").join("bin"), &base.join("vendor"));
        assert_eq!(first_bin(&c, Some(&path)).unwrap().dir.as_deref(), Some(decoy.as_path()));
        assert!(first_bin(&c, None).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn proxy_decision() {
        let np = |ext, v, a, pix, linux| browser_needs_proxy(ext, v, a, pix, linux);
        // H.264 8 бит + AAC в MP4/MKV играет и в WebView2, и в WebKitGTK (gst-libav в AppImage)
        for linux in [false, true] {
            assert!(!np("mp4", Some("h264"), Some("aac"), Some("yuv420p"), linux));
            assert!(!np("MKV", Some("h264"), Some("opus"), Some("yuvj420p"), linux));
            assert!(!np("webm", Some("vp9"), Some("opus"), Some("yuv420p"), linux));
            assert!(!np("mp3", None, Some("mp3"), None, linux));
            // H.264 10 бит / 4:2:2, чужой контейнер или кодек — прокси везде
            assert!(np("mp4", Some("h264"), None, Some("yuv420p10le"), linux));
            assert!(np("mp4", Some("h264"), None, Some("yuv422p"), linux));
            assert!(np("avi", Some("h264"), None, Some("yuv420p"), linux));
            assert!(np("mp4", Some("mpeg4"), None, None, linux));
            assert!(np("mp4", Some("h264"), Some("ac3"), Some("yuv420p"), linux));
        }
        // HEVC и AV1: Windows (WebView2) — напрямую, Linux (WebKitGTK) — через прокси
        for v in ["hevc", "av1"] {
            assert!(!np("mp4", Some(v), Some("aac"), Some("yuv420p"), false), "{v}");
            assert!(np("mp4", Some(v), Some("aac"), Some("yuv420p"), true), "{v}");
        }
    }

    #[test]
    fn reverse_range_checks() {
        assert_eq!(reverse_range(1.0, 3.0, 10.0).unwrap(), (1.0, 3.0));
        assert_eq!(reverse_range(-1.0, 30.0, 10.0).unwrap(), (0.0, 10.0));
        assert!(reverse_range(3.0, 1.0, 10.0).is_err());
        assert!(reverse_range(2.0, 2.0, 10.0).is_err());
        assert!(reverse_range(12.0, 15.0, 10.0).is_err());
        assert!(reverse_range(f64::NAN, 1.0, 10.0).is_err());
        assert!(reverse_range(0.0, f64::INFINITY, 0.0).is_err());
    }

    #[test]
    fn key_locks_do_not_grow() {
        for i in 0..500 {
            let _l = key_lock(&format!("test:{i}"));
        }
        let held = key_lock("test:held");
        for i in 0..200 {
            let _l = key_lock(&format!("test2:{i}"));
        }
        let n = LOCKS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|m| m.len()).unwrap_or(0);
        assert!(n <= 66, "{n}");
        assert!(LOCKS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().unwrap().contains_key("test:held"));
        drop(held);
    }

    #[test]
    fn poisoned_locks_do_not_panic() {
        let _ = std::thread::spawn(|| {
            let _g = LOCKS.lock().unwrap();
            panic!("отравить LOCKS");
        })
        .join(); // i18n-ignore — тест
        let _l = key_lock("after-poison");
    }

    #[test]
    fn encoder_probe_args() {
        let l = encoders_list();
        assert!(l.contains(&"h264_nvenc") && l.contains(&"h264_qsv") && l.contains(&"av1_amf"));
        assert_eq!(l.contains(&"h264_vaapi"), cfg!(target_os = "linux"));
        let q = probe_encoder_args("h264_qsv").join(" ");
        assert!(q.contains("-c:v h264_qsv -preset slow -global_quality 25 -profile:v high"), "{q}");
        let a = probe_encoder_args("hevc_amf").join(" ");
        assert!(a.contains("-rc cqp -qp_i 25 -qp_p 27") && !a.contains("qp_b"), "{a}");
        let v = probe_encoder_args("h264_vaapi").join(" ");
        assert!(
            v.starts_with("-hide_banner -loglevel error -vaapi_device /dev/dri/renderD128") && v.contains("-vf format=nv12,hwupload"),
            "{v}"
        );
        assert!(probe_encoder_args("libx264").join(" ").contains("320x240"));
        assert!(is_gpu_encoder("av1_qsv") && !is_gpu_encoder("libsvtav1"));
    }

    #[test]
    fn encoders_disk_cache_roundtrip() {
        let key = json!({ "ffmpeg": "x:/test/ffmpeg-ffm-unit.exe", "size": 1, "mtime": 2 });
        let mut enc = serde_json::Map::new();
        for k in encoders_list() {
            enc.insert(k.into(), json!(k == "libx264"));
        }
        let enc = Value::Object(enc);
        let saved = std::fs::read_to_string(enc_file()).ok();
        enc_disk_write(&key, &enc);
        assert_eq!(enc_disk_read(&key), Some(enc.clone()));
        // ffmpeg обновили (другой размер) — кэш не годится
        assert_eq!(enc_disk_read(&json!({ "ffmpeg": key["ffmpeg"], "size": 3, "mtime": 2 })), None);
        // FFM_NO_GPU гасит аппаратные
        let v = json!({ "libx264": true, "h264_nvenc": true, "h264_qsv": true });
        std::env::set_var("FFM_NO_GPU", "1");
        let m = apply_no_gpu(v);
        std::env::remove_var("FFM_NO_GPU");
        assert_eq!(m, json!({ "libx264": true, "h264_nvenc": false, "h264_qsv": false }));
        match saved {
            Some(t) => {
                let _ = std::fs::write(enc_file(), t);
            }
            None => {
                let _ = std::fs::remove_file(enc_file());
            }
        }
    }
}
