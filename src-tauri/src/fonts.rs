// Шрифты (M5): встроенные (assets/fonts окна), пользовательские (<app_dir>/user-fonts, для тестов — FFM_FONTS_DIR)
// и папка для libass при экспорте субтитров (<app_cache>/fonts: копии встроенных и пользовательских).
// Окно подключает шрифты через new FontFace(family, 'url(media-адрес)'), поэтому каждый файл — protocol::allow.
use crate::{paths, protocol, tr};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

/// Встроенные шрифты (src/renderer/assets/fonts, встроены в exe вместе с окном)
pub const BUILTIN: &[&str] = &["Inter.ttf", "OpenSans.ttf"];
pub const FONT_EXT: &[&str] = &["ttf", "otf", "ttc"];
/// Один файл шрифта
const MAX_FONT: u64 = 50 * 1024 * 1024;

fn s(p: &Path) -> String { p.to_string_lossy().to_string() }

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Папка пользовательских шрифтов: FFM_FONTS_DIR (тесты) или <app_dir>/user-fonts
pub fn user_dir() -> PathBuf {
    match std::env::var("FFM_FONTS_DIR") {
        Ok(d) if !d.trim().is_empty() => paths::absolute(Path::new(d.trim()), &std::env::current_dir().unwrap_or_default()),
        _ => paths::get().app_dir.join("user-fonts"),
    }
}

/// Папка шрифтов для libass (fontsdir фильтра ass): <app_cache>/fonts
pub fn export_dir() -> PathBuf { paths::get().app_cache.join("fonts") }

// ---------------------------------------------------------------------------
// Разбор sfnt (TTF/OTF/TTC): имя семейства из таблицы 'name'
// ---------------------------------------------------------------------------
fn u16at(b: &[u8], i: usize) -> Option<u16> { Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])) }
fn u32at(b: &[u8], i: usize) -> Option<u32> { Some(u32::from_be_bytes([*b.get(i)?, *b.get(i + 1)?, *b.get(i + 2)?, *b.get(i + 3)?])) }

/// Сигнатура sfnt: 0x00010000 (TrueType), 'OTTO' (CFF), 'true' (старый Apple), 'ttcf' (коллекция)
pub fn is_sfnt(b: &[u8]) -> bool {
    b.len() >= 12 && matches!(&b[..4], [0, 1, 0, 0] | b"OTTO" | b"true" | b"ttcf")
}

fn utf16be(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
}

/// Имя семейства: nameID 16 (типографское семейство), иначе 1; платформа 3 (UTF-16BE, лучше язык 0x0409),
/// иначе 0 (UTF-16BE), иначе 1 (Mac Roman — берём как ASCII). У .ttc — первый шрифт коллекции.
pub fn family_name(b: &[u8]) -> Option<String> {
    name_id(b, 16).or_else(|| name_id(b, 1))
}

/// Строка nameID из таблицы 'name' (выбор платформы — как в family_name)
pub fn name_id(b: &[u8], want: u16) -> Option<String> {
    if !is_sfnt(b) { return None; }
    let face = if &b[..4] == b"ttcf" {
        if u32at(b, 8)? == 0 { return None; }
        u32at(b, 12)? as usize
    } else { 0 };
    let num_tables = u16at(b, face + 4)? as usize;
    let mut name = None;
    for t in 0..num_tables.min(512) {
        let rec = face + 12 + t * 16;
        if b.get(rec..rec + 4)? == b"name" {
            let (off, len) = (u32at(b, rec + 8)? as usize, u32at(b, rec + 12)? as usize);
            name = Some(b.get(off..off.checked_add(len)?)?);
            break;
        }
    }
    let tab = name?;
    let count = u16at(tab, 2)? as usize;
    let strings = u16at(tab, 4)? as usize;
    // (приоритет, текст): меньше — лучше
    let mut best: Option<(u8, String)> = None;
    for r in 0..count {
        let rec = 6 + r * 12;
        let (Some(platform), Some(encoding), Some(lang), Some(id), Some(len), Some(off)) =
            (u16at(tab, rec), u16at(tab, rec + 2), u16at(tab, rec + 4), u16at(tab, rec + 6), u16at(tab, rec + 8), u16at(tab, rec + 10)) else { break };
        if id != want { continue; }
        let Some(raw) = tab.get(strings + off as usize..strings + off as usize + len as usize) else { continue };
        let (prio, text) = match (platform, encoding) {
            (3, 0 | 1 | 10) => (if lang == 0x0409 { 0 } else { 1 }, utf16be(raw)),
            (0, _) => (2, utf16be(raw)),
            (1, 0) => (3, raw.iter().map(|&c| if c < 0x80 { c as char } else { '?' }).collect()),
            _ => continue,
        };
        let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
        if text.is_empty() { continue; }
        if best.as_ref().is_none_or(|(p, _)| prio < *p) { best = Some((prio, text)); }
    }
    best.map(|(_, t)| t)
}

// ---------------------------------------------------------------------------
// Записи списка
// ---------------------------------------------------------------------------
/// Кэш имён: (путь, размер, время изменения) → (семейство, nameID 1), чтобы не перечитывать шрифты на каждый список
type Names = (String, String);
static NAMES: Mutex<Option<HashMap<(String, u64, u128), Names>>> = Mutex::new(None);

fn mtime(m: &std::fs::Metadata) -> u128 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)
}

/// Запись { family, assFamily, file, path, url, builtin, size }; None — файл не читается или это не шрифт.
/// assFamily — nameID 1: по нему (и по полному имени) libass ищет шрифт из Fontname стиля .ass;
/// отличается от family у статических начертаний («Roboto Medium» при типографском «Roboto»).
fn entry(p: &Path, builtin: bool) -> Option<Value> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > MAX_FONT { return None; }
    let key = (s(p), meta.len(), mtime(&meta));
    let cached = NAMES.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(&key).cloned());
    let (family, ass_family) = match cached {
        Some(f) => f,
        None => {
            let bytes = std::fs::read(p).ok()?;
            let f = family_name(&bytes)?;
            let names = (f.clone(), name_id(&bytes, 1).unwrap_or(f));
            NAMES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(key, names.clone());
            names
        }
    };
    protocol::allow(p);
    let file = p.file_name()?.to_string_lossy().to_string();
    Some(json!({ "family": family, "assFamily": ass_family, "file": file, "path": s(p), "url": protocol::url(p), "builtin": builtin, "size": meta.len() }))
}

fn has_font_ext(p: &Path) -> bool { FONT_EXT.contains(&crate::ff::ext_of(p).as_str()) }

/// Файлы шрифтов в папке (по имени)
fn font_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| has_font_ext(p) && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .collect();
    v.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    v
}

fn is_builtin_name(name: &str) -> bool { BUILTIN.iter().any(|b| b.eq_ignore_ascii_case(name)) }

// ---------------------------------------------------------------------------
// Папка шрифтов для экспорта
// ---------------------------------------------------------------------------
static SYNC: Mutex<bool> = Mutex::new(false);

/// Байты встроенного шрифта: из ресурсов окна (встроены в exe), иначе из <app_dir>/src/renderer/assets/fonts.
/// asset_resolver при отсутствии файла отдаёт index.html — поэтому байты проверяются как шрифт.
fn builtin_bytes(app: &AppHandle, name: &str) -> Option<Vec<u8>> {
    let ok = |b: Vec<u8>| if family_name(&b).is_some() { Some(b) } else { None };
    app.asset_resolver().get(format!("assets/fonts/{name}")).and_then(|a| ok(a.bytes))
        .or_else(|| std::fs::read(paths::get().app_dir.join("src").join("renderer").join("assets").join("fonts").join(name)).ok().and_then(ok))
}

/// Записать через временный файл (rename атомарен)
fn write_atomic(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = dest.with_file_name(format!(".{}.{}.tmp", dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, dest).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); })
}

fn copy_atomic(src: &Path, dest: &Path) -> std::io::Result<()> {
    let bytes = std::fs::read(src)?;
    write_atomic(dest, &bytes)
}

/// Имя копии пользовательского шрифта в папке экспорта (совпадение со встроенным — с префиксом user-)
fn export_name(user_file: &str) -> String {
    if is_builtin_name(user_file) { format!("user-{user_file}") } else { user_file.to_string() }
}

/// <app_cache>/fonts: встроенные шрифты + копии пользовательских (копируются, если нет или другой размер),
/// лишние файлы удаляются. Ошибки отдельных файлов не прерывают (файл может читать идущий экспорт).
pub fn ensure_export(app: &AppHandle) -> R<PathBuf> {
    let mut synced = SYNC.lock().unwrap_or_else(|e| e.into_inner());
    let dir = export_dir();
    std::fs::create_dir_all(&dir).map_err(|e| tr!("Не удалось создать папку шрифтов {}: {}", "Cannot create the fonts folder {}: {}", dir.display(), e))?;
    let mut keep: Vec<String> = vec![];
    let mut all_builtin = true;
    for name in BUILTIN {
        keep.push(name.to_lowercase());
        let dest = dir.join(name);
        // Первый раз за запуск — сверить размер с встроенным; потом — только наличие
        if *synced && dest.is_file() { continue; }
        match builtin_bytes(app, name) {
            Some(b) => {
                if std::fs::metadata(&dest).map(|m| m.len() != b.len() as u64).unwrap_or(true) && write_atomic(&dest, &b).is_err() && !dest.is_file() {
                    all_builtin = false;
                }
            }
            None => all_builtin = false,
        }
    }
    *synced = all_builtin;
    for src in font_files(&user_dir()) {
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        let target = export_name(&name);
        keep.push(target.to_lowercase());
        let dest = dir.join(&target);
        let src_len = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        if src_len == 0 || src_len > MAX_FONT { continue; }
        if std::fs::metadata(&dest).map(|m| m.len() != src_len).unwrap_or(true) {
            let _ = copy_atomic(&src, &dest);
        }
    }
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) && !keep.contains(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
    Ok(dir)
}

fn list(app: &AppHandle) -> R<Vec<Value>> {
    let dir = ensure_export(app)?;
    let mut out: Vec<Value> = BUILTIN.iter().filter_map(|n| entry(&dir.join(n), true)).collect();
    out.extend(font_files(&user_dir()).iter().filter_map(|p| entry(p, false)));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Добавление и удаление
// ---------------------------------------------------------------------------
/// Проверить файл как шрифт: расширение, размер, сигнатура, имя семейства → байты
fn read_font(p: &Path) -> R<Vec<u8>> {
    let shown = p.display();
    if !has_font_ext(p) { return Err(tr!("{}: нужен файл .ttf, .otf или .ttc", "{}: a .ttf, .otf or .ttc file is required", shown)); }
    let meta = std::fs::metadata(p).map_err(|e| format!("{shown}: {e}"))?;
    if !meta.is_file() { return Err(tr!("{}: это не файл", "{}: not a file", shown)); }
    if meta.len() > MAX_FONT { return Err(tr!("{}: шрифт больше 50 МБ", "{}: the font is larger than 50 MB", shown)); }
    let bytes = std::fs::read(p).map_err(|e| format!("{shown}: {e}"))?;
    if !is_sfnt(&bytes) || family_name(&bytes).is_none() {
        return Err(tr!("{}: не удалось прочитать шрифт", "{}: cannot read the font", shown));
    }
    Ok(bytes)
}

fn add_one(src: &Path) -> R<Value> {
    let bytes = read_font(src)?;
    let dir = user_dir();
    std::fs::create_dir_all(&dir).map_err(|e| tr!("Не удалось создать папку шрифтов {}: {}", "Cannot create the fonts folder {}: {}", dir.display(), e))?;
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (stem, ext) = match name.rsplit_once('.') { Some((a, b)) => (a.to_string(), b.to_string()), None => (name.clone(), String::new()) };
    let mut dest = dir.join(&name);
    let mut i = 2;
    loop {
        let taken_builtin = dest.file_name().is_some_and(|n| is_builtin_name(&n.to_string_lossy()));
        if !taken_builtin {
            match std::fs::read(&dest) {
                Err(_) if !dest.exists() => break,
                // Тот же файл уже добавлен — не копировать второй раз
                Ok(b) if b == bytes => return entry(&dest, false).ok_or_else(|| tr!("{}: не удалось прочитать шрифт", "{}: cannot read the font", dest.display())),
                _ => {}
            }
        }
        dest = dir.join(format!("{stem} ({i}).{ext}"));
        i += 1;
        if i > 999 { return Err(tr!("{}: слишком много файлов с таким именем", "{}: too many files with this name", name)); }
    }
    write_atomic(&dest, &bytes).map_err(|e| tr!("Не удалось скопировать шрифт {}: {}", "Cannot copy the font {}: {}", name, e))?;
    entry(&dest, false).ok_or_else(|| tr!("{}: не удалось прочитать шрифт", "{}: cannot read the font", dest.display()))
}

/// Имя файла без папок: без разделителей, «..», управляющих символов
fn plain_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 255 && n != "." && n != ".." && !n.contains("..") && !n.chars().any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------
/// [{ family, assFamily, file, path, url, builtin, size }]: встроенные (из <app_cache>/fonts), затем пользовательские
#[tauri::command]
pub async fn fonts_list(app: AppHandle) -> R<Vec<Value>> {
    blocking(move || list(&app)).await?
}

/// Добавить шрифты (paths не задан — диалог выбора файлов). Возвращает добавленные записи; отмена — [].
/// Если не добавился ни один файл — ошибка с причинами.
#[tauri::command]
pub async fn fonts_add(window: WebviewWindow, paths: Option<Vec<String>>) -> R<Vec<Value>> {
    let files: Vec<PathBuf> = match paths {
        Some(v) => v.into_iter().map(PathBuf::from).collect(),
        None => {
            let d = window.dialog().file().set_title(tr!("Добавить шрифты", "Add fonts")).set_parent(&window)
                .add_filter(tr!("Шрифты (TTF, OTF, TTC)", "Fonts (TTF, OTF, TTC)"), FONT_EXT);
            match tauri::async_runtime::spawn_blocking(move || d.blocking_pick_files()).await.ok().flatten() {
                Some(v) => v.into_iter().filter_map(|f| f.into_path().ok()).collect(),
                None => return Ok(vec![]),
            }
        }
    };
    if files.is_empty() { return Ok(vec![]); }
    blocking(move || {
        let (mut added, mut errors) = (vec![], vec![]);
        for f in &files {
            match add_one(f) { Ok(e) => added.push(e), Err(e) => errors.push(e) }
        }
        if added.is_empty() && !errors.is_empty() { Err(errors.join("\n")) } else { Ok(added) }
    }).await?
}

/// Удалить пользовательский шрифт по имени файла
#[tauri::command]
pub async fn fonts_remove(file: String) -> R<bool> {
    blocking(move || {
        if !plain_name(&file) || !has_font_ext(Path::new(&file)) { return Err(tr!("Неверное имя файла шрифта: «{}»", "Invalid font file name: \"{}\"", file)); }
        let p = user_dir().join(&file);
        if !p.is_file() { return Err(tr!("Шрифт «{}» не найден", "Font \"{}\" not found", file)); }
        std::fs::remove_file(&p).map_err(|e| tr!("Не удалось удалить шрифт: {}", "Cannot remove the font: {}", e))?;
        Ok(true)
    }).await?
}

/// Открыть папку пользовательских шрифтов в проводнике
#[tauri::command]
pub async fn fonts_open_dir() -> R<bool> {
    blocking(|| {
        let d = user_dir();
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        tauri_plugin_opener::open_path(s(&d), None::<&str>).map_err(|e| e.to_string())?;
        Ok(true)
    }).await?
}

/// Подготовить <app_cache>/fonts (для fontsdir фильтра ass) → путь к папке
#[tauri::command]
pub async fn fonts_export_dir(app: AppHandle) -> R<String> {
    blocking(move || ensure_export(&app).map(|d| s(&d))).await?
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn builtin_file(name: &str) -> Vec<u8> {
        std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/renderer/assets/fonts").join(name)).unwrap()
    }

    #[test]
    fn builtin_family_names() {
        let inter = family_name(&builtin_file("Inter.ttf"));
        let open = family_name(&builtin_file("OpenSans.ttf"));
        println!("Inter.ttf → {inter:?}; OpenSans.ttf → {open:?}");
        for n in ["Inter.ttf", "OpenSans.ttf"] {
            let b = builtin_file(n);
            for id in [1u16, 2, 4, 6, 16] { println!("{n} nameID {id}: {:?}", name_id(&b, id)); }
        }
        // Inter 4 (вариативный) называется «Inter Variable»; nameID 16 у обоих нет
        assert_eq!(inter.as_deref(), Some("Inter Variable"));
        assert_eq!(name_id(&builtin_file("Inter.ttf"), 1).as_deref(), Some("Inter Variable"));
        assert_eq!(open.as_deref(), Some("Open Sans"));
        assert!(is_sfnt(&builtin_file("Inter.ttf")));
    }

    #[test]
    fn bad_fonts_rejected() {
        assert_eq!(family_name(b""), None);
        assert_eq!(family_name(b"<!DOCTYPE html><html></html>"), None);
        // обрезанный шрифт не паникует
        let b = builtin_file("Inter.ttf");
        for n in [12, 100, 1000, 5000] { let _ = family_name(&b[..n]); }
        // коллекция с одним шрифтом (смещение первого шрифта = 12 + 4) — то же имя
        let mut ttc = b"ttcf\x00\x01\x00\x00\x00\x00\x00\x01\x00\x00\x00\x10".to_vec();
        let mut face = b.clone();
        // смещения таблиц в коллекции — от начала файла: сдвигаем на 16
        let n = u16at(&face, 4).unwrap() as usize;
        for t in 0..n {
            let rec = 12 + t * 16 + 8;
            let off = u32at(&face, rec).unwrap() + 16;
            face[rec..rec + 4].copy_from_slice(&off.to_be_bytes());
        }
        ttc.extend(face);
        assert_eq!(family_name(&ttc).as_deref(), Some("Inter Variable"));
        assert!(plain_name("Inter.ttf") && !plain_name("../x.ttf") && !plain_name("a/b.ttf") && !plain_name("a\\b.ttf") && !plain_name(""));
    }

    /// Добавление в папку пользователя (FFM_FONTS_DIR): тот же файл — не копируется, другой с тем же именем — с суффиксом,
    /// имя встроенного шрифта занято, не шрифт — отказ
    #[test]
    fn add_user_fonts() {
        let base = std::env::temp_dir().join(format!("ffm-fonts-{}", std::process::id()));
        let user = base.join("user");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::env::set_var("FFM_FONTS_DIR", &user);
        let inter = builtin_file("Inter.ttf");
        let open = builtin_file("OpenSans.ttf");
        std::fs::write(src.join("My.ttf"), &inter).unwrap();
        let e = add_one(&src.join("My.ttf")).unwrap();
        assert_eq!(e["family"], "Inter Variable");
        assert_eq!(e["file"], "My.ttf");
        assert_eq!(e["builtin"], false);
        assert!(e["url"].as_str().unwrap().contains("My.ttf"));
        assert_eq!(add_one(&src.join("My.ttf")).unwrap()["file"], "My.ttf");
        std::fs::write(src.join("My.ttf"), &open).unwrap();
        assert_eq!(add_one(&src.join("My.ttf")).unwrap()["file"], "My (2).ttf");
        std::fs::write(src.join("Inter.ttf"), &open).unwrap();
        assert_eq!(add_one(&src.join("Inter.ttf")).unwrap()["family"], "Open Sans");
        assert!(!user.join("Inter.ttf").exists());
        std::fs::write(src.join("bad.ttf"), b"<html></html> not a font").unwrap();
        assert!(add_one(&src.join("bad.ttf")).is_err());
        std::fs::write(src.join("font.exe"), &inter).unwrap();
        assert!(add_one(&src.join("font.exe")).is_err());
        let names: Vec<String> = font_files(&user).iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["Inter (2).ttf", "My (2).ttf", "My.ttf"]);
        assert_eq!(export_name("inter.TTF"), "user-inter.TTF");
        std::env::remove_var("FFM_FONTS_DIR");
        let _ = std::fs::remove_dir_all(&base);
    }
}
