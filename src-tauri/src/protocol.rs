// Протокол media:// — отдаёт окну медиафайлы (видео, звук, миниатюры) с поддержкой Range для перемотки.
// В Windows адрес выглядит как http://media.localhost/<путь>, в Linux/macOS — media://localhost/<путь>.
// Linux (0.4.2): WebKitGTK играет <video>/<audio> через GStreamer, а у того нет источника для своих схем
// (webkitwebsrc понимает только http/https/blob) — media:// даёт MEDIA_ERR_SRC_NOT_SUPPORTED. Поэтому на Linux тот же
// обработчик отдаётся ещё и по HTTP на 127.0.0.1 со случайным портом и секретным токеном в пути (http_start).
use crate::paths;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode};

const KEEP: &AsciiSet =
    &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
const CHUNK: u64 = 4 * 1024 * 1024;

static ALLOWED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn norm(p: &Path) -> String {
    let n = paths::normalize(p).to_string_lossy().to_string();
    if cfg!(windows) {
        n.to_lowercase().replace('/', "\\")
    } else {
        n
    }
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
    if let Some(base) = HTTP_BASE.get() {
        return format!("{base}/{enc}");
    }
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
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", typ)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", size.to_string())
            .header("Access-Control-Allow-Origin", "*")
            .body(vec![])
            .unwrap();
    }
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_string);
    // Без Range маленькие файлы отдаём целиком (200), большие — первым куском (206; Chromium/WebView2 для медиа всегда шлёт Range)
    let range = range.or_else(|| if size > WHOLE_MAX { Some("bytes=0-".to_string()) } else { None });
    let Some(range) = range else {
        let mut body = Vec::with_capacity(size as usize);
        if f.read_to_end(&mut body).is_err() {
            return reply(StatusCode::INTERNAL_SERVER_ERROR, vec![]);
        }
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", typ)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", body.len().to_string())
            .header("Access-Control-Allow-Origin", "*")
            .body(body)
            .unwrap();
    };
    let Some((start, end)) = parse_range(&range, size) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{size}"))
            .header("Access-Control-Allow-Origin", "*")
            .body(vec![])
            .unwrap();
    };
    let len = end - start + 1;
    let mut body = vec![0u8; len as usize];
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut body).is_err() {
        return reply(StatusCode::INTERNAL_SERVER_ERROR, vec![]);
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", typ)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{size}"))
        .header("Content-Length", len.to_string())
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        .body(body)
        .unwrap()
}

// ---- HTTP для <video>/<audio> на Linux (WebKitGTK + GStreamer) ----
// Только 127.0.0.1, порт случайный, в пути — 128-битный токен (другие программы и страницы в браузере его не знают),
// Host должен быть 127.0.0.1:<порт> (защита от DNS rebinding), файлы — те же, что разрешены media:// (is_allowed).
// Один запрос на соединение (Connection: close) — WebKit сам открывает новые для Range.
static HTTP_BASE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Запустить HTTP-мост; дальше url() отдаёт http://127.0.0.1:<порт>/<токен>/<путь>. Повторный вызов — тот же адрес.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn http_start() -> Option<String> {
    if let Some(b) = HTTP_BASE.get() {
        return Some(b.clone());
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    let mut t = [0u8; 16];
    getrandom::fill(&mut t).ok()?;
    let token: String = t.iter().map(|b| format!("{b:02x}")).collect();
    let host = format!("127.0.0.1:{port}");
    let base = format!("http://{host}/{token}");
    let (host2, token2) = (host.clone(), token.clone());
    std::thread::Builder::new()
        .name("ffm-media-http".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                let (h, t) = (host2.clone(), token2.clone());
                let _ = std::thread::Builder::new().name("ffm-media-conn".into()).spawn(move || {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| http_serve(conn, &h, &t)));
                });
            }
        })
        .ok()?;
    Some(HTTP_BASE.get_or_init(|| base).clone())
}

/// Разобрать запрос «METHOD /путь HTTP/1.x» с заголовками; None — не HTTP или слишком длинный
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn http_parse(head: &str) -> Option<(String, String, Vec<(String, String)>)> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if !version.starts_with("HTTP/1.") || !target.starts_with('/') {
        return None;
    }
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    Some((method.to_string(), target.to_string(), headers))
}

/// Ответ на запрос к мосту (без сети — для тестов): проверка Host и токена, затем обычный handle()
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn http_respond(method: &str, target: &str, headers: &[(String, String)], host: &str, token: &str) -> Response<Vec<u8>> {
    let header = |k: &str| headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    if header("host") != Some(host) {
        return reply(StatusCode::FORBIDDEN, b"Forbidden".to_vec());
    }
    let Some(rest) = target.strip_prefix(&format!("/{token}/")) else {
        return reply(StatusCode::NOT_FOUND, b"Not found".to_vec());
    };
    match method {
        "OPTIONS" => {
            return Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                .header("Access-Control-Allow-Headers", "Range")
                .header("Access-Control-Max-Age", "600")
                .body(vec![])
                .unwrap();
        }
        "GET" | "HEAD" => {}
        _ => return reply(StatusCode::METHOD_NOT_ALLOWED, vec![]),
    }
    let mut b = Request::builder().method(method).uri(format!("http://127.0.0.1/{}", rest.split('?').next().unwrap_or("")));
    if let Some(r) = header("range") {
        b = b.header("range", r);
    }
    match b.body(vec![]) {
        Ok(req) => handle(&req),
        Err(_) => reply(StatusCode::BAD_REQUEST, vec![]),
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn http_serve(mut conn: std::net::TcpStream, host: &str, token: &str) {
    use std::io::Write;
    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let _ = conn.set_write_timeout(Some(std::time::Duration::from_secs(60)));
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > 16 * 1024 {
            return;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let head = head.split("\r\n\r\n").next().unwrap_or("");
    let Some((method, target, headers)) = http_parse(head) else { return };
    let resp = http_respond(&method, &target, &headers, host, token);
    let mut out = format!("HTTP/1.1 {} {}\r\n", resp.status().as_u16(), resp.status().canonical_reason().unwrap_or(""));
    for (k, v) in resp.headers() {
        out.push_str(&format!("{}: {}\r\n", k.as_str(), v.to_str().unwrap_or("")));
    }
    if !resp.headers().contains_key("content-length") {
        out.push_str(&format!("Content-Length: {}\r\n", resp.body().len()));
    }
    out.push_str("Connection: close\r\n\r\n");
    let _ = conn.write_all(out.as_bytes());
    if method != "HEAD" {
        let _ = conn.write_all(resp.body());
    }
    let _ = conn.flush();
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
                    Ok(job) => {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                    }
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
    fn http_bridge_checks() {
        let h = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let host = "127.0.0.1:5555";
        let ok = h(&[("host", host)]);
        // Чужой Host (DNS rebinding), нет токена, чужой метод
        assert_eq!(http_respond("GET", "/tok/x", &h(&[("host", "evil.example:5555")]), host, "tok").status(), StatusCode::FORBIDDEN);
        assert_eq!(http_respond("GET", "/tok/x", &[], host, "tok").status(), StatusCode::FORBIDDEN);
        assert_eq!(http_respond("GET", "/other/x", &ok, host, "tok").status(), StatusCode::NOT_FOUND);
        assert_eq!(http_respond("GET", "/tokx", &ok, host, "tok").status(), StatusCode::NOT_FOUND);
        assert_eq!(http_respond("POST", "/tok/x", &ok, host, "tok").status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(http_respond("OPTIONS", "/tok/x", &ok, host, "tok").status(), StatusCode::NO_CONTENT);
        // Неразрешённый файл — как у media://
        let p = paths::test_dir("http-deny").join("secret.txt");
        let enc = utf8_percent_encode(&p.to_string_lossy(), KEEP).to_string();
        assert_eq!(http_respond("GET", &format!("/tok/{enc}"), &ok, host, "tok").status(), StatusCode::FORBIDDEN);
        assert!(http_parse("GET /a HTTP/1.1\r\nHost: x\r\nRange: bytes=0-1").is_some());
        assert!(http_parse("GET a HTTP/1.1").is_none());
        assert!(http_parse("garbage").is_none());
    }

    #[test]
    fn http_bridge_serves_ranges() {
        use std::io::Write;
        let dir = paths::test_dir("http-bridge");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("клип 1.mp4"); // i18n-ignore — имя файла в тесте
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &data).unwrap();
        allow(&file);
        let base = http_start().unwrap();
        assert_eq!(http_start().unwrap(), base, "second start returns the same address");
        let u = url(&file);
        assert!(u.starts_with(&base) && u.starts_with("http://127.0.0.1:"), "{u}");
        let hostport = base.trim_start_matches("http://").split('/').next().unwrap().to_string();
        let path = &u[format!("http://{hostport}").len()..];
        let get = |req: String| -> Vec<u8> {
            let mut s = std::net::TcpStream::connect(&hostport).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut out = vec![];
            s.read_to_end(&mut out).unwrap();
            out
        };
        let split = |r: &[u8]| -> (String, Vec<u8>) {
            let i = r.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            (String::from_utf8_lossy(&r[..i]).to_string(), r[i + 4..].to_vec())
        };
        let (head, body) = split(&get(format!("GET {path} HTTP/1.1\r\nHost: {hostport}\r\nRange: bytes=100-199\r\n\r\n")));
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.to_lowercase().contains("content-range: bytes 100-199/1000"), "{head}");
        assert!(head.to_lowercase().contains("access-control-allow-origin: *"), "{head}");
        assert_eq!(body, data[100..200].to_vec());
        let (head, body) = split(&get(format!("HEAD {path} HTTP/1.1\r\nHost: {hostport}\r\n\r\n")));
        assert!(head.starts_with("HTTP/1.1 200") && head.to_lowercase().contains("content-length: 1000"), "{head}");
        assert!(body.is_empty());
        let (head, _) = split(&get(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n")));
        assert!(head.starts_with("HTTP/1.1 403"), "{head}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pool_runs_jobs() {
        let (tx, rx) = std::sync::mpsc::channel();
        for i in 0..20 {
            let tx = tx.clone();
            spawn(move || {
                let _ = tx.send(i);
            });
        }
        spawn(|| panic!("boom")); // поток пула переживает панику
        let tx2 = tx.clone();
        spawn(move || {
            let _ = tx2.send(100);
        });
        let mut got: Vec<i32> = (0..21).map(|_| rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap()).collect();
        got.sort();
        assert_eq!(got.last(), Some(&100));
        assert_eq!(got.len(), 21);
    }
}
