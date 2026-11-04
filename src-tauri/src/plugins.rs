// Плагины (M3): каталог <папка данных>/plugins/<id>/plugin.json (paths::Paths::plugins_dir, FFM_PLUGINS_DIR), проверка манифестов, установка из папки / ZIP / GitHub,
// хранилище данных плагина, сетевые запросы плагина и протокол plugin:// (файлы плагина для песочных iframe).
// Общий контракт — .agent/plugins-contract.md. Права плагина проверяет окно; здесь — вторая линия защиты
// (манифест перечитывается с диска, пути — только внутри папки плагина).
use crate::{ff, paths, tr};
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::http::{Request, Response, StatusCode};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

pub const API_VERSION: u64 = 1;
/// Размер plugin.json и данных storage
const MAX_JSON: u64 = 1024 * 1024;
/// Установка: архив / распакованное содержимое и число файлов
const MAX_INSTALL_BYTES: u64 = 100 * 1024 * 1024;
const MAX_INSTALL_FILES: usize = 2000;
/// Сетевой запрос плагина
const MAX_NET_BYTES: usize = 5 * 1024 * 1024;
/// Один файл, который отдаёт протокол plugin://
const MAX_SERVE_BYTES: u64 = 64 * 1024 * 1024;

const SAFE_SRC: &str = include_str!("../../src/renderer/js/core/safeFilters.js");
const SDK_JS: &str = include_str!("../../src/renderer/js/plugins/sdk.js");

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

// ---------------------------------------------------------------------------
// Безопасные фильтры FFmpeg (один список с JS: js/core/safeFilters.js)
// ---------------------------------------------------------------------------
/// Имена в одинарных кавычках между `// BEGIN-FILTERS` и `// END-FILTERS` (комментарии `//` пропускаются)
fn parse_safe(src: &str) -> Vec<String> {
    let start = src.find("// BEGIN-FILTERS").map(|i| i + "// BEGIN-FILTERS".len()).unwrap_or(src.len());
    let end = src[start..].find("// END-FILTERS").map(|i| start + i).unwrap_or(start);
    let mut out = vec![];
    for line in src[start..end].lines() {
        let code = line.split("//").next().unwrap_or("");
        let mut rest = code;
        while let Some(a) = rest.find('\'') {
            let Some(b) = rest[a + 1..].find('\'') else { break };
            let name = &rest[a + 1..a + 1 + b];
            if !name.is_empty() && !out.iter().any(|x| x == name) {
                out.push(name.to_string());
            }
            rest = &rest[a + 2 + b..];
        }
    }
    out
}

pub fn safe_filters() -> &'static [String] {
    static LIST: OnceLock<Vec<String>> = OnceLock::new();
    LIST.get_or_init(|| parse_safe(SAFE_SRC))
}

pub fn is_safe_filter(name: &str) -> bool {
    safe_filters().iter().any(|f| f == name)
}

/// Как FORBIDDEN_OPTION в safeFilters.js: /file|^filename$|^model$|^sofa$|^url$|^commands?$/i
pub fn forbidden_option(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("file") || matches!(k.as_str(), "filename" | "model" | "sofa" | "url" | "command" | "commands")
}

// ---------------------------------------------------------------------------
// Каталог и адреса
// ---------------------------------------------------------------------------
pub fn plugins_dir() -> PathBuf {
    paths::get().plugins_dir.clone()
}

/// Начало адреса файлов плагина: <base><id>/<путь>
pub fn base_url() -> &'static str {
    if cfg!(windows) || cfg!(target_os = "android") {
        "http://plugin.localhost/"
    } else {
        "plugin://localhost/"
    }
}

/// ^[a-z0-9][a-z0-9-]{1,40}$, не "core"
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (2..=41).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && id != "core"
}

fn check_id(id: &str) -> R<()> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(tr!("Неверный id плагина: «{}»", "Invalid plugin id: \"{}\"", id))
    }
}

/// Относительный путь внутри папки плагина: без «..», «.», пустых частей, «\», «:» и управляющих символов
pub fn safe_rel(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 260
        && !p.starts_with('/')
        && !p.chars().any(|c| c == '\\' || c == ':' || c.is_control())
        && p.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// Имя хоста для права net:<host> (без порта, схемы, звёздочек)
pub fn valid_host(h: &str) -> bool {
    let labels: Vec<&str> = h.split('.').collect();
    !h.is_empty()
        && h.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            let b = l.as_bytes();
            !b.is_empty()
                && b.len() <= 63
                && b[0] != b'-'
                && b[b.len() - 1] != b'-'
                && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        })
}

const PERMISSIONS: &[&str] = &["project:read", "project:write", "ui:panel", "storage", "notify"];

fn text_or_lang(v: &Value) -> bool {
    match v {
        Value::String(t) => !t.trim().is_empty(),
        Value::Object(o) => {
            !o.is_empty() && o.values().all(|x| x.is_string()) && o.values().any(|x| !x.as_str().unwrap_or("").trim().is_empty())
        }
        _ => false,
    }
}

/// Проверка manifest; dir — папка плагина (тогда проверяется, что entry-файлы есть). Ok(id).
pub fn check_manifest(m: &Value, dir: Option<&Path>) -> R<String> {
    if !m.is_object() {
        return Err(tr!("plugin.json — не объект JSON", "plugin.json is not a JSON object").into());
    }
    let id = m["id"].as_str().unwrap_or("");
    check_id(id)?;
    if !text_or_lang(&m["name"]) {
        return Err(tr!("нет поля name", "the name field is missing").into());
    }
    let ver = m["version"].as_str().unwrap_or("");
    if ver.trim().is_empty() || ver.len() > 40 {
        return Err(tr!("нет поля version", "the version field is missing").into());
    }
    if m["apiVersion"].as_u64() != Some(API_VERSION) {
        return Err(tr!("apiVersion должен быть {}", "apiVersion must be {}", API_VERSION));
    }
    if !m["description"].is_null() && !text_or_lang(&m["description"]) {
        return Err(tr!("description — строка или объект ru/en", "description must be a string or an ru/en object").into());
    }
    for k in ["author", "homepage"] {
        if !m[k].is_null() && !m[k].is_string() {
            return Err(tr!("{} — строка", "{} must be a string", k));
        }
    }
    let file_ok = |rel: &str| -> R<()> {
        if !safe_rel(rel) {
            return Err(tr!("путь «{}» должен быть внутри папки плагина", "path \"{}\" must be inside the plugin folder", rel));
        }
        if let Some(d) = dir {
            if !d.join(rel).is_file() {
                return Err(tr!("нет файла «{}»", "file \"{}\" not found", rel));
            }
        }
        Ok(())
    };
    if !m["entry"].is_null() {
        file_ok(m["entry"].as_str().ok_or(tr!("entry — строка", "entry must be a string"))?)?;
    }
    let c = &m["contributes"];
    if !c.is_null() {
        if !c.is_object() {
            return Err(tr!("contributes — объект", "contributes must be an object").into());
        }
        for k in ["effects", "transitions", "audioEffects", "exportPresets", "textStyles", "keymaps", "actions", "panels"] {
            if !c[k].is_null() && !c[k].is_array() {
                return Err(tr!("contributes.{} — массив", "contributes.{} must be an array", k));
            }
        }
        for p in c["panels"].as_array().into_iter().flatten() {
            if !p["id"].is_string() {
                return Err(tr!("у панели нет id", "a panel has no id").into());
            }
            file_ok(p["entry"].as_str().ok_or(tr!("у панели нет entry", "a panel has no entry"))?)?;
        }
    }
    if !m["permissions"].is_null() {
        let arr = m["permissions"].as_array().ok_or(tr!("permissions — массив строк", "permissions must be an array of strings"))?;
        for p in arr {
            let p = p.as_str().ok_or(tr!("permissions — массив строк", "permissions must be an array of strings"))?;
            let ok = PERMISSIONS.contains(&p) || p.strip_prefix("net:").map(valid_host).unwrap_or(false);
            if !ok {
                return Err(tr!("неизвестное право «{}»", "unknown permission \"{}\"", p));
            }
        }
    }
    let f = &m["ffmpeg"];
    if !f.is_null() {
        if !f.is_object() || (!f["filters"].is_null() && !f["filters"].is_array()) {
            return Err(tr!("ffmpeg.filters — массив имён фильтров", "ffmpeg.filters must be an array of filter names").into());
        }
        for x in f["filters"].as_array().into_iter().flatten() {
            let n = x.as_str().unwrap_or("");
            if !is_safe_filter(n) {
                return Err(tr!("фильтр FFmpeg «{}» не разрешён", "FFmpeg filter \"{}\" is not allowed", n));
            }
        }
    }
    if !m["assets"].is_null() && !m["assets"].is_array() {
        return Err(tr!("assets — массив", "assets must be an array").into());
    }
    Ok(id.to_string())
}

fn read_json_file(file: &Path) -> R<Value> {
    let len = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    if len > MAX_JSON {
        return Err(tr!("{} больше 1 МБ", "{} is larger than 1 MB", file.display()));
    }
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| tr!("{}: ошибка JSON: {}", "{}: JSON error: {}", file.display(), e))
}

pub fn read_manifest(dir: &Path) -> R<Value> {
    read_json_file(&dir.join("plugin.json"))
}

/// Установленный плагин с проверенным манифестом (папка = id)
fn installed(id: &str) -> R<(PathBuf, Value)> {
    check_id(id)?;
    let dir = plugins_dir().join(id);
    if !dir.join("plugin.json").is_file() {
        return Err(tr!("Плагин «{}» не установлен", "Plugin \"{}\" is not installed", id));
    }
    let m = read_manifest(&dir)?;
    let mid = check_manifest(&m, Some(&dir))?;
    if mid != id {
        return Err(tr!(
            "id в plugin.json («{}») не совпадает с папкой «{}»",
            "the id in plugin.json (\"{}\") does not match the folder \"{}\"",
            mid,
            id
        ));
    }
    Ok((dir, m))
}

fn permissions(m: &Value) -> Vec<String> {
    m["permissions"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Команды: список, выбор, удаление, папка
// ---------------------------------------------------------------------------
pub fn list() -> Value {
    let dir = plugins_dir();
    let mut items: Vec<Value> = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let pdir = e.path();
            if !pdir.join("plugin.json").exists() {
                continue;
            }
            let mut item = json!({ "id": name, "dir": s(&pdir), "manifest": Value::Null });
            match read_manifest(&pdir) {
                Ok(m) => {
                    match check_manifest(&m, Some(&pdir)) {
                        Ok(id) if id == name => {}
                        Ok(id) => {
                            item["error"] = json!(tr!(
                                "id в plugin.json («{}») не совпадает с папкой «{}»",
                                "the id in plugin.json (\"{}\") does not match the folder \"{}\"",
                                id,
                                name
                            ))
                        }
                        Err(e) => item["error"] = json!(e),
                    }
                    item["manifest"] = m;
                }
                Err(e) => item["error"] = json!(e),
            }
            items.push(item);
        }
    }
    items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    json!({ "dir": s(&dir), "baseUrl": base_url(), "apiVersion": API_VERSION, "safeFilters": safe_filters(), "plugins": items })
}

#[tauri::command]
pub fn plugins_list() -> Value {
    list()
}

#[tauri::command]
pub async fn plugins_pick(window: WebviewWindow, kind: Option<String>) -> Option<String> {
    let d = window.dialog().file().set_parent(&window);
    let zip = kind.as_deref() == Some("zip");
    let r = if zip {
        let d = d.set_title(tr!("Плагин (ZIP-архив)", "Plugin (ZIP archive)")).add_filter(tr!("ZIP-архив", "ZIP archive"), &["zip"]);
        tauri::async_runtime::spawn_blocking(move || d.blocking_pick_file()).await.ok().flatten()
    } else {
        let d = d.set_title(tr!("Папка плагина (с plugin.json)", "Plugin folder (with plugin.json)"));
        tauri::async_runtime::spawn_blocking(move || d.blocking_pick_folder()).await.ok().flatten()
    };
    r.and_then(|f| f.into_path().ok()).map(|p| s(&p))
}

#[tauri::command]
pub fn plugins_remove(id: String) -> R<bool> {
    check_id(&id)?;
    let dir = plugins_dir().join(&id);
    if !dir.is_dir() {
        return Err(tr!("Плагин «{}» не установлен", "Plugin \"{}\" is not installed", id));
    }
    // Сначала переименовать (файлы могут быть открыты), потом удалить
    let tmp = plugins_dir().join(format!(".old-{id}-{}", stamp()));
    std::fs::rename(&dir, &tmp).map_err(|e| tr!("Не удалось удалить плагин: {}", "Cannot remove the plugin: {}", e))?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(true)
}

#[tauri::command]
pub fn plugins_open_dir(id: Option<String>) -> R<bool> {
    let dir = match id.filter(|x| !x.is_empty()) {
        Some(id) => {
            check_id(&id)?;
            let d = plugins_dir().join(&id);
            if !d.is_dir() {
                return Err(tr!("Плагин «{}» не установлен", "Plugin \"{}\" is not installed", id));
            }
            d
        }
        None => {
            let d = plugins_dir();
            std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
            d
        }
    };
    tauri_plugin_opener::open_path(s(&dir), None::<&str>).map_err(|e| e.to_string())?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Установка
// ---------------------------------------------------------------------------
fn stamp() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// Временная папка внутри каталога плагинов (тот же диск — rename атомарен); удаляется при drop
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn staging() -> R<Staging> {
    let d = plugins_dir().join(format!(".tmp-{}", stamp()));
    std::fs::create_dir_all(&d).map_err(|e| tr!("Не удалось создать папку {}: {}", "Cannot create folder {}: {}", d.display(), e))?;
    Ok(Staging(d))
}

struct Budget {
    bytes: u64,
    files: usize,
}

impl Budget {
    fn new() -> Self {
        Budget { bytes: 0, files: 0 }
    }
    fn file(&mut self) -> R<()> {
        self.files += 1;
        if self.files > MAX_INSTALL_FILES {
            return Err(tr!("В плагине больше {} файлов", "The plugin has more than {} files", MAX_INSTALL_FILES));
        }
        Ok(())
    }
}

/// Путь записи ZIP → относительный путь внутри папки, или None (zip-slip: «..», абсолютный путь, диск, «\»-обход)
pub fn zip_entry_path(name: &str) -> Option<PathBuf> {
    let n = name.replace('\\', "/");
    if n.starts_with('/') || n.contains(':') || n.chars().any(|c| c.is_control()) {
        return None;
    }
    let mut out = PathBuf::new();
    for seg in n.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None,
            s => out.push(s),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Распаковать архив в dst. Любая подозрительная запись — ошибка (весь архив отклоняется).
pub fn extract_zip(file: &Path, dst: &Path) -> R<()> {
    let len = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    if len > MAX_INSTALL_BYTES {
        return Err(tr!("Архив больше 100 МБ", "The archive is larger than 100 MB").into());
    }
    let f = std::fs::File::open(file).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|e| tr!("Не ZIP-архив: {}", "Not a ZIP archive: {}", e))?;
    if zip.len() > MAX_INSTALL_FILES {
        return Err(tr!("В архиве больше {} файлов", "The archive has more than {} files", MAX_INSTALL_FILES));
    }
    let mut budget = Budget::new();
    for i in 0..zip.len() {
        let mut ent = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = ent.name().to_string();
        let rel =
            zip_entry_path(&name).ok_or_else(|| tr!("Недопустимый путь в архиве: «{}»", "Invalid path in the archive: \"{}\"", name))?;
        if ent.unix_mode().map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
            return Err(tr!("В архиве символьная ссылка: «{}»", "The archive contains a symbolic link: \"{}\"", name));
        }
        let out = dst.join(&rel);
        if ent.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        budget.file()?;
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        // Размер из заголовка не верим: считаем реально распакованное
        let left = MAX_INSTALL_BYTES - budget.bytes;
        let n = std::io::copy(&mut (&mut ent).take(left + 1), &mut w).map_err(|e| e.to_string())?;
        budget.bytes += n;
        if budget.bytes > MAX_INSTALL_BYTES {
            return Err(tr!("Распакованный плагин больше 100 МБ", "The unpacked plugin is larger than 100 MB").into());
        }
    }
    Ok(())
}

/// Копия папки плагина (символьные ссылки и .git пропускаются)
fn copy_dir(src: &Path, dst: &Path, budget: &mut Budget) -> R<()> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name();
        let md = std::fs::symlink_metadata(e.path()).map_err(|e| e.to_string())?;
        if md.file_type().is_symlink() || name == ".git" {
            continue;
        }
        let to = dst.join(&name);
        if md.is_dir() {
            copy_dir(&e.path(), &to, budget)?;
        } else if md.is_file() {
            budget.file()?;
            budget.bytes += md.len();
            if budget.bytes > MAX_INSTALL_BYTES {
                return Err(tr!("Плагин больше 100 МБ", "The plugin is larger than 100 MB").into());
            }
            std::fs::copy(e.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// plugin.json — в корне или в единственной вложенной папке (служебные __MACOSX, .DS_Store не считаются)
fn find_root(x: &Path) -> R<PathBuf> {
    if x.join("plugin.json").is_file() {
        return Ok(x.to_path_buf());
    }
    let entries: Vec<PathBuf> = std::fs::read_dir(x)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n != "__MACOSX" && n != ".DS_Store"
        })
        .map(|e| e.path())
        .collect();
    if entries.len() == 1 && entries[0].is_dir() && entries[0].join("plugin.json").is_file() {
        return Ok(entries[0].clone());
    }
    Err(tr!(
        "plugin.json не найден (нужен в корне архива/папки или в единственной вложенной папке)",
        "plugin.json not found (it must be in the root of the archive/folder or in a single nested folder)"
    )
    .into())
}

/// Проверить распакованный плагин и атомарно поставить его на место <plugins>/<id>
fn install_from(root: &Path) -> R<Value> {
    let manifest = read_manifest(root)?;
    let id = check_manifest(&manifest, Some(root)).map_err(|e| tr!("Плагин не установлен: {}", "Plugin not installed: {}", e))?;
    let dir = plugins_dir();
    let target = dir.join(&id);
    let replaced = target.exists();
    let old = dir.join(format!(".old-{id}-{}", stamp()));
    if replaced {
        std::fs::rename(&target, &old).map_err(|e| {
            tr!("Не удалось заменить старую версию (файлы заняты?): {}", "Cannot replace the old version (files in use?): {}", e)
        })?;
    }
    if let Err(e) = std::fs::rename(root, &target) {
        if replaced {
            let _ = std::fs::rename(&old, &target);
        }
        return Err(tr!("Не удалось установить плагин: {}", "Cannot install the plugin: {}", e));
    }
    if replaced {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(json!({ "id": id, "manifest": manifest, "replaced": replaced }))
}

pub fn install(source: &Path) -> R<Value> {
    let st = staging()?;
    let x = st.0.join("x");
    if source.is_dir() {
        copy_dir(source, &x, &mut Budget::new())?;
    } else if source.is_file() && ff::ext_of(source) == "zip" {
        std::fs::create_dir_all(&x).map_err(|e| e.to_string())?;
        extract_zip(source, &x)?;
    } else {
        return Err(tr!("Укажите папку плагина или ZIP-архив: {}", "Choose a plugin folder or a ZIP archive: {}", source.display()));
    }
    let root = find_root(&x)?;
    install_from(&root)
}

#[tauri::command]
pub async fn plugins_install(source: String) -> R<Value> {
    let p = PathBuf::from(source.trim());
    tauri::async_runtime::spawn_blocking(move || install(&p)).await.map_err(|e| e.to_string())?
}

// --- GitHub: последний релиз → первый ассет .zip; если есть <zip>.sha256 или SHA256SUMS* — сверить ---
fn valid_repo(repo: &str) -> bool {
    let ok = |p: &str| {
        !p.is_empty()
            && p.len() <= 100
            && p != "."
            && p != ".."
            && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    matches!(repo.split_once('/'), Some((a, b)) if ok(a) && ok(b))
}

async fn curl_get(url: &str, out: Option<&Path>, max_bytes: u64) -> R<Vec<u8>> {
    let curl = crate::update::which("curl").ok_or(tr!("curl не найден", "curl not found"))?;
    let mut c = ff::command(&curl);
    c.args([
        "-q",
        "-sSL",
        "--fail",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-time",
        "120",
        "--max-filesize",
        &max_bytes.to_string(),
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "User-Agent: FF-Montage",
    ]);
    if let Some(o) = out {
        c.arg("-o").arg(o);
    }
    c.arg("--url").arg(url);
    let r = c.output().await.map_err(|e| e.to_string())?;
    if !r.status.success() {
        return Err(tr!("Не удалось скачать {}: {}", "Cannot download {}: {}", url, String::from_utf8_lossy(&r.stderr).trim()));
    }
    Ok(r.stdout)
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// Ожидаемая сумма для файла name из текста .sha256 / SHA256SUMS
pub fn expected_sha(text: &str, name: &str, single: bool) -> Option<String> {
    let is_hex = |t: &str| t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit());
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(h) = parts.next() else { continue };
        if !is_hex(h) {
            continue;
        }
        let file = parts.next().map(|f| f.trim_start_matches('*'));
        if file == Some(name) || (single && file.is_none_or(|f| f.ends_with(name))) {
            return Some(h.to_ascii_lowercase());
        }
    }
    None
}

#[tauri::command]
pub async fn plugins_install_github(repo: String) -> R<Value> {
    let repo = repo.trim().trim_start_matches("https://github.com/").trim_end_matches('/').to_string();
    if !valid_repo(&repo) {
        return Err(tr!("Укажите репозиторий в виде owner/name", "Enter the repository as owner/name").into());
    }
    let body = curl_get(&format!("https://api.github.com/repos/{repo}/releases/latest"), None, MAX_JSON * 4).await?;
    let rel: Value = serde_json::from_slice(&body).map_err(|_| tr!("GitHub не ответил", "GitHub did not respond").to_string())?;
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    let name_of = |a: &Value| a["name"].as_str().unwrap_or("").to_string();
    let url_of = |a: &Value| a["browser_download_url"].as_str().unwrap_or("").to_string();
    let zip = assets
        .iter()
        .find(|a| name_of(a).to_lowercase().ends_with(".zip"))
        .ok_or(tr!("В последнем релизе нет ZIP-архива", "The latest release has no ZIP archive"))?;
    let zip_name = name_of(zip);
    if !url_of(zip).starts_with("https://") {
        return Err(tr!("Неверный адрес архива", "Invalid archive URL").into());
    }
    let st = staging()?;
    let file = st.0.join("plugin.zip");
    curl_get(&url_of(zip), Some(&file), MAX_INSTALL_BYTES).await?;
    let data = std::fs::read(&file).map_err(|e| e.to_string())?;
    // Контрольная сумма
    let single = assets.iter().find(|a| name_of(a) == format!("{zip_name}.sha256"));
    let sums = assets.iter().find(|a| name_of(a).to_uppercase().starts_with("SHA256SUMS"));
    let mut verified = false;
    if let Some((a, single)) = single.map(|a| (a, true)).or(sums.map(|a| (a, false))) {
        let text = String::from_utf8_lossy(&curl_get(&url_of(a), None, MAX_JSON).await?).to_string();
        let want = expected_sha(&text, &zip_name, single)
            .ok_or_else(|| tr!("В {} нет суммы для {}", "{} has no checksum for {}", name_of(a), zip_name))?;
        let got = sha256_hex(&data);
        if got != want {
            return Err(tr!("Контрольная сумма архива не совпала ({} ≠ {})", "Archive checksum mismatch ({} ≠ {})", got, want));
        }
        verified = true;
    }
    let st_path = st.0.clone();
    let mut r = tauri::async_runtime::spawn_blocking(move || -> R<Value> {
        let x = st_path.join("x");
        std::fs::create_dir_all(&x).map_err(|e| e.to_string())?;
        extract_zip(&st_path.join("plugin.zip"), &x)?;
        install_from(&find_root(&x)?)
    })
    .await
    .map_err(|e| e.to_string())??;
    drop(st);
    r["sha256Verified"] = json!(verified);
    r["asset"] = json!(zip_name);
    Ok(r)
}

// ---------------------------------------------------------------------------
// Хранилище плагина: <plugins>/.data/<id>.json (≤ 1 МБ)
// ---------------------------------------------------------------------------
fn storage_file(id: &str) -> PathBuf {
    plugins_dir().join(".data").join(format!("{id}.json"))
}

fn need_permission(m: &Value, perm: &str) -> R<()> {
    if permissions(m).iter().any(|p| p == perm) {
        Ok(())
    } else {
        Err(tr!("У плагина нет права «{}»", "The plugin has no \"{}\" permission", perm))
    }
}

#[tauri::command]
pub fn plugin_storage_get(id: String) -> R<Value> {
    let (_, m) = installed(&id)?;
    need_permission(&m, "storage")?;
    let f = storage_file(&id);
    if !f.exists() {
        return Ok(json!({}));
    }
    let v = read_json_file(&f)?;
    Ok(if v.is_object() { v } else { json!({}) })
}

#[tauri::command]
pub fn plugin_storage_set(id: String, data: Value) -> R<bool> {
    let (_, m) = installed(&id)?;
    need_permission(&m, "storage")?;
    if !data.is_object() {
        return Err(tr!("Данные плагина — объект JSON", "Plugin data must be a JSON object").into());
    }
    let text = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    if text.len() as u64 > MAX_JSON {
        return Err(tr!("Данные плагина больше 1 МБ", "Plugin data is larger than 1 MB").into());
    }
    let f = storage_file(&id);
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &f)).map_err(|e| e.to_string())?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Сеть плагина: только https и хосты из net:<host> манифеста (перечитывается с диска)
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub struct NetRequest {
    url: String,
    method: Option<String>,
    headers: Option<serde_json::Map<String, Value>>,
    body: Option<String>,
}

/// Хост из адреса, если запрос разрешён правами hosts
pub fn net_allowed(url: &str, hosts: &[String]) -> R<()> {
    let u = tauri::Url::parse(url).map_err(|_| tr!("Неверный адрес: {}", "Invalid URL: {}", url))?;
    if u.scheme() != "https" {
        return Err(tr!("Разрешены только адреса https://", "Only https:// URLs are allowed").into());
    }
    if !u.username().is_empty() || u.password().is_some() || u.port().is_some_and(|p| p != 443) {
        return Err(tr!("Адрес с логином или портом не разрешён", "URLs with credentials or a port are not allowed").into());
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if hosts.contains(&host) {
        Ok(())
    } else {
        Err(tr!("У плагина нет права net:{}", "The plugin has no net:{} permission", host))
    }
}

/// Разбор ответа curl -i: пропускаем «100 Continue» и «Connection established» прокси
fn parse_http(raw: &[u8]) -> (u16, serde_json::Map<String, Value>, Vec<u8>) {
    let mut rest = raw;
    loop {
        let (head, body) = match rest.windows(4).position(|w| w == b"\r\n\r\n") {
            Some(i) => (&rest[..i], &rest[i + 4..]),
            None => match rest.windows(2).position(|w| w == b"\n\n") {
                Some(i) => (&rest[..i], &rest[i + 2..]),
                None => (rest, &rest[rest.len()..]),
            },
        };
        let text = String::from_utf8_lossy(head).to_string();
        let mut lines = text.lines();
        let status_line = lines.next().unwrap_or("");
        let code: u16 = status_line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let interim = code < 200 || status_line.to_ascii_lowercase().contains("connection established");
        if interim && body.starts_with(b"HTTP/") {
            rest = body;
            continue;
        }
        let mut headers = serde_json::Map::new();
        for l in lines {
            if let Some((k, v)) = l.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), json!(v.trim()));
            }
        }
        return (code, headers, body.to_vec());
    }
}

#[tauri::command]
pub async fn plugin_net_fetch(id: String, request: NetRequest) -> R<Value> {
    let (_, m) = installed(&id)?;
    let hosts: Vec<String> = permissions(&m).iter().filter_map(|p| p.strip_prefix("net:").map(str::to_string)).collect();
    net_allowed(&request.url, &hosts)?;
    let method = request.method.unwrap_or_else(|| "GET".into()).to_ascii_uppercase();
    if !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(&method.as_str()) {
        return Err(tr!("Метод {} не разрешён", "Method {} is not allowed", method));
    }
    let curl = crate::update::which("curl").ok_or(tr!("curl не найден", "curl not found"))?;
    let mut c = ff::command(&curl);
    // -q — без ~/.curlrc; -g — без «глоббинга» {}/[] в адресе; без -L — редиректы на другие хосты не идут
    c.args(["-q", "-g", "-sS", "-i", "--proto", "=https", "--max-time", "30", "--max-filesize", &MAX_NET_BYTES.to_string(), "-X", &method]);
    let headers = request.headers.unwrap_or_default();
    if headers.len() > 64 {
        return Err(tr!("Слишком много заголовков", "Too many headers").into());
    }
    for (k, v) in &headers {
        let v = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || v.contains(['\r', '\n']) {
            return Err(tr!("Недопустимый заголовок «{}»", "Invalid header \"{}\"", k));
        }
        c.arg("-H").arg(format!("{k}: {v}"));
    }
    let body = request.body.unwrap_or_default();
    if body.len() > MAX_NET_BYTES {
        return Err(tr!("Тело запроса больше 5 МБ", "The request body is larger than 5 MB").into());
    }
    if !body.is_empty() {
        c.args(["--data-binary", "@-"]).stdin(std::process::Stdio::piped());
    }
    c.arg("--url").arg(&request.url);
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    if !body.is_empty() {
        if let Some(mut si) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = si.write_all(body.as_bytes()).await;
        }
    }
    let mut so = child.stdout.take().ok_or("stdout")?;
    let read = async {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = so.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > MAX_NET_BYTES + 256 * 1024 {
                return Err(tr!("Ответ больше 5 МБ", "The response is larger than 5 MB").to_string());
            }
        }
        Ok(buf)
    };
    let raw = match tokio::time::timeout(Duration::from_secs(35), read).await {
        Ok(r) => r?,
        Err(_) => return Err(tr!("Нет ответа за 30 с", "No response in 30 s").into()),
    };
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    if raw.is_empty() {
        return Err(tr!("Запрос не выполнен: {}", "Request failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let (status, headers, body) = parse_http(&raw);
    if body.len() > MAX_NET_BYTES {
        return Err(tr!("Ответ больше 5 МБ", "The response is larger than 5 MB").into());
    }
    Ok(json!({ "status": status, "headers": headers, "body": String::from_utf8_lossy(&body) }))
}

// ---------------------------------------------------------------------------
// Протокол plugin:// — файлы плагина для песочных iframe
// ---------------------------------------------------------------------------
fn mime(p: &str) -> &'static str {
    match p.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn csp(id: &str) -> String {
    let o = format!("{}{id}/", base_url());
    format!("sandbox allow-scripts; default-src 'none'; script-src {o} 'unsafe-inline'; style-src {o} 'unsafe-inline'; img-src {o} data: blob:; \
        media-src {o} blob:; font-src {o} data:; connect-src {o}; frame-src 'none'; form-action 'none'; base-uri 'none'")
}

fn reply(status: StatusCode, id: &str, typ: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    // Неизвестный id — всё равно самая строгая политика
    let policy = if valid_id(id) { csp(id) } else { "sandbox; default-src 'none'".to_string() };
    Response::builder()
        .status(status)
        .header("Content-Type", typ)
        .header("Access-Control-Allow-Origin", "*")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", policy)
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap()
}

/// <script src="/<id>/__sdk.js"> сразу после <head …> или в начало документа
pub fn inject_sdk(html: &str, id: &str) -> String {
    let tag = format!("<script src=\"/{id}/__sdk.js\"></script>");
    let low = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = low[from..].find("<head").map(|i| from + i) {
        let next = low.as_bytes().get(i + 5).copied();
        if matches!(next, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n') | Some(b'/')) {
            if let Some(j) = low[i..].find('>') {
                let at = i + j + 1;
                return format!("{}{tag}{}", &html[..at], &html[at..]);
            }
        }
        from = i + 5;
    }
    format!("{tag}{html}")
}

pub fn main_html(id: &str, entry: &str) -> String {
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><script src=\"/{id}/__sdk.js\"></script><script type=\"module\" src=\"/{id}/{entry}\"></script></head><body></body></html>")
}

/// Файл rel внутри dir (после разрешения символьных ссылок — всё ещё внутри)
pub fn resolve_inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    if !safe_rel(rel) {
        return None;
    }
    let root = dir.canonicalize().ok()?;
    let file = dir.join(rel).canonicalize().ok()?;
    if file.starts_with(&root) && file.is_file() {
        Some(file)
    } else {
        None
    }
}

pub fn handle(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = req.uri().path().trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8_lossy().to_string();
    let (id, rest) = decoded.split_once('/').unwrap_or((decoded.as_str(), ""));
    let not_found = || reply(StatusCode::NOT_FOUND, id, "text/plain; charset=utf-8", b"Not found".to_vec());
    if !valid_id(id) {
        return not_found();
    }
    let dir = plugins_dir().join(id);
    if !dir.join("plugin.json").is_file() {
        return not_found();
    }
    match rest {
        "__sdk.js" => return reply(StatusCode::OK, id, "text/javascript; charset=utf-8", SDK_JS.as_bytes().to_vec()),
        "__main.html" => {
            let entry = read_manifest(&dir).ok().and_then(|m| m["entry"].as_str().map(str::to_string)).filter(|e| safe_rel(e));
            return match entry {
                Some(e) => reply(StatusCode::OK, id, "text/html; charset=utf-8", main_html(id, &e).into_bytes()),
                None => not_found(),
            };
        }
        _ => {}
    }
    let Some(file) = resolve_inside(&dir, rest) else { return not_found() };
    if std::fs::metadata(&file).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_SERVE_BYTES {
        return not_found();
    }
    let Ok(mut data) = std::fs::read(&file) else { return not_found() };
    let typ = mime(rest);
    if typ.starts_with("text/html") {
        data = inject_sdk(&String::from_utf8_lossy(&data), id).into_bytes();
    }
    reply(StatusCode::OK, id, typ, data)
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn safe_list_parsed() {
        let f = safe_filters();
        assert!(f.len() > 100, "{}", f.len());
        for n in ["setpts", "xfade", "overlay", "curves", "reverse", "rotate", "split", "color"] {
            assert!(is_safe_filter(n), "{n}");
        }
        for n in ["movie", "amovie", "sendcmd", "lut3d", "subtitles", "drawtext", "ladspa", "arnndn", "zmq", "BEGIN-FILTERS"] {
            assert!(!is_safe_filter(n), "{n}");
        }
    }

    #[test]
    fn forbidden_keys() {
        for k in ["file", "psfile", "FileName", "dumpfile", "model", "SOFA", "url", "command", "commands"] {
            assert!(forbidden_option(k), "{k}");
        }
        for k in ["preset", "master", "s", "expr", "models", "urls2"] {
            assert!(!forbidden_option(k), "{k}");
        }
    }

    #[test]
    fn ids_and_paths() {
        assert!(valid_id("vignette") && valid_id("a1") && valid_id("my-plugin-2"));
        assert!(!valid_id("core") && !valid_id("a") && !valid_id("-x") && !valid_id("Big") && !valid_id("a_b") && !valid_id("../x"));
        assert!(!valid_id(&"a".repeat(42)));
        assert!(safe_rel("main.js") && safe_rel("ui/panel.html"));
        for bad in ["", "../x.js", "a/../../x", "/abs.js", "C:/x.js", "a\\b.js", "./a.js", "a//b"] {
            assert!(!safe_rel(bad), "{bad}");
        }
        assert!(
            valid_host("api.example.com")
                && !valid_host("localhost")
                && !valid_host("*.x.com")
                && !valid_host("x.com:8080")
                && !valid_host("X.com")
        );
    }

    fn manifest() -> Value {
        json!({ "id": "vignette", "name": { "ru": "Виньетка", "en": "Vignette" }, "version": "1.0.0", "apiVersion": 1, // i18n-ignore — тест
            "permissions": ["storage", "notify", "net:api.example.com"], "ffmpeg": { "filters": ["vignette"] },
            "contributes": { "effects": [] } })
    }

    #[test]
    fn manifest_check() {
        assert_eq!(check_manifest(&manifest(), None).unwrap(), "vignette");
        let bad = |f: &dyn Fn(&mut Value)| {
            let mut m = manifest();
            f(&mut m);
            check_manifest(&m, None).is_err()
        };
        assert!(bad(&|m| m["id"] = json!("core")));
        assert!(bad(&|m| m["id"] = json!("Bad Id")));
        assert!(bad(&|m| {
            m.as_object_mut().unwrap().remove("name");
        }));
        assert!(bad(&|m| {
            m.as_object_mut().unwrap().remove("version");
        }));
        assert!(bad(&|m| m["apiVersion"] = json!(2)));
        assert!(bad(&|m| m["entry"] = json!("../main.js")));
        assert!(bad(&|m| m["entry"] = json!("/etc/main.js")));
        assert!(bad(&|m| m["contributes"]["panels"] = json!([{ "id": "p", "entry": "..\\p.html" }])));
        assert!(bad(&|m| m["permissions"] = json!(["fs:write"])));
        assert!(bad(&|m| m["permissions"] = json!(["net:*.example.com"])));
        assert!(bad(&|m| m["permissions"] = json!(["net:example.com:8443"])));
        assert!(bad(&|m| m["ffmpeg"]["filters"] = json!(["movie"])));
        assert!(bad(&|m| m["ffmpeg"]["filters"] = json!(["lut3d"])));
        // entry указан, но файла нет в папке
        let dir = std::env::temp_dir().join(format!("ffm-mtest-{}", stamp()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut m = manifest();
        m["entry"] = json!("main.js");
        assert!(check_manifest(&m, Some(&dir)).is_err());
        std::fs::write(dir.join("main.js"), "").unwrap();
        assert!(check_manifest(&m, Some(&dir)).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_slip_paths() {
        assert_eq!(zip_entry_path("a/b.js"), Some(PathBuf::from("a").join("b.js")));
        assert_eq!(zip_entry_path("./a.js"), Some(PathBuf::from("a.js")));
        for bad in ["../evil", "a/../../evil", "..\\evil", "/abs/evil", "\\abs\\evil", "C:/evil", "C:evil", ""] {
            assert_eq!(zip_entry_path(bad), None, "{bad}");
        }
    }

    fn make_zip(file: &Path, entries: &[(&str, &[u8])]) {
        let f = std::fs::File::create(file).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            w.start_file(*name, opt).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn zip_extract() {
        let base = std::env::temp_dir().join(format!("ffm-ztest-{}", stamp()));
        std::fs::create_dir_all(&base).unwrap();
        // Нормальный архив: плагин во вложенной папке
        let good = base.join("good.zip");
        make_zip(&good, &[("vignette/plugin.json", br#"{"id":"vignette"}"#), ("vignette/ui/panel.html", b"<html></html>")]);
        let x = base.join("x");
        extract_zip(&good, &x).unwrap();
        assert!(x.join("vignette").join("ui").join("panel.html").is_file());
        assert_eq!(find_root(&x).unwrap(), x.join("vignette"));
        // zip-slip: весь архив отклоняется, наружу ничего не пишется
        for (i, evil) in ["../evil.txt", "a/../../evil.txt", "/abs-evil.txt", "C:/evil.txt"].iter().enumerate() {
            let z = base.join(format!("evil{i}.zip"));
            make_zip(&z, &[("plugin.json", b"{}"), (evil, b"pwned")]);
            let y = base.join(format!("y{i}"));
            std::fs::create_dir_all(&y).unwrap();
            assert!(extract_zip(&z, &y).is_err(), "{evil}");
            assert!(!base.join("evil.txt").exists() && !std::env::temp_dir().join("evil.txt").exists());
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sdk_injection() {
        let h = inject_sdk("<!doctype html><HTML><Head lang=\"ru\"><title>x</title></head><body><header></header></body></html>", "vig");
        assert!(h.contains("<Head lang=\"ru\"><script src=\"/vig/__sdk.js\"></script><title>"), "{h}");
        let h = inject_sdk("<body><header>x</header></body>", "vig");
        assert!(h.starts_with("<script src=\"/vig/__sdk.js\"></script><body><header>"), "{h}");
        assert!(main_html("vig", "main.js").contains("<script type=\"module\" src=\"/vig/main.js\"></script>"));
        assert!(csp("vig").contains(&format!("script-src {}vig/ 'unsafe-inline'", base_url())));
    }

    #[test]
    fn resolve_paths() {
        let base = std::env::temp_dir().join(format!("ffm-rtest-{}", stamp()));
        let dir = base.join("p");
        std::fs::create_dir_all(dir.join("ui")).unwrap();
        std::fs::write(dir.join("ui").join("a.html"), "x").unwrap();
        std::fs::write(base.join("secret.txt"), "x").unwrap();
        assert!(resolve_inside(&dir, "ui/a.html").is_some());
        assert!(resolve_inside(&dir, "../secret.txt").is_none());
        assert!(resolve_inside(&dir, "ui/../../secret.txt").is_none());
        assert!(resolve_inside(&dir, "ui").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn net_rules() {
        let hosts = vec!["api.example.com".to_string()];
        assert!(net_allowed("https://api.example.com/v1?q=1", &hosts).is_ok());
        assert!(net_allowed("https://API.example.com/v1", &hosts).is_ok());
        for bad in [
            "http://api.example.com/",
            "https://evil.com/",
            "https://api.example.com.evil.com/",
            "https://u:p@api.example.com/",
            "https://api.example.com:8443/",
            "file:///etc/passwd",
            "https://evil.com#@api.example.com",
        ] {
            assert!(net_allowed(bad, &hosts).is_err(), "{bad}");
        }
        let (code, h, body) = parse_http(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/2 201 \r\nContent-Type: text/plain\r\nX-A: b\r\n\r\nhello");
        assert_eq!((code, h["content-type"].as_str(), body.as_slice()), (201, Some("text/plain"), &b"hello"[..]));
    }

    #[test]
    fn checksums() {
        let h = sha256_hex(b"abc");
        assert_eq!(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(expected_sha(&format!("{h}  plugin.zip\n"), "plugin.zip", false), Some(h.clone()));
        assert_eq!(expected_sha(&format!("{h} *other.zip\n"), "plugin.zip", false), None);
        assert_eq!(expected_sha(&h, "plugin.zip", true), Some(h.clone()));
    }
}
