// Встроенные плагины: исходники — plugins-bundled/<id>/… в репозитории, build.rs встраивает их файлы в exe
// (BUNDLED ниже). При запуске программы (main.rs run, до открытия окна — окно сразу видит их в plugins_list)
// недостающие копируются в <plugins>/<id>/, установленные с более старой version (semver) — обновляются,
// с той же или более новой — не трогаются. Удалённые пользователем запоминаются в settings.json
// plugins.removedBundled (settings.rs) и не возвращаются; кнопка «Вернуть встроенные» —
// команда plugins_restore_bundled. Ручная установка плагина с тем же id убирает его из removedBundled (plugins.rs).
// Движок без окна (--engine) и MCP плагины не загружают — им синхронизация не нужна.
use crate::{plugins, settings, tr};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::Path;

include!(concat!(env!("OUT_DIR"), "/bundled_plugins.rs"));

type R<T> = Result<T, String>;

pub fn ids() -> impl Iterator<Item = &'static str> {
    BUNDLED.iter().map(|(id, _)| *id)
}

pub fn is_bundled(id: &str) -> bool {
    ids().any(|x| x == id)
}

fn files(id: &str) -> Option<&'static [(&'static str, &'static [u8])]> {
    BUNDLED.iter().find(|(x, _)| *x == id).map(|(_, f)| *f)
}

/// plugin.json встроенного плагина
pub fn manifest(id: &str) -> Option<Value> {
    let (_, data) = files(id)?.iter().find(|(rel, _)| *rel == "plugin.json")?;
    serde_json::from_slice(data).ok()
}

// ---------------------------------------------------------------------------
// Версии
// ---------------------------------------------------------------------------
/// semver: «1.2.3», «v1.2», «1.0.0-beta.2+build» → (числа, метки пре-релиза); None — не версия
fn parse_version(v: &str) -> Option<(Vec<u64>, Vec<String>)> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let v = v.split('+').next().unwrap_or("");
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let mut nums = core.split('.').map(|x| x.parse::<u64>().ok()).collect::<Option<Vec<u64>>>()?;
    if nums.is_empty() || nums.len() > 4 {
        return None;
    }
    nums.resize(4, 0);
    let pre = match pre {
        Some(p) => {
            let ids: Vec<String> = p.split('.').map(str::to_string).collect();
            if ids.iter().any(|x| x.is_empty()) {
                return None;
            }
            ids
        }
        None => vec![],
    };
    Some((nums, pre))
}

/// Сравнение версий: 1.2.0 < 1.10.0, 1.0.0-beta < 1.0.0 < 1.0.1; None — одна из строк не версия
pub fn cmp_versions(a: &str, b: &str) -> Option<Ordering> {
    let (an, ap) = parse_version(a)?;
    let (bn, bp) = parse_version(b)?;
    let ord = an.cmp(&bn).then_with(|| match (ap.is_empty(), bp.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in ap.iter().zip(bp.iter()) {
                let o = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    _ => x.cmp(y),
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
            ap.len().cmp(&bp.len())
        }
    });
    Some(ord)
}

// ---------------------------------------------------------------------------
// Копирование в папку плагинов
// ---------------------------------------------------------------------------
#[derive(Debug, PartialEq)]
enum Need {
    /// Установленный не трогать (та же или более новая версия, или версия не разбирается)
    Keep,
    /// Нет папки или plugin.json
    Missing,
    /// Установлена старая версия или сломанный манифест
    Update,
}

fn need(dir: &Path, id: &str) -> Need {
    let pdir = dir.join(id);
    if !pdir.join("plugin.json").is_file() {
        return Need::Missing;
    }
    let Some(want) = manifest(id) else { return Need::Keep };
    let have = match plugins::read_manifest(&pdir) {
        Ok(m) if plugins::check_manifest(&m, Some(&pdir)).as_deref() == Ok(id) => m,
        _ => return Need::Update,
    };
    match cmp_versions(have["version"].as_str().unwrap_or(""), want["version"].as_str().unwrap_or("")) {
        Some(Ordering::Less) => Need::Update,
        _ => Need::Keep,
    }
}

/// Записать файлы встроенного плагина во временную папку внутри dir и атомарно поставить на место dir/<id>
fn place(dir: &Path, id: &str) -> R<()> {
    let list = files(id).ok_or_else(|| tr!("Нет встроенного плагина «{}»", "No built-in plugin \"{}\"", id))?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = dir.join(format!(".tmp-bundled-{id}-{stamp}"));
    let res = (|| -> R<()> {
        for (rel, data) in list {
            if !plugins::safe_rel(rel) {
                return Err(tr!("Недопустимый путь «{}»", "Invalid path \"{}\"", rel));
            }
            let f = tmp.join(rel);
            if let Some(p) = f.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            std::fs::write(&f, data).map_err(|e| e.to_string())?;
        }
        let m = plugins::read_manifest(&tmp)?;
        if plugins::check_manifest(&m, Some(&tmp))? != id {
            return Err(tr!("id в plugin.json не совпадает с «{}»", "the id in plugin.json does not match \"{}\"", id));
        }
        let target = dir.join(id);
        let old = dir.join(format!(".old-{id}-{stamp}"));
        let replaced = target.exists();
        if replaced {
            std::fs::rename(&target, &old).map_err(|e| {
                tr!("Не удалось заменить старую версию (файлы заняты?): {}", "Cannot replace the old version (files in use?): {}", e)
            })?;
        }
        if let Err(e) = std::fs::rename(&tmp, &target) {
            if replaced {
                let _ = std::fs::rename(&old, &target);
            }
            return Err(tr!("Не удалось установить плагин: {}", "Cannot install the plugin: {}", e));
        }
        if replaced {
            let _ = std::fs::remove_dir_all(&old);
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    res
}

/// Установить недостающие и обновить устаревшие встроенные плагины в dir (кроме skip) → (изменённые id, ошибки)
fn sync_into(dir: &Path, skip: &[String]) -> (Vec<String>, Vec<String>) {
    let (mut done, mut errors) = (vec![], vec![]);
    if std::fs::create_dir_all(dir).is_err() {
        return (done, vec![tr!("Не удалось создать папку {}", "Cannot create folder {}", dir.display())]);
    }
    for id in ids() {
        if skip.iter().any(|x| x == id) || need(dir, id) == Need::Keep {
            continue;
        }
        match place(dir, id) {
            Ok(()) => done.push(id.to_string()),
            Err(e) => errors.push(format!("{id}: {e}")),
        }
    }
    (done, errors)
}

/// При запуске программы: всё, кроме удалённых пользователем
pub fn sync() {
    let (_, errors) = sync_into(&plugins::plugins_dir(), &settings::removed_bundled());
    for e in errors {
        eprintln!("bundled plugins: {e}");
    }
}

/// «Вернуть встроенные»: забыть удалённые и снова поставить все недостающие/устаревшие
#[tauri::command]
pub async fn plugins_restore_bundled() -> R<Value> {
    tauri::async_runtime::spawn_blocking(|| -> R<Value> {
        settings::update_removed_bundled(|v| v.clear())?;
        let (done, errors) = sync_into(&plugins::plugins_dir(), &[]);
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(json!({ "restored": done }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Встроенные, которых нет в папке плагинов (удалены пользователем или вручную) — для кнопки «Вернуть встроенные»
pub fn missing(dir: &Path) -> Vec<String> {
    ids().filter(|id| !dir.join(id).join("plugin.json").is_file()).map(str::to_string).collect()
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        use Ordering::*;
        let c = |a, b| cmp_versions(a, b);
        assert_eq!(c("1.0.0", "1.1.0"), Some(Less));
        assert_eq!(c("1.10.0", "1.9.9"), Some(Greater));
        assert_eq!(c("1.0", "1.0.0"), Some(Equal));
        assert_eq!(c("v2.0.0", "2.0.0+build.5"), Some(Equal));
        assert_eq!(c("1.0.0-beta", "1.0.0"), Some(Less));
        assert_eq!(c("1.0.0-beta.2", "1.0.0-beta.10"), Some(Less));
        assert_eq!(c("1.0.0-alpha", "1.0.0-alpha.1"), Some(Less));
        assert_eq!(c("1.0.0-1", "1.0.0-alpha"), Some(Less));
        assert_eq!(c("1.0.1", "1.0.0-rc.1"), Some(Greater));
        for bad in ["", "dev", "1..0", "1.0.0-", "1.x", "1.2.3.4.5"] {
            assert_eq!(c(bad, "1.0.0"), None, "{bad}");
        }
    }

    #[test]
    fn bundled_manifests_valid() {
        assert!(is_bundled("vignette") && is_bundled("restore") && is_bundled("stabilize") && !is_bundled("core"));
        for (id, list) in BUNDLED {
            let m = manifest(id).unwrap_or_else(|| panic!("{id}: plugin.json"));
            assert_eq!(plugins::check_manifest(&m, None).unwrap(), *id);
            assert!(parse_version(m["version"].as_str().unwrap()).is_some(), "{id}: version");
            assert!(list.iter().all(|(rel, _)| plugins::safe_rel(rel)), "{id}: paths");
            for e in m["contributes"]["effects"].as_array().into_iter().flatten() {
                // «frame» — шторка ДО/ПОСЛЕ; «proxy» (стабилизация) — только со stage «source»
                let p = e["preview"].as_str().unwrap_or_default();
                assert!(p == "frame" || (p == "proxy" && e["stage"] == "source"), "{id}.{}: preview", e["id"]);
                assert!(e["name"]["ru"].is_string() && e["name"]["en"].is_string(), "{id}: name ru/en");
            }
        }
    }

    #[test]
    fn sync_rules() {
        let base = crate::paths::test_dir("bundled");
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("plugins");
        // Пусто: ставятся все, кроме удалённых
        let (done, errors) = sync_into(&dir, &["restore".to_string()]);
        assert!(errors.is_empty(), "{errors:?}");
        assert!(done.contains(&"vignette".to_string()) && !done.contains(&"restore".to_string()));
        assert!(dir.join("vignette").join("plugin.json").is_file() && !dir.join("restore").exists());
        assert_eq!(missing(&dir), vec!["restore".to_string()]);
        // Повторно — ничего не меняется
        assert!(sync_into(&dir, &["restore".to_string()]).0.is_empty());
        // Установлена старая версия — обновить (пользовательские файлы старой версии уходят вместе с ней)
        let vf = dir.join("vignette").join("plugin.json");
        let mut m = manifest("vignette").unwrap();
        m["version"] = json!("0.9.0");
        std::fs::write(&vf, m.to_string()).unwrap();
        std::fs::write(dir.join("vignette").join("old.txt"), "x").unwrap();
        assert_eq!(need(&dir, "vignette"), Need::Update);
        let mut done = sync_into(&dir, &[]).0;
        done.sort();
        assert_eq!(done, vec!["restore".to_string(), "vignette".to_string()]);
        assert_eq!(plugins::read_manifest(&dir.join("vignette")).unwrap()["version"], manifest("vignette").unwrap()["version"]);
        assert!(!dir.join("vignette").join("old.txt").exists());
        // Новее или «не версия» — не трогать
        for v in ["99.0.0", "dev"] {
            m["version"] = json!(v);
            std::fs::write(&vf, m.to_string()).unwrap();
            assert_eq!(need(&dir, "vignette"), Need::Keep, "{v}");
            assert!(sync_into(&dir, &[]).0.is_empty());
            assert_eq!(plugins::read_manifest(&dir.join("vignette")).unwrap()["version"], v);
        }
        // Сломанный манифест — заменить
        std::fs::write(&vf, "{ broken").unwrap();
        assert_eq!(need(&dir, "vignette"), Need::Update);
        assert_eq!(sync_into(&dir, &[]).0, vec!["vignette".to_string()]);
        // Временные папки не остаются
        let left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(left.iter().all(|n| !n.starts_with('.')), "{left:?}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
