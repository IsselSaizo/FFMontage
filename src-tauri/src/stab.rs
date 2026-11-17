// Стабилизация (план fx-restore, этапы 4–5; встроенный плагин plugins-bundled/stabilize).
//   • Анализ движения (vidstab) — шаг подготовки клипа: vidstabdetect запускает ТОЛЬКО программа (плагинам этот фильтр
//     не даётся, plancheck.rs DENY_FILTERS) для отрезка файла клипа с запасом по краям (MARGIN). Результат —
//     <кэш>/app/media/<ключ файла>/stab/<id>.trf и описание <id>.json (файл, отрезок, параметры анализа).
//     .trf привязан к номерам кадров отрезка: экспорт обязан подать ровно тот же отрезок (-ss start -t …, js/exportPlan.js
//     stabSource) и после vidstabtransform отрезать запас (trim=start=…). Отрезок start/end — с точностью 1 мс, -ss
//     пишется одинаково (6 знаков) здесь и в exportPlan.js.
//   • Прокси превью (чекбокс «Показывать превью»): цепочка стабилизации клипа (plancheck::check_preview_chain — тот же
//     vidstabtransform с .trf только из stab-кэша) на отрезке → H.264 ~720p <id>.mp4 там же; плеер подменяет им исходник
//     клипа со сдвигом start (js/stab.js stabPreview, preview.js).
//   • Подходящий готовый результат ищется по описаниям *.json: отрезок покрывает клип и лишнего не больше MAX_WASTE с
//     с каждой стороны — обрезка клипа в пределах запаса не требует пересчёта.
//   • Задания — в фоне через очередь (queue::slot), прогресс — по -progress; повторный запрос того же задания отвечает
//     его состоянием (окно опрашивает), stab_cancel — отмена (процесс убивается: kill_on_drop).
// Команды окна: stab_analyze {req}, stab_proxy {req}, stab_cancel {id}; движок: --engine stab-analyze / stab-proxy
// (ждут окончания). Категория кэша — «stab» (cache.rs): уходит вместе с медиа файла, файлы открытого проекта не трогаются.
use crate::plancheck::{self, Inputs};
use crate::{cache, ff, procs, protocol, queue, tr};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

type Res<T> = Result<T, String>;

/// Запас по краям отрезка по умолчанию, с
pub const MARGIN: f64 = 1.0;
/// Сколько лишнего (с каждой стороны) может быть у готового отрезка, чтобы он ещё годился клипу
pub const MAX_WASTE: f64 = 10.0;
const EPS: f64 = 0.0005;
const VERSION: u32 = 1;

fn n6(x: f64) -> String {
    format!("{x:.6}")
}
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}
fn hash(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()[..20].to_string()
}
fn num(v: &Value, k: &str) -> Option<f64> {
    v[k].as_f64().filter(|x| x.is_finite())
}

// ---------------------------------------------------------------------------
// Запросы
// ---------------------------------------------------------------------------
/// Параметры анализа vidstabdetect (числа приводятся к границам фильтра)
#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    shakiness: i64,
    accuracy: i64,
    stepsize: i64,
    mincontrast: f64,
    tripod: i64,
}

impl Args {
    fn parse(v: &Value) -> Args {
        let i = |k: &str, lo: i64, hi: i64, def: i64| num(v, k).map(|x| (x.round() as i64).clamp(lo, hi)).unwrap_or(def);
        Args {
            shakiness: i("shakiness", 1, 10, 5),
            accuracy: i("accuracy", 1, 15, 15),
            stepsize: i("stepsize", 1, 32, 6),
            mincontrast: (num(v, "mincontrast").unwrap_or(0.25).clamp(0.0, 1.0) * 1000.0).round() / 1000.0,
            tripod: i("tripod", 0, 1_000_000, 0),
        }
    }
    /// Строка для ключа и описания
    fn canon(&self) -> String {
        format!(
            "shakiness={}:accuracy={}:stepsize={}:mincontrast={:.3}:tripod={}",
            self.shakiness, self.accuracy, self.stepsize, self.mincontrast, self.tripod
        )
    }
}

/// Отрезок файла, нужный клипу: [in, out] (+ запас), длительность файла (0 — неизвестна), или точный отрезок (fixed)
#[derive(Debug, Clone, PartialEq)]
struct Span {
    a: f64,
    b: f64,
    margin: f64,
    duration: f64,
    fixed: Option<(f64, f64)>,
}

impl Span {
    fn parse(v: &Value) -> Res<Span> {
        let bad = || tr!("неверный отрезок клипа для стабилизации", "invalid clip range for stabilization");
        let a = num(v, "in").ok_or_else(bad)?.max(0.0);
        let b = num(v, "out").ok_or_else(bad)?;
        if b - a < 0.02 || b > 48.0 * 3600.0 {
            return Err(bad().into());
        }
        let margin = num(v, "margin").unwrap_or(MARGIN).clamp(0.0, 5.0);
        let duration = num(v, "duration").unwrap_or(0.0).max(0.0);
        let fixed = match (num(&v["fixed"], "start"), num(&v["fixed"], "end")) {
            (Some(s), Some(e)) if s >= 0.0 && e > s => Some((round3(s), round3(e))),
            _ => None,
        };
        Ok(Span { a, b, margin, duration, fixed })
    }
    /// Новый отрезок: клип с запасом, в пределах файла
    fn wanted(&self) -> (f64, f64) {
        if let Some(f) = self.fixed {
            return f;
        }
        let s = round3((self.a - self.margin).max(0.0));
        let mut e = round3(self.b + self.margin);
        if self.duration > 0.0 {
            e = e.min(round3(self.duration).max(round3(self.b)));
        }
        (s, e.max(s + 0.04))
    }
    /// Годится ли готовый отрезок start…end
    fn covered_by(&self, start: f64, end: f64) -> bool {
        if let Some((s, e)) = self.fixed {
            return (s - start).abs() < EPS && (e - end).abs() < EPS;
        }
        start <= self.a + EPS && end >= self.b - EPS && self.a - start <= MAX_WASTE && end - self.b <= MAX_WASTE
    }
}

/// Сведения о готовом файле (<id>.json)
fn sidecar(dir: &Path, kind: &str, sig: &str, span: &Span, ext: &str) -> Option<(String, f64, f64)> {
    let mut best: Option<(String, f64, f64)> = None;
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if ff::ext_of(&p) != "json" {
            continue;
        }
        let Some(v) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        if v["v"].as_u64() != Some(VERSION as u64) || v["kind"] != kind || v["sig"] != sig {
            continue;
        }
        let (Some(s), Some(en), Some(id)) = (num(&v, "start"), num(&v, "end"), v["id"].as_str()) else { continue };
        if !span.covered_by(s, en) || !dir.join(format!("{id}.{ext}")).is_file() {
            continue;
        }
        // из подходящих — самый короткий (меньше лишнего декодирования в экспорте)
        if best.as_ref().map(|b| en - s < b.2 - b.1).unwrap_or(true) {
            best = Some((id.to_string(), s, en));
        }
    }
    best
}

fn write_sidecar(dir: &Path, id: &str, kind: &str, sig: &str, file: &Path, start: f64, end: f64) {
    let v = json!({ "v": VERSION, "kind": kind, "id": id, "sig": sig, "file": file.to_string_lossy(), "start": start, "end": end });
    let _ = crate::paths::write_atomic(&dir.join(format!("{id}.json")), v.to_string().as_bytes());
}

// ---------------------------------------------------------------------------
// Задания
// ---------------------------------------------------------------------------
struct Job {
    progress: Arc<AtomicU64>,
    error: Option<String>,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

static JOBS: Mutex<Option<HashMap<String, Job>>> = Mutex::new(None);

fn jobs() -> std::sync::MutexGuard<'static, Option<HashMap<String, Job>>> {
    JOBS.lock().unwrap_or_else(|e| e.into_inner())
}

fn set_progress(p: &AtomicU64, f: f64) {
    p.store(f.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
}

/// Незаконченный файл убирается, если задание отменили или оно упало
struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        if !self.0.exists() {
            return;
        }
        let p = self.0.clone();
        // процесс FFmpeg убивается асинхронно (kill_on_drop) — файл может быть ещё открыт
        std::thread::spawn(move || {
            for _ in 0..30 {
                if !p.exists() || std::fs::remove_file(&p).is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
    }
}

/// Что нужно сделать: всё уже проверено (вход разрешён, цепочка проверена), пути посчитаны
#[derive(Clone)]
struct Work {
    id: String,
    kind: &'static str,
    file: PathBuf,
    dir: PathBuf,
    sig: String,
    start: f64,
    end: f64,
    /// анализ: аргументы vidstabdetect; прокси: цепочка фильтров
    args: Option<Args>,
    chain: String,
    audio: bool,
}

impl Work {
    fn out(&self) -> PathBuf {
        self.dir.join(format!("{}.{}", self.id, if self.kind == "analyze" { "trf" } else { "mp4" }))
    }
}

/// Значение опции в графе (как js/core/ffEscape.js ffPath): «\» → «/», экранирование двух уровней
fn ff_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).to_string();
    let opt: String = s.chars().flat_map(|c| if "\\':".contains(c) { vec!['\\', c] } else { vec![c] }).collect();
    opt.chars().flat_map(|c| if "\\'[],;".contains(c) { vec!['\\', c] } else { vec![c] }).collect()
}

/// Аргументы анализа: тот же отрезок, что потом подаст экспорт (-ss start -t end−start), только видео
fn analyze_args(w: &Work, a: &Args, result: &Path) -> Vec<String> {
    let mut v = ff::sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", &n6(w.start), "-t", &n6(w.end - w.start), "-i"]);
    v.push(w.file.to_string_lossy().to_string());
    v.extend(ff::sv(&["-map", "0:v:0", "-an", "-sn", "-dn", "-vf"]));
    v.push(format!("vidstabdetect={}:result={}", a.canon(), ff_path(result)));
    v.extend(ff::sv(&["-f", "null", "-progress", "pipe:1", "-nostats", "-"]));
    v
}

/// Аргументы прокси: цепочка стабилизации → 720p H.264 (+ первый звуковой поток, если есть)
fn proxy_args(w: &Work, nvenc: bool, out: &Path) -> Vec<String> {
    let mut v = ff::sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", &n6(w.start), "-t", &n6(w.end - w.start), "-i"]);
    v.push(w.file.to_string_lossy().to_string());
    v.extend(ff::sv(&["-map", "0:v:0"]));
    if w.audio {
        v.extend(ff::sv(&["-map", "0:a:0?"]));
    }
    v.extend(ff::sv(&["-sn", "-dn", "-vf"]));
    v.push(format!("{},scale=trunc(iw/2)*2:trunc(ih/2)*2,scale=-2:'min(720,ih)':flags=bicubic,format=yuv420p", w.chain));
    if nvenc {
        v.extend(ff::sv(&["-c:v", "h264_nvenc", "-preset", "p2", "-rc", "vbr", "-cq", "27", "-b:v", "0"]));
    } else {
        v.extend(ff::sv(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]));
    }
    v.extend(ff::sv(&["-g", "30"]));
    if w.audio {
        v.extend(ff::sv(&["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]));
    }
    v.extend(ff::sv(&["-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats"]));
    v.push(out.to_string_lossy().to_string());
    v
}

async fn run(w: &Work, progress: &(dyn Fn(f64) + Send + Sync)) -> Res<PathBuf> {
    let bin = ff::find();
    let dur = w.end - w.start;
    let enc = if w.kind == "proxy" { ff::detect_encoders(&bin).await } else { Value::Null };
    let nvenc = enc["h264_nvenc"].as_bool().unwrap_or(false);
    let _slot = queue::slot(nvenc).await;
    let out = w.out();
    let tmp = w.dir.join(format!("{}.part.{}", w.id, ff::ext_of(&out)));
    let _part = procs::part(&tmp);
    let guard = Tmp(tmp.clone());
    let args = match &w.args {
        Some(a) => analyze_args(w, a, &tmp),
        None => proxy_args(w, nvenc, &tmp),
    };
    let lim = ff::Limits { stall: Some(ff::STALL_TIMEOUT), ..ff::Limits::for_media(dur * 3.0) };
    ff::run_limited(&bin.ffmpeg, &args, Some(ff::progress_parser(dur, progress)), lim).await?;
    if std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0) == 0 {
        return Err(tr!("FFmpeg не записал результат (в отрезке нет кадров?)", "FFmpeg wrote no result (no frames in the range?)").into());
    }
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    drop(guard);
    write_sidecar(&w.dir, &w.id, w.kind, &w.sig, &w.file, w.start, w.end);
    progress(1.0);
    Ok(out)
}

/// Ответ окну о готовом файле
fn ready(w_id: &str, kind: &str, path: &Path, start: f64, end: f64) -> Value {
    let mut v = json!({ "id": w_id, "state": "ready", "progress": 1.0, "start": start, "end": end, "path": path.to_string_lossy() });
    if kind == "analyze" {
        v["trf"] = json!(path.to_string_lossy());
    } else {
        v["url"] = json!(protocol::url(path));
    }
    v
}

/// Разбор запроса окна: проверка входа и цепочки, поиск готового. Ok(Ok(готово)) | Ok(Err(работа))
fn plan(kind: &'static str, req: &Value, inputs: Inputs) -> Res<Result<Value, Work>> {
    let file = plancheck::input_allowed(req["file"].as_str().unwrap_or_default(), inputs)?;
    let span = Span::parse(req)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    let mkey = ff::cache_key(&file, &meta);
    cache::touch(&mkey);
    let dir = ff::media_cache_dir(&mkey).join("stab");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (args, chain, sig) = if kind == "analyze" {
        let a = Args::parse(&req["args"]);
        let sig = a.canon();
        (Some(a), String::new(), sig)
    } else {
        let chain = req["chain"].as_str().unwrap_or_default().trim().trim_end_matches(',').to_string();
        if chain.is_empty() || chain.len() > 16 * 1024 {
            return Err(tr!("нет цепочки стабилизации", "no stabilization chain").into());
        }
        plancheck::check_preview_chain(&chain, inputs)?;
        let sig = hash(&format!("chain|{chain}"));
        (None, chain, sig)
    };
    let ext = if kind == "analyze" { "trf" } else { "mp4" };
    if let Some((id, s, e)) = sidecar(&dir, kind, &sig, &span, ext) {
        return Ok(Ok(ready(&id, kind, &dir.join(format!("{id}.{ext}")), s, e)));
    }
    let (start, end) = span.wanted();
    let id = hash(&format!("{kind}|{mkey}|{sig}|{}|{}", n6(start), n6(end)));
    let audio = req["audio"].as_bool().unwrap_or(false);
    Ok(Err(Work { id, kind, file, dir, sig, start, end, args, chain, audio }))
}

/// Окно: готово → ответ; идёт → прогресс; нет → запуск в фоне
fn request(kind: &'static str, req: &Value) -> Res<Value> {
    let w = match plan(kind, req, Inputs::Window)? {
        Ok(v) => return Ok(v),
        Err(w) => w,
    };
    let retry = req["retry"].as_bool() == Some(true);
    let mut g = jobs();
    let m = g.get_or_insert_with(HashMap::new);
    if let Some(j) = m.get(&w.id) {
        match &j.error {
            Some(e) if !retry => return Ok(json!({ "id": w.id, "state": "error", "error": e, "start": w.start, "end": w.end })),
            Some(_) => {}
            None => {
                let p = f64::from_bits(j.progress.load(Ordering::Relaxed));
                return Ok(json!({ "id": w.id, "state": "running", "progress": p, "start": w.start, "end": w.end }));
            }
        }
    }
    let progress = Arc::new(AtomicU64::new(0f64.to_bits()));
    let (p2, w2) = (progress.clone(), w.clone());
    let handle = tauri::async_runtime::spawn(async move {
        let p3 = p2.clone();
        let r = run(&w2, &move |f| set_progress(&p3, f)).await;
        let mut g = jobs();
        let m = g.get_or_insert_with(HashMap::new);
        match r {
            // файл готов — запись больше не нужна: следующий запрос найдёт его по описанию
            Ok(_) => {
                m.remove(&w2.id);
            }
            Err(e) => {
                if let Some(j) = m.get_mut(&w2.id) {
                    j.error = Some(e);
                    j.handle = None;
                }
            }
        }
    });
    m.insert(w.id.clone(), Job { progress, error: None, handle: Some(handle) });
    Ok(json!({ "id": w.id, "state": "running", "progress": 0.0, "start": w.start, "end": w.end }))
}

/// Отменить задание (окно сменило параметры, выключило превью, отменило экспорт)
pub fn cancel(id: &str) -> bool {
    let j = jobs().as_mut().and_then(|m| m.remove(id));
    match j {
        Some(j) => {
            if let Some(h) = j.handle {
                h.abort();
            }
            true
        }
        None => false,
    }
}

/// Движок: сделать сразу и дождаться
pub async fn now(kind: &'static str, req: &Value, inputs: Inputs) -> Res<Value> {
    match plan(kind, req, inputs)? {
        Ok(v) => Ok(v),
        Err(w) => {
            let out = run(&w, &|_| {}).await?;
            let mut v = ready(&w.id, kind, &out, w.start, w.end);
            v["cached"] = json!(false);
            Ok(v)
        }
    }
}

/// Анализ движения клипа: req { file, in, out, margin?, duration?, args { shakiness, accuracy, stepsize, mincontrast, tripod }, retry? }
/// → { id, state: ready|running|error, progress, start, end, trf? , error? }
#[tauri::command]
pub async fn stab_analyze(req: Value) -> Res<Value> {
    if !ff::has_vidstab(&ff::find()).await {
        return Err(tr!("В этой сборке FFmpeg нет vidstab", "This FFmpeg build has no vidstab").into());
    }
    tauri::async_runtime::spawn_blocking(move || request("analyze", &req)).await.map_err(|e| e.to_string())?
}

/// Прокси превью: req { file, chain, in, out, margin?, duration?, fixed? { start, end }, audio?, retry? } → { …, url? }
#[tauri::command]
pub async fn stab_proxy(req: Value) -> Res<Value> {
    tauri::async_runtime::spawn_blocking(move || request("proxy", &req)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn stab_cancel(id: String) -> bool {
    cancel(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(v: Value) -> Span {
        Span::parse(&v).unwrap()
    }

    #[test]
    fn spans_and_coverage() {
        let s = span(json!({ "in": 3.0, "out": 8.0, "duration": 8.5 }));
        assert_eq!(s.wanted(), (2.0, 8.5), "запас 1 с, конец — не дальше файла"); // i18n-ignore — тест
        assert!(s.covered_by(2.0, 9.0));
        assert!(s.covered_by(3.0, 8.0));
        assert!(!s.covered_by(3.2, 9.0), "клип вышел за начало отрезка"); // i18n-ignore — тест
        assert!(!s.covered_by(2.0, 7.9));
        assert!(!s.covered_by(0.0, 30.0), "слишком много лишнего"); // i18n-ignore — тест
        let f = span(json!({ "in": 3.0, "out": 8.0, "fixed": { "start": 2.0, "end": 9.0 } }));
        assert_eq!(f.wanted(), (2.0, 9.0));
        assert!(f.covered_by(2.0, 9.0) && !f.covered_by(2.0, 9.5));
        assert_eq!(span(json!({ "in": 0.3, "out": 1.0 })).wanted(), (0.0, 2.0));
        assert!(Span::parse(&json!({ "in": 1.0, "out": 1.0 })).is_err());
        assert!(Span::parse(&json!({})).is_err());
    }

    #[test]
    fn args_clamped() {
        let a = Args::parse(&json!({ "shakiness": 40, "accuracy": 0, "stepsize": 6, "mincontrast": 0.1, "tripod": 1 }));
        assert_eq!(a.canon(), "shakiness=10:accuracy=1:stepsize=6:mincontrast=0.100:tripod=1");
        assert_eq!(Args::parse(&json!({})).canon(), "shakiness=5:accuracy=15:stepsize=6:mincontrast=0.250:tripod=0");
    }

    #[test]
    fn commands_built() {
        let w = Work {
            id: "x".into(),
            kind: "analyze",
            file: PathBuf::from("C:/in.mp4"),
            dir: PathBuf::from("C:/c/media/k/stab"),
            sig: String::new(),
            start: 2.0,
            end: 9.5,
            args: Some(Args::parse(&json!({ "shakiness": 10 }))),
            chain: String::new(),
            audio: false,
        };
        let a = analyze_args(&w, w.args.as_ref().unwrap(), Path::new("C:/c/media/k/stab/x.part.trf"));
        let i = a.iter().position(|x| x == "-ss").unwrap();
        assert_eq!((a[i + 1].as_str(), a[i + 3].as_str()), ("2.000000", "7.500000"));
        let vf = &a[a.iter().position(|x| x == "-vf").unwrap() + 1];
        assert!(vf.starts_with("vidstabdetect=shakiness=10:") && vf.ends_with(":result=C\\\\:/c/media/k/stab/x.part.trf"), "{vf}");
        let p = Work { kind: "proxy", args: None, chain: "deshake=rx=16:ry=16".into(), audio: true, ..w };
        let b = proxy_args(&p, false, Path::new("C:/o.mp4"));
        assert!(b.contains(&"0:a:0?".to_string()) && b.iter().any(|x| x.starts_with("deshake=rx=16:ry=16,scale=")));
    }
}
