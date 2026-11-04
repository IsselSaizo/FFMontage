// Язык интерфейса для строк, которые формирует сама программа (диалоги, ошибки, окна).
// Строки окна переводит рендерер (src/renderer/js/i18n.js); здесь — пары «рус / англ» прямо в коде: tr!("…", "…").
use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

pub fn en() -> bool {
    EN.load(Ordering::Relaxed)
}

pub fn lang() -> &'static str {
    if en() {
        "en"
    } else {
        "ru"
    }
}

pub fn set(lang: &str) {
    EN.store(lang == "en", Ordering::Relaxed);
}

/// `tr!("Русский", "English")` → строка на текущем языке; с аргументами — как format!:
/// `tr!("Файл {}", "File {}", name)`.
#[macro_export]
macro_rules! tr {
    ($ru:literal, $en:literal) => {
        if $crate::i18n::en() { $en } else { $ru }
    };
    ($ru:literal, $en:literal, $($arg:tt)*) => {
        if $crate::i18n::en() { format!($en, $($arg)*) } else { format!($ru, $($arg)*) }
    };
}

/// Язык системы: русский, если русский язык интерфейса Windows / локаль или установлена русская раскладка
pub fn system_lang() -> &'static str {
    if system_is_ru() {
        "ru"
    } else {
        "en"
    }
}

#[cfg(windows)]
fn system_is_ru() -> bool {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayoutList, HKL};
    const LANG_RUSSIAN: u16 = 0x19;
    // Нижние 10 бит LANGID — основной язык
    if unsafe { GetUserDefaultUILanguage() } & 0x3ff == LANG_RUSSIAN {
        return true;
    }
    let mut layouts = [HKL::default(); 64];
    let n = unsafe { GetKeyboardLayoutList(Some(&mut layouts)) }.max(0) as usize;
    layouts[..n.min(64)].iter().any(|h| (h.0 as usize as u16) & 0x3ff == LANG_RUSSIAN)
}

#[cfg(not(windows))]
fn system_is_ru() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .filter(|v| !v.is_empty())
        .take(1)
        .any(|v| v.to_lowercase().starts_with("ru"))
}
