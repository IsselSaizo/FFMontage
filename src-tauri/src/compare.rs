// Шторка «ДО / ПОСЛЕ» в плеере (план fx-restore, этап 2): два кадра одного момента исходного файла клипа —
// ДО (без эффектов) и ПОСЛЕ (цепочка эффектов клипа, та же, что в экспорте: js/effects.js ffEffects).
// Оба кадра делает FFmpeg за один проход (split), с одинаковым кадрированием и масштабом — разница только от эффектов.
//   • Временны́е фильтры (hqdn3d, atadenoise…) на одном кадре не работают: декодирование начинается за PREROLL с
//     до момента (не раньше start — начала отрезка клипа), фильтры «разогреваются», берётся кадр нужного момента
//     (trim после эффектов, -frames:v 1).
//   • Вход — только файл, разрешённый окну (plancheck::input_allowed), цепочка — plancheck::check_preview_chain.
//   • Очередь — queue::slot (процессор), лимит времени, новый запрос отменяет предыдущий (GEN), compare_cancel — тоже.
//   • Кэш: <кэш>/app/media/<ключ файла>/compare/<хэш>-a.jpg / -b.jpg (хэш — время, начало, цепочка, кадрирование,
//     ширина); категория «прочее» в cache.rs, уходит вместе с медиа файла; в папке — не больше KEEP_FILES кадров.
// Команда окна: compare_frames {req} → { before, after: base64 JPEG } | { cancelled: true }; движок: --engine compare.
use crate::plancheck::{self, Inputs};
use crate::{cache, ff, queue, tr};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Сколько секунд до момента прогоняется через фильтры
const PREROLL: f64 = 0.5;
/// Лимит одного запуска FFmpeg (кадр 4K с тяжёлым шумодавом — секунды; зависание — убить)
const TIMEOUT: Duration = Duration::from_secs(90);
/// Сколько файлов кадров держать в папке compare одного файла
const KEEP_FILES: usize = 48;
const MAX_WIDTH: f64 = 1920.0;

/// Номер последнего запроса: запрос, номер которого уже не последний, отменён
static GEN: AtomicU64 = AtomicU64::new(0);

/// Отменить идущий запрос (окно закрыло шторку)
pub fn cancel() {
    GEN.fetch_add(1, Ordering::SeqCst);
}

/// Запрос окна (поля — как в js/effects.js compareRequest)
#[derive(Debug, PartialEq)]
struct Req {
    file: String,
    /// момент файла, с — кадр, который виден в плеере
    t: f64,
    /// раньше этого момента файла не начинать (начало отрезка клипа)
    start: f64,
    /// цепочка эффектов без завершающей запятой ('' — эффектов нет)
    fx: String,
    /// кадрирование l, t, r, b — доли кадра (как exportPlan.js cropChain)
    crop: [f64; 4],
    /// ширина кадра на выходе (чётная, 64…1920)
    width: i64,
    /// картинка (один кадр, без перемотки)
    image: bool,
    fps: f64,
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v[k].as_f64().filter(|x| x.is_finite())
}

fn parse(v: &Value) -> Result<Req, String> {
    let file = v["file"].as_str().unwrap_or_default().to_string();
    let t = num(v, "t").filter(|x| *x >= 0.0 && *x < 48.0 * 3600.0).ok_or_else(|| tr!("неверное время кадра", "invalid frame time"))?;
    let start = num(v, "start").unwrap_or(0.0).clamp(0.0, t);
    let fx = v["fx"].as_str().unwrap_or_default().trim().trim_end_matches(',').to_string();
    if fx.len() > 64 * 1024 {
        return Err(tr!("слишком длинная цепочка эффектов", "the effect chain is too long").into());
    }
    let c = &v["crop"];
    let f = |k: &str| num(c, k).unwrap_or(0.0).clamp(0.0, 0.95);
    let crop = [f("l"), f("t"), f("r"), f("b")];
    let width = ((num(v, "width").unwrap_or(1280.0).clamp(64.0, MAX_WIDTH) / 2.0).round() * 2.0) as i64;
    let fps = num(v, "fps").filter(|x| *x >= 1.0 && *x <= 480.0).unwrap_or(30.0);
    Ok(Req { file, t, start, fx, crop, width, image: v["image"].as_bool() == Some(true), fps })
}

fn n6(x: f64) -> String {
    format!("{x:.6}")
}

/// Кадрирование — та же формула, что exportPlan.js cropChain ('' — без кадрирования)
fn crop_chain(c: &[f64; 4]) -> String {
    let [l, t, r, b] = *c;
    if l + t + r + b <= 0.0 {
        return String::new();
    }
    let w = (1.0 - l - r).max(0.05);
    let h = (1.0 - t - b).max(0.05);
    format!("crop=w=trunc(iw*{}/2)*2:h=trunc(ih*{}/2)*2:x=iw*{}:y=ih*{},", n6(w), n6(h), n6(l), n6(t))
}

/// Аргументы FFmpeg: один вход, split → [a] без эффектов и [b] с эффектами → два JPEG
fn build(r: &Req, file: &Path, out_a: &Path, out_b: &Path) -> Vec<String> {
    let mut a: Vec<String> = ff::sv(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    // d — где нужный момент от начала декодирования; кадр, который виден в момент t, начался не раньше t − 1/fps
    let (d, fps) = if r.image {
        a.extend(ff::sv(&["-loop", "1", "-framerate", "10", "-t", &n6(PREROLL + 0.3)]));
        (PREROLL, 10.0)
    } else {
        let ss = r.start.max(r.t - PREROLL).max(0.0);
        a.extend(ff::sv(&["-ss", &n6(ss)]));
        (r.t - ss, r.fps)
    };
    a.push("-i".into());
    a.push(file.to_string_lossy().to_string());
    let from = (d - 1.0 / fps + 0.0005).max(0.0);
    let tail = format!("trim=start={},{}scale={}:-2:flags=lanczos,setsar=1", n6(from), crop_chain(&r.crop), r.width);
    let fx = if r.fx.is_empty() { String::new() } else { format!("{},", r.fx) };
    let graph = format!("[0:v]split=2[pa][pb];[pa]{tail}[a];[pb]{fx}{tail}[b]");
    a.extend(ff::sv(&["-filter_complex", &graph]));
    for (label, out) in [("[a]", out_a), ("[b]", out_b)] {
        a.extend(ff::sv(&["-map", label, "-frames:v", "1", "-an", "-sn", "-dn", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p"]));
        a.extend(ff::sv(&["-f", "image2", "-update", "1"]));
        a.push(out.to_string_lossy().to_string());
    }
    a
}

fn key_of(r: &Req) -> String {
    let s = format!("v1|{:.4}|{:.4}|{}|{:?}|{}|{}|{:.3}", r.t, r.start, r.fx, r.crop, r.width, r.image, r.fps);
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()[..20].to_string()
}

/// Старые кадры — прочь (папка одного файла не растёт)
fn prune(dir: &Path) {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= KEEP_FILES {
        return;
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, p) in files.drain(KEEP_FILES..) {
        let _ = std::fs::remove_file(p);
    }
}

fn read_pair(a: &Path, b: &Path) -> Option<(Vec<u8>, Vec<u8>)> {
    let x = std::fs::read(a).ok().filter(|x| !x.is_empty())?;
    let y = std::fs::read(b).ok().filter(|y| !y.is_empty())?;
    Some((x, y))
}

fn answer(a: &Path, b: &Path, pair: (Vec<u8>, Vec<u8>), cached: bool) -> Value {
    json!({
        "before": crate::commands::base64(&pair.0),
        "after": crate::commands::base64(&pair.1),
        "beforePath": a.to_string_lossy(),
        "afterPath": b.to_string_lossy(),
        "cached": cached,
    })
}

/// Запрос стал не последним — отменён
async fn superseded(my: u64) {
    while GEN.load(Ordering::SeqCst) == my {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// Два кадра для шторки. Ошибка — текст для человека; отменённый запрос — { cancelled: true }
pub async fn frames(req: &Value, inputs: Inputs) -> Result<Value, String> {
    let my = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let r = parse(req)?;
    let file = plancheck::input_allowed(&r.file, inputs)?;
    if !r.fx.is_empty() {
        plancheck::check_preview_chain(&r.fx, inputs)?;
    }
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    let mkey = ff::cache_key(&file, &meta);
    cache::touch(&mkey);
    let dir = ff::media_cache_dir(&mkey).join("compare");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = key_of(&r);
    let (fa, fb) = (dir.join(format!("{key}-a.jpg")), dir.join(format!("{key}-b.jpg")));
    if let Some(pair) = read_pair(&fa, &fb) {
        return Ok(answer(&fa, &fb, pair, true));
    }
    let cancelled = || Ok(json!({ "cancelled": true }));
    let _slot = tokio::select! {
        s = queue::slot(false) => s,
        _ = superseded(my) => return cancelled(),
    };
    let (pa, pb) = (dir.join(format!("{key}-a.part.jpg")), dir.join(format!("{key}-b.part.jpg")));
    let args = build(&r, &file, &pa, &pb);
    let bin = ff::find();
    let run = tokio::select! {
        o = ff::run_t(&bin.ffmpeg, &args, ff::Limits::total(TIMEOUT)) => Some(o),
        _ = superseded(my) => None,
    };
    let done = match run {
        None => Err(None),
        Some(Err(e)) => Err(Some(e)),
        Some(Ok(_)) => std::fs::rename(&pa, &fa).and_then(|_| std::fs::rename(&pb, &fb)).map_err(|_| {
            Some(tr!("FFmpeg не выдал кадр (момент за концом файла?)", "FFmpeg produced no frame (time past the end of the file?)").into())
        }),
    };
    let _ = std::fs::remove_file(&pa);
    let _ = std::fs::remove_file(&pb);
    match done {
        Err(None) => cancelled(),
        Err(Some(e)) => Err(e),
        Ok(()) => {
            prune(&dir);
            read_pair(&fa, &fb).map(|pair| answer(&fa, &fb, pair, false)).ok_or_else(|| {
                tr!("FFmpeg не выдал кадр (момент за концом файла?)", "FFmpeg produced no frame (time past the end of the file?)").into()
            })
        }
    }
}

#[tauri::command]
pub async fn compare_frames(req: Value) -> Result<Value, String> {
    frames(&req, Inputs::Window).await
}

#[tauri::command]
pub fn compare_cancel() {
    cancel();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(v: Value) -> Req {
        parse(&v).unwrap()
    }

    #[test]
    fn parse_limits() {
        let r = req(json!({ "file": "x", "t": 5.0, "start": 9.0, "fx": "hue=s=0,", "width": 5000, "crop": { "l": 2.0 } }));
        assert_eq!(r.start, 5.0, "start не позже t"); // i18n-ignore — тест
        assert_eq!(r.fx, "hue=s=0");
        assert_eq!(r.width, 1920);
        assert_eq!(r.crop, [0.95, 0.0, 0.0, 0.0]);
        assert_eq!(req(json!({ "t": 1.0, "width": 101 })).width, 102);
        assert!(parse(&json!({ "t": -1.0 })).is_err());
        assert!(parse(&json!({})).is_err());
    }

    #[test]
    fn graph_and_preroll() {
        let r = req(json!({ "file": "x", "t": 3.0, "start": 1.0, "fx": "hqdn3d=4:3:6:4", "width": 640, "fps": 25 }));
        let a = build(&r, Path::new("C:/in.mp4"), Path::new("C:/a.jpg"), Path::new("C:/b.jpg"));
        let ss = a.iter().position(|x| x == "-ss").unwrap();
        assert_eq!(a[ss + 1], "2.500000");
        let g = &a[a.iter().position(|x| x == "-filter_complex").unwrap() + 1];
        assert_eq!(
            g,
            "[0:v]split=2[pa][pb];[pa]trim=start=0.460500,scale=640:-2:flags=lanczos,setsar=1[a];[pb]hqdn3d=4:3:6:4,trim=start=0.460500,scale=640:-2:flags=lanczos,setsar=1[b]"
        );
        // начало отрезка клипа ближе PREROLL — с него
        let r2 = req(json!({ "t": 1.2, "start": 1.0, "crop": { "l": 0.25, "r": 0.25 } }));
        let a2 = build(&r2, Path::new("C:/in.mp4"), Path::new("C:/a.jpg"), Path::new("C:/b.jpg"));
        assert_eq!(a2[a2.iter().position(|x| x == "-ss").unwrap() + 1], "1.000000");
        assert!(a2.iter().any(|x| x.contains("crop=w=trunc(iw*0.500000/2)*2:h=trunc(ih*1.000000/2)*2:x=iw*0.250000:y=ih*0.000000,scale=")));
        // картинка: без перемотки, повтор кадра
        let r3 = req(json!({ "t": 0.0, "image": true }));
        let a3 = build(&r3, Path::new("C:/in.png"), Path::new("C:/a.jpg"), Path::new("C:/b.jpg"));
        assert!(!a3.contains(&"-ss".to_string()) && a3.contains(&"-loop".to_string()));
        assert_ne!(key_of(&r), key_of(&r2));
    }

    #[test]
    fn chain_checked() {
        let ok = |s: &str| plancheck::check_preview_chain(s, Inputs::Any).is_ok();
        assert!(ok("hue=s=0"));
        assert!(ok("gblur=sigma=11.52,vignette=angle=0.6000"));
        assert!(!ok("hue=s=0[x];[x]negate"));
        assert!(!ok("movie=C\\:/x.mp4"));
        assert!(!ok("ass=C\\:/x.ass"));
        assert!(!ok("hwupload"));
        assert!(!ok("drawtext=textfile=C\\:/x.txt"));
        assert!(!ok("frei0r=filter_name=x"));
        assert!(!ok("sendcmd=c=x"));
        assert!(!ok("lut=y=val:c0=0\nmovie"));
    }
}
