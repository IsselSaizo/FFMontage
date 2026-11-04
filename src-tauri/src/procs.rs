// Дочерние процессы FFmpeg: после выхода программы (и даже после её падения) они не должны продолжать работать.
//   Windows       — каждый процесс FFmpeg кладётся в Job Object с KILL_ON_JOB_CLOSE: система убьёт их сама,
//                   когда закроется последний дескриптор задания, то есть вместе с программой.
//   Linux / macOS — список PID; при выходе программы — SIGKILL.
// Плюс: незаконченные файлы (.part) удаляются при выходе и при следующем запуске.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Пока жив — процесс считается «нашим»; drop убирает его из списка (на Windows список не нужен).
pub struct Tracked(#[allow(dead_code)] u32);

impl Drop for Tracked {
    fn drop(&mut self) {
        imp::untrack(self.0);
    }
}

pub fn track(child: &tokio::process::Child) -> Tracked {
    Tracked(imp::track(child))
}

static PARTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Незаконченный файл: удалить, если программа закроется раньше, чем он будет готов
pub struct Part(PathBuf);

impl Drop for Part {
    fn drop(&mut self) {
        if let Ok(mut v) = PARTS.lock() {
            v.retain(|p| p != &self.0);
        }
    }
}

pub fn part(p: &Path) -> Part {
    if let Ok(mut v) = PARTS.lock() {
        v.push(p.to_path_buf());
    }
    Part(p.to_path_buf())
}

/// Выход программы: убить все процессы FFmpeg и удалить их незаконченные файлы
pub fn kill_all() {
    imp::kill_all();
    let parts: Vec<PathBuf> = PARTS.lock().map(|mut v| v.drain(..).collect()).unwrap_or_default();
    for p in parts {
        // Процесс завершается не мгновенно, файл может быть ещё открыт — несколько попыток
        for _ in 0..20 {
            if !p.exists() || std::fs::remove_file(&p).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

/// Запуск программы: убрать то, что осталось от прошлого раза (падение, выключение компьютера):
/// *.part* в кэше медиа (прокси, звук, реверс, стоп-кадр) и рабочие папки *_work.
pub fn sweep_leftovers(media_cache: &Path) {
    fn walk(dir: &Path, depth: u32) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if name.ends_with("_work") {
                    let _ = std::fs::remove_dir_all(&path);
                } else if depth > 0 {
                    walk(&path, depth - 1);
                }
            } else if name.contains(".part.") || name.ends_with(".part") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    walk(media_cache, 3);
}

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // Дескриптор задания живёт до конца процесса и закрывается системой — тогда и срабатывает KILL_ON_JOB_CLOSE
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        let h = *JOB.get_or_init(|| unsafe {
            let Ok(h) = CreateJobObjectW(None, PCWSTR::null()) else { return 0 };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok.is_err() {
                return 0;
            }
            h.0 as usize
        });
        if h == 0 {
            None
        } else {
            Some(HANDLE(h as *mut core::ffi::c_void))
        }
    }

    pub fn track(child: &tokio::process::Child) -> u32 {
        if let (Some(j), Some(raw)) = (job(), child.raw_handle()) {
            unsafe {
                let _ = AssignProcessToJobObject(j, HANDLE(raw));
            }
        }
        0
    }

    pub fn untrack(_: u32) {}

    pub fn kill_all() {
        if let Some(j) = job() {
            unsafe {
                let _ = TerminateJobObject(j, 1);
            }
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::sync::Mutex;

    static PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

    pub fn track(child: &tokio::process::Child) -> u32 {
        let id = child.id().unwrap_or(0);
        if id != 0 {
            if let Ok(mut v) = PIDS.lock() {
                v.push(id);
            }
        }
        id
    }

    pub fn untrack(id: u32) {
        if let Ok(mut v) = PIDS.lock() {
            v.retain(|&p| p != id);
        }
    }

    pub fn kill_all() {
        let pids: Vec<u32> = PIDS.lock().map(|mut v| v.drain(..).collect()).unwrap_or_default();
        for pid in pids {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}
