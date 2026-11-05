// Отчёты о сбоях и ошибках — только локально, никуда не отправляются.
//   <кэш>/app/logs/reports/<UTC-время>-<вид>.txt, не больше MAX_REPORTS файлов (старые удаляются).
// Виды: panic (паника Rust), native (исключение Windows в процессе программы), unclean-exit (прошлый запуск не завершился
// штатно: падение без паники, снятие задачи, отключение питания), window-crash (упал процесс WebView),
// js-error (необработанная ошибка в окне), export-failed (FFmpeg завершился с ошибкой), render-failed (рендер звука).
// В отчёт входят версия, ОС, режим хранения данных и хвост журнала окна — этого обычно хватает, чтобы найти причину.
// Текст отчёта — по-английски: его читает разработчик, а не пользователь.
use crate::paths;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

pub const MAX_REPORTS: usize = 50;
/// Сколько отчётов js-error окно может записать за один запуск (ошибка в цикле не должна забить диск)
const MAX_JS_PER_SESSION: usize = 20;
const LOG_TAIL_LINES: usize = 150;

static JS_REPORTS: AtomicUsize = AtomicUsize::new(0);
/// Отчёты не о падении (export-failed, render-failed, js-error…) за запуск: цикл повторов не должен вытеснить
/// из ротации тот единственный отчёт о падении, ради которого папку откроют
static OTHER_REPORTS: AtomicUsize = AtomicUsize::new(0);
const MAX_OTHER_PER_SESSION: usize = 30;
/// Процесс — хост аудиоплагинов (--vst-host): его паника — отдельный вид, без «программа упала» в окне
static VST_HOST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Виды «программа упала» (уведомление при запуске, app.js noticeCrashReports)
fn is_crash(kind: &str) -> bool {
    matches!(kind, "panic" | "native" | "unclean-exit" | "window-crash")
}

pub fn dir() -> PathBuf {
    paths::get().logs.join("reports")
}

fn session_file() -> PathBuf {
    paths::get().logs.join("session.json")
}

fn seen_file() -> PathBuf {
    dir().join(".seen")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Дата UTC из секунд Unix: (год, месяц, день, ч, м, с) — без зависимостей (алгоритм civil_from_days)
pub fn utc_parts(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32)
}

pub fn utc_text(secs: u64) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(secs);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02} UTC")
}

fn file_stamp(secs: u64) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(secs);
    format!("{y:04}-{mo:02}-{d:02}_{h:02}-{mi:02}-{s:02}")
}

/// Вид отчёта — только латиница, цифры и дефис (часть имени файла)
fn clean_kind(kind: &str) -> String {
    let k: String = kind.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect();
    if k.is_empty() {
        "error".into()
    } else {
        k.to_ascii_lowercase()
    }
}

/// Последние n строк текстового файла (без чтения гигантских файлов целиком: не больше 512 КБ с конца)
pub fn tail(path: &Path, n: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(512 * 1024);
    let _ = f.seek(SeekFrom::Start(from));
    let mut buf = vec![];
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Начало и конец файла (по max байт) — байты, без требования UTF-8 (журнал FFmpeg может содержать что угодно)
pub fn head_tail(path: &Path, max: usize) -> String {
    let Ok(buf) = std::fs::read(path) else { return String::new() };
    if buf.len() <= max * 3 {
        return String::from_utf8_lossy(&buf).into_owned();
    }
    format!("{}\n…\n{}", String::from_utf8_lossy(&buf[..max]), String::from_utf8_lossy(&buf[buf.len() - max..]))
}

/// Домашняя папка в тексте отчёта → «~» (в путях — имя пользователя; отчёт могут приложить к сообщению об ошибке)
fn redact(text: &str) -> String {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let home = home.trim_end_matches(['/', '\\']);
    if home.len() < 4 {
        return text.to_string();
    }
    let mut out = text.replace(home, "~");
    // То же в виде, как его пишет FFmpeg в графе (\\ и экранированное двоеточие)
    let esc = home.replace('\\', "/");
    if esc != home {
        out = out.replace(&esc, "~");
    }
    out
}

/// Шапка отчёта: версия, ОС, режим данных
pub fn header(kind: &str, secs: u64) -> String {
    let p = paths::get();
    format!(
        "FF Montage {} ({} {}), data mode: {}\nTime: {}\nKind: {}\nProcess: {} (pid {})\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        p.mode.as_str(),
        utc_text(secs),
        kind,
        std::env::args().skip(1).take(2).collect::<Vec<_>>().join(" "),
        std::process::id(),
    )
}

/// Записать отчёт; log — журнал, хвост которого приложить (None — без журнала). Возвращает путь файла.
pub fn report(kind: &str, title: &str, body: &str, log: Option<&Path>) -> Option<PathBuf> {
    let kind = clean_kind(kind);
    if !is_crash(&kind) && OTHER_REPORTS.fetch_add(1, Ordering::SeqCst) >= MAX_OTHER_PER_SESSION {
        return None;
    }
    let secs = now_secs();
    let d = dir();
    std::fs::create_dir_all(&d).ok()?;
    let mut path = d.join(format!("{}-{kind}.txt", file_stamp(secs)));
    let mut i = 2;
    while path.exists() && i < 100 {
        path = d.join(format!("{}-{kind}-{i}.txt", file_stamp(secs)));
        i += 1;
    }
    let mut text = header(&kind, secs);
    text.push_str(&format!("\n=== {} ===\n{}\n", title.trim(), body.trim_end()));
    if let Some(l) = log {
        let t = tail(l, LOG_TAIL_LINES);
        if !t.trim().is_empty() {
            let name = l.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            text.push_str(&format!("\n=== last {LOG_TAIL_LINES} lines of {name} ===\n{t}\n"));
        }
    }
    std::fs::write(&path, redact(&text)).ok()?;
    prune(&d, MAX_REPORTS);
    Some(path)
}

/// Отчёт из окна (необработанная ошибка JS) — с лимитом на запуск
pub fn report_js(kind: &str, message: &str, detail: &str) -> Option<PathBuf> {
    if JS_REPORTS.fetch_add(1, Ordering::SeqCst) >= MAX_JS_PER_SESSION {
        return None;
    }
    let kind = match kind {
        "js-error" | "render-failed" | "export-failed" => kind,
        _ => "js-error",
    };
    let msg: String = message.chars().take(2000).collect();
    let det: String = detail.chars().take(30_000).collect();
    report(kind, &msg, &det, Some(&paths::get().logs.join("renderer.log")))
}

/// Отчётов в папке не больше max: удаляются самые старые (по имени — в нём время)
fn prune(d: &Path, max: usize) {
    let mut files = list_names(d);
    if files.len() <= max {
        return;
    }
    files.sort();
    for name in &files[..files.len() - max] {
        let _ = std::fs::remove_file(d.join(name));
    }
}

fn list_names(d: &Path) -> Vec<String> {
    std::fs::read_dir(d)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".txt"))
        .collect()
}

/// Вид отчёта по имени файла «<время>-<вид>[-N].txt»
fn kind_of(name: &str) -> String {
    let stem = name.trim_end_matches(".txt");
    // время — 19 символов «YYYY-MM-DD_HH-MM-SS», дальше «-вид»
    let rest = stem.get(20..).unwrap_or("");
    let rest = rest.trim_end_matches(|c: char| c.is_ascii_digit()).trim_end_matches('-');
    if rest.is_empty() {
        "error".into()
    } else {
        rest.to_string()
    }
}

/// Список отчётов для окна: { dir, total, fresh: [{name, kind, path}] } — fresh: новые с прошлого просмотра;
/// mark_seen — запомнить, что пользователю их показали
pub fn list(mark_seen: bool) -> Value {
    let d = dir();
    let mut names = list_names(&d);
    names.sort();
    let seen = std::fs::read_to_string(seen_file()).unwrap_or_default().trim().to_string();
    let fresh: Vec<Value> = names
        .iter()
        .filter(|n| n.as_str() > seen.as_str())
        .map(|n| json!({ "name": n, "kind": kind_of(n), "path": d.join(n).to_string_lossy() }))
        .collect();
    if mark_seen {
        if let Some(last) = names.last() {
            let _ = std::fs::create_dir_all(&d);
            let _ = std::fs::write(seen_file(), last);
        }
    }
    json!({ "dir": d.to_string_lossy(), "total": names.len(), "fresh": fresh, "last": names.last() })
}

// ---------------------------------------------------------------------------
// Сессия: признак «программа работает». Остался после запуска — прошлый раз она завершилась не штатно.
// ---------------------------------------------------------------------------

/// Начало сессии окна (после проверки «одна копия на папку кэша»). prev_log — журнал прошлого запуска.
pub fn session_start(prev_log: &Path) {
    #[cfg(unix)]
    unix_signals::install(&session_file());
    let f = session_file();
    // Пустой файл — «очистка журналов» в настройках кэша, а не след падения
    let old: Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if old["pid"].is_u64() {
        let v = old;
        let since = v["started"].as_u64().map(file_stamp).unwrap_or_default();
        let started = v["started"].as_u64().map(utc_text).unwrap_or_else(|| "?".into());
        let ver = v["version"].as_str().unwrap_or("?");
        // Причина уже записана (паника, исключение) — второй отчёт о том же не нужен
        let explained =
            list_names(&dir()).iter().any(|n| n.as_str() >= since.as_str() && matches!(kind_of(n).as_str(), "panic" | "native"));
        if !explained {
            report(
                "unclean-exit",
                "The previous session did not exit normally",
                &format!(
                    "Previous session: version {ver}, pid {}, started {started}.\n\
                 Possible causes: a native crash without a Rust panic, the process was killed (Task Manager), \
                 power loss or a system crash.",
                    v["pid"].as_u64().unwrap_or(0)
                ),
                Some(prev_log),
            );
        }
    }
    let _ = std::fs::create_dir_all(paths::get().logs.clone());
    let _ =
        std::fs::write(&f, json!({ "pid": std::process::id(), "started": now_secs(), "version": env!("CARGO_PKG_VERSION") }).to_string());
}

/// Штатный выход: признак сессии больше не нужен. Только свой: при перезапуске после обновления новая копия
/// уже могла записать свой признак, пока старая завершалась.
pub fn session_end() {
    let f = session_file();
    let v: Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if v["pid"].as_u64().is_none_or(|p| p == u64::from(std::process::id())) {
        let _ = std::fs::remove_file(f);
    }
}

/// Linux / Steam Deck: SIGTERM и SIGHUP (выход из игрового режима, завершение сеанса) — не падение. Обработчик делает
/// только async-signal-safe: unlink признака сессии, затем стандартное действие сигнала.
#[cfg(unix)]
mod unix_signals {
    use std::ffi::CString;
    use std::path::Path;
    use std::sync::OnceLock;

    static MARKER: OnceLock<CString> = OnceLock::new();

    extern "C" fn on_signal(sig: libc::c_int) {
        if let Some(p) = MARKER.get() {
            unsafe {
                libc::unlink(p.as_ptr());
            }
        }
        unsafe {
            libc::signal(sig, libc::SIG_DFL);
            libc::raise(sig);
        }
    }

    pub fn install(marker: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = CString::new(marker.as_os_str().as_bytes()) else { return };
        if MARKER.set(c).is_err() {
            return;
        }
        let h = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        unsafe {
            libc::signal(libc::SIGTERM, h);
            libc::signal(libc::SIGHUP, h);
        }
    }
}

/// Журнал при запуске: прошлый переименовывается в <name>.prev.log (раньше он затирался — и с ним следы падения)
pub fn rotate_log(name: &str) -> PathBuf {
    let logs = &paths::get().logs;
    let _ = std::fs::create_dir_all(logs);
    let cur = logs.join(format!("{name}.log"));
    let prev = logs.join(format!("{name}.prev.log"));
    if cur.is_file() {
        let _ = std::fs::remove_file(&prev);
        let _ = std::fs::rename(&cur, &prev);
    }
    prev
}

// ---------------------------------------------------------------------------
// Паника Rust и исключения Windows
// ---------------------------------------------------------------------------

/// Перехват паник (все режимы: окно, --mcp, --engine, --vst-host) и необработанных исключений Windows.
/// vst_host — процесс-хост аудиоплагинов: паника — вид vst-host-panic, исключения Windows (падение стороннего
/// плагина, изолировано by design) не перехватываются.
pub fn install(vst_host: bool) {
    VST_HOST.store(vst_host, Ordering::SeqCst);
    std::panic::set_hook(Box::new(|info| {
        let bt = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        // {bt:#} — с адресами (в релизе символов нет); база exe — чтобы перевести адреса в смещения по PDB сборки
        let msg = format!("{info}\nthread: {thread}\n{}\n{bt:#}", exe_base());
        eprintln!("{msg}");
        let p = paths::get();
        let _ = std::fs::create_dir_all(&p.logs);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p.logs.join("panic.log")) {
            let _ = writeln!(f, "--- {}\n{msg}\n", utc_text(now_secs()));
        }
        let kind = if VST_HOST.load(Ordering::SeqCst) { "vst-host-panic" } else { "panic" };
        report(kind, "Rust panic", &msg, Some(&p.logs.join("renderer.log")));
    }));
    #[cfg(windows)]
    if !vst_host {
        native::install();
    }
}

/// Адрес загрузки exe (ASLR): адреса стека минус база = смещения в символах (PDB) этой сборки
fn exe_base() -> String {
    #[cfg(windows)]
    {
        let h = unsafe { windows::Win32::System::LibraryLoader::GetModuleHandleW(None) };
        h.map(|h| format!("exe base: 0x{:X}", h.0 as usize)).unwrap_or_default()
    }
    #[cfg(not(windows))]
    String::new()
}

#[cfg(windows)]
mod native {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::Diagnostics::Debug::{SetUnhandledExceptionFilter, EXCEPTION_POINTERS};
    use windows::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    };

    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;
    static BUSY: AtomicBool = AtomicBool::new(false);

    /// Модуль (exe или DLL), в котором адрес, и смещение от его начала — по ним сбой находится в символах сборки
    fn module_of(addr: usize) -> String {
        let mut h = HMODULE::default();
        let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
        if unsafe { GetModuleHandleExW(flags, windows::core::PCWSTR(addr as *const u16), &mut h) }.is_err() {
            return "?".into();
        }
        let mut buf = [0u16; 520];
        let n = unsafe { GetModuleFileNameW(Some(h), &mut buf) } as usize;
        let name = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
        let name = name.rsplit(['\\', '/']).next().unwrap_or("?").to_string();
        format!("{name}+0x{:X}", addr.wrapping_sub(h.0 as usize))
    }

    unsafe extern "system" fn filter(info: *const EXCEPTION_POINTERS) -> i32 {
        // Повторный сбой внутри самого обработчика — дальше системе, без отчёта
        if BUSY.swap(true, Ordering::SeqCst) {
            return EXCEPTION_CONTINUE_SEARCH;
        }
        // Процесс уже в аварийном состоянии: только самое простое — код, адрес, стек Rust (если получится)
        let (code, addr) = unsafe {
            match info.as_ref().and_then(|i| i.ExceptionRecord.as_ref()) {
                Some(r) => (r.ExceptionCode.0 as u32, r.ExceptionAddress as usize),
                None => (0, 0),
            }
        };
        let name = match code {
            0xC000_0005 => "ACCESS_VIOLATION",
            0xC000_00FD => "STACK_OVERFLOW",
            0xC000_001D => "ILLEGAL_INSTRUCTION",
            0xC000_0094 => "INTEGER_DIVIDE_BY_ZERO",
            0xC000_0409 => "STACK_BUFFER_OVERRUN (fail fast)",
            0xC000_0374 => "HEAP_CORRUPTION",
            0x8000_0003 => "BREAKPOINT",
            _ => "unknown",
        };
        // Переполнение стека: места на стеке почти нет — без захвата стека вызовов
        let bt = if code == 0xC000_00FD {
            String::from("(stack overflow: no backtrace)")
        } else {
            format!("{:#}", std::backtrace::Backtrace::force_capture())
        };
        let body = format!("exception 0x{code:08X} ({name}) at 0x{addr:016X} ({})\n{}\n{bt}", module_of(addr), super::exe_base());
        super::report("native", "Unhandled Windows exception", &body, Some(&crate::paths::get().logs.join("renderer.log")));
        EXCEPTION_CONTINUE_SEARCH
    }

    pub fn install() {
        unsafe {
            SetUnhandledExceptionFilter(Some(filter));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc_text(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(utc_text(951_782_400), "2000-02-29 00:00:00 UTC");
        assert_eq!(utc_text(1_794_043_845), "2026-11-07 09:30:45 UTC");
        assert_eq!(file_stamp(1_794_043_845), "2026-11-07_09-30-45");
    }

    #[test]
    fn kinds() {
        assert_eq!(clean_kind("Panic"), "panic");
        assert_eq!(clean_kind("../x y"), "xy");
        assert_eq!(clean_kind(""), "error");
        assert_eq!(kind_of("2026-11-07_10-10-45-panic.txt"), "panic");
        assert_eq!(kind_of("2026-11-07_10-10-45-js-error-3.txt"), "js-error");
        assert_eq!(kind_of("2026-11-07_10-10-45-unclean-exit.txt"), "unclean-exit");
    }

    #[test]
    fn prune_and_tail() {
        let d = std::env::temp_dir().join(format!("ffm-crashlog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        for i in 0..7 {
            std::fs::write(d.join(format!("2026-11-07_10-10-0{i}-panic.txt")), "x").unwrap();
        }
        std::fs::write(d.join(".seen"), "x").unwrap();
        prune(&d, 5);
        let mut left = list_names(&d);
        left.sort();
        assert_eq!(left.len(), 5);
        assert_eq!(left[0], "2026-11-07_10-10-02-panic.txt");
        assert!(d.join(".seen").exists());
        let log = d.join("a.log");
        std::fs::write(&log, (1..=10).map(|i| i.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(tail(&log, 3), "8\n9\n10");
        let _ = std::fs::remove_dir_all(&d);
    }
}
