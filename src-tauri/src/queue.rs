// Очередь задач FFmpeg (M0.4, R-1): сколько процессов FFmpeg работает одновременно.
//   • процессор — миниатюры, пики, звук, прокси, реверс, стоп-кадр, поиск тишины: не больше max(2, ядра/2);
//   • видеокарта (NVENC, а также qsv/amf/vaapi) — отдельный лимит 3: у NVENC на обычных картах ограничено число сессий.
// Экспорт идёт вне очереди (Limiter::take_now), но занимает слот видеокарты, если кодирует на ней, —
// фоновые задачи с видеокартой тогда ждут.
// Порядок блокировок в ff.rs: сначала блокировка ключа кэша (key_lock), потом слот — иначе задачи с одним ключом
// могли бы занять все слоты и ждать друг друга.
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tokio::sync::Notify;

pub const GPU_LIMIT: usize = 3;

pub struct Limiter {
    limit: usize,
    /// (занято, ждут)
    state: Mutex<(usize, usize)>,
    notify: Notify,
}

/// Занятый слот; drop освобождает его
pub struct Slot(&'static Limiter);

impl Drop for Slot {
    fn drop(&mut self) {
        {
            let mut s = self.0.lock();
            s.0 = s.0.saturating_sub(1);
        }
        self.0.notify.notify_waiters();
    }
}

impl Limiter {
    const fn new(limit: usize) -> Self {
        Limiter { limit, state: Mutex::new((0, 0)), notify: Notify::const_new() }
    }

    /// Отравленный Mutex (паника в другом потоке) не должен ронять очередь
    fn lock(&self) -> MutexGuard<'_, (usize, usize)> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Дождаться свободного слота
    pub async fn acquire(&'static self) -> Slot {
        let mut waiting = false;
        loop {
            // подписка на освобождение — до проверки, чтобы не пропустить notify_waiters между ними
            let n = self.notify.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            {
                let mut s = self.lock();
                if s.0 < self.limit {
                    s.0 += 1;
                    if waiting {
                        s.1 = s.1.saturating_sub(1);
                    }
                    return Slot(self);
                }
                if !waiting {
                    s.1 += 1;
                    waiting = true;
                }
            }
            // если задачу отменили (future уничтожен) — счётчик ожидающих поправит Waiting
            let _w = Waiting(self, waiting);
            n.await;
            std::mem::forget(_w);
        }
    }

    /// Занять слот сразу, даже сверх лимита (экспорт идёт вне очереди)
    pub fn take_now(&'static self) -> Slot {
        self.lock().0 += 1;
        Slot(self)
    }

    pub fn stats(&self) -> Value {
        let s = self.lock();
        json!({ "running": s.0, "waiting": s.1, "limit": self.limit })
    }
}

/// Ожидание прервано (future уничтожен до получения слота) — убрать из счётчика ожидающих
struct Waiting(&'static Limiter, bool);
impl Drop for Waiting {
    fn drop(&mut self) {
        if self.1 {
            let mut s = self.0.lock();
            s.1 = s.1.saturating_sub(1);
        }
    }
}

pub fn cpu_limit() -> usize {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (n / 2).max(2)
}

pub fn cpu() -> &'static Limiter {
    static L: OnceLock<Limiter> = OnceLock::new();
    L.get_or_init(|| Limiter::new(cpu_limit()))
}

pub fn gpu() -> &'static Limiter {
    static L: Limiter = Limiter::new(GPU_LIMIT);
    &L
}

/// Слот для фоновой задачи: на видеокарте (gpu = true) или на процессоре
pub async fn slot(gpu_job: bool) -> Slot {
    if gpu_job {
        gpu().acquire().await
    } else {
        cpu().acquire().await
    }
}

/// Состояние очереди (для журнала и окна)
pub fn stats() -> Value {
    json!({ "cpu": cpu().stats(), "gpu": gpu().stats() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn limit_is_respected() {
        static L: Limiter = Limiter::new(2);
        let now = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut hs = vec![];
        for _ in 0..12 {
            let (now, peak) = (now.clone(), peak.clone());
            hs.push(tokio::spawn(async move {
                let _s = L.acquire().await;
                let n = now.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
                now.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in hs {
            h.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(L.stats()["running"], 0);
        assert_eq!(L.stats()["waiting"], 0);
    }

    #[tokio::test]
    async fn take_now_blocks_background() {
        static L: Limiter = Limiter::new(1);
        let export = L.take_now();
        // слот занят экспортом — фоновая задача ждёт
        let r = tokio::time::timeout(std::time::Duration::from_millis(50), L.acquire()).await;
        assert!(r.is_err());
        assert_eq!(L.stats()["waiting"], 0, "отменённое ожидание убрано из счётчика"); // i18n-ignore — тест
                                                                                       // экспорт вне очереди — даже сверх лимита
        let second = L.take_now();
        assert_eq!(L.stats()["running"], 2);
        drop(export);
        drop(second);
        let s = tokio::time::timeout(std::time::Duration::from_millis(500), L.acquire()).await;
        assert!(s.is_ok());
        assert!(cpu_limit() >= 2);
    }
}
