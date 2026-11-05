// Запуск экспорта. Команду FFmpeg собирает окно (src/renderer/js/exportPlan.js),
// здесь — проверка плана (plancheck.rs), запуск, прогресс, отмена, журнал и замена файла по готовности.
use crate::{ff, paths, tr};
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

/// Отравленный Mutex (паника в другом потоке) не должен ронять экспорт и выход программы (R-7)
fn running() -> std::sync::MutexGuard<'static, Option<tokio::sync::oneshot::Sender<()>>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn busy() -> bool {
    running().is_some()
}

/// Видеокодек плана (последний -c:v; -c:v перед -i выбирает декодер входа)
fn video_codec(args: &[String]) -> Option<&str> {
    args.windows(2).rfind(|w| w[0] == "-c:v").map(|w| w[1].as_str())
}

pub fn cancel() -> bool {
    if let Some(tx) = running().take() {
        CANCELLED.store(true, Ordering::SeqCst);
        let _ = tx.send(());
        true
    } else {
        false
    }
}

/// inputs — какие входные файлы разрешены (окно / движок без окна); план проверяется до запуска FFmpeg (plancheck.rs)
pub async fn run(plan: Plan, inputs: crate::plancheck::Inputs, on_progress: impl Fn(Value) + Send + Sync) -> Result<Value, Value> {
    run_inner(plan, false, inputs, on_progress).await
}

/// Первый проход нормализации громкости (0.5.0): план звука (как у vst_render — без -f, выход @@OUT@@) с фильтром
/// loudnorm=…:print_format=json в конце графа; вывод — в никуда (-f null). Ответ — замер loudnorm:
/// { input_i, input_tp, input_lra, input_thresh, target_offset } (числа). Занимает «слот экспорта» — отменяется так же.
pub async fn measure_loudness(
    args: Vec<String>,
    filter: String,
    duration: f64,
    inputs: crate::plancheck::Inputs,
    on_progress: impl Fn(Value) + Send + Sync,
) -> Result<Value, Value> {
    let plan = Plan { args, filter, duration, output: String::new() };
    run_inner(plan, true, inputs, on_progress).await
}

/// Замер loudnorm из вывода FFmpeg: последний JSON-блок с input_i; значения — строки («-23.51», «-inf»)
pub fn parse_loudnorm(stderr: &str) -> Option<Value> {
    let end = stderr.rfind('}')?;
    let start = stderr[..end].rfind('{')?;
    let v: Value = serde_json::from_str(&stderr[start..=end]).ok()?;
    let num = |k: &str| -> Value {
        let s = v[k].as_str().map(str::trim).unwrap_or("");
        match s.parse::<f64>() {
            Ok(x) if x.is_finite() => json!(x),
            _ => Value::Null,
        }
    };
    v.get("input_i")?;
    Some(json!({
        "input_i": num("input_i"), "input_tp": num("input_tp"), "input_lra": num("input_lra"),
        "input_thresh": num("input_thresh"), "target_offset": num("target_offset"),
    }))
}

async fn run_inner(
    plan: Plan,
    measure: bool,
    inputs: crate::plancheck::Inputs,
    on_progress: impl Fn(Value) + Send + Sync,
) -> Result<Value, Value> {
    let err = |m: String, cancelled: bool| json!({ "message": m, "cancelled": cancelled });
    if measure {
        crate::plancheck::check_pcm(&plan.args, &plan.filter, plan.duration, inputs).map_err(|e| err(e, false))?;
        if !plan.filter.contains("loudnorm=") {
            return Err(err(tr!("в плане нет замера громкости", "the plan has no loudness measurement").into(), false));
        }
    } else {
        crate::plancheck::check(&plan.args, &plan.filter, plan.duration, &plan.output, inputs).map_err(|e| err(e, false))?;
    }
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut g = running();
        if g.is_some() {
            return Err(err(tr!("Экспорт уже идёт.", "An export is already running.").into(), false));
        }
        *g = Some(tx);
    }
    CANCELLED.store(false, Ordering::SeqCst);
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            running().take();
        }
    }
    let _guard = Guard;
    // M0.4: экспорт идёт вне очереди, но на видеокарте занимает её слот — фоновые задачи NVENC подождут
    let _gpu_slot = video_codec(&plan.args).filter(|c| crate::plancheck::gpu_codec(c)).map(|_| crate::queue::gpu().take_now());

    let p = paths::get();
    let output = PathBuf::from(&plan.output);
    if !measure {
        if let Some(d) = output.parent() {
            let _ = std::fs::create_dir_all(d);
        }
    }
    let _ = std::fs::create_dir_all(&p.temp);
    let _ = std::fs::create_dir_all(&p.logs);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let filter_file = p.temp.join(format!("export-{stamp}.filter.txt"));
    std::fs::write(&filter_file, &plan.filter).map_err(|e| err(e.to_string(), false))?;
    // Замер громкости файла не пишет — части нет (путь «.part» относительно папки процесса трогать нельзя)
    let part = (!measure).then(|| PathBuf::from(format!("{}.part", plan.output)));
    let drop_part = || {
        if let Some(p) = &part {
            let _ = std::fs::remove_file(p);
        }
    };
    let mut args: Vec<String> = vec![];
    for a in &plan.args {
        match a.as_str() {
            "@@FILTER@@" => args.push(filter_file.to_string_lossy().to_string()),
            // Замер: прогресс в stdout, звук — в никуда
            "@@OUT@@" if measure => args.extend(["-progress", "pipe:1", "-nostats", "-f", "null", "-"].map(String::from)),
            "@@OUT@@" => args.push(part.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()),
            _ => args.push(a.clone()),
        }
    }

    let bin = ff::find();
    let log_file = p.logs.join(if measure { "last-loudness.log" } else { "last-export.log" });
    let quoted: Vec<String> = args.iter().map(|a| if a.contains(char::is_whitespace) { format!("\"{a}\"") } else { a.clone() }).collect();
    let _ = std::fs::write(&log_file, format!("ffmpeg {}\n\n--- filter ---\n{}\n\n--- stderr ---\n", quoted.join(" "), plan.filter));

    let started = Instant::now();
    let _part_guard = part.as_ref().map(|p| crate::procs::part(p));
    let mut child = ff::command(&bin.ffmpeg)
        .args(&args)
        .spawn()
        .map_err(|e| err(tr!("Не удалось запустить FFmpeg: {}", "Cannot start FFmpeg: {}", e), false))?;
    let _tracked = crate::procs::track(&child);
    let (Some(mut so), Some(mut se)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill().await;
        return Err(err(tr!("Не удалось запустить FFmpeg: нет вывода", "Cannot start FFmpeg: no output pipes").into(), false));
    };
    let duration = plan.duration.max(0.001);

    let read_out = async {
        let mut buf = vec![0u8; 16 * 1024];
        let mut text = String::new();
        let mut state: std::collections::HashMap<String, String> = Default::default();
        loop {
            let n = match so.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
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
            let n = match se.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if let Some(f) = f.as_mut() {
                let _ = f.write_all(&buf[..n]);
            }
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
        drop_part();
        return Err(err(tr!("Экспорт отменён.", "Export cancelled.").into(), true));
    };
    if CANCELLED.load(Ordering::SeqCst) {
        drop_part();
        return Err(err(tr!("Экспорт отменён.", "Export cancelled.").into(), true));
    }
    let st = st.map_err(|e| err(e.to_string(), false))?;
    if !st.success() {
        drop_part();
        let lines: Vec<&str> = tail.trim().lines().filter(|l| !l.trim().is_empty()).collect();
        let last = lines[lines.len().saturating_sub(6)..].join("\n");
        // Отчёт: команда, граф и вывод FFmpeg целиком (большой журнал — начало и конец)
        // Байты, а не строка: FFmpeg выводит теги как есть (Latin-1 и т. п.) — read_to_string дал бы пустой отчёт
        let body = crate::crashlog::head_tail(&log_file, 100_000);
        crate::crashlog::report("export-failed", &format!("FFmpeg exit code {}", st.code().unwrap_or(-1)), &body, None);
        return Err(err(
            tr!("FFmpeg завершился с ошибкой (код {}).\n{}", "FFmpeg failed (code {}).\n{}", st.code().unwrap_or(-1), last),
            false,
        ));
    }
    if measure {
        return parse_loudnorm(&tail)
            .ok_or_else(|| err(tr!("FFmpeg не сообщил громкость", "FFmpeg did not report the loudness").into(), false));
    }
    let Some(part) = part else { return Err(err("part".into(), false)) };
    let _ = std::fs::remove_file(&output);
    std::fs::rename(&part, &output).map_err(|e| err(e.to_string(), false))?;
    let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    Ok(json!({ "output": plan.output, "size": size, "duration": plan.duration, "elapsed": started.elapsed().as_secs_f64() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loudnorm_json() {
        let err = "[Parsed_loudnorm_5 @ 000001] \n{\n\t\"input_i\" : \"-27.61\",\n\t\"input_tp\" : \"-4.47\",\n\t\"input_lra\" : \"18.06\",\n\t\"input_thresh\" : \"-39.20\",\n\t\"output_i\" : \"-16.58\",\n\t\"target_offset\" : \"0.58\"\n}\n[out#0/null @ 0] audio:1kB\n";
        let v = parse_loudnorm(err).unwrap();
        assert_eq!(v["input_i"], json!(-27.61));
        assert_eq!(v["input_thresh"], json!(-39.2));
        assert_eq!(v["target_offset"], json!(0.58));
        // тишина: -inf → null
        let v = parse_loudnorm("{ \"input_i\" : \"-inf\", \"input_tp\" : \"-inf\" }").unwrap();
        assert!(v["input_i"].is_null());
        assert!(parse_loudnorm("no json").is_none());
        assert!(parse_loudnorm("{ \"x\": 1 }").is_none());
    }

    #[test]
    fn codec_of_plan() {
        let a: Vec<String> =
            ["-c:v", "libvpx-vp9", "-i", "x.webm", "-c:v", "hevc_amf", "-f", "mp4"].iter().map(|s| s.to_string()).collect();
        assert_eq!(video_codec(&a), Some("hevc_amf"));
        assert!(crate::plancheck::gpu_codec(video_codec(&a).unwrap()));
        assert_eq!(video_codec(&a[..4]), Some("libvpx-vp9"));
        assert_eq!(video_codec(&[]), None);
        // отравленный RUNNING не роняет busy/cancel
        let _ = std::thread::spawn(|| {
            let _g = RUNNING.lock().unwrap();
            panic!("отравить");
        })
        .join(); // i18n-ignore — тест
        assert!(!busy());
        assert!(!cancel());
    }
}
