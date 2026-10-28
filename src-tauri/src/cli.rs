// Движок без окна — для автотестов (tests/engine-test.js) и CI:
//   ff-montage --engine <команда>   (параметры — JSON в stdin, ответ — JSON в stdout)
// Команды: probe {file} | thumbs {info} | peaks {info} | proxy {info} | reverse {info,a,b} | freeze {info,at}
//          silence {file,threshold,min} | frame {file,t,width} | encoders | version | export {plan} | paths
use crate::{commands, export, ff, paths};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;

pub fn main(cmd: &str) {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let args: Value = serde_json::from_str(input.trim()).unwrap_or(json!({}));
    paths::ensure_dirs();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    let r: Result<Value, String> = rt.block_on(async {
        let bin = ff::find();
        let enc = || async { ff::detect_encoders(&ff::find()).await };
        let f = |k: &str| args[k].as_f64().unwrap_or(0.0);
        let file = || PathBuf::from(args["file"].as_str().unwrap_or_default());
        let noop = |_: f64| {};
        match cmd {
            "paths" => Ok(serde_json::to_value(paths::get()).unwrap_or_default()),
            "version" => Ok(json!({ "ffmpeg": bin.ffmpeg.to_string_lossy(), "missing": bin.missing, "version": ff::version_info(&bin).await })),
            "encoders" => Ok(enc().await),
            "probe" => ff::probe(&file()).await,
            "thumbs" => ff::thumbs(&args["info"]).await,
            "peaks" => ff::peaks(&args["info"], args["stream"].as_u64().unwrap_or(0) as usize).await,
            "astream" => ff::audio_stream(&args["info"], args["stream"].as_u64().unwrap_or(1) as usize).await.map(|p| json!(p.to_string_lossy())),
            "proxy" => ff::proxy(&args["info"], &noop, &enc().await).await.map(|p| json!(p.to_string_lossy())),
            "reverse" => ff::reverse(&args["info"], f("a"), f("b"), &noop, &enc().await).await.map(|p| json!(p.to_string_lossy())),
            "freeze" => ff::freeze(&args["info"], f("at"), &enc().await).await.map(|p| json!(p.to_string_lossy())),
            "silence" => ff::silence(&file(), args["threshold"].as_f64().unwrap_or(-35.0), args["min"].as_f64().unwrap_or(0.5)).await,
            "frame" => ff::frame_jpeg(&file(), f("t"), args["width"].as_f64().unwrap_or(640.0)).await.map(|b| json!(commands::base64(&b))),
            "export" => {
                let plan: export::Plan = serde_json::from_value(args["plan"].clone()).map_err(|e| e.to_string())?;
                let last = std::sync::Mutex::new(0.0f64);
                let r = export::run(plan, |p| { *last.lock().unwrap() = p["fraction"].as_f64().unwrap_or(0.0); }).await;
                let fr = *last.lock().unwrap();
                r.map(|mut v| { v["lastProgress"] = json!(fr); v }).map_err(|e| e["message"].as_str().unwrap_or("").to_string())
            }
            other => Err(format!("неизвестная команда: {other}")),
        }
    });
    let out = match r { Ok(v) => json!({ "ok": true, "result": v }), Err(e) => json!({ "ok": false, "error": e }) };
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{out}");
    let _ = o.flush();
    std::process::exit(if out["ok"] == true { 0 } else { 1 });
}
