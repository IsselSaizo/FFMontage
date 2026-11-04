// Протокол media:// — отдаёт окну медиафайлы (видео, звук, миниатюры) с поддержкой Range для перемотки.
// В Windows адрес выглядит как http://media.localhost/<путь>, в Linux/macOS — media://localhost/<путь>.
use crate::paths;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode};

const KEEP: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
const CHUNK: u64 = 4 * 1024 * 1024;

static ALLOWED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn norm(p: &Path) -> String {
    let n = paths::normalize(p).to_string_lossy().to_string();
    if cfg!(windows) { n.to_lowercase().replace('/', "\\") } else { n }
}

/// Разрешить окну читать файл
pub fn allow(p: &Path) {
    ALLOWED.lock().unwrap().get_or_insert_with(HashSet::new).insert(norm(p));
}

/// Разрешён ли окну файл: открытый через импорт (media_probe) или лежащий в кэше медиа
pub fn is_allowed(p: &Path) -> bool {
    let n = norm(p);
    if ALLOWED.lock().unwrap().as_ref().map(|s| s.contains(&n)).unwrap_or(false) {
        return true;
    }
    let cache = norm(&paths::get().media_cache);
    let sep = if cfg!(windows) { "\\" } else { "/" };
    n.starts_with(&format!("{cache}{sep}"))
}

pub fn url(p: &Path) -> String {
    let enc = utf8_percent_encode(&p.to_string_lossy(), KEEP).to_string();
    if cfg!(windows) || cfg!(target_os = "android") {
        format!("http://media.localhost/{enc}")
    } else {
        format!("media://localhost/{enc}")
    }
}

fn mime(p: &Path) -> &'static str {
    match crate::ff::ext_of(p).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" | "mov" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "json" => "application/json",
        "ttf" | "ttc" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn reply(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder().status(status).header("Access-Control-Allow-Origin", "*").body(body).unwrap()
}

/// Файлы больше этого без заголовка Range отдаются первым куском (206), а не целиком в память.
const WHOLE_MAX: u64 = 32 * 1024 * 1024;

/// Разбор `Range: bytes=…` (только первый диапазон). None — диапазон невыполним (416).
/// Кусок ответа не больше CHUNK: плеер сам попросит продолжение.
pub fn parse_range(spec: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let spec = spec.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let last = size - 1;
    let (start, end) = if a.is_empty() {
        // bytes=-N — последние N байт
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (size.saturating_sub(n), last)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { last } else { b.parse::<u64>().ok()?.min(last) };
        (start, end)
    };
    if start > end || start > last {
        return None;
    }
    Some((start, end.min(start.saturating_add(CHUNK - 1))))
}

pub fn handle(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = req.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8_lossy().to_string();
    let file = PathBuf::from(&decoded);
    if !is_allowed(&file) {
        return reply(StatusCode::FORBIDDEN, b"Forbidden".to_vec());
    }
    let mut f = match std::fs::File::open(&file) {
        Ok(f) => f,
        Err(_) => return reply(StatusCode::NOT_FOUND, b"Not found".to_vec()),
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let typ = mime(&file);
    // HEAD — только заголовки (WebKit спрашивает размер перед воспроизведением)
    if req.method() == tauri::http::Method::HEAD {
        return Response::builder().status(StatusCode::OK)
            .header("Content-Type", typ).header("Accept-Ranges", "bytes").header("Content-Length", size.to_string())
            .header("Access-Control-Allow-Origin", "*").body(vec![]).unwrap();
    }
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_string);
    // Без Range маленькие файлы отдаём целиком (200), большие — первым куском (206; Chromium/WebView2 для медиа всегда шлёт Range)
    let range = range.or_else(|| if size > WHOLE_MAX { Some("bytes=0-".to_string()) } else { None });
    let Some(range) = range else {
        let mut body = Vec::with_capacity(size as usize);
        if f.read_to_end(&mut body).is_err() {
            return reply(StatusCode::INTERNAL_SERVER_ERROR, vec![]);
        }
        return Response::builder().status(StatusCode::OK)
            .header("Content-Type", typ).header("Accept-Ranges", "bytes").header("Content-Length", body.len().to_string())
            .header("Access-Control-Allow-Origin", "*").body(body).unwrap();
    };
    let Some((start, end)) = parse_range(&range, size) else {
        return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{size}")).header("Access-Control-Allow-Origin", "*").body(vec![]).unwrap();
    };
    let len = end - start + 1;
    let mut body = vec![0u8; len as usize];
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut body).is_err() {
        return reply(StatusCode::INTERNAL_SERVER_ERROR, vec![]);
    }
    Response::builder().status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", typ)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{size}"))
        .header("Content-Length", len.to_string())
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        .body(body).unwrap()
}

// ---- Пул потоков для протоколов media:// и plugin:// (R-6) ----
// Раньше на каждый запрос создавался поток; с несколькими видеодорожками плеер шлёт десятки запросов сразу.
type Job = Box<dyn FnOnce() + Send + 'static>;
const WORKERS: usize = 6;

static POOL: std::sync::OnceLock<Mutex<std::sync::mpsc::Sender<Job>>> = std::sync::OnceLock::new();

fn pool() -> &'static Mutex<std::sync::mpsc::Sender<Job>> {
    POOL.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        let rx = std::sync::Arc::new(Mutex::new(rx));
        for i in 0..WORKERS {
            let rx = rx.clone();
            let _ = std::thread::Builder::new().name(format!("ffm-proto-{i}")).spawn(move || loop {
                let job = match rx.lock() {
                    Ok(r) => r.recv(),
                    Err(p) => p.into_inner().recv(),
                };
                match job {
                    // Паника в обработчике не должна убивать поток пула
                    Ok(job) => { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)); }
                    Err(_) => break,
                }
            });
        }
        Mutex::new(tx)
    })
}

/// Выполнить обработчик запроса в пуле (если пул недоступен — в отдельном потоке, как раньше)
pub fn spawn(job: impl FnOnce() + Send + 'static) {
    let job: Job = Box::new(job);
    let sent = match pool().lock() {
        Ok(tx) => tx.send(job),
        Err(p) => p.into_inner().send(job),
    };
    if let Err(std::sync::mpsc::SendError(job)) = sent {
        std::thread::spawn(job);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-500", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=-0", 100), None);
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=20-10", 100), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("items=0-", 100), None);
        assert_eq!(parse_range("bytes=x-", 100), None);
        // переполнение start + CHUNK
        let big = u64::MAX;
        assert_eq!(parse_range(&format!("bytes={}-", big - 5), big), Some((big - 5, big - 1)));
        // кусок не больше CHUNK
        assert_eq!(parse_range("bytes=0-", 10 * CHUNK), Some((0, CHUNK - 1)));
    }

    #[test]
    fn pool_runs_jobs() {
        let (tx, rx) = std::sync::mpsc::channel();
        for i in 0..20 {
            let tx = tx.clone();
            spawn(move || { let _ = tx.send(i); });
        }
        spawn(|| panic!("boom")); // поток пула переживает панику
        let tx2 = tx.clone();
        spawn(move || { let _ = tx2.send(100); });
        let mut got: Vec<i32> = (0..21).map(|_| rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap()).collect();
        got.sort();
        assert_eq!(got.last(), Some(&100));
        assert_eq!(got.len(), 21);
    }
}
