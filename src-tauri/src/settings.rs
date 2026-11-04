// Настройки интерфейса (M0.6): один файл settings.json рядом с config.json (paths::Paths::settings_file).
// Ключи верхнего уровня ведёт окно (js/prefs.js, js/settings.js): lang, keymap, restoreSession, plugins,
// cache{limitGb}, ui{rightTab, tlHeight, mode, magnet, monitorVol, monitorMute, speedRipple}, export{…}.
// Служебные ключи начинаются с «_»: _format, _version, _localMigrated.
// Миграция:
//   • config.json → "settings" (до 0.4) переносится сюда при первом чтении за запуск и убирается из config.json;
//     эти значения сильнее (их мог написать тест или пользователь руками);
//   • localStorage окна (ffm.*) окно присылает командой settings_migrate_local и после ответа удаляет эти ключи —
//     значения слабее уже сохранённых.
use crate::paths;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
static LEGACY_CHECKED: AtomicBool = AtomicBool::new(false);

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn read_json(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok()
}

fn read_map(file: &Path) -> Option<Map<String, Value>> {
    match read_json(file)? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn write_map(file: &Path, m: &Map<String, Value>) -> Result<(), String> {
    let mut m = m.clone();
    m.insert("_format".into(), json!("ff-montage-settings"));
    m.insert("_version".into(), json!(1));
    let text = serde_json::to_string_pretty(&Value::Object(m)).unwrap_or_default();
    paths::write_atomic(file, text.as_bytes()).map_err(|e| format!("{}: {e}", file.display()))
}

/// Старые настройки из config.json → "settings"; после успешного переноса ключ из config.json убирается
fn take_legacy(config_file: &Path, settings_file: &Path, cur: &mut Option<Map<String, Value>>) {
    let _c = paths::config_lock();
    let Some(Value::Object(mut cfg)) = read_json(config_file) else { return };
    let Some(Value::Object(old)) = cfg.remove("settings") else { return };
    let m = cur.get_or_insert_with(Map::new);
    for (k, v) in old {
        m.insert(k, v);
    }
    if write_map(settings_file, m).is_ok() {
        let text = serde_json::to_string_pretty(&Value::Object(cfg)).unwrap_or_default();
        let _ = paths::write_atomic(config_file, text.as_bytes());
    }
}

fn load_from(config_file: &Path, settings_file: &Path, check_legacy: bool) -> Map<String, Value> {
    let mut cur = read_map(settings_file);
    if check_legacy {
        take_legacy(config_file, settings_file, &mut cur);
    }
    cur.unwrap_or_default()
}

fn load_locked() -> Map<String, Value> {
    let p = paths::get();
    let check = !LEGACY_CHECKED.swap(true, Ordering::SeqCst);
    load_from(&p.config_file, &p.settings_file, check)
}

/// Все настройки (объект; пустой, если файла нет)
pub fn load() -> Value {
    let _g = lock();
    Value::Object(load_locked())
}

fn apply_patch(m: &mut Map<String, Value>, patch: &Value) {
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            if k.starts_with('_') {
                continue;
            }
            if v.is_null() {
                m.remove(k);
            } else {
                m.insert(k.clone(), v.clone());
            }
        }
    }
}

/// Меняет ключи верхнего уровня (null — удалить ключ) и возвращает все настройки
pub fn patch(patch: &Value) -> Result<Value, String> {
    let _g = lock();
    let mut m = load_locked();
    apply_patch(&mut m, patch);
    write_map(&paths::get().settings_file, &m)?;
    Ok(Value::Object(m))
}

/// Значения из localStorage окна: добавляются, только если такого ключа ещё нет (у объектов — по полям)
fn merge_local(m: &mut Map<String, Value>, values: &Value) {
    let Some(obj) = values.as_object() else { return };
    for (k, v) in obj {
        if k.starts_with('_') || v.is_null() {
            continue;
        }
        match (m.get_mut(k), v) {
            (None, _) => {
                m.insert(k.clone(), v.clone());
            }
            (Some(Value::Object(dst)), Value::Object(src)) => {
                for (k2, v2) in src {
                    if !dst.contains_key(k2) && !v2.is_null() {
                        dst.insert(k2.clone(), v2.clone());
                    }
                }
            }
            _ => {}
        }
    }
}

/// Перенос localStorage окна. Окно после ответа удаляет перенесённые ключи, так что для каждого значения это
/// происходит один раз; уже сохранённые настройки не перезаписываются. _localMigrated — когда это было (для отладки).
pub fn migrate_local(values: &Value) -> Result<Value, String> {
    let _g = lock();
    let mut m = load_locked();
    merge_local(&mut m, values);
    m.insert("_localMigrated".into(), json!(now_secs()));
    write_map(&paths::get().settings_file, &m)?;
    Ok(Value::Object(m))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Лимит автоочистки кэша, ГБ: 1..50, по умолчанию 1
pub const CACHE_LIMIT_MIN: u64 = 1;
pub const CACHE_LIMIT_MAX: u64 = 50;
pub fn clamp_limit(v: &Value) -> u64 {
    v.as_f64()
        .filter(|x| x.is_finite())
        .map(|x| x.round().clamp(CACHE_LIMIT_MIN as f64, CACHE_LIMIT_MAX as f64) as u64)
        .unwrap_or(CACHE_LIMIT_MIN)
}
pub fn cache_limit_gb() -> u64 {
    clamp_limit(&load()["cache"]["limitGb"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_and_local_migration() {
        let base = paths::test_dir("settings");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let cfg = base.join("config.json");
        let st = base.join("settings.json");
        std::fs::write(&cfg, r#"{"version":1,"cacheDir":"C","outputDir":"O","settings":{"lang":"en","keymap":{"preset":"premiere"}}}"#)
            .unwrap();
        // Первый запуск: settings.json нет — берём из config.json и убираем оттуда
        let m = load_from(&cfg, &st, true);
        assert_eq!(m["lang"], "en");
        assert_eq!(m["keymap"]["preset"], "premiere");
        let c: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert!(c.get("settings").is_none() && c["cacheDir"] == "C");
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&st).unwrap()).unwrap();
        assert_eq!(saved["lang"], "en");
        assert_eq!(saved["_format"], "ff-montage-settings");
        // config.json снова с settings (тест или правка руками) — эти значения сильнее
        std::fs::write(&cfg, r#"{"cacheDir":"C","outputDir":"O","settings":{"lang":"ru"}}"#).unwrap();
        let m = load_from(&cfg, &st, true);
        assert_eq!(m["lang"], "ru");
        assert_eq!(m["keymap"]["preset"], "premiere");
        // localStorage: не перезаписывает сохранённое, добавляет недостающее
        let mut m = m;
        m.insert("ui".into(), json!({ "rightTab": "text" }));
        merge_local(
            &mut m,
            &json!({ "lang": "en", "ui": { "rightTab": "props", "magnet": false }, "export": { "codec": "h264" }, "_x": 1 }),
        );
        assert_eq!(m["lang"], "ru");
        assert_eq!(m["ui"]["rightTab"], "text");
        assert_eq!(m["ui"]["magnet"], false);
        assert_eq!(m["export"]["codec"], "h264");
        assert!(m.get("_x").is_none());
        // patch: null удаляет, служебные ключи не меняются
        apply_patch(&mut m, &json!({ "export": null, "_localMigrated": false, "restoreSession": false }));
        assert!(m.get("export").is_none() && m.get("_localMigrated").is_none() && m["restoreSession"] == false);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cache_limit_clamped() {
        assert_eq!(clamp_limit(&json!(null)), 1);
        assert_eq!(clamp_limit(&json!(0)), 1);
        assert_eq!(clamp_limit(&json!(7.4)), 7);
        assert_eq!(clamp_limit(&json!(500)), 50);
        assert_eq!(clamp_limit(&json!("x")), 1);
    }
}
