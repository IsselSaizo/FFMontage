// Кэш (M0.7): размеры по категориям, очистка, учёт использования и автоочистка до лимита.
// Категории:
//   thumbs  — миниатюры (<кэш>/app/media/<ключ>/thumbs/)
//   peaks   — волны звука (media/<ключ>/peaks2*.json)
//   proxy   — прокси и отдельные звуковые дорожки (media/<ключ>/proxy.*, audio-aN.m4a)
//   fx      — реверс и стоп-кадры (media/<ключ>/fx/)
//   anim    — сохранённые анимации (<кэш>/anim) — материалы проектов, очищаются только по запросу
//   assets  — картинки текстов и субтитры для экспорта (<кэш>/app/export-assets)
//   fonts   — копии шрифтов для libass (<кэш>/app/fonts)
//   temp    — прочее: временные файлы (<кэш>/tmp) и неопознанные файлы в media/<ключ>
//   logs    — журналы (очищается содержимое)
//   webview — данные окна — только размер
// «media» в cache_clear — старое имя для thumbs+peaks+proxy+fx+прочего в media/<ключ>.
// Учёт: <кэш>/app/media/meta.json — { "used": { "<ключ>": unix-время последнего использования } }.
// Автоочистка (LRU): всё, что пересоздаётся само (media/<ключ>, export-assets, fonts), ужимается до лимита
// settings.json → cache.limitGb (1..50 ГБ, по умолчанию 1), начиная с давно неиспользованного.
// Никогда не удаляются: медиа открытого проекта (keep от окна и автосохранение), то, чем пользовались последние
// 10 минут, и папки с незаконченными файлами (.part, *_work) — даже если всё это больше лимита.
use crate::{export, paths, settings};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub const GB: u64 = 1024 * 1024 * 1024;
/// Пользовались недавно — автоочистка не трогает (файл может как раз создаваться или проигрываться)
const RECENT_SECS: u64 = 600;
/// Файлы для экспорта старше суток при запуске не нужны (их готовят заново перед каждым экспортом)
const ASSETS_MAX_AGE: u64 = 24 * 3600;

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn mtime(p: &Path) -> u64 {
    p.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

fn size_of(p: &Path) -> u64 {
    if p.is_dir() {
        dir_size(p)
    } else {
        p.metadata().map(|m| m.len()).unwrap_or(0)
    }
}

/// Самое позднее изменение внутри папки (для папок без записи в meta.json)
fn newest(p: &Path, depth: u32) -> u64 {
    let mut t = mtime(p);
    if depth > 0 {
        for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
            let path = e.path();
            t = t.max(if path.is_dir() { newest(&path, depth - 1) } else { mtime(&path) });
        }
    }
    t
}

fn is_part(name: &str) -> bool {
    name.ends_with(".part") || name.contains(".part.")
}

/// Есть ли в папке незаконченные файлы (идёт работа FFmpeg)
fn has_work(p: &Path, depth: u32) -> bool {
    std::fs::read_dir(p).into_iter().flatten().flatten().any(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if path.is_dir() {
            name.ends_with("_work") || (depth > 0 && has_work(&path, depth - 1))
        } else {
            is_part(&name)
        }
    })
}

fn remove(path: &Path) -> std::io::Result<u64> {
    let size = size_of(path);
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(size)
}

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric())
}

fn media_dirs(media: &Path) -> Vec<(String, PathBuf)> {
    std::fs::read_dir(media)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .collect()
}

fn files_in(d: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(d).into_iter().flatten().flatten().map(|e| e.path()).collect()
}

/// Категория элемента внутри media/<ключ>/
pub fn media_cat(name: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return match name {
            "thumbs" => "thumbs",
            "fx" => "fx",
            _ => "temp",
        };
    }
    if name.starts_with("peaks") && name.ends_with(".json") {
        "peaks"
    } else if name.starts_with("proxy.") || (name.starts_with("audio-a") && !is_part(name)) {
        "proxy"
    } else {
        "temp"
    }
}

fn anim_dir() -> PathBuf {
    paths::get().cache_dir.join("anim")
}
fn meta_file() -> PathBuf {
    paths::get().media_cache.join("meta.json")
}

// ---------------------------------------------------------------------------
// meta.json: время последнего использования ключей кэша
// ---------------------------------------------------------------------------
static META: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);
static FLUSH_PENDING: AtomicBool = AtomicBool::new(false);

fn meta_lock() -> std::sync::MutexGuard<'static, Option<HashMap<String, u64>>> {
    let mut g = META.lock().unwrap_or_else(|p| p.into_inner());
    if g.is_none() {
        let m = std::fs::read_to_string(meta_file())
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["used"].as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_u64()?))).collect()))
            .unwrap_or_default();
        *g = Some(m);
    }
    g
}

fn flush_meta() {
    FLUSH_PENDING.store(false, Ordering::SeqCst);
    let used: serde_json::Map<String, Value> =
        meta_lock().as_ref().map(|m| m.iter().map(|(k, v)| (k.clone(), json!(v))).collect()).unwrap_or_default();
    let text = json!({ "version": 1, "used": used }).to_string();
    let _ = paths::write_atomic(&meta_file(), text.as_bytes());
}

/// Ключ кэша только что понадобился (миниатюры, волна, прокси, реверс…). Запись на диск — не чаще раза в 3 с.
pub fn touch(key: &str) {
    if !valid_key(key) {
        return;
    }
    let t = now();
    {
        let mut g = meta_lock();
        let m = g.get_or_insert_with(HashMap::new);
        if m.get(key).map(|old| t.saturating_sub(*old) < 60).unwrap_or(false) {
            return;
        }
        m.insert(key.to_string(), t);
    }
    if !FLUSH_PENDING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(3));
            flush_meta();
        });
    }
}

fn forget(keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    if let Some(m) = meta_lock().as_mut() {
        for k in keys {
            m.remove(k);
        }
    }
    flush_meta();
}

// ---------------------------------------------------------------------------
// Что сохранить: медиа открытого проекта
// ---------------------------------------------------------------------------
fn norm(p: &str) -> String {
    let s = p.replace('\\', "/").to_lowercase();
    s.trim_end_matches('/').to_string()
}

/// Ключи кэша и пути файлов, которые трогать нельзя
#[derive(Default)]
pub struct Keep {
    keys: HashSet<String>,
    paths: Vec<String>,
}

impl Keep {
    pub fn new<'a>(list: impl IntoIterator<Item = &'a String>) -> Keep {
        let mut k = Keep::default();
        for s in list {
            k.add(s);
        }
        k
    }
    fn add(&mut self, s: &str) {
        let s = s.trim();
        if s.is_empty() {
            return;
        }
        if valid_key(s) {
            self.keys.insert(s.to_lowercase());
        } else {
            self.paths.push(norm(s));
        }
    }
    /// Папка media/<ключ>: ключ в списке или в ней лежит файл из списка (реверс, стоп-кадр)
    pub fn dir(&self, dir: &Path, key: &str) -> bool {
        if self.keys.contains(&key.to_lowercase()) {
            return true;
        }
        let prefix = format!("{}/", norm(&dir.to_string_lossy()));
        self.paths.iter().any(|p| p.starts_with(&prefix))
    }
    pub fn file(&self, f: &Path) -> bool {
        let n = norm(&f.to_string_lossy());
        self.paths.contains(&n)
    }
}

/// Ключи и пути медиа проекта из автосохранения (программа только что запущена, окна ещё нет)
fn autosave_keep() -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(&paths::get().autosave) else { return vec![] };
    let Ok(a) = serde_json::from_str::<Value>(&text) else { return vec![] };
    let project = match &a["data"] {
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        v => v.clone(),
    };
    project_keep(&project)
}

pub fn project_keep(project: &Value) -> Vec<String> {
    let mut out = vec![];
    if let Some(media) = project["media"].as_object() {
        for m in media.values() {
            for k in ["key", "path"] {
                if let Some(s) = m[k].as_str() {
                    out.push(s.to_string());
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Размеры
// ---------------------------------------------------------------------------
pub fn stats() -> Value {
    let p = paths::get();
    let mut by: HashMap<&'static str, u64> = HashMap::new();
    let dirs = media_dirs(&p.media_cache);
    for (_, d) in &dirs {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let path = e.path();
            let cat = media_cat(&e.file_name().to_string_lossy(), path.is_dir());
            *by.entry(cat).or_default() += size_of(&path);
        }
    }
    let get = |by: &HashMap<&str, u64>, k: &str| by.get(k).copied().unwrap_or(0);
    let media_other = get(&by, "temp");
    let tmp = dir_size(&p.temp);
    let assets = dir_size(&crate::assets::dir());
    let fonts = dir_size(&crate::fonts::export_dir());
    let media_total = dir_size(&p.media_cache);
    let anim = dir_size(&anim_dir());
    let logs = dir_size(&p.logs);
    let webview = dir_size(&p.webview);
    let limit_gb = settings::cache_limit_gb();
    json!({
        "thumbs": get(&by, "thumbs"),
        "peaks": get(&by, "peaks"),
        "proxy": get(&by, "proxy"),
        "fx": get(&by, "fx"),
        "anim": anim,
        "assets": assets,
        "fonts": fonts,
        "temp": tmp + media_other,
        "logs": logs,
        "webview": webview,
        "media": media_total,
        "mediaItems": dirs.len(),
        // Что учитывается в лимите автоочистки
        "auto": media_total + assets + fonts,
        "total": media_total + assets + fonts + tmp + anim + logs + webview,
        "limitGb": limit_gb,
        "limitMin": settings::CACHE_LIMIT_MIN,
        "limitMax": settings::CACHE_LIMIT_MAX,
        "cacheDir": p.cache_dir.to_string_lossy(),
    })
}

// ---------------------------------------------------------------------------
// Очистка по категориям
// ---------------------------------------------------------------------------
/// Удаляет содержимое выбранных категорий. keep — ключи кэша и пути файлов открытого проекта:
/// папки media/<ключ>, в которых лежат эти файлы или чей ключ указан, и сами эти файлы (анимации) не трогаем.
pub fn clear(cats: &[String], keep: &[String]) -> Value {
    let p = paths::get();
    let keep = Keep::new(keep);
    let mut want: HashSet<&str> = HashSet::new();
    for c in cats {
        match c.as_str() {
            "media" => want.extend(["thumbs", "peaks", "proxy", "fx", "media-other"]),
            "thumbs" | "peaks" | "proxy" | "fx" | "anim" | "assets" | "fonts" | "logs" => {
                want.insert(c.as_str());
            }
            "temp" => want.extend(["temp", "media-other"]),
            _ => {}
        }
    }
    let (mut freed, mut kept, mut failed) = (0u64, 0usize, 0usize);
    let rm = |path: &Path, freed: &mut u64, failed: &mut usize| match remove(path) {
        Ok(n) => *freed += n,
        Err(_) => *failed += 1,
    };
    let media_wanted = ["thumbs", "peaks", "proxy", "fx", "media-other"].iter().any(|c| want.contains(c));
    let mut gone = vec![];
    if media_wanted {
        for (key, dir) in media_dirs(&p.media_cache) {
            if keep.dir(&dir, &key) {
                kept += 1;
                continue;
            }
            for path in files_in(&dir) {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let cat = match media_cat(&name, path.is_dir()) {
                    "temp" => "media-other",
                    c => c,
                };
                if want.contains(cat) {
                    rm(&path, &mut freed, &mut failed);
                }
            }
            if files_in(&dir).is_empty() && std::fs::remove_dir(&dir).is_ok() {
                gone.push(key);
            }
        }
    }
    if want.contains("anim") {
        for f in files_in(&anim_dir()) {
            if keep.file(&f) {
                kept += 1;
            } else {
                rm(&f, &mut freed, &mut failed);
            }
        }
    }
    if want.contains("assets") {
        for f in files_in(&crate::assets::dir()) {
            rm(&f, &mut freed, &mut failed);
        }
    }
    if want.contains("fonts") {
        for f in files_in(&crate::fonts::export_dir()) {
            rm(&f, &mut freed, &mut failed);
        }
    }
    if want.contains("temp") {
        for f in files_in(&p.temp) {
            rm(&f, &mut freed, &mut failed);
        }
    }
    if want.contains("logs") {
        // Текущие журналы открыты на запись — очищаем содержимое, а не удаляем
        for path in files_in(&p.logs) {
            let size = path.metadata().map(|m| m.len()).unwrap_or(0);
            if std::fs::write(&path, b"").is_ok() {
                freed += size;
            } else {
                failed += 1;
            }
        }
    }
    forget(&gone);
    json!({ "freed": freed, "kept": kept, "failed": failed, "stats": stats() })
}

// ---------------------------------------------------------------------------
// Автоочистка до лимита (LRU)
// ---------------------------------------------------------------------------
struct Item {
    path: PathBuf,
    key: Option<String>,
    size: u64,
    last: u64,
    protected: bool,
}

/// Что удалить, чтобы уложиться в limit: самые давние незащищённые элементы. Возвращает индексы.
fn plan_lru(items: &[Item], limit: u64) -> Vec<usize> {
    let mut total: u64 = items.iter().map(|i| i.size).sum();
    let mut order: Vec<usize> = (0..items.len()).filter(|&i| !items[i].protected).collect();
    order.sort_by_key(|&i| items[i].last);
    let mut out = vec![];
    for i in order {
        if total <= limit {
            break;
        }
        total = total.saturating_sub(items[i].size);
        out.push(i);
    }
    out
}

/// Тестовые параметры (только в режиме автотеста): limitBytes, recentSecs
#[derive(Default, Clone, Copy)]
pub struct AutoOpts {
    pub limit_bytes: Option<u64>,
    pub recent_secs: Option<u64>,
}

pub fn autoclean(keep: &[String], opts: AutoOpts) -> Value {
    if export::busy() {
        return json!({ "skipped": "export", "freed": 0, "removed": 0 });
    }
    let p = paths::get();
    let limit = opts.limit_bytes.unwrap_or_else(|| settings::cache_limit_gb() * GB);
    let recent = opts.recent_secs.unwrap_or(RECENT_SECS);
    let mut list: Vec<String> = keep.to_vec();
    list.extend(autosave_keep());
    let keep = Keep::new(&list);
    let t = now();
    let used = meta_lock().clone().unwrap_or_default();
    let mut items = vec![];
    for (key, dir) in media_dirs(&p.media_cache) {
        let last = used.get(&key).copied().unwrap_or_else(|| newest(&dir, 2));
        let protected =
            keep.dir(&dir, &key) || t.saturating_sub(last) < recent || t.saturating_sub(newest(&dir, 2)) < recent || has_work(&dir, 2);
        items.push(Item { size: dir_size(&dir), path: dir, key: Some(key), last, protected });
    }
    for d in [crate::assets::dir(), crate::fonts::export_dir()] {
        for f in files_in(&d) {
            let last = mtime(&f);
            items.push(Item { size: size_of(&f), protected: t.saturating_sub(last) < recent, path: f, key: None, last });
        }
    }
    let total: u64 = items.iter().map(|i| i.size).sum();
    let protected_bytes: u64 = items.iter().filter(|i| i.protected).map(|i| i.size).sum();
    let (mut freed, mut removed, mut failed) = (0u64, 0usize, 0usize);
    let mut gone = vec![];
    for i in plan_lru(&items, limit) {
        let it = &items[i];
        match remove(&it.path) {
            Ok(n) => {
                freed += n;
                removed += 1;
                if let Some(k) = &it.key {
                    gone.push(k.clone());
                }
            }
            Err(_) => failed += 1,
        }
    }
    forget(&gone);
    json!({ "freed": freed, "removed": removed, "failed": failed, "total": total - freed.min(total), "limit": limit, "protected": protected_bytes })
}

// ---------------------------------------------------------------------------
// Уборка при запуске
// ---------------------------------------------------------------------------
/// Убрать сирот: незаконченные файлы (.part, *_work, *.tmp), пустые папки media/<ключ>, миниатюры с потерянными
/// файлами, старые файлы для экспорта, записи meta.json без папок. Затем — автоочистка до лимита.
pub fn startup() {
    let p = paths::get();
    let mut gone = vec![];
    let t = now();
    // Окно уже может делать миниатюры и прокси: свежие (< 2 мин) папки не трогаем
    let old = |d: &Path| t.saturating_sub(newest(d, 1)) > 120;
    for (key, dir) in media_dirs(&p.media_cache) {
        if !old(&dir) {
            continue;
        }
        sweep_parts(&dir, 3);
        let thumbs = dir.join("thumbs");
        if thumbs.is_dir() && !thumbs_ok(&thumbs) {
            let _ = std::fs::remove_dir_all(&thumbs);
        }
        if files_in(&dir).is_empty() && std::fs::remove_dir(&dir).is_ok() {
            gone.push(key);
        }
    }
    for f in files_in(&crate::assets::dir()) {
        if t.saturating_sub(mtime(&f)) > ASSETS_MAX_AGE {
            let _ = remove(&f);
        }
    }
    // <кэш>/tmp не трогаем: это TEMP программы, им уже пользуется WebView
    for d in [crate::assets::dir(), crate::fonts::export_dir(), anim_dir()] {
        sweep_parts(&d, 0);
    }
    // записи meta.json без папок
    let dirs: HashSet<String> = media_dirs(&p.media_cache).into_iter().map(|(k, _)| k).collect();
    let stale: Vec<String> = meta_lock().as_ref().map(|m| m.keys().filter(|k| !dirs.contains(*k)).cloned().collect()).unwrap_or_default();
    gone.extend(stale);
    forget(&gone);
    autoclean(&[], AutoOpts::default());
}

fn sweep_parts(dir: &Path, depth: u32) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if name.ends_with("_work") {
                let _ = std::fs::remove_dir_all(&path);
            } else if depth > 0 {
                sweep_parts(&path, depth - 1);
            }
        } else if is_part(&name) || name.ends_with(".tmp") {
            let _ = std::fs::remove_file(&path);
        }
    }
}

// ---------------------------------------------------------------------------
// thumbs.json: имена файлов относительно папки миниатюр (B-9)
// ---------------------------------------------------------------------------
fn thumb_names(v: &Value) -> Vec<String> {
    v["files"]
        .as_array()
        .map(|a| {
            a.iter().filter_map(|f| f.as_str()).filter_map(|f| Path::new(f).file_name().map(|n| n.to_string_lossy().to_string())).collect()
        })
        .unwrap_or_default()
}

fn thumbs_ok(dir: &Path) -> bool {
    let Some(v) = std::fs::read_to_string(dir.join("thumbs.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return false;
    };
    let names = thumb_names(&v);
    !names.is_empty() && names.iter().all(|n| dir.join(n).is_file())
}

/// Ответ ff::thumbs → абсолютные пути в текущей папке кэша. Старый thumbs.json с абсолютными путями (после переноса
/// кэша они ведут в старую папку) переписывается именами файлов. None — файлов нет, миниатюры надо сделать заново.
pub fn thumbs_files(key: &str, v: &Value) -> Option<Vec<PathBuf>> {
    if !valid_key(key) {
        return None;
    }
    let dir = paths::get().media_cache.join(key).join("thumbs");
    let names = thumb_names(v);
    let files: Vec<PathBuf> = names.iter().map(|n| dir.join(n)).collect();
    if files.is_empty() || !files.iter().all(|f| f.is_file()) {
        let _ = std::fs::remove_file(dir.join("thumbs.json"));
        return None;
    }
    let relative =
        v["files"].as_array().map(|a| a.iter().all(|f| f.as_str().map(|s| !s.contains(['/', '\\'])).unwrap_or(false))).unwrap_or(false);
    if !relative {
        let mut fixed = v.clone();
        fixed["files"] = json!(names);
        let _ = paths::write_atomic(&dir.join("thumbs.json"), fixed.to_string().as_bytes());
    }
    Some(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(size: u64, last: u64, protected: bool) -> Item {
        Item { path: PathBuf::new(), key: None, size, last, protected }
    }

    #[test]
    fn lru_order_and_protection() {
        // 4 элемента по 10, лимит 25: удаляются самые старые незащищённые, пока не уложимся
        let items = vec![item(10, 300, false), item(10, 100, false), item(10, 200, true), item(10, 400, false)];
        assert_eq!(plan_lru(&items, 25), vec![1, 0]);
        // Защищённое больше лимита — его не трогаем, удаляем всё остальное
        let items = vec![item(100, 1, true), item(5, 2, false), item(5, 3, false)];
        assert_eq!(plan_lru(&items, 10), vec![1, 2]);
        // Уже в лимите — ничего
        assert!(plan_lru(&items, 1000).is_empty());
    }

    #[test]
    fn categories() {
        assert_eq!(media_cat("thumbs", true), "thumbs");
        assert_eq!(media_cat("fx", true), "fx");
        assert_eq!(media_cat("peaks2.json", false), "peaks");
        assert_eq!(media_cat("peaks2-a1.json", false), "peaks");
        assert_eq!(media_cat("proxy.mp4", false), "proxy");
        assert_eq!(media_cat("audio-a1.m4a", false), "proxy");
        assert_eq!(media_cat("proxy.mp4.part.mp4", false), "proxy");
        assert_eq!(media_cat("junk.bin", false), "temp");
    }

    #[test]
    fn keep_rules() {
        let keys = vec!["ABC123".to_string(), r"F:\Cache\app\media\def456\fx\rev.mp4".to_string(), "C:/v/clip.mp4".to_string()];
        let k = Keep::new(&keys);
        assert!(k.dir(Path::new("/x/media/abc123"), "abc123"));
        assert!(k.dir(Path::new(r"F:\Cache\app\media\DEF456"), "DEF456"));
        assert!(!k.dir(Path::new(r"F:\Cache\app\media\def4567"), "def4567"));
        assert!(k.file(Path::new(r"c:\v\clip.mp4")));
        assert!(!k.file(Path::new(r"c:\v\clip2.mp4")));
        let proj = json!({ "media": { "m1": { "key": "aa11", "path": "C:/a.mp4" }, "m2": { "key": "bb22", "path": "C:/c/app/media/aa11/fx/r.mp4", "derived": { "from": "m1" } } } });
        assert_eq!(project_keep(&proj).len(), 4);
    }

    #[test]
    fn thumbs_names_relative() {
        let v = json!({ "interval": 1.0, "height": 90, "files": [r"F:\old\cache\app\media\k\thumbs\0001.jpg", "/old/thumbs/0002.jpg", "0003.jpg"] });
        assert_eq!(thumb_names(&v), vec!["0001.jpg", "0002.jpg", "0003.jpg"]);
        let base = paths::test_dir("thumbs");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("0001.jpg"), b"x").unwrap();
        std::fs::write(base.join("thumbs.json"), json!({ "files": ["/elsewhere/0001.jpg"] }).to_string()).unwrap();
        assert!(thumbs_ok(&base));
        std::fs::write(base.join("thumbs.json"), json!({ "files": ["0001.jpg", "0002.jpg"] }).to_string()).unwrap();
        assert!(!thumbs_ok(&base));
        sweep_parts(&base, 0);
        std::fs::write(base.join("proxy.mp4.part.mp4"), b"x").unwrap();
        std::fs::create_dir_all(base.join("r_work")).unwrap();
        assert!(has_work(&base, 0));
        sweep_parts(&base, 0);
        assert!(!has_work(&base, 0) && base.join("0001.jpg").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
