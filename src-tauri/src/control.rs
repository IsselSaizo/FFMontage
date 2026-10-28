// Канал управления для ИИ-ассистента (MCP).
//
// Программа слушает локальный канал (Windows — именованный канал, Linux/macOS — unix-сокет) и принимает
// команды от MCP-сервера («ff-montage --mcp», см. mcp.rs), который запускает ИИ-клиент (Claude Desktop, Cursor…).
// Сеть не используется. Каждый запрос должен содержать секретный ключ из <кэш>/app/mcp-endpoint.json.
//
// Протокол: JSON по одной строке на сообщение.
//   запрос  { id, token, method, params }
//   ответ   { id, result } | { id, error }
// Методы: ping → { ok, version, pid, ready }; call { tool, args } → результат инструмента из окна;
//         quit (только если программа запущена с FFM_ALLOW_QUIT=1 — для автотестов).
use crate::paths;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify};

const CALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const READY_TIMEOUT: Duration = Duration::from_secs(60);

static APP: OnceLock<AppHandle> = OnceLock::new();
static TOKEN: OnceLock<String> = OnceLock::new();
static PIPE: OnceLock<String> = OnceLock::new();
static READY: AtomicBool = AtomicBool::new(false);
static READY_NOTIFY: OnceLock<Notify> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(0);
static PENDING: Mutex<Option<HashMap<String, oneshot::Sender<Result<Value, String>>>>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);

fn notify() -> &'static Notify { READY_NOTIFY.get_or_init(Notify::new) }

pub fn version() -> String { env!("CARGO_PKG_VERSION").to_string() }

fn user_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

pub fn pipe_path(app_cache: &std::path::Path) -> String {
    let mut h = Sha1::new();
    h.update(format!("{}|{}", app_cache.to_string_lossy(), user_name()).as_bytes());
    let hash: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()[..12].to_string();
    if cfg!(windows) {
        return format!(r"\\.\pipe\ffmontage-{hash}");
    }
    let name = format!("ffmontage-{hash}.sock");
    for dir in [std::env::var("XDG_RUNTIME_DIR").ok(), Some(std::env::temp_dir().to_string_lossy().to_string()), Some("/tmp".into())].into_iter().flatten() {
        let p = PathBuf::from(&dir).join(&name);
        if p.to_string_lossy().len() < 100 {
            return p.to_string_lossy().to_string();
        }
    }
    format!("/tmp/{name}")
}

pub fn endpoint_file() -> PathBuf { paths::get().app_cache.join("mcp-endpoint.json") }

fn random_token() -> String {
    let mut b = [0u8; 32];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Связь с окном
// ---------------------------------------------------------------------------
pub fn set_ready(v: bool) {
    READY.store(v, Ordering::SeqCst);
    if v { notify().notify_waiters(); }
}

pub fn fail_all(message: &str) {
    if let Some(m) = PENDING.lock().unwrap().as_mut() {
        for (_, tx) in m.drain() { let _ = tx.send(Err(message.to_string())); }
    }
}

/// Окно прислало результат (или сообщило о готовности: id "__ready__")
pub fn on_result(id: String, payload: Value) {
    if id == "__ready__" {
        set_ready(payload["ready"].as_bool() != Some(false));
        return;
    }
    let tx = PENDING.lock().unwrap().as_mut().and_then(|m| m.remove(&id));
    if let Some(tx) = tx {
        let r = match payload.get("error") {
            Some(e) if !e.is_null() => Err(e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())),
            _ => Ok(payload.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = tx.send(r);
    }
}

fn window_open() -> bool {
    APP.get().and_then(|a| a.get_webview_window("main")).is_some()
}

async fn call_tool(tool: &str, args: Value) -> Result<Value, String> {
    if tool.is_empty() { return Err("Не указан инструмент.".into()); }
    if !window_open() { return Err("Окно FF Montage не открыто.".into()); }
    if !READY.load(Ordering::SeqCst) {
        let waited = tokio::time::timeout(READY_TIMEOUT, async {
            while !READY.load(Ordering::SeqCst) {
                let n = notify().notified();
                if READY.load(Ordering::SeqCst) { break; }
                let _ = tokio::time::timeout(Duration::from_millis(500), n).await;
            }
        }).await;
        if waited.is_err() {
            return Err(if window_open() {
                "Интерфейс FF Montage не отвечает: окно ещё загружается или в нём произошла ошибка (см. logs/renderer.log).".into()
            } else { "Окно FF Montage не открыто.".into() });
        }
    }
    let app = APP.get().ok_or("Программа не запущена")?;
    let win = app.get_webview_window("main").ok_or("Окно FF Montage закрыто.")?;
    let id = format!("c{}", SEQ.fetch_add(1, Ordering::SeqCst) + 1);
    let (tx, rx) = oneshot::channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id.clone(), tx);
    let args = if args.is_object() { args } else { json!({}) };
    if let Err(e) = win.emit_to("main", "mcp:call", json!({ "id": id, "tool": tool, "args": args })) {
        PENDING.lock().unwrap().as_mut().map(|m| m.remove(&id));
        return Err(e.to_string());
    }
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("Окно FF Montage закрыто.".into()),
        Err(_) => {
            PENDING.lock().unwrap().as_mut().map(|m| m.remove(&id));
            Err(format!("Нет ответа от окна за {} мин.", CALL_TIMEOUT.as_secs() / 60))
        }
    }
}

/// Всё, что нужно окну «ИИ-ассистент»: готовые настройки для MCP-клиентов
pub fn info() -> Value {
    let command = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let args = vec!["--mcp".to_string()];
    let mut env = serde_json::Map::new();
    for k in ["FFM_CONFIG", "FFM_APP_DIR"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                env.insert(k.into(), json!(paths::absolute(std::path::Path::new(&v), &std::env::current_dir().unwrap_or_default()).to_string_lossy()));
            }
        }
    }
    let mut entry = json!({ "command": command, "args": args });
    if !env.is_empty() { entry["env"] = Value::Object(env.clone()); }
    let config_json = serde_json::to_string_pretty(&json!({ "mcpServers": { "ff-montage": entry } })).unwrap_or_default();
    let mut vs = entry.clone();
    vs["type"] = json!("stdio");
    let vscode_json = serde_json::to_string_pretty(&json!({ "servers": { "ff-montage": vs } })).unwrap_or_default();
    let q = |s: &str| if s.contains(char::is_whitespace) || s.contains('"') { format!("\"{}\"", s.replace('"', "\\\"")) } else { s.to_string() };
    let env_flags: Vec<String> = env.iter().map(|(k, v)| format!("-e {k}={}", q(v.as_str().unwrap_or("")))).collect();
    let claude = format!("claude mcp add ff-montage {}{}-- {} --mcp", env_flags.join(" "), if env_flags.is_empty() { "" } else { " " }, q(&command));
    json!({
        "serverScript": command,
        "serverExists": true,
        "command": command, "args": ["--mcp"], "env": env,
        "configJson": config_json, "vscodeJson": vscode_json, "claudeCodeCommand": claude,
        "endpoint": endpoint_file().to_string_lossy(),
        "pipe": PIPE.get().cloned().unwrap_or_default(),
        "running": RUNNING.load(Ordering::SeqCst),
        "ready": READY.load(Ordering::SeqCst),
    })
}

// ---------------------------------------------------------------------------
// Сервер
// ---------------------------------------------------------------------------
fn safe_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn handle_conn<S: AsyncRead + AsyncWrite + Send + 'static>(stream: S) {
    let (rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::unbounded_channel::<Option<String>>();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            match m {
                Some(line) => { if wr.write_all(line.as_bytes()).await.is_err() { break; } let _ = wr.flush().await; }
                None => break,
            }
        }
        let _ = wr.shutdown().await;
    });
    let mut lines = BufReader::new(rd).lines();
    let token = TOKEN.get().cloned().unwrap_or_default();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() { continue; }
        if line.len() > 64 * 1024 * 1024 { break; }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => { let _ = tx.send(Some(format!("{}\n", json!({ "id": null, "error": "Неверный JSON" })))); continue; }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        if !safe_eq(req["token"].as_str().unwrap_or(""), &token) {
            let _ = tx.send(Some(format!("{}\n", json!({ "id": id, "error": "Неверный ключ доступа" }))));
            let _ = tx.send(None);
            break;
        }
        let tx2 = tx.clone();
        tokio::spawn(async move {
            let r: Result<Value, String> = match req["method"].as_str().unwrap_or("") {
                "ping" => Ok(json!({ "ok": true, "version": version(), "pid": std::process::id(), "ready": READY.load(Ordering::SeqCst) && window_open(), "window": window_open() })),
                "focus" => {
                    // Вторую копию программы запустили с тем же кэшем — показываем это окно
                    if let Some(w) = APP.get().and_then(|a| a.get_webview_window("setup").or_else(|| a.get_webview_window("main"))) {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    Ok(json!({ "ok": true }))
                }
                "call" => call_tool(req["params"]["tool"].as_str().unwrap_or(""), req["params"]["args"].clone()).await,
                "quit" => {
                    if std::env::var("FFM_ALLOW_QUIT").as_deref() == Ok("1") {
                        let _ = tx2.send(Some(format!("{}\n", json!({ "id": id, "result": { "ok": true } }))));
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        stop();
                        if let Some(a) = APP.get() { a.exit(0); }
                        return;
                    }
                    Err("Метод quit запрещён".into())
                }
                m => Err(format!("Неизвестный метод: {m}")),
            };
            let msg = match r { Ok(v) => json!({ "id": id, "result": v }), Err(e) => json!({ "id": id, "error": e }) };
            let _ = tx2.send(Some(format!("{msg}\n")));
        });
    }
    drop(tx);
    let _ = writer.await;
}

fn write_endpoint(pipe: &str, token: &str) -> std::io::Result<()> {
    let file = endpoint_file();
    if let Some(d) = file.parent() { std::fs::create_dir_all(d)?; }
    let data = json!({ "pipe": pipe, "token": token, "pid": std::process::id(), "version": version(),
        "appDir": paths::get().app_dir.to_string_lossy(), "exe": std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default() });
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&data).unwrap_or_default())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &file)
}

pub fn start(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) { return; }
    let _ = APP.set(app);
    let token = TOKEN.get_or_init(random_token).clone();
    let pipe = PIPE.get_or_init(|| pipe_path(&paths::get().app_cache)).clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(&pipe, &token).await {
            eprintln!("[mcp] control server error: {e}");
            RUNNING.store(false, Ordering::SeqCst);
        }
    });
}

#[cfg(windows)]
async fn serve(pipe: &str, token: &str) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let mut server = ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(pipe)?;
    write_endpoint(pipe, token)?;
    loop {
        server.connect().await?;
        let conn = server;
        server = ServerOptions::new().reject_remote_clients(true).create(pipe)?;
        tokio::spawn(handle_conn(conn));
    }
}

#[cfg(unix)]
async fn serve(pipe: &str, token: &str) -> std::io::Result<()> {
    let _ = std::fs::remove_file(pipe);
    let listener = tokio::net::UnixListener::bind(pipe)?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(pipe, std::fs::Permissions::from_mode(0o600));
    }
    write_endpoint(pipe, token)?;
    loop {
        let (s, _) = listener.accept().await?;
        tokio::spawn(handle_conn(s));
    }
}

/// Уже запущена копия программы с этим же кэшем? Тогда просим её показать окно (true — надо выйти).
/// Копии с разными кэшами (автотесты) друг другу не мешают — как было в Electron.
pub fn focus_existing() -> bool {
    let Ok(text) = std::fs::read_to_string(endpoint_file()) else { return false };
    let Ok(ep) = serde_json::from_str::<Value>(&text) else { return false };
    let (Some(pipe), Some(token)) = (ep["pipe"].as_str(), ep["token"].as_str()) else { return false };
    let msg = format!("{}\n", json!({ "id": "focus", "token": token, "method": "focus" }));
    use std::io::{BufRead, Write};
    #[cfg(windows)]
    let conn = std::fs::OpenOptions::new().read(true).write(true).open(pipe);
    #[cfg(unix)]
    let conn = std::os::unix::net::UnixStream::connect(pipe);
    let Ok(mut c) = conn else { return false };
    if c.write_all(msg.as_bytes()).is_err() { return false; }
    let mut line = String::new();
    let mut r = std::io::BufReader::new(c);
    r.read_line(&mut line).is_ok() && line.contains("\"ok\"")
}

pub fn stop() {
    fail_all("FF Montage закрывается.");
    let file = endpoint_file();
    if let Ok(t) = std::fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            if v["pid"].as_u64() == Some(std::process::id() as u64) { let _ = std::fs::remove_file(&file); }
        }
    }
    #[cfg(unix)]
    if let Some(p) = PIPE.get() { let _ = std::fs::remove_file(p); }
}
