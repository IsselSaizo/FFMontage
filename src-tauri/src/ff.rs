// Работа с FFmpeg: поиск бинарников, анализ файлов, миниатюры, волна звука, прокси, эффекты, проверка кодеков.
use crate::paths;
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

/// Порядок поиска: папка из настроек → vendor/ffmpeg → ffmpeg рядом/внутри программы → ffmpeg-* рядом с программой → PATH
pub fn search_binaries(configured: Option<&Path>) -> Option<Bin> {
    if let Some(c) = configured {
        return bin_in(c);
    }
    let p = paths::get();
    let mut cands: Vec<PathBuf> = vec![];
    if let Ok(e) = std::env::var("FFMONTAGE_FFMPEG_DIR") {
        if !e.is_empty() {
            cands.push(PathBuf::from(e));
        }
    }
    cands.push(p.vendor_dir.join("ffmpeg"));
    cands.push(p.app_dir.join("ffmpeg"));
    if let Some(parent) = p.app_dir.parent() {
        if let Ok(rd) = std::fs::read_dir(parent) {
            let mut names: Vec<PathBuf> = rd
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("ffmpeg"))
                .map(|e| e.path())
                .collect();
            names.sort();
            cands.extend(names);
        }
    }
    for d in cands {
        if let Some(b) = bin_in(&d) {
            return Some(b);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            if let Some(b) = bin_in(&d) {
                return Some(b);
            }
        }
    }
    None
}

pub fn find() -> Bin {
    if let Some(b) = BIN.read().unwrap().as_ref() {
        return b.clone();
    }
    let b = search_binaries(paths::get().ffmpeg_dir.as_deref()).unwrap_or_else(|| Bin {
        ffmpeg: PathBuf::from(format!("ffmpeg{EXE}")),
        ffprobe: PathBuf::from(format!("ffprobe{EXE}")),
        dir: None,
        missing: true,
    });
    *BIN.write().unwrap() = Some(b.clone());
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
    format!("{name} завершился с кодом {}: {last}", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
}

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Запуск с захватом вывода. on_chunk — потоковая обработка stdout (тогда stdout в результате пуст).
pub async fn run_with<F: FnMut(&[u8]) + Send>(prog: &Path, args: &[String], mut on_chunk: Option<F>, timeout: Option<Duration>) -> Res<Output> {
    let mut child = command(prog).args(args).spawn().map_err(|e| format!("Не удалось запустить {}: {e}", prog.display()))?;
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let read_out = async {
        let mut all = Vec::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match so.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => match on_chunk.as_mut() {
                    Some(f) => f(&buf[..n]),
                    None => all.extend_from_slice(&buf[..n]),
                },
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
    let (out, err, st) = match timeout {
        Some(t) => match tokio::time::timeout(t, work).await {
            Ok(r) => r,
            Err(_) => return Err(format!("{} не ответил за {} с", prog.display(), t.as_secs())),
        },
        None => work.await,
    };
    let st = st.map_err(|e| e.to_string())?;
    if st.success() {
        Ok(Output { stdout: out, stderr: err })
    } else {
        Err(fail_message(prog, st.code(), &err))
    }
}

pub async fn run(prog: &Path, args: &[String]) -> Res<Output> {
    run_with::<fn(&[u8])>(prog, args, None, None).await
}

pub fn sv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

// ---------------------------------------------------------------------------
// Анализ файла
// ---------------------------------------------------------------------------
const BROWSER_VIDEO_CODECS: &[&str] = &["h264", "av1", "hevc", "vp8", "vp9"];
const BROWSER_AUDIO_CODECS: &[&str] = &["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"];
const BROWSER_CONTAINERS: &[&str] = &[".mp4", ".m4v", ".mov", ".webm", ".mkv", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"];
pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "bmp", "webp", "gif", "tif", "tiff"];

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

/// Ключ кэша: тот же, что был у версии на Electron (кэш миниатюр и прокси сохраняется)
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
    let out = run(&bin.ffprobe, &[sv(&["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]), vec![file.to_string_lossy().to_string()]].concat()).await?;
    let j: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe: {e}"))?;
    let empty = vec![];
    let streams = j["streams"].as_array().unwrap_or(&empty);
    let v = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 0);
    let a = streams.iter().find(|s| s["codec_type"] == "audio");
    let fmt = &j["format"];
    let num = |x: &Value| -> Option<f64> { x.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| x.as_f64()) };
    let ext = ext_of(file);
    let is_image = IMAGE_EXT.contains(&ext.as_str())
        || v.map(|v| matches!(v["codec_name"].as_str(), Some("png" | "mjpeg" | "bmp" | "webp" | "tiff" | "gif"))
            && fmt["format_name"].as_str().map(|f| f.contains("pipe") || f.contains("image2") || f == "gif" || f == "webp_pipe").unwrap_or(false))
            .unwrap_or(false);
    let mut duration = num(&fmt["duration"]).filter(|d| d.is_finite()).unwrap_or_else(|| {
        v.and_then(|v| num(&v["duration"])).or_else(|| a.and_then(|a| num(&a["duration"]))).unwrap_or(0.0)
    });
    let meta = std::fs::metadata(file).map_err(|e| e.to_string())?;
    let mut fps = v.map(|v| { let f = parse_rate(v["avg_frame_rate"].as_str()); if f > 0.0 { f } else { parse_rate(v["r_frame_rate"].as_str()) } }).unwrap_or(0.0);
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
    let animated = is_image && v.map(|v| v["nb_frames"].as_str().and_then(|n| n.parse::<i64>().ok()).unwrap_or(0) > 1 || ext == "gif").unwrap_or(false)
        && duration > 0.05;
    let still = is_image && !animated;
    if still {
        duration = 0.0;
        fps = 0.0;
    }
    let dot_ext = format!(".{ext}");
    let mut needs_proxy = !BROWSER_CONTAINERS.contains(&dot_ext.as_str());
    if let Some(c) = &vcodec {
        if !BROWSER_VIDEO_CODECS.contains(&c.as_str()) {
            needs_proxy = true;
        }
    }
    if let Some(c) = &acodec {
        if !BROWSER_AUDIO_CODECS.contains(&c.as_str()) {
            needs_proxy = true;
        }
    }
    // На Linux окно (WebKitGTK/GStreamer) не всегда умеет HEVC и AV1
    if cfg!(target_os = "linux") && matches!(vcodec.as_deref(), Some("hevc" | "av1")) {
        needs_proxy = true;
    }
    if vcodec.as_deref() == Some("h264") {
        if let Some(p) = &pix {
            if !matches!(p.as_str(), "yuv420p" | "yuvj420p" | "nv12") {
                needs_proxy = true;
            }
        }
    }
    if still {
        needs_proxy = false; // картинка показывается как <img>
    }
    if animated {
        needs_proxy = true; // анимация играет через короткое видео
    }
    let channels = a.and_then(|a| a["channels"].as_i64());
    Ok(json!({
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
static LOCKS: StdMutex<Option<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = StdMutex::new(None);
fn key_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut g = LOCKS.lock().unwrap();
    g.get_or_insert_with(HashMap::new).entry(key.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
}

/// Поля сведений о файле, присланные окном
pub struct Info<'a>(pub &'a Value);
impl Info<'_> {
    pub fn path(&self) -> PathBuf { PathBuf::from(self.0["path"].as_str().unwrap_or_default()) }
    pub fn key(&self) -> Res<String> {
        let k = self.0["key"].as_str().unwrap_or_default();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err("Неверный ключ кэша".into());
        }
        Ok(k.to_string())
    }
    pub fn f(&self, k: &str) -> f64 { self.0[k].as_f64().unwrap_or(0.0) }
    pub fn b(&self, k: &str) -> bool { self.0[k].as_bool().unwrap_or(false) }
}

fn s(p: &Path) -> String { p.to_string_lossy().to_string() }
pub fn n3(x: f64) -> String { format!("{x:.3}") }

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
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bin = find();
    let still = i.b("isImage");
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
    if still || run(&bin.ffmpeg, &fast).await.is_err() {
        run(&bin.ffmpeg, &[common, input, out_args].concat()).await?;
    }
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".jpg"))
        .map(|e| s(&e.path()))
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

pub async fn peaks(info: &Value) -> Res<Value> {
    let i = Info(info);
    let key = i.key()?;
    let lock = key_lock(&format!("peaks:{key}"));
    let _g = lock.lock().await;
    let file = media_cache_dir(&key).join("peaks2.json");
    if let Ok(t) = std::fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            return Ok(v);
        }
    }
    if !i.b("hasAudio") {
        return Ok(Value::Null);
    }
    let stereo = i.f("channels") >= 2.0;
    let ch = if stereo { 2 } else { 1 };
    let bin = find();
    let per = PEAK_SR / PEAKS_PER_SEC;
    // Каналы: [моно-сумма], [левый, правый]
    let mut acc: Vec<Vec<f32>> = vec![vec![]; ch + 1];
    let mut cur = vec![0f32; ch + 1];
    let mut n = 0usize;
    let mut rest: Vec<u8> = vec![];
    let frame = 4 * ch;
    let args = [sv(&["-hide_banner", "-loglevel", "error", "-i"]), vec![s(&i.path())],
        sv(&["-vn", "-sn", "-ac", &ch.to_string(), "-ar", &PEAK_SR.to_string(), "-f", "f32le", "pipe:1"])].concat();
    run_with(&bin.ffmpeg, &args, Some(|chunk: &[u8]| {
        rest.extend_from_slice(chunk);
        let usable = rest.len() - rest.len() % frame;
        let mut k = 0;
        while k < usable {
            let mut mono = 0f32;
            for c in 0..ch {
                let o = k + c * 4;
                let v = f32::from_le_bytes([rest[o], rest[o + 1], rest[o + 2], rest[o + 3]]).abs();
                if v > cur[c + 1] { cur[c + 1] = v; }
                if v > mono { mono = v; }
            }
            if mono > cur[0] { cur[0] = mono; }
            n += 1;
            if n >= per {
                for c in 0..=ch { acc[c].push(cur[c]); cur[c] = 0.0; }
                n = 0;
            }
            k += frame;
        }
        rest.drain(..usable);
    }), None).await?;
    if n > 0 {
        for c in 0..=ch { acc[c].push(cur[c]); }
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

pub async fn proxy(info: &Value, on_progress: &(dyn Fn(f64) + Send + Sync), enc: &Value) -> Res<PathBuf> {
    let i = Info(info);
    let key = i.key()?;
    let lock = key_lock(&format!("proxy:{key}"));
    let _g = lock.lock().await;
    let has_video = i.b("hasVideo");
    let file = media_cache_dir(&key).join(if has_video { "proxy.mp4" } else { "proxy.m4a" });
    if file.exists() {
        return Ok(file);
    }
    let tmp = PathBuf::from(format!("{}.part.mp4", file.display()));
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
        if i.f("channels") > 2.0 { args.extend(sv(&["-ac", "2"])); }
    }
    args.extend(sv(&["-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats"]));
    args.push(s(&tmp));
    run_with(&bin.ffmpeg, &args, Some(progress_parser(i.f("duration"), on_progress)), None).await?;
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
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

pub async fn reverse(info: &Value, a: f64, b: f64, on_progress: &(dyn Fn(f64) + Send + Sync), enc: &Value) -> Res<PathBuf> {
    let i = Info(info);
    let key = i.key()?;
    let a = a.max(0.0);
    let dur_all = i.f("duration");
    let b = if dur_all > 0.0 { b.min(dur_all) } else { b };
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
    let bin = find();
    let dur = b - a;
    let common = sv(&["-hide_banner", "-loglevel", "error", "-y", "-nostdin"]);
    let work = WorkDir(dir.join(format!("{base}_work")));
    let _ = std::fs::remove_dir_all(&work.0);
    std::fs::create_dir_all(&work.0).map_err(|e| e.to_string())?;
    let src = s(&i.path());
    if !has_video {
        let out = work.0.join("out.flac");
        run(&bin.ffmpeg, &[common.clone(), sv(&["-ss", &n3(a), "-t", &n3(dur), "-i", &src, "-vn", "-sn", "-af", "areverse", "-c:a", "flac"]), vec![s(&out)]].concat()).await?;
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
        run(&bin.ffmpeg, &[common.clone(), sv(&["-ss", &n3(ss), "-t", &n3(d), "-i", &src, "-an", "-sn", "-dn", "-vf", "reverse"]), fx_video_args(enc, fps), vec![s(&out)]].concat()).await?;
        parts.push(out);
        on_progress((k + 1) as f64 / steps);
    }
    let list = work.0.join("list.txt");
    let text: Vec<String> = parts.iter().map(|p| format!("file '{}'", s(p).replace('\\', "/").replace('\'', "'\\''"))).collect();
    std::fs::write(&list, text.join("\n")).map_err(|e| e.to_string())?;
    let mut args = [common.clone(), sv(&["-f", "concat", "-safe", "0", "-i"]), vec![s(&list)]].concat();
    if has_audio {
        let wav = work.0.join("audio.wav");
        run(&bin.ffmpeg, &[common.clone(), sv(&["-ss", &n3(a), "-t", &n3(dur), "-i", &src, "-vn", "-sn", "-af", "areverse", "-c:a", "pcm_s16le"]), vec![s(&wav)]].concat()).await?;
        on_progress((n + 1) as f64 / steps);
        args.extend([vec!["-i".to_string(), s(&wav)], sv(&["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "256k"])].concat());
    }
    let tmp = work.0.join("out.mp4");
    args.extend(sv(&["-c:v", "copy", "-t", &n3(dur), "-movflags", "+faststart"]));
    args.push(s(&tmp));
    run(&bin.ffmpeg, &args).await?;
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
    let bin = find();
    let png = dir.join(format!("{base}.png"));
    let common = sv(&["-hide_banner", "-loglevel", "error", "-y", "-nostdin"]);
    let src = s(&i.path());
    // У самого конца файла кадра может не оказаться — отступаем назад
    for t in [at, at - 0.05, at - 0.25, at - 1.0] {
        if t < 0.0 { continue; }
        let _ = run(&bin.ffmpeg, &[common.clone(), sv(&["-ss", &n3(t), "-i", &src, "-frames:v", "1", "-an", "-sn"]), vec![s(&png)]].concat()).await;
        if std::fs::metadata(&png).map(|m| m.len() > 0).unwrap_or(false) { break; }
    }
    if !png.exists() {
        return Err("Не удалось взять кадр из файла".into());
    }
    let tmp = dir.join(format!("{base}.part.mp4"));
    run(&bin.ffmpeg, &[common, sv(&["-loop", "1", "-framerate", "10", "-i"]), vec![s(&png)],
        sv(&["-t", &FREEZE_FILE_SEC.to_string(), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"]),
        fx_video_args(enc, 10.0), sv(&["-movflags", "+faststart"]), vec![s(&tmp)]].concat()).await?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&png);
    Ok(file)
}

/// Один кадр в JPEG (для ИИ-ассистента: «посмотреть» на видео)
pub async fn frame_jpeg(file: &Path, t: f64, width: f64) -> Res<Vec<u8>> {
    let bin = find();
    let w = ((width / 2.0).round() * 2.0).clamp(64.0, 1920.0) as i64;
    for tt in [t, t - 0.1, t - 0.5] {
        if tt < 0.0 { continue; }
        let out = run(&bin.ffmpeg, &[sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", &n3(tt), "-i"]), vec![s(file)],
            sv(&["-frames:v", "1", "-an", "-sn", "-vf", &format!("scale={w}:-2"), "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"])].concat()).await;
        if let Ok(o) = out {
            if !o.stdout.is_empty() { return Ok(o.stdout); }
        }
    }
    Err("Не удалось получить кадр".into())
}

/// Поиск тишины: [{ start, end }] в секундах файла
pub async fn silence(file: &Path, threshold_db: f64, min_dur: f64) -> Res<Value> {
    let bin = find();
    let out = run(&bin.ffmpeg, &[sv(&["-hide_banner", "-nostdin", "-i"]), vec![s(file)],
        sv(&["-vn", "-sn", "-af", &format!("silencedetect=noise={threshold_db}dB:d={min_dur}"), "-f", "null", "-"])].concat()).await?;
    let mut list = vec![];
    let mut cur: Option<f64> = None;
    for line in out.stderr.lines() {
        if let Some(p) = line.find("silence_start:") {
            let v = line[p + 14..].trim().split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0);
            cur = Some(v.max(0.0));
            continue;
        }
        if let Some(p) = line.find("silence_end:") {
            let v = line[p + 12..].trim().split_whitespace().next().and_then(|x| x.parse::<f64>().ok());
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
static ENC_CACHE: StdMutex<Option<HashMap<PathBuf, Value>>> = StdMutex::new(None);

pub async fn detect_encoders(bin: &Bin) -> Value {
    if let Some(v) = ENC_CACHE.lock().unwrap().as_ref().and_then(|m| m.get(&bin.ffmpeg).cloned()) {
        return v;
    }
    static LIST: [&str; 6] = ["av1_nvenc", "hevc_nvenc", "h264_nvenc", "libx264", "libx265", "libsvtav1"];
    let futs = LIST.iter().map(|enc: &'static &'static str| {
        let ff = bin.ffmpeg.clone();
        async move {
            let args = sv(&["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=0.2", "-c:v", enc, "-f", "null", "-"]);
            let ok = run_with::<fn(&[u8])>(&ff, &args, None, Some(Duration::from_secs(15))).await.is_ok();
            (enc.to_string(), ok)
        }
    });
    let res = futures_join_all(futs).await;
    // FFM_NO_GPU=1 — вести себя как компьютер без видеокарты NVIDIA (проверка и CI)
    let no_gpu = std::env::var("FFM_NO_GPU").map(|v| v == "1").unwrap_or(false);
    let mut m = serde_json::Map::new();
    for (k, v) in res { m.insert(k.clone(), json!(v && !(no_gpu && k.ends_with("_nvenc")))); }
    let v = Value::Object(m);
    ENC_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(bin.ffmpeg.clone(), v.clone());
    v
}

async fn futures_join_all<F: std::future::Future>(futs: impl IntoIterator<Item = F>) -> Vec<F::Output>
where F::Output: Send + 'static, F: Send + 'static {
    let handles: Vec<_> = futs.into_iter().map(tokio::spawn).collect();
    let mut out = vec![];
    for h in handles { if let Ok(v) = h.await { out.push(v); } }
    out
}

/// Версия FFmpeg: (первая строка, major). major нужен для совместимости со старыми сборками.
static VER_CACHE: StdMutex<Option<HashMap<PathBuf, Option<(String, u32)>>>> = StdMutex::new(None);

pub async fn version_info(bin: &Bin) -> Option<(String, u32)> {
    if let Some(v) = VER_CACHE.lock().unwrap().as_ref().and_then(|m| m.get(&bin.ffmpeg).cloned()) {
        return v;
    }
    let r = run_with::<fn(&[u8])>(&bin.ffmpeg, &sv(&["-hide_banner", "-version"]), None, Some(Duration::from_secs(15))).await.ok().map(|o| {
        let text = String::from_utf8_lossy(&o.stdout).to_string();
        let line = text.lines().next().unwrap_or("").trim().to_string();
        let mut major = 99; // сборки из master («N-12345-g…») считаем самыми новыми
        let low = line.to_lowercase();
        if let Some(p) = low.find("version ") {
            let rest = low[p + 8..].trim_start_matches('n');
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if rest[digits.len()..].starts_with('.') {
                if let Ok(m) = digits.parse() { major = m; }
            }
        }
        (line, major)
    });
    VER_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(bin.ffmpeg.clone(), r.clone());
    r
}

/// Для окна настроек: проверить конкретную папку (или автопоиск, если пусто)
pub async fn check_dir(dir: &str) -> Value {
    let bin = if dir.is_empty() { search_binaries(None) } else { bin_in(Path::new(dir)) };
    let Some(bin) = bin else {
        return json!({ "ok": false, "error": if dir.is_empty() { "FFmpeg не найден" } else { "В этой папке нет ffmpeg и ffprobe" } });
    };
    match version_info(&bin).await {
        None => json!({ "ok": false, "error": "ffmpeg найден, но не запускается", "path": s(&bin.ffmpeg) }),
        Some((line, major)) => json!({ "ok": true, "path": s(&bin.ffmpeg), "dir": bin.dir.as_deref().map(s), "version": line, "major": major }),
    }
}
