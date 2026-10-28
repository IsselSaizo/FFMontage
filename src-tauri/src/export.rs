// Запуск экспорта. Команду FFmpeg собирает окно (src/renderer/js/exportPlan.js),
// здесь — запуск, прогресс, отмена, журнал и замена файла по готовности.
use crate::{ff, paths};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tokio::io::AsyncReadExt;

#[derive(Deserialize, Debug)]
pub struct Plan {
    /// Аргументы ffmpeg; @@FILTER@@ — путь к файлу фильтра, @@OUT@@ — выходной файл
    pub args: Vec<String>,
    pub filter: String,
    pub duration: f64,
    pub output: String,
}

static RUNNING: Mutex<Option<tokio::sync::oneshot::Sender<()>>> = Mutex::new(None);
static CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn cancel() -> bool {
    if let Some(tx) = RUNNING.lock().unwrap().take() {
        CANCELLED.store(true, Ordering::SeqCst);
        let _ = tx.send(());
        true
    } else {
        false
    }
}

pub async fn run(plan: Plan, on_progress: impl Fn(Value) + Send + Sync) -> Result<Value, Value> {
    let err = |m: String, cancelled: bool| json!({ "message": m, "cancelled": cancelled });
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut g = RUNNING.lock().unwrap();
        if g.is_some() {
            return Err(err("Экспорт уже идёт.".into(), false));
        }
        *g = Some(tx);
    }
    CANCELLED.store(false, Ordering::SeqCst);
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) { RUNNING.lock().unwrap().take(); }
    }
    let _guard = Guard;

    let p = paths::get();
    let output = PathBuf::from(&plan.output);
    if let Some(d) = output.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::create_dir_all(&p.temp);
    let _ = std::fs::create_dir_all(&p.logs);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let filter_file = p.temp.join(format!("export-{stamp}.filter.txt"));
    std::fs::write(&filter_file, &plan.filter).map_err(|e| err(e.to_string(), false))?;
    let part = PathBuf::from(format!("{}.part", plan.output));
    let args: Vec<String> = plan.args.iter().map(|a| match a.as_str() {
        "@@FILTER@@" => filter_file.to_string_lossy().to_string(),
        "@@OUT@@" => part.to_string_lossy().to_string(),
        _ => a.clone(),
    }).collect();

    let bin = ff::find();
    let log_file = p.logs.join("last-export.log");
    let quoted: Vec<String> = args.iter().map(|a| if a.contains(char::is_whitespace) { format!("\"{a}\"") } else { a.clone() }).collect();
    let _ = std::fs::write(&log_file, format!("ffmpeg {}\n\n--- filter ---\n{}\n\n--- stderr ---\n", quoted.join(" "), plan.filter));

    let started = Instant::now();
    let mut child = ff::command(&bin.ffmpeg).args(&args).spawn().map_err(|e| err(format!("Не удалось запустить FFmpeg: {e}"), false))?;
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let duration = plan.duration.max(0.001);

    let read_out = async {
        let mut buf = vec![0u8; 16 * 1024];
        let mut text = String::new();
        let mut state: std::collections::HashMap<String, String> = Default::default();
        loop {
            let n = match so.read(&mut buf).await { Ok(0) | Err(_) => break, Ok(n) => n };
            text.push_str(&String::from_utf8_lossy(&buf[..n]));
            while let Some(i) = text.find('\n') {
                let line: String = text.drain(..=i).collect();
                let line = line.trim();
                if let Some((k, v)) = line.split_once('=') {
                    state.insert(k.to_string(), v.trim().to_string());
                }
                if line.starts_with("progress=") {
                    let us: f64 = state.get("out_time_us").or(state.get("out_time_ms")).and_then(|v| v.parse().ok()).unwrap_or(0.0);
                    let t = us / 1e6;
                    let frac = (t / duration).clamp(0.0, 1.0);
                    let elapsed = started.elapsed().as_secs_f64();
                    let eta = if frac > 0.01 { Value::from(elapsed * (1.0 - frac) / frac) } else { Value::Null };
                    on_progress(json!({
                        "fraction": frac, "time": t, "duration": duration, "elapsed": elapsed, "eta": eta,
                        "speed": state.get("speed").cloned().unwrap_or_default(),
                        "fps": state.get("fps").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
                        "size": state.get("total_size").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0),
                    }));
                }
            }
        }
    };
    let log2 = log_file.clone();
    let read_err = async move {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&log2).ok();
        let mut tail = String::new();
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = match se.read(&mut buf).await { Ok(0) | Err(_) => break, Ok(n) => n };
            if let Some(f) = f.as_mut() { let _ = f.write_all(&buf[..n]); }
            tail.push_str(&String::from_utf8_lossy(&buf[..n]));
            if tail.len() > 8000 {
                let cut = tail.len() - 4000;
                let cut = (cut..tail.len()).find(|&i| tail.is_char_boundary(i)).unwrap_or(tail.len());
                tail.drain(..cut);
            }
        }
        tail
    };
    let status = tokio::select! {
        (_, tail, st) = async { let (a, b) = tokio::join!(read_out, read_err); let st = child.wait().await; (a, b, st) } => Some((tail, st)),
        _ = &mut rx => None,
    };
    let _ = std::fs::remove_file(&filter_file);
    let Some((tail, st)) = status else {
        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = std::fs::remove_file(&part);
        return Err(err("Экспорт отменён.".into(), true));
    };
    if CANCELLED.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&part);
        return Err(err("Экспорт отменён.".into(), true));
    }
    let st = st.map_err(|e| err(e.to_string(), false))?;
    if !st.success() {
        let _ = std::fs::remove_file(&part);
        let lines: Vec<&str> = tail.trim().lines().filter(|l| !l.trim().is_empty()).collect();
        let last = lines[lines.len().saturating_sub(6)..].join("\n");
        return Err(err(format!("FFmpeg завершился с ошибкой (код {}).\n{last}", st.code().unwrap_or(-1)), false));
    }
    let _ = std::fs::remove_file(&output);
    std::fs::rename(&part, &output).map_err(|e| err(e.to_string(), false))?;
    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(json!({ "output": plan.output, "size": size, "duration": plan.duration, "elapsed": started.elapsed().as_secs_f64() }))
}
