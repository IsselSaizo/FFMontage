// MCP-сервер FF Montage: «ff-montage --mcp». ИИ-клиент (Claude Desktop, Cursor, VS Code…) запускает его
// и общается по stdio (JSON-RPC 2.0, одно сообщение на строку). В stdout — только JSON-RPC, журнал — в stderr.
//
// Сервер сам ничего не монтирует: он передаёт вызовы инструментов в окно программы через локальный канал
// (control.rs). Адрес канала и ключ — в <кэш>/app/mcp-endpoint.json. Если программа не запущена — запускает её.
use crate::{control, paths};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

const SUPPORTED: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST: &str = "2025-06-18";
const LAUNCH_WAIT: Duration = Duration::from_secs(45);
const CALL_TIMEOUT: Duration = Duration::from_secs(16 * 60);
const TOOLS_JSON: &str = include_str!("../../mcp/tools.json");

fn log(s: &str) { eprintln!("[ff-montage-mcp] {s}"); }

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

struct Link {
    tx: mpsc::UnboundedSender<String>,
    token: String,
    pending: Pending,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

struct App {
    link: tokio::sync::Mutex<Option<Link>>,
    seq: AtomicU64,
    launched_at: Mutex<Option<Instant>>,
}

fn read_endpoint() -> Result<Option<Value>, String> {
    let p = paths::get();
    if p.first_run {
        return Err(format!("FF Montage is not set up yet ({} not found). First start FF Montage and choose the folders \
            (сначала запустите FF Montage и выберите папки), then try again.", p.config_file.display()));
    }
    let v = std::fs::read_to_string(control::endpoint_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    Ok(v.filter(|e| e["pipe"].is_string() && e["token"].is_string()))
}

#[cfg(windows)]
async fn open_pipe(name: &str) -> std::io::Result<(Box<dyn tokio::io::AsyncRead + Send + Unpin>, Box<dyn tokio::io::AsyncWrite + Send + Unpin>)> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let mut tries = 0;
    let c = loop {
        match ClientOptions::new().open(name) {
            Ok(c) => break c,
            Err(e) if e.raw_os_error() == Some(231) && tries < 20 => { tries += 1; tokio::time::sleep(Duration::from_millis(50)).await; } // ERROR_PIPE_BUSY
            Err(e) => return Err(e),
        }
    };
    let (r, w) = tokio::io::split(c);
    Ok((Box::new(r), Box::new(w)))
}

#[cfg(unix)]
async fn open_pipe(name: &str) -> std::io::Result<(Box<dyn tokio::io::AsyncRead + Send + Unpin>, Box<dyn tokio::io::AsyncWrite + Send + Unpin>)> {
    let s = tokio::net::UnixStream::connect(name).await?;
    let (r, w) = tokio::io::split(s);
    Ok((Box::new(r), Box::new(w)))
}

/// Подключиться к запущенной программе и проверить ключ. Err(true) — канала нет (программа не запущена).
async fn connect(ep: &Value) -> Result<Link, (bool, String)> {
    let pipe = ep["pipe"].as_str().unwrap_or_default().to_string();
    let token = ep["token"].as_str().unwrap_or_default().to_string();
    let (r, mut w) = open_pipe(&pipe).await.map_err(|e| {
        let gone = matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) || e.raw_os_error() == Some(2);
        (gone, e.to_string())
    })?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if w.write_all(line.as_bytes()).await.is_err() { break; }
            let _ = w.flush().await;
        }
    });
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (p2, a2) = (pending.clone(), alive.clone());
    tokio::spawn(async move {
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let id = msg["id"].as_str().unwrap_or_default().to_string();
            if let Some(t) = p2.lock().unwrap().remove(&id) {
                let r = match msg.get("error") { Some(e) if !e.is_null() => Err(e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())), _ => Ok(msg["result"].clone()) };
                let _ = t.send(r);
            }
        }
        a2.store(false, Ordering::SeqCst);
        for (_, t) in p2.lock().unwrap().drain() { let _ = t.send(Err("Connection to FF Montage was lost (the app was closed?).".into())); }
    });
    let link = Link { tx, token, pending, alive };
    match tokio::time::timeout(Duration::from_secs(3), request_on(&link, "hello", "ping", json!({}))).await {
        Ok(Ok(_)) => Ok(link),
        Ok(Err(e)) => Err((false, e)),
        Err(_) => Err((false, "timeout".into())),
    }
}

async fn request_on(link: &Link, id: &str, method: &str, params: Value) -> Result<Value, String> {
    let (t, r) = oneshot::channel();
    link.pending.lock().unwrap().insert(id.to_string(), t);
    let msg = json!({ "id": id, "token": link.token, "method": method, "params": params });
    link.tx.send(format!("{msg}\n")).map_err(|_| "Connection to FF Montage was lost (the app was closed?).".to_string())?;
    match tokio::time::timeout(CALL_TIMEOUT, r).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => Err("Connection to FF Montage was lost (the app was closed?).".into()),
        Err(_) => Err("FF Montage did not answer in time.".into()),
    }
}

fn launch_app() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    log(&format!("starting FF Montage: {}", exe.display()));
    let mut c = std::process::Command::new(exe);
    c.current_dir(&paths::get().app_dir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    let mut child = c.spawn().map_err(|e| format!("launch failed: {e}"))?;
    // Забираем код выхода, иначе на Linux/macOS закрытая программа висит зомби, пока жив MCP-сервер
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

impl App {
    async fn ensure(&self) -> Result<(), String> {
        let mut g = self.link.lock().await;
        if g.as_ref().map(|l| l.alive.load(Ordering::SeqCst)).unwrap_or(false) { return Ok(()); }
        *g = None;
        let try_existing = || async {
            match read_endpoint()? {
                None => Ok::<_, String>(Err((true, "no endpoint".to_string()))),
                Some(ep) => Ok(connect(&ep).await),
            }
        };
        let mut r: Result<Link, (bool, String)> = try_existing().await?;
        if let Ok(l) = r { *g = Some(l); return Ok(()); }
        let gone = matches!(&r, Err((true, _)));
        let recently = self.launched_at.lock().unwrap().map(|t| t.elapsed() < LAUNCH_WAIT).unwrap_or(false);
        if gone && !recently {
            launch_app()?;
            *self.launched_at.lock().unwrap() = Some(Instant::now());
        }
        let deadline = Instant::now() + LAUNCH_WAIT;
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            r = try_existing().await?;
            if let Ok(l) = r { *g = Some(l); return Ok(()); }
        }
        Err(match r {
            Err((false, e)) => format!("FF Montage is running but does not answer ({e}). Restart FF Montage and try again."),
            _ => "Could not start or reach FF Montage within 45 s. Open FF Montage manually (if a folder setup window is shown, finish it) and try again.".into(),
        })
    }
}

async fn call(app: &App, name: &str, args: Value, tools: &[Value]) -> Result<Value, String> {
    if !tools.iter().any(|t| t["name"] == name) { return Err(format!("Unknown tool: {name}")); }
    let params = json!({ "tool": name, "args": if args.is_object() { args.clone() } else { json!({}) } });
    let mut res = send(app, "call", params.clone()).await;
    if let Err(e) = &res {
        // Канал оборвался (программу закрыли/перезапустили) — одна повторная попытка для безопасных инструментов
        if e.contains("Connection to FF Montage was lost") && (name == "get_project" || name == "export_status") {
            res = send(app, "call", params).await;
        }
    }
    let result = res?;
    if let Some(c) = result.get("__content").filter(|c| c.is_array()) {
        return Ok(json!({ "content": c }));
    }
    let text = match &result { Value::String(s) => s.clone(), v => serde_json::to_string_pretty(v).unwrap_or_default() };
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

/// Запрос к программе без удержания замка соединения во время ожидания ответа
async fn send(app: &App, method: &str, params: Value) -> Result<Value, String> {
    app.ensure().await?;
    let id = format!("r{}", app.seq.fetch_add(1, Ordering::SeqCst) + 1);
    let (tx, token, pending) = {
        let g = app.link.lock().await;
        let l = g.as_ref().ok_or("not connected")?;
        (l.tx.clone(), l.token.clone(), l.pending.clone())
    };
    let (t, r) = oneshot::channel();
    pending.lock().unwrap().insert(id.clone(), t);
    let msg = json!({ "id": id, "token": token, "method": method, "params": params });
    tx.send(format!("{msg}\n")).map_err(|_| "Connection to FF Montage was lost (the app was closed?).".to_string())?;
    match tokio::time::timeout(CALL_TIMEOUT, r).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => Err("Connection to FF Montage was lost (the app was closed?).".into()),
        Err(_) => { pending.lock().unwrap().remove(&id); Err("FF Montage did not answer in time.".into()) }
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value { json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }) }
fn rpc_result(id: Value, result: Value) -> Value { json!({ "jsonrpc": "2.0", "id": id, "result": result }) }

async fn handle(app: &App, msg: &Value, tools: &[Value], instructions: &str) -> Option<Value> {
    if !msg.is_object() || msg["jsonrpc"] != "2.0" {
        return Some(rpc_error(msg.get("id").cloned().unwrap_or(Value::Null), -32600, "Invalid Request"));
    }
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg["method"].as_str()?;
    if method.starts_with("notifications/") || id.is_null() { return None; }
    let params = &msg["params"];
    Some(match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            rpc_result(id, json!({
                "protocolVersion": if SUPPORTED.contains(&asked) { asked } else { LATEST },
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "ff-montage", "title": "FF Montage", "version": control::version() },
                "instructions": instructions,
            }))
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tools })),
        "tools/call" => {
            let Some(name) = params["name"].as_str() else { return Some(rpc_error(id, -32602, "Invalid params: name is required")) };
            if !tools.iter().any(|t| t["name"] == name) { return Some(rpc_error(id, -32602, &format!("Unknown tool: {name}"))); }
            match call(app, name, params["arguments"].clone(), tools).await {
                Ok(v) => rpc_result(id, v),
                Err(e) => {
                    log(&format!("tool {name} failed: {e}"));
                    rpc_result(id, json!({ "content": [{ "type": "text", "text": format!("Error: {e}") }], "isError": true }))
                }
            }
        }
        "resources/list" => rpc_result(id, json!({ "resources": [] })),
        "prompts/list" => rpc_result(id, json!({ "prompts": [] })),
        m => rpc_error(id, -32601, &format!("Method not found: {m}")),
    })
}

fn out(v: &Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

pub fn main() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    rt.block_on(async {
        let spec: Value = serde_json::from_str(TOOLS_JSON).expect("tools.json");
        let tools: Arc<Vec<Value>> = Arc::new(spec["tools"].as_array().cloned().unwrap_or_default());
        let instructions: Arc<String> = Arc::new(spec["instructions"].as_str().unwrap_or("").to_string());
        let app = Arc::new(App { link: tokio::sync::Mutex::new(None), seq: AtomicU64::new(0), launched_at: Mutex::new(None) });
        log(&format!("ready (app {}, config {})", control::version(), paths::get().config_file.display()));
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        let mut tasks = vec![];
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if line.is_empty() { continue; }
            let (app, tools, ins) = (app.clone(), tools.clone(), instructions.clone());
            tasks.push(tokio::spawn(async move {
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => { out(&rpc_error(Value::Null, -32700, "Parse error")); return; }
                };
                if let Some(arr) = msg.as_array() {
                    if arr.is_empty() { out(&rpc_error(Value::Null, -32600, "Invalid Request")); return; }
                    let mut res = vec![];
                    for m in arr { if let Some(r) = handle(&app, m, &tools, &ins).await { res.push(r); } }
                    if !res.is_empty() { out(&Value::Array(res)); }
                    return;
                }
                if let Some(r) = handle(&app, &msg, &tools, &ins).await { out(&r); }
            }));
            tasks.retain(|t| !t.is_finished());
        }
        for t in tasks { let _ = t.await; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    });
    std::process::exit(0);
}
