// Кэш: размеры по категориям и очистка (окно настроек → «Кэш»).
//   media — миниатюры, волны, прокси, реверс/стоп-кадры (<кэш>/app/media/<ключ файла>), пересоздаются сами;
//   temp  — временные файлы FFmpeg и окна (<кэш>/tmp);
//   logs  — журналы;
//   anim  — сохранённые анимации (<кэш>/anim) — это материалы проектов, только размер;
//   webview — данные окна — только размер.
use crate::paths;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten().map(|e| match e.file_type() {
        Ok(t) if t.is_dir() => dir_size(&e.path()),
        Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
        Err(_) => 0,
    }).sum()
}

fn anim_dir() -> PathBuf { paths::get().cache_dir.join("anim") }

pub fn stats() -> Value {
    let p = paths::get();
    let media_items = std::fs::read_dir(&p.media_cache).map(|r| r.flatten().filter(|e| e.path().is_dir()).count()).unwrap_or(0);
    json!({
        "media": dir_size(&p.media_cache),
        "mediaItems": media_items,
        "temp": dir_size(&p.temp),
        "logs": dir_size(&p.logs),
        "anim": dir_size(&anim_dir()),
        "webview": dir_size(&p.webview),
        "cacheDir": p.cache_dir.to_string_lossy(),
    })
}

fn norm(p: &Path) -> String { p.to_string_lossy().replace('\\', "/").to_lowercase() }

/// Удаляет содержимое выбранных категорий. keep — ключи кэша и пути файлов открытого проекта:
/// папки media/<ключ>, в которых лежат эти файлы или чей ключ указан, не трогаем.
pub fn clear(cats: &[String], keep: &[String]) -> Value {
    let p = paths::get();
    let keep_n: Vec<String> = keep.iter().map(|k| k.replace('\\', "/").to_lowercase()).collect();
    let mut freed = 0u64;
    let mut kept = 0usize;
    let mut failed = 0usize;
    let remove = |path: &Path, freed: &mut u64, failed: &mut usize| {
        let size = if path.is_dir() { dir_size(path) } else { path.metadata().map(|m| m.len()).unwrap_or(0) };
        let r = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        match r { Ok(_) => *freed += size, Err(_) => *failed += 1 }
    };
    for cat in cats {
        match cat.as_str() {
            "media" => {
                for e in std::fs::read_dir(&p.media_cache).into_iter().flatten().flatten() {
                    let path = e.path();
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    let prefix = format!("{}/", norm(&path));
                    if keep_n.iter().any(|k| *k == name || k.starts_with(&prefix)) { kept += 1; continue; }
                    remove(&path, &mut freed, &mut failed);
                }
            }
            "temp" => {
                for e in std::fs::read_dir(&p.temp).into_iter().flatten().flatten() { remove(&e.path(), &mut freed, &mut failed); }
            }
            "logs" => {
                // Текущие журналы открыты на запись — очищаем содержимое, а не удаляем
                for e in std::fs::read_dir(&p.logs).into_iter().flatten().flatten() {
                    let path = e.path();
                    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                    if std::fs::write(&path, b"").is_ok() { freed += size; } else { failed += 1; }
                }
            }
            _ => {}
        }
    }
    json!({ "freed": freed, "kept": kept, "failed": failed, "stats": stats() })
}
