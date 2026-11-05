// Аудиоплагины VST3 и CLAP (Windows x64). Устройство — как у REAPER:
//   • плагины работают только в отдельном процессе-хосте `ff-montage --vst-host …` (host.rs): падение плагина
//     не роняет программу;
//   • сканирование — по одному файлу в своём процессе с тайм-аутом, результат — в <data>/audio-plugins.json
//     с ключом «путь + размер + время» (как reaper-vstplugins64.ini); сбойный файл не сканируется повторно,
//     пока не изменится;
//   • полное состояние плагина хранится в проекте (base64), звук для плеера и экспорта — офлайн-рендер в кэш
//     (<cache>/audio-fx/<sha1>.wav), при открытом окне плагина — живое прослушивание (WASAPI в хосте).
// Контракт с окном — .agent/vst3-contract.md.
#[cfg(windows)]
mod clap;
#[cfg(windows)]
mod com;
#[cfg(windows)]
mod fx;
#[cfg(windows)]
pub mod host;
#[cfg(windows)]
mod vst3;
#[cfg(windows)]
mod wasapi;

use crate::{ff, paths, plancheck, protocol, settings, tr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

type R<T> = Result<T, String>;

pub const SUPPORTED: bool = cfg!(all(windows, target_arch = "x86_64"));
const SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const DB_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Папки и кэш сканирования
// ---------------------------------------------------------------------------
/// Свои плагины пользователя (кнопка «Добавить плагин…»)
pub fn user_dir() -> PathBuf {
    paths::get().data_dir.join("audio-plugins")
}

fn db_file() -> PathBuf {
    paths::get().data_dir.join("audio-plugins.json")
}

/// Стандартные папки VST3 и CLAP + папка программы + CLAP_PATH.
/// FFM_AUDIO_PLUGIN_PATH (автотесты) — только эти папки и папка программы, системные не сканируются.
pub fn default_folders() -> Vec<PathBuf> {
    let mut v = vec![];
    if let Some(p) = std::env::var_os("FFM_AUDIO_PLUGIN_PATH") {
        v.extend(std::env::split_paths(&p).filter(|p| p.is_absolute()));
        v.push(user_dir());
        return v;
    }
    if let Some(c) = std::env::var_os("CommonProgramFiles") {
        let c = PathBuf::from(c);
        v.push(c.join("VST3"));
        v.push(c.join("CLAP"));
    }
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        let l = PathBuf::from(l).join("Programs").join("Common");
        v.push(l.join("VST3"));
        v.push(l.join("CLAP"));
    }
    v.push(user_dir());
    if let Some(p) = std::env::var_os("CLAP_PATH") {
        v.extend(std::env::split_paths(&p).filter(|p| p.is_absolute()));
    }
    v
}

fn user_folders() -> Vec<PathBuf> {
    settings::load()["vst"]["folders"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(PathBuf::from).filter(|p| p.is_absolute()).collect())
        .unwrap_or_default()
}

fn all_folders() -> Vec<PathBuf> {
    let mut v = default_folders();
    for f in user_folders() {
        if !v.contains(&f) {
            v.push(f);
        }
    }
    v
}

fn plugin_ext(p: &Path) -> Option<&'static str> {
    let e = p.extension()?.to_string_lossy().to_ascii_lowercase();
    match e.as_str() {
        "vst3" => Some("vst3"),
        "clap" => Some("clap"),
        _ => None,
    }
}

/// Плагины в папках: файл .vst3/.clap или пакет-папка .vst3 (внутрь пакета не заходим)
fn discover(folders: &[PathBuf]) -> Vec<PathBuf> {
    fn walk(d: &Path, depth: u32, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            match plugin_ext(&p) {
                Some(_) => out.push(p),
                None if is_dir && depth > 0 => walk(&p, depth - 1, out),
                None => {}
            }
        }
    }
    let mut out = vec![];
    for f in folders {
        walk(f, 6, &mut out);
    }
    out.sort();
    out.dedup();
    out
}

/// «Подпись» файла плагина: размер и время изменения (у пакета — самой DLL)
fn signature(p: &Path) -> (u64, u64) {
    let target = if p.is_dir() {
        let arch = p.join("Contents").join("x86_64-win");
        std::fs::read_dir(&arch)
            .ok()
            .and_then(|rd| rd.flatten().map(|e| e.path()).find(|x| plugin_ext(x).is_some()))
            .unwrap_or_else(|| p.to_path_buf())
    } else {
        p.to_path_buf()
    };
    let m = std::fs::metadata(&target).ok();
    let size = m.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime =
        m.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    (size, mtime)
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Entry {
    size: u64,
    mtime: u64,
    #[serde(default)]
    classes: Vec<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Db {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

static DB_LOCK: Mutex<()> = Mutex::new(());

fn db_load() -> Db {
    let db: Db = std::fs::read_to_string(db_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if db.version != DB_VERSION {
        return Db { version: DB_VERSION, ..Default::default() };
    }
    db
}

fn db_save(db: &Db) {
    let text = serde_json::to_string_pretty(db).unwrap_or_default();
    let _ = paths::write_atomic(&db_file(), text.as_bytes());
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

pub fn list() -> Value {
    let _g = DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let db = db_load();
    let mut plugins = vec![];
    let mut failed = vec![];
    for (path, e) in &db.entries {
        if let Some(err) = &e.error {
            failed.push(json!({ "path": path, "error": err }));
            continue;
        }
        for c in &e.classes {
            let mut c = c.clone();
            c["path"] = json!(path);
            plugins.push(c);
        }
    }
    plugins.sort_by_key(|c| (c["vendor"].as_str().unwrap_or("").to_lowercase(), c["name"].as_str().unwrap_or("").to_lowercase()));
    json!({
        "supported": SUPPORTED,
        "plugins": plugins,
        "failed": failed,
        "folders": user_folders().iter().map(|p| s(p)).collect::<Vec<_>>(),
        "defaults": default_folders().iter().map(|p| s(p)).collect::<Vec<_>>(),
        "userDir": s(&user_dir()),
    })
}

/// uid → (путь файла плагина, описание)
fn find(uid: &str) -> Option<(PathBuf, Value)> {
    let _g = DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let db = db_load();
    for (path, e) in &db.entries {
        if let Some(c) = e.classes.iter().find(|c| c["uid"].as_str() == Some(uid)) {
            return Some((PathBuf::from(path), c.clone()));
        }
    }
    None
}

fn self_exe() -> R<PathBuf> {
    std::env::current_exe().map_err(|e| e.to_string())
}

fn host_cmd() -> R<tokio::process::Command> {
    let mut c = ff::command(&self_exe()?);
    c.arg("--vst-host");
    Ok(c)
}

/// Один файл — в своём процессе с тайм-аутом
async fn scan_one(path: &Path) -> R<Vec<Value>> {
    let mut cmd = host_cmd()?;
    cmd.arg("scan").arg(path);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let _t = crate::procs::track(&child);
    let out = match tokio::time::timeout(SCAN_TIMEOUT, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| e.to_string())?,
        Err(_) => return Err(tr!("плагин не ответил за {} с", "the plugin did not respond in {} s", SCAN_TIMEOUT.as_secs())),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let v: Value = serde_json::from_str(last).unwrap_or(Value::Null);
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_string());
    }
    if !out.status.success() || !v["classes"].is_array() {
        return Err(tr!(
            "процесс плагина завершился с ошибкой (код {})",
            "the plugin process failed (code {})",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(v["classes"].as_array().cloned().unwrap_or_default())
}

pub async fn scan(force: bool, on_progress: impl Fn(usize, usize, &str)) -> Value {
    if !SUPPORTED {
        return list();
    }
    let found = discover(&all_folders());
    let old = {
        let _g = DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        db_load()
    };
    let mut entries: BTreeMap<String, Entry> = BTreeMap::new();
    let mut todo = vec![];
    for p in &found {
        let key = s(p);
        let (size, mtime) = signature(p);
        match old.entries.get(&key) {
            Some(e) if !force && e.size == size && e.mtime == mtime => {
                entries.insert(key, e.clone());
            }
            _ => todo.push((p.clone(), size, mtime)),
        }
    }
    let total = todo.len();
    let mut set = tokio::task::JoinSet::new();
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    for (p, size, mtime) in todo {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await;
            let r = scan_one(&p).await;
            (p, size, mtime, r)
        });
    }
    let mut done = 0;
    while let Some(Ok((p, size, mtime, r))) = set.join_next().await {
        done += 1;
        on_progress(done, total, &s(&p));
        let e = match r {
            Ok(classes) => Entry { size, mtime, classes, error: None },
            Err(err) => Entry { size, mtime, classes: vec![], error: Some(err) },
        };
        entries.insert(s(&p), e);
    }
    {
        let _g = DB_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        db_save(&Db { version: DB_VERSION, entries });
    }
    list()
}

// ---------------------------------------------------------------------------
// Сведения о плагине: состояние по умолчанию, параметры, есть ли окно
// ---------------------------------------------------------------------------
fn spec_of(uid: &str, state: &Value, ctrl: &Value, params: &Value) -> R<Value> {
    let (path, _) = find(uid).ok_or_else(|| tr!("плагин не найден: {}", "plugin not found: {}", uid))?;
    Ok(json!({ "path": s(&path), "uid": uid, "state": state, "ctrl": ctrl, "params": params }))
}

pub async fn info(uid: &str, state: &Value, ctrl: &Value, params: &Value) -> R<Value> {
    let spec = spec_of(uid, state, ctrl, params)?;
    let mut cmd = host_cmd()?;
    cmd.arg("info").stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let _t = crate::procs::track(&child);
    if let Some(mut i) = child.stdin.take() {
        let _ = i.write_all(spec.to_string().as_bytes()).await;
    }
    let out = tokio::time::timeout(SCAN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| tr!("плагин не ответил за {} с", "the plugin did not respond in {} s", SCAN_TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let v: Value = serde_json::from_str(last).unwrap_or(Value::Null);
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_string());
    }
    if v.is_null() {
        return Err(tr!(
            "процесс плагина завершился с ошибкой (код {})",
            "the plugin process failed (code {})",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(v)
}

// ---------------------------------------------------------------------------
// Офлайн-рендер: вход (кусок файла или граф дорожки) → стадии (фильтры FFmpeg / плагины) → WAV в кэше
// ---------------------------------------------------------------------------
const PCM: [&str; 6] = ["-f", "f32le", "-ar", "48000", "-ac", "2"];

fn atempo(sp: f64) -> String {
    let mut parts = vec![];
    let mut r = sp;
    while r > 2.0 + 1e-9 {
        parts.push("atempo=2".to_string());
        r /= 2.0;
    }
    while r < 0.5 - 1e-9 {
        parts.push("atempo=0.5".to_string());
        r /= 0.5;
    }
    if (r - 1.0).abs() > 1e-9 {
        parts.push(format!("atempo={r:.6}"));
    }
    parts.join(",")
}

fn n6(v: f64) -> String {
    format!("{v:.6}")
}

enum Stage {
    Ff(String),
    Plugins(Vec<Value>),
}

/// Один ключ — один рендер за раз
static RENDERING: Mutex<Option<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>> = Mutex::new(None);

fn key_lock(key: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut g = RENDERING.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashMap::new).entry(key.to_string()).or_default().clone()
}

fn done(out: &Path, key: &str, cached: bool) -> Value {
    protocol::allow(out);
    json!({ "path": s(out), "url": protocol::url(out), "key": key, "cached": cached })
}

pub async fn render(job: &Value, inputs: plancheck::Inputs, on_progress: impl Fn(f64) + Send + Sync) -> R<Value> {
    // 0.5.0: рендер без плагинов (только стадии FFmpeg — шумоподавление для плеера) работает везде
    let has_plugins = job["stages"].as_array().is_some_and(|a| a.iter().any(|s| s["vst"].is_object()));
    if !SUPPORTED && has_plugins {
        return Err(tr!("аудиоплагины поддерживаются только в Windows x64", "audio plugins are supported on Windows x64 only").into());
    }
    let dur = job["dur"].as_f64().unwrap_or(0.0);
    if !dur.is_finite() || dur <= 0.0 || dur > 7.0 * 24.0 * 3600.0 {
        return Err(tr!("неверная длительность", "invalid duration").into());
    }
    // Стадии и ключ кэша (с подписями файлов плагинов: новая версия плагина — новый рендер)
    let mut stages: Vec<Stage> = vec![];
    let mut sigs = vec![];
    for st in job["stages"].as_array().cloned().unwrap_or_default() {
        if let Some(af) = st["af"].as_str() {
            if af.trim().is_empty() {
                continue;
            }
            plancheck::check_chain(af, inputs)?;
            stages.push(Stage::Ff(af.to_string()));
        } else if st["vst"].is_object() {
            let v = &st["vst"];
            let uid = v["uid"].as_str().unwrap_or_default();
            let spec = spec_of(uid, &v["state"], &v["ctrl"], &v["params"])?;
            sigs.push(json!(signature(Path::new(spec["path"].as_str().unwrap_or_default()))));
            match stages.last_mut() {
                Some(Stage::Plugins(list)) => list.push(spec),
                _ => stages.push(Stage::Plugins(vec![spec])),
            }
        } else {
            return Err(tr!("неизвестная стадия рендера", "unknown render stage").into());
        }
    }
    let input = &job["input"];
    let mut h = Sha1::new();
    let mut keyed = job.clone();
    if let Some(o) = keyed.as_object_mut() {
        o.remove("tag"); // метка для событий прогресса — не часть звука
    }
    h.update(keyed.to_string().as_bytes());
    h.update(Value::Array(sigs).to_string().as_bytes());
    if let Some(f) = input["file"].as_str() {
        h.update(json!(signature(Path::new(f))).to_string().as_bytes());
    }
    let key: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let dir = crate::cache::audiofx_dir();
    let _ = std::fs::create_dir_all(&dir);
    let out = dir.join(format!("{key}.wav"));
    let lock = key_lock(&key);
    let _g = lock.lock().await;
    if out.is_file() {
        return Ok(done(&out, &key, true));
    }
    let _slot = crate::queue::cpu().acquire().await;
    let bin = ff::find();
    let p = paths::get();
    let _ = std::fs::create_dir_all(&p.temp);
    let mut temps: Vec<PathBuf> = vec![];
    let ffbase = |c: &mut tokio::process::Command| {
        c.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
    };

    // 1. Источник → f32le stdout
    let mut first = ff::command(&bin.ffmpeg);
    ffbase(&mut first);
    match input["kind"].as_str() {
        Some("clip") => {
            let file = plancheck::input_allowed(input["file"].as_str().unwrap_or_default(), inputs)
                .map_err(|e| tr!("План экспорта отклонён: {}", "Export plan rejected: {}", e))?;
            let stream = input["stream"].as_u64().unwrap_or(0).min(64);
            let start = input["in"].as_f64().unwrap_or(0.0).max(0.0);
            let speed = input["speed"].as_f64().unwrap_or(1.0);
            if !speed.is_finite() || !(0.05..=100.0).contains(&speed) {
                return Err(tr!("неверная скорость", "invalid speed").into());
            }
            let cdur = input["dur"].as_f64().unwrap_or(dur).max(0.001);
            let mut af = "aresample=48000,aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo".to_string();
            // 0.5.1: клип одного канала многоканального потока — этот канал двойным моно (audioLayout.js channelPick)
            if let Some(ch) = input["channel"].as_u64().filter(|c| *c < 64) {
                af = format!("pan=stereo|c0=c{ch}|c1=c{ch},{af}");
            }
            let t = atempo(speed);
            if !t.is_empty() {
                af = format!("{af},{t}");
            }
            first.args(["-ss", &n6(start), "-t", &n6(cdur * speed), "-i"]).arg(&file);
            first.args(["-map", &format!("0:a:{stream}"), "-vn", "-af", &af]);
        }
        Some("graph") => {
            let plan = &input["plan"];
            let args: Vec<String> = serde_json::from_value(plan["args"].clone()).map_err(|e| e.to_string())?;
            let filter = plan["filter"].as_str().unwrap_or_default();
            let pdur = plan["duration"].as_f64().unwrap_or(dur);
            plancheck::check_pcm(&args, filter, pdur, inputs)?;
            let ff = p.temp.join(format!("audiofx-{key}.filter.txt"));
            std::fs::write(&ff, filter).map_err(|e| e.to_string())?;
            temps.push(ff.clone());
            for a in &args {
                match a.as_str() {
                    "@@FILTER@@" => {
                        first.arg(&ff);
                    }
                    "@@OUT@@" => {}
                    _ => {
                        first.arg(a);
                    }
                }
            }
        }
        _ => return Err(tr!("неизвестный вход рендера", "unknown render input").into()),
    }
    first.args(PCM).arg("pipe:1");

    // 2. Стадии; 3. запись WAV
    let part = dir.join(format!("{key}.part.wav"));
    let _part = crate::procs::part(&part);
    let mut procs: Vec<(String, tokio::process::Child)> = vec![];
    fn spawn(
        procs: &mut Vec<(String, tokio::process::Child)>,
        name: String,
        mut c: tokio::process::Command,
        input: Option<Stdio>,
    ) -> R<()> {
        if let Some(i) = input {
            c.stdin(i);
        }
        let ch = c.spawn().map_err(|e| tr!("Не удалось запустить {}: {}", "Cannot start {}: {}", name, e))?;
        procs.push((name, ch));
        Ok(())
    }
    spawn(&mut procs, "FFmpeg".into(), first, None)?;
    for st in &stages {
        let prev: Stdio =
            procs.last_mut().and_then(|x| x.1.stdout.take()).ok_or("pipe")?.try_into().map_err(|e: std::io::Error| e.to_string())?;
        match st {
            Stage::Ff(af) => {
                let mut c = ff::command(&bin.ffmpeg);
                ffbase(&mut c);
                c.args(PCM).args(["-i", "pipe:0", "-af", af]).args(PCM).arg("pipe:1");
                spawn(&mut procs, "FFmpeg".into(), c, Some(prev))?;
            }
            Stage::Plugins(list) => {
                let jf = p.temp.join(format!("audiofx-{key}-{}.json", procs.len()));
                std::fs::write(&jf, json!({ "chain": list }).to_string()).map_err(|e| e.to_string())?;
                temps.push(jf.clone());
                let mut c = host_cmd()?;
                c.arg("render").arg(&jf);
                let names: Vec<&str> = list.iter().filter_map(|x| x["uid"].as_str()).collect();
                spawn(&mut procs, tr!("плагин {}", "plugin {}", names.join(", ")), c, Some(prev))?;
            }
        }
    }
    let mut last_out = procs.last_mut().and_then(|x| x.1.stdout.take()).ok_or("pipe")?;
    let mut fin = ff::command(&bin.ffmpeg);
    ffbase(&mut fin);
    fin.args(PCM).args(["-i", "pipe:0", "-af", "apad", "-t", &n6(dur), "-c:a", "pcm_f32le", "-f", "wav", "-y"]).arg(&part);
    fin.stdin(Stdio::piped());
    let mut fin = fin.spawn().map_err(|e| e.to_string())?;
    let _trk: Vec<crate::procs::Tracked> = procs.iter().map(|x| crate::procs::track(&x.1)).chain([crate::procs::track(&fin)]).collect();
    let mut fin_in = fin.stdin.take().ok_or("pipe")?;
    // Перекачка последней стадии в запись — заодно прогресс
    let total = (dur * 48000.0 * 8.0).max(1.0);
    let pump = async {
        let mut buf = vec![0u8; 1 << 16];
        let mut n_all = 0u64;
        let mut last = 0.0;
        loop {
            let n = match last_out.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if fin_in.write_all(&buf[..n]).await.is_err() {
                break;
            }
            n_all += n as u64;
            let f = (n_all as f64 / total).min(1.0);
            if f - last >= 0.01 {
                last = f;
                on_progress(f);
            }
        }
        drop(fin_in);
    };
    // stderr всех процессов — для сообщения об ошибке
    let mut errs = vec![];
    for (name, ch) in procs.iter_mut() {
        if let Some(mut e) = ch.stderr.take() {
            let name = name.clone();
            errs.push(tokio::spawn(async move {
                let mut t = String::new();
                let _ = e.read_to_string(&mut t).await;
                (name, t)
            }));
        }
    }
    let fin_err = fin.stderr.take();
    let fin_err_task = tokio::spawn(async move {
        let mut t = String::new();
        if let Some(mut e) = fin_err {
            let _ = e.read_to_string(&mut t).await;
        }
        t
    });
    pump.await;
    let mut failure: Option<String> = None;
    for (i, (name, ch)) in procs.iter_mut().enumerate() {
        let st = ch.wait().await.map_err(|e| e.to_string())?;
        let text = match errs.get_mut(i) {
            Some(t) => t.await.map(|x| x.1).unwrap_or_default(),
            None => String::new(),
        };
        if !st.success() && failure.is_none() {
            let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
            let tail = tail[tail.len().saturating_sub(3)..].join(" | ");
            let msg = if tail.starts_with('{') {
                serde_json::from_str::<Value>(&tail).ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or(tail)
            } else {
                tail
            };
            failure = Some(tr!("{} завершился с ошибкой (код {}): {}", "{} failed (code {}): {}", name, st.code().unwrap_or(-1), msg));
        }
    }
    let fst = fin.wait().await.map_err(|e| e.to_string())?;
    let ftext = fin_err_task.await.unwrap_or_default();
    for t in &temps {
        let _ = std::fs::remove_file(t);
    }
    if failure.is_none() && !fst.success() {
        failure = Some(tr!("FFmpeg завершился с ошибкой: {}", "FFmpeg failed: {}", ftext.trim()));
    }
    if let Some(f) = failure {
        let _ = std::fs::remove_file(&part);
        return Err(f);
    }
    std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
    on_progress(1.0);
    Ok(done(&out, &key, false))
}

// ---------------------------------------------------------------------------
// Окно плагина (сессия = процесс хоста в режиме editor)
// ---------------------------------------------------------------------------
struct Session {
    stdin: std::sync::Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
}

static SESSIONS: Mutex<Option<HashMap<String, Session>>> = Mutex::new(None);

fn sessions() -> std::sync::MutexGuard<'static, Option<HashMap<String, Session>>> {
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner())
}

async fn send(session: &str, cmd: &Value) -> bool {
    let stdin = sessions().as_ref().and_then(|m| m.get(session)).map(|s| s.stdin.clone());
    let Some(stdin) = stdin else { return false };
    let mut g = stdin.lock().await;
    g.write_all(format!("{cmd}\n").as_bytes()).await.is_ok() && g.flush().await.is_ok()
}

pub async fn editor_open(app: AppHandle, session: String, cfg: Value) -> R<Value> {
    if !SUPPORTED {
        return Err(tr!("аудиоплагины поддерживаются только в Windows x64", "audio plugins are supported on Windows x64 only").into());
    }
    if session.is_empty() || session.len() > 128 {
        return Err("bad session".into());
    }
    if sessions().as_ref().is_some_and(|m| m.contains_key(&session)) {
        send(&session, &json!({ "op": "focus" })).await;
        return Ok(json!({ "ok": true, "reused": true }));
    }
    let uid = cfg["uid"].as_str().unwrap_or_default();
    let mut spec = spec_of(uid, &cfg["state"], &cfg["ctrl"], &cfg["params"])?;
    spec["title"] = json!(cfg["title"].as_str().unwrap_or("Plugin").chars().take(200).collect::<String>());
    if let Some(w) = cfg["audition"]["wav"].as_str() {
        // Только файлы рендера из кэша
        let wp = PathBuf::from(w);
        let dir = crate::cache::audiofx_dir();
        if wp.parent().map(paths::normalize) != Some(paths::normalize(&dir)) || !wp.is_file() {
            return Err(tr!("файл прослушивания не разрешён", "the audition file is not allowed").into());
        }
        spec["audition"] = json!({ "wav": w, "pos": cfg["audition"]["pos"].as_f64().unwrap_or(0.0) });
    }
    let mut cmd = host_cmd()?;
    cmd.arg("editor").stdin(Stdio::piped()).kill_on_drop(false);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let tracked = crate::procs::track(&child);
    let mut stdin = child.stdin.take().ok_or("pipe")?;
    stdin.write_all(format!("{spec}\n").as_bytes()).await.map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("pipe")?;
    let stderr = child.stderr.take();
    sessions()
        .get_or_insert_with(HashMap::new)
        .insert(session.clone(), Session { stdin: std::sync::Arc::new(tokio::sync::Mutex::new(stdin)) });
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    let sid = session.clone();
    tauri::async_runtime::spawn(async move {
        let _tracked = tracked;
        let mut tx = Some(tx);
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut closed_ok = false;
        let mut first_error: Option<String> = None;
        if let Some(mut e) = stderr {
            tokio::spawn(async move {
                let mut sink = vec![];
                let _ = e.read_to_end(&mut sink).await;
            });
        }
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
            if let Some(e) = v["error"].as_str() {
                first_error = Some(e.to_string());
                if let Some(t) = tx.take() {
                    let _ = t.send(json!({ "error": e }));
                }
                continue;
            }
            match v["ev"].as_str().unwrap_or("") {
                "ready" => {
                    let _ = app.emit("vst:editor", json!({ "session": sid, "hasEditor": v["hasEditor"], "width": v["width"], "height": v["height"], "latency": v["latency"] }));
                    if let Some(t) = tx.take() {
                        let _ = t.send(v.clone());
                    }
                }
                "state" => {
                    let _ = app.emit("vst:state", json!({ "session": sid, "state": v["state"], "ctrl": v["ctrl"] }));
                }
                "error" => {
                    let _ = app.emit("vst:error", json!({ "session": sid, "message": v["message"] }));
                }
                "closed" => closed_ok = true,
                _ => {}
            }
        }
        let st = child.wait().await.ok();
        sessions().as_mut().map(|m| m.remove(&sid));
        let error = if closed_ok {
            Value::Null
        } else {
            json!(first_error.unwrap_or_else(|| tr!(
                "процесс плагина завершился аварийно (код {})",
                "the plugin process crashed (code {})",
                st.and_then(|s| s.code()).unwrap_or(-1)
            )))
        };
        if let Some(t) = tx.take() {
            let _ = t.send(json!({ "error": error }));
        }
        let _ = app.emit("vst:closed", json!({ "session": sid, "error": error }));
    });
    let r = tokio::time::timeout(SCAN_TIMEOUT, rx)
        .await
        .map_err(|_| tr!("плагин не ответил за {} с", "the plugin did not respond in {} s", SCAN_TIMEOUT.as_secs()))?;
    let v = r.map_err(|e| e.to_string())?;
    if let Some(e) = v["error"].as_str() {
        return Err(e.to_string());
    }
    Ok(json!({ "ok": true, "hasEditor": v["hasEditor"], "latency": v["latency"] }))
}

pub fn close_all() {
    // Процессы хоста сами выходят, когда закрывается их stdin (программа завершилась), и сидят в Job Object
    sessions().take();
}

// ---------------------------------------------------------------------------
// Команды окна
// ---------------------------------------------------------------------------
#[tauri::command]
pub fn vst_supported() -> bool {
    SUPPORTED
}

#[tauri::command]
pub async fn vst_list() -> Value {
    tauri::async_runtime::spawn_blocking(list).await.unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn vst_scan(app: AppHandle, force: Option<bool>) -> Value {
    scan(force.unwrap_or(false), |done, total, path| {
        let _ = app.emit("vst:scan", json!({ "done": done, "total": total, "path": path }));
    })
    .await
}

#[tauri::command]
pub async fn vst_folders_set(app: AppHandle, folders: Vec<String>) -> R<Value> {
    let list: Vec<String> = folders.into_iter().filter(|f| Path::new(f).is_absolute()).take(64).collect();
    settings::patch(&json!({ "vst": { "folders": list } }))?;
    Ok(vst_scan(app, Some(false)).await)
}

#[tauri::command]
pub async fn vst_pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(tr!("Папка с аудиоплагинами", "Audio plugin folder")).pick_folder(move |p| {
        let _ = tx.send(p.and_then(|p| p.into_path().ok()));
    });
    rx.await.ok().flatten().map(|p| s(&p))
}

/// Копия плагина (.vst3 — файл или пакет, .clap) в папку программы и пересканирование
#[tauri::command]
pub async fn vst_install(app: AppHandle, path: Option<String>) -> R<Value> {
    use tauri_plugin_dialog::DialogExt;
    let src = match path {
        Some(p) => Some(PathBuf::from(p)),
        None => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_title(tr!("Аудиоплагин VST3 или CLAP", "VST3 or CLAP audio plugin"))
                .add_filter("VST3 / CLAP", &["vst3", "clap"])
                .pick_file(move |p| {
                    let _ = tx.send(p.and_then(|p| p.into_path().ok()));
                });
            rx.await.ok().flatten()
        }
    };
    let Some(src) = src else { return Ok(list()) };
    if plugin_ext(&src).is_none() || !src.exists() {
        return Err(tr!("это не плагин VST3 или CLAP: {}", "not a VST3 or CLAP plugin: {}", s(&src)));
    }
    let dst = user_dir().join(src.file_name().ok_or("name")?);
    let (a, b) = (src.clone(), dst.clone());
    tauri::async_runtime::spawn_blocking(move || copy_any(&a, &b)).await.map_err(|e| e.to_string())??;
    Ok(vst_scan(app, Some(false)).await)
}

fn copy_any(src: &Path, dst: &Path) -> R<()> {
    if let Some(d) = dst.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    if src.is_dir() {
        let _ = std::fs::remove_dir_all(dst);
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            copy_any(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ()).map_err(|e| format!("{}: {e}", s(dst)))
    }
}

#[tauri::command]
pub async fn vst_info(uid: String, state: Option<Value>, ctrl: Option<Value>, params: Option<Value>) -> R<Value> {
    info(&uid, &state.unwrap_or(Value::Null), &ctrl.unwrap_or(Value::Null), &params.unwrap_or(Value::Null)).await
}

#[tauri::command]
pub async fn vst_render(app: AppHandle, job: Value) -> R<Value> {
    // job.tag (любая строка от окна) возвращается в событиях прогресса vst:render {tag, fraction}
    let tag = job["tag"].clone();
    render(&job, plancheck::Inputs::Window, move |f| {
        let _ = app.emit("vst:render", json!({ "tag": tag, "fraction": f }));
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // поля команды окна — по одному аргументу, как у остальных команд
pub async fn vst_editor_open(
    app: AppHandle,
    session: String,
    uid: String,
    state: Option<Value>,
    ctrl: Option<Value>,
    params: Option<Value>,
    title: Option<String>,
    audition: Option<Value>,
) -> R<Value> {
    let cfg = json!({
        "uid": uid, "state": state, "ctrl": ctrl, "params": params, "title": title, "audition": audition,
    });
    editor_open(app, session, cfg).await
}

#[tauri::command]
pub async fn vst_editor_cmd(session: String, cmd: Value) -> bool {
    let op = cmd["op"].as_str().unwrap_or("");
    if !["play", "pause", "seek", "focus", "params", "close"].contains(&op) {
        return false;
    }
    send(&session, &cmd).await
}
