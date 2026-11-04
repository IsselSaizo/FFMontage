// Файлы для экспорта (M5, решение D2): PNG титров, отрисованных окном на canvas, и файлы субтитров (.ass/.srt/.vtt).
// Лежат в <app_cache>/export-assets/<16 hex sha256>.<тип>; план экспорта ссылается на них (-i / ass=filename=…),
// plancheck разрешает окну только эту папку. Плюс чтение/запись файлов субтитров пользователя.
use crate::{paths, protocol, tr};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

type R<T> = Result<T, String>;

const MAX_PNG: usize = 64 * 1024 * 1024;
const MAX_TEXT: usize = 16 * 1024 * 1024;
const MAX_SUB_FILE: u64 = 32 * 1024 * 1024;
/// Файлы старше этого удаляются при первом сохранении за запуск
const KEEP_SECS: u64 = 3 * 24 * 3600;
const SUB_READ_EXT: &[&str] = &["srt", "vtt", "ass", "ssa"];
const SUB_WRITE_EXT: &[&str] = &["srt", "vtt", "ass"];

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// <app_cache>/export-assets
pub fn dir() -> PathBuf {
    paths::get().app_cache.join("export-assets")
}

// ---------------------------------------------------------------------------
// base64 (стандартный алфавит; пробелы и переводы строк пропускаются, «=» — только в конце)
// ---------------------------------------------------------------------------
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits, mut pad) = (0u32, 0u32, 0usize);
    for &c in text.as_bytes() {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == b'=' {
            pad += 1;
            continue;
        }
        if pad > 0 {
            return None;
        }
        acc = (acc << 6) | val(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // Остаток: 2 или 4 бита нулей (6 бит — неполный символ)
    if pad > 2 || bits >= 6 || acc != 0 {
        return None;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Сохранение файлов экспорта
// ---------------------------------------------------------------------------
static CLEANED: std::sync::Once = std::sync::Once::new();

fn cleanup(dir: &Path) {
    let now = std::time::SystemTime::now();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let old = meta.modified().ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|d| d.as_secs() > KEEP_SECS);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Байты файла по типу (с проверками) → путь, без записи на диск
fn asset_bytes(kind: &str, data: &str) -> R<Vec<u8>> {
    match kind {
        "png" => {
            // допускаем data:-адрес из canvas.toDataURL()
            let b64 = data.strip_prefix("data:image/png;base64,").unwrap_or(data);
            if b64.len() / 4 * 3 > MAX_PNG + 3 {
                return Err(tr!("картинка больше 64 МБ", "the image is larger than 64 MB").into());
            }
            let b = base64_decode(b64).ok_or(tr!("неверные данные base64", "invalid base64 data"))?;
            if b.len() > MAX_PNG {
                return Err(tr!("картинка больше 64 МБ", "the image is larger than 64 MB").into());
            }
            if !b.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err(tr!("это не PNG", "not a PNG image").into());
            }
            Ok(b)
        }
        "ass" | "srt" | "vtt" => {
            if data.len() > MAX_TEXT {
                return Err(tr!("файл субтитров больше 16 МБ", "the subtitle file is larger than 16 MB").into());
            }
            Ok(data.as_bytes().to_vec())
        }
        _ => Err(tr!("неизвестный тип файла «{}»", "unknown file type \"{}\"", kind)),
    }
}

pub fn save(kind: &str, data: &str) -> R<PathBuf> {
    let bytes = asset_bytes(kind, data)?;
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    CLEANED.call_once(|| cleanup(&dir));
    let hash = Sha256::digest(&bytes);
    let hex: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let file = dir.join(format!("{hex}.{kind}"));
    if !file.is_file() {
        let tmp = dir.join(format!(".{hex}.{kind}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, &bytes).map_err(|e| tr!("Не удалось записать {}: {}", "Cannot write {}: {}", file.display(), e))?;
        if let Err(e) = std::fs::rename(&tmp, &file) {
            let _ = std::fs::remove_file(&tmp);
            // другой поток успел записать тот же файл
            if !file.is_file() {
                return Err(tr!("Не удалось записать {}: {}", "Cannot write {}: {}", file.display(), e));
            }
        }
    }
    protocol::allow(&file);
    Ok(file)
}

// ---------------------------------------------------------------------------
// Кодировки файлов субтитров
// ---------------------------------------------------------------------------
/// Windows-1251, байты 0x80–0xBF (0xC0–0xFF — А…я подряд с U+0410); 0x98 не определён
const CP1251_80: [u16; 64] = [
    0x0402, 0x0403, 0x201A, 0x0453, 0x201E, 0x2026, 0x2020, 0x2021, 0x20AC, 0x2030, 0x0409, 0x2039, 0x040A, 0x040C, 0x040B, 0x040F, 0x0452,
    0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0xFFFD, 0x2122, 0x0459, 0x203A, 0x045A, 0x045C, 0x045B, 0x045F, 0x00A0, 0x040E,
    0x045E, 0x0408, 0x00A4, 0x0490, 0x00A6, 0x00A7, 0x0401, 0x00A9, 0x0404, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x0407, 0x00B0, 0x00B1, 0x0406,
    0x0456, 0x0491, 0x00B5, 0x00B6, 0x00B7, 0x0451, 0x2116, 0x0454, 0x00BB, 0x0458, 0x0405, 0x0455, 0x0457,
];

pub fn cp1251(b: &[u8]) -> String {
    b.iter()
        .map(|&c| match c {
            0..=0x7F => c as char,
            0x80..=0xBF => char::from_u32(CP1251_80[(c - 0x80) as usize] as u32).unwrap_or('\u{FFFD}'),
            _ => char::from_u32(0x0410 + (c - 0xC0) as u32).unwrap_or('\u{FFFD}'),
        })
        .collect()
}

fn utf16(b: &[u8], le: bool) -> String {
    let units: Vec<u16> = b.as_chunks::<2>().0.iter().map(|&c| if le { u16::from_le_bytes(c) } else { u16::from_be_bytes(c) }).collect();
    String::from_utf16_lossy(&units)
}

/// BOM UTF-8 / UTF-16 LE / BE, иначе корректный UTF-8, иначе Windows-1251
pub fn decode_text(b: &[u8]) -> String {
    if let Some(r) = b.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(r).into_owned();
    }
    if let Some(r) = b.strip_prefix(b"\xFF\xFE") {
        return utf16(r, true);
    }
    if let Some(r) = b.strip_prefix(b"\xFE\xFF") {
        return utf16(r, false);
    }
    match std::str::from_utf8(b) {
        Ok(t) => t.to_string(),
        Err(_) => cp1251(b),
    }
}

fn read_subtitle(p: &Path) -> R<Value> {
    let ext = crate::ff::ext_of(p);
    if !SUB_READ_EXT.contains(&ext.as_str()) {
        return Err(tr!("Нужен файл субтитров .srt, .vtt, .ass или .ssa", "A .srt, .vtt, .ass or .ssa subtitle file is required").into());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
    if !meta.is_file() {
        return Err(tr!("{}: это не файл", "{}: not a file", p.display()));
    }
    if meta.len() > MAX_SUB_FILE {
        return Err(tr!("Файл субтитров больше 32 МБ", "The subtitle file is larger than 32 MB").into());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({ "path": s(p), "name": name, "text": decode_text(&bytes) }))
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------
/// kind: png (data — base64 или data:image/png;base64,…) | ass | srt | vtt (data — текст) → абсолютный путь
#[tauri::command]
pub async fn export_asset_save(kind: String, data: String) -> R<String> {
    blocking(move || save(&kind, &data).map(|p| s(&p))).await?
}

/// Прочитать файл субтитров (path не задан — диалог) → { path, name, text } или null (отмена)
#[tauri::command]
pub async fn subtitle_file_read(window: WebviewWindow, path: Option<String>) -> R<Value> {
    let p = match path.filter(|x| !x.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let d = window
                .dialog()
                .file()
                .set_title(tr!("Открыть субтитры", "Open subtitles"))
                .set_parent(&window)
                .add_filter(tr!("Субтитры (SRT, VTT, ASS, SSA)", "Subtitles (SRT, VTT, ASS, SSA)"), SUB_READ_EXT);
            match tauri::async_runtime::spawn_blocking(move || d.blocking_pick_file()).await.ok().flatten().and_then(|f| f.into_path().ok())
            {
                Some(p) => p,
                None => return Ok(Value::Null),
            }
        }
    };
    if !p.is_absolute() {
        return Err(tr!("Нужен абсолютный путь: {}", "An absolute path is required: {}", p.display()));
    }
    blocking(move || read_subtitle(&p)).await?
}

/// Записать субтитры в UTF-8 без BOM (path не задан — диалог «Сохранить» в папке вывода) → путь или null (отмена)
#[tauri::command]
pub async fn subtitle_file_write(window: WebviewWindow, path: Option<String>, default_name: String, text: String) -> R<Option<String>> {
    if text.len() > MAX_SUB_FILE as usize {
        return Err(tr!("Файл субтитров больше 32 МБ", "The subtitle file is larger than 32 MB").into());
    }
    let default_name = crate::commands::safe_name(&default_name, "subtitles.srt");
    let mut p = match path.filter(|x| !x.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let d = window
                .dialog()
                .file()
                .set_title(tr!("Сохранить субтитры", "Save subtitles"))
                .set_parent(&window)
                .set_directory(&paths::get().output_dir)
                .set_file_name(&default_name)
                .add_filter("SubRip (SRT)", &["srt"])
                .add_filter("WebVTT", &["vtt"])
                .add_filter("Advanced SubStation (ASS)", &["ass"]);
            match tauri::async_runtime::spawn_blocking(move || d.blocking_save_file()).await.ok().flatten().and_then(|f| f.into_path().ok())
            {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    // Без расширения (ввели имя без него) — расширение из default_name
    if p.extension().is_none() {
        let e = crate::ff::ext_of(Path::new(&default_name));
        if SUB_WRITE_EXT.contains(&e.as_str()) {
            p.set_extension(e);
        }
    }
    if !p.is_absolute() {
        return Err(tr!("Нужен абсолютный путь: {}", "An absolute path is required: {}", p.display()));
    }
    if !SUB_WRITE_EXT.contains(&crate::ff::ext_of(&p).as_str()) {
        return Err(tr!("Субтитры сохраняются в .srt, .vtt или .ass", "Subtitles are saved as .srt, .vtt or .ass").into());
    }
    blocking(move || {
        std::fs::write(&p, text.as_bytes()).map_err(|e| tr!("Не удалось записать {}: {}", "Cannot write {}: {}", p.display(), e))?;
        Ok(Some(s(&p)))
    })
    .await?
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar", b"\x89PNG\r\n\x1a\n\x00\xff"] {
            assert_eq!(base64_decode(&crate::commands::base64(data)).as_deref(), Some(data));
        }
        assert_eq!(base64_decode("Zm9v\nYmFy").as_deref(), Some(&b"foobar"[..]));
        assert_eq!(base64_decode("Zm9=v"), None);
        assert_eq!(base64_decode("Zm9v!"), None);
        assert_eq!(base64_decode("Z"), None);
        assert!(asset_bytes("png", &crate::commands::base64(b"GIF89a")).is_err());
        assert!(asset_bytes("png", &format!("data:image/png;base64,{}", crate::commands::base64(b"\x89PNG\r\n\x1a\nxx"))).is_ok());
        assert!(asset_bytes("exe", "x").is_err());
        assert!(asset_bytes("ass", "[Script Info]").is_ok());
    }

    #[test]
    fn text_encodings() {
        let ru = "Привет, мир! ёЁ №"; // i18n-ignore — тест
        assert_eq!(decode_text(ru.as_bytes()), ru);
        assert_eq!(decode_text(&[b"\xEF\xBB\xBF", ru.as_bytes()].concat()), ru);
        let le: Vec<u8> = [0xFF, 0xFE].into_iter().chain(ru.encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        let be: Vec<u8> = [0xFE, 0xFF].into_iter().chain(ru.encode_utf16().flat_map(|u| u.to_be_bytes())).collect();
        assert_eq!(decode_text(&le), ru);
        assert_eq!(decode_text(&be), ru);
        // «Привет, мир! ёЁ №» в Windows-1251
        let w = b"\xCF\xF0\xE8\xE2\xE5\xF2, \xEC\xE8\xF0! \xB8\xA8 \xB9";
        assert_eq!(decode_text(w), ru);
        assert_eq!(cp1251(b"\xC0\xDF\xE0\xFF"), "АЯая"); // i18n-ignore — тест
    }
}
