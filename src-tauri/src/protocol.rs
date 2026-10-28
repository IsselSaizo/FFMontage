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

fn is_allowed(p: &Path) -> bool {
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
        _ => "application/octet-stream",
    }
}

fn reply(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder().status(status).header("Access-Control-Allow-Origin", "*").body(body).unwrap()
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
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_string);
    // Без Range маленькие файлы отдаём целиком, большие — первым куском (плеер дальше попросит сам)
    let range = range.or_else(|| if size > 32 * 1024 * 1024 { Some("bytes=0-".to_string()) } else { None });
    let Some(range) = range else {
        let mut body = Vec::with_capacity(size as usize);
        if f.read_to_end(&mut body).is_err() {
            return reply(StatusCode::INTERNAL_SERVER_ERROR, vec![]);
        }
        return Response::builder().status(StatusCode::OK)
            .header("Content-Type", typ).header("Accept-Ranges", "bytes").header("Content-Length", body.len().to_string())
            .header("Access-Control-Allow-Origin", "*").body(body).unwrap();
    };
    let spec = range.trim().strip_prefix("bytes=").unwrap_or("").split(',').next().unwrap_or("").trim().to_string();
    let (a, b) = spec.split_once('-').unwrap_or(("", ""));
    let (mut start, mut end): (u64, u64);
    if a.is_empty() && !b.is_empty() {
        let n: u64 = b.parse().unwrap_or(0);
        start = size.saturating_sub(n);
        end = size.saturating_sub(1);
    } else {
        start = a.parse().unwrap_or(0);
        end = if b.is_empty() { size.saturating_sub(1) } else { b.parse().unwrap_or(size.saturating_sub(1)) };
    }
    end = end.min(size.saturating_sub(1)).min(start + CHUNK - 1);
    if size == 0 || start >= size || start > end {
        return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{size}")).header("Access-Control-Allow-Origin", "*").body(vec![]).unwrap();
    }
    let len = end - start + 1;
    let mut body = vec![0u8; len as usize];
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut body).is_err() {
        return reply(StatusCode::INTERNAL_SERVER_ERROR, vec![]);
    }
    start = start.min(end);
    Response::builder().status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", typ)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{size}"))
        .header("Content-Length", len.to_string())
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        .body(body).unwrap()
}
