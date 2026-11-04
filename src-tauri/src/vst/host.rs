// Процесс-хост аудиоплагинов (как reaper_host64.exe у REAPER): `ff-montage --vst-host <режим>`.
// Плагин — чужой машинный код; если он упадёт или зависнет, закроется только этот процесс, программа — нет.
//   scan <путь>        → stdout: {"classes":[ClassInfo…]}
//   info               ← stdin: {path,uid,state?,ctrl?,params?} → stdout: {state,ctrl,hasEditor,latency,params:[…]}
//   render <job.json>  job: {chain:[{path,uid,state,ctrl,params}]}; stdin f32le стерео 48 кГц → stdout столько же кадров
//   editor             ← первая строка stdin: {path,uid,state,ctrl,params,title,audition?:{wav,pos}},
//                        дальше команды {op:play|pause|seek|focus|params|close,…}; stdout — события JSON по строке
use super::fx::{Fx, Module, ResizeFn, SR};
use super::wasapi;
use crate::assets::base64_decode;
use crate::commands::base64;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

fn emit(v: Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

fn fail(msg: String) -> ! {
    emit(json!({ "error": msg }));
    hard_exit(2)
}

fn b64(v: &Value) -> Vec<u8> {
    v.as_str().and_then(base64_decode).unwrap_or_default()
}

fn params_of(v: &Value) -> Vec<(u32, f64)> {
    v.as_object().map(|m| m.iter().filter_map(|(k, x)| Some((k.parse::<u32>().ok()?, x.as_f64()?))).collect()).unwrap_or_default()
}

/// Плагин из описания {path, uid, state, ctrl, params}
fn open(module: &Module, spec: &Value, offline: bool, block: usize) -> Box<dyn Fx> {
    let uid = spec["uid"].as_str().unwrap_or_default();
    let mut fx = module.open(uid, offline, block).unwrap_or_else(|e| fail(e));
    fx.set_state(&b64(&spec["state"]), &b64(&spec["ctrl"]));
    let p = params_of(&spec["params"]);
    if !p.is_empty() {
        fx.set_params(&p);
    }
    fx
}

fn load(spec: &Value) -> Module {
    let path = PathBuf::from(spec["path"].as_str().unwrap_or_default());
    Module::load(&path).unwrap_or_else(|e| fail(e))
}

pub fn main(args: &[String]) {
    let mode = args.first().map(String::as_str).unwrap_or("");
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
    }
    match mode {
        "scan" => scan(Path::new(args.get(1).map(String::as_str).unwrap_or(""))),
        "info" => info(),
        "render" => render(Path::new(args.get(1).map(String::as_str).unwrap_or(""))),
        "editor" => editor(),
        _ => fail(format!("unknown mode {mode}")),
    }
    hard_exit(0);
}

/// Выход без DLL_PROCESS_DETACH и деструкторов статиков плагина: многие плагины (JUCE и др.) падают,
/// если их выгружать при завершении процесса. Весь вывод к этому моменту уже записан.
fn hard_exit(code: u32) -> ! {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    unsafe {
        let _ = windows::Win32::System::Threading::TerminateProcess(windows::Win32::System::Threading::GetCurrentProcess(), code);
    }
    std::process::exit(code as i32)
}

fn scan(path: &Path) {
    let m = Module::load(path).unwrap_or_else(|e| fail(e));
    let classes = m.classes();
    emit(json!({ "classes": classes }));
    m.exit();
}

fn info() {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    let spec: Value = serde_json::from_str(s.trim()).unwrap_or_else(|e| fail(e.to_string()));
    let m = load(&spec);
    let mut fx = open(&m, &spec, false, 512);
    let _ = fx.activate();
    let (l, r) = (vec![0f32; 512], vec![0f32; 512]);
    let (mut ol, mut or) = (vec![0f32; 512], vec![0f32; 512]);
    // Блок тишины: правки параметров доходят до процессора, состояние становится полным
    fx.process(&l, &r, &mut ol, &mut or, 512);
    let (st, ct) = fx.get_state();
    let has = fx.has_editor();
    let params = fx.params();
    emit(json!({ "state": base64(&st), "ctrl": base64(&ct), "hasEditor": has, "latency": fx.latency(), "params": params }));
    fx.shutdown();
    m.exit();
}

// ---------------------------------------------------------------------------
// Офлайн-рендер: stdin → цепочка → stdout, длина выхода = длине входа (задержка плагинов компенсируется)
// ---------------------------------------------------------------------------
const BLOCK: usize = 1024;

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> usize {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    n
}

fn render(job: &Path) {
    let text = std::fs::read_to_string(job).unwrap_or_else(|e| fail(format!("{}: {e}", job.display())));
    let job: Value = serde_json::from_str(&text).unwrap_or_else(|e| fail(e.to_string()));
    let chain = job["chain"].as_array().cloned().unwrap_or_default();
    let mut mods = vec![];
    let mut fxs: Vec<Box<dyn Fx>> = vec![];
    for spec in &chain {
        let m = load(spec);
        let mut fx = open(&m, spec, true, BLOCK);
        fx.activate().unwrap_or_else(|e| fail(e));
        fx.set_playing(true, 0);
        fxs.push(fx);
        mods.push(m);
    }
    let latency: usize = fxs.iter().map(|f| f.latency() as usize).sum();
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::BufWriter::with_capacity(1 << 16, std::io::stdout().lock());
    let mut raw = vec![0u8; BLOCK * 8];
    let mut a = (vec![0f32; BLOCK], vec![0f32; BLOCK]);
    let mut b = (vec![0f32; BLOCK], vec![0f32; BLOCK]);
    let mut skip = latency;
    let mut tail = latency;
    let mut out = Vec::with_capacity(BLOCK * 8);
    loop {
        let got = read_full(&mut stdin, &mut raw);
        let mut n = got / 8;
        if n == 0 {
            // Конец входа: прогнать тишину на величину задержки, чтобы выход сравнялся с входом
            if tail == 0 {
                break;
            }
            n = tail.min(BLOCK);
            tail -= n;
            a.0[..n].fill(0.0);
            a.1[..n].fill(0.0);
        } else {
            for i in 0..n {
                let o = i * 8;
                a.0[i] = f32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]);
                a.1[i] = f32::from_le_bytes([raw[o + 4], raw[o + 5], raw[o + 6], raw[o + 7]]);
            }
        }
        for fx in fxs.iter_mut() {
            fx.process(&a.0, &a.1, &mut b.0, &mut b.1, n);
            std::mem::swap(&mut a, &mut b);
        }
        let from = skip.min(n);
        skip -= from;
        out.clear();
        for i in from..n {
            out.extend_from_slice(&a.0[i].to_le_bytes());
            out.extend_from_slice(&a.1[i].to_le_bytes());
        }
        if stdout.write_all(&out).is_err() {
            break;
        }
        if got > 0 && got < raw.len() && !got.is_multiple_of(8) {
            break;
        }
    }
    let _ = stdout.flush();
    for fx in fxs.iter_mut() {
        fx.shutdown();
    }
    for m in &mods {
        m.exit();
    }
}

// ---------------------------------------------------------------------------
// WAV float32 стерео (результат vst_render) — источник живого прослушивания
// ---------------------------------------------------------------------------
struct Wav {
    file: std::fs::File,
    data: u64,
    frames: u64,
}

impl Wav {
    fn open(p: &Path) -> Result<Wav, String> {
        use std::io::{Seek, SeekFrom};
        let mut f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
        let mut hdr = [0u8; 12];
        f.read_exact(&mut hdr).map_err(|e| e.to_string())?;
        if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" {
            return Err("not a WAV file".into());
        }
        let mut fmt_ok = false;
        loop {
            let mut ch = [0u8; 8];
            if f.read_exact(&mut ch).is_err() {
                return Err("WAV: no data chunk".into());
            }
            let size = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]) as u64;
            match &ch[0..4] {
                b"fmt " => {
                    let mut b = vec![0u8; size as usize];
                    f.read_exact(&mut b).map_err(|e| e.to_string())?;
                    let tag = u16::from_le_bytes([b[0], b[1]]);
                    let chs = u16::from_le_bytes([b[2], b[3]]);
                    let bits = u16::from_le_bytes([b[14], b[15]]);
                    fmt_ok = (tag == 3 || tag == 0xFFFE) && chs == 2 && bits == 32;
                    if size % 2 == 1 {
                        f.seek(SeekFrom::Current(1)).map_err(|e| e.to_string())?;
                    }
                }
                b"data" => {
                    if !fmt_ok {
                        return Err("WAV: expected float32 stereo".into());
                    }
                    let data = f.stream_position().map_err(|e| e.to_string())?;
                    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                    let avail = len.saturating_sub(data);
                    let size = if size == 0 || size == 0xFFFF_FFFF { avail } else { size.min(avail) };
                    return Ok(Wav { file: f, data, frames: size / 8 });
                }
                _ => {
                    f.seek(SeekFrom::Current((size + size % 2) as i64)).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    /// Кадры [pos, pos+n) → l, r (за концом — тишина)
    fn read(&mut self, pos: u64, l: &mut [f32], r: &mut [f32], n: usize) {
        use std::io::{Seek, SeekFrom};
        l[..n].fill(0.0);
        r[..n].fill(0.0);
        if pos >= self.frames {
            return;
        }
        let k = (n as u64).min(self.frames - pos) as usize;
        let mut raw = vec![0u8; k * 8];
        if self.file.seek(SeekFrom::Start(self.data + pos * 8)).is_err() {
            return;
        }
        let got = read_full(&mut self.file, &mut raw) / 8;
        for i in 0..got {
            let o = i * 8;
            l[i] = f32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]);
            r[i] = f32::from_le_bytes([raw[o + 4], raw[o + 5], raw[o + 6], raw[o + 7]]);
        }
    }
}

// ---------------------------------------------------------------------------
// Окно плагина + живое прослушивание
// ---------------------------------------------------------------------------
struct SendFx(Box<dyn Fx>);
unsafe impl Send for SendFx {}

type Shared = Arc<Mutex<SendFx>>;

#[derive(Default)]
struct Live {
    playing: AtomicBool,
    quit: AtomicBool,
    seek: Mutex<Option<f64>>,
}

fn audio_thread(fx: Shared, live: Arc<Live>, wav: PathBuf) {
    let mut src = match Wav::open(&wav) {
        Ok(w) => w,
        Err(e) => {
            emit(json!({ "ev": "error", "message": e }));
            return;
        }
    };
    let mut out: Option<wasapi::Out> = None;
    let mut pos: u64 = 0;
    const B: usize = 512;
    let (mut l, mut r, mut ol, mut or) = (vec![0f32; B], vec![0f32; B], vec![0f32; B], vec![0f32; B]);
    while !live.quit.load(Ordering::SeqCst) {
        let playing = live.playing.load(Ordering::SeqCst);
        if let Some(t) = live.seek.lock().ok().and_then(|mut s| s.take()) {
            pos = (t.max(0.0) * SR) as u64;
            if let Ok(mut f) = fx.lock() {
                f.0.set_playing(playing, pos as i64);
            }
        }
        if !playing {
            if let Some(o) = out.as_mut() {
                o.stop();
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        }
        if out.is_none() {
            match wasapi::Out::open() {
                Ok(o) => out = Some(o),
                Err(e) => {
                    emit(json!({ "ev": "error", "message": e }));
                    live.playing.store(false, Ordering::SeqCst);
                    continue;
                }
            }
        }
        let Some(o) = out.as_mut() else { continue };
        let res = o.fill(&mut |buf: &mut [f32]| {
            let frames = buf.len() / 2;
            let mut done = 0;
            while done < frames {
                let n = (frames - done).min(B);
                src.read(pos, &mut l, &mut r, n);
                if let Ok(mut f) = fx.lock() {
                    f.0.process(&l, &r, &mut ol, &mut or, n);
                } else {
                    ol[..n].copy_from_slice(&l[..n]);
                    or[..n].copy_from_slice(&r[..n]);
                }
                for i in 0..n {
                    buf[(done + i) * 2] = ol[i];
                    buf[(done + i) * 2 + 1] = or[i];
                }
                pos += n as u64;
                done += n;
            }
        });
        o.start();
        if let Err(e) = res {
            emit(json!({ "ev": "error", "message": e }));
            out = None;
            live.playing.store(false, Ordering::SeqCst);
        }
    }
}

mod win {
    use super::*;
    use std::cell::{Cell, RefCell};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    std::thread_local! {
        pub static FX: RefCell<Option<Shared>> = const { RefCell::new(None) };
        /// Размер меняем мы сами (по просьбе плагина) — WM_SIZE не пересылать обратно
        pub static RESIZING: Cell<bool> = const { Cell::new(false) };
        pub static RESIZABLE: Cell<bool> = const { Cell::new(false) };
    }

    pub fn style(resizable: bool) -> (WINDOW_STYLE, WINDOW_EX_STYLE) {
        let s = if resizable { WS_OVERLAPPEDWINDOW & !WS_MAXIMIZEBOX } else { WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX };
        (s, WS_EX_APPWINDOW)
    }

    /// Клиентская область w×h → размер окна
    pub fn set_client(hwnd: HWND, w: u32, h: u32) {
        let (s, ex) = style(RESIZABLE.with(|c| c.get()));
        let mut r = RECT { left: 0, top: 0, right: w as i32, bottom: h as i32 };
        unsafe {
            let _ = AdjustWindowRectEx(&mut r, s, false, ex);
            RESIZING.with(|c| c.set(true));
            let _ = SetWindowPos(hwnd, None, 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            RESIZING.with(|c| c.set(false));
        }
    }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_CLOSE => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            WM_SIZE if !RESIZING.with(|c| c.get()) && RESIZABLE.with(|c| c.get()) && wp.0 as u32 != SIZE_MINIMIZED => {
                let (w, h) = ((lp.0 & 0xFFFF) as u32, ((lp.0 >> 16) & 0xFFFF) as u32);
                let fx = FX.with(|f| f.borrow().clone());
                if let Some(fx) = fx {
                    if let Ok(mut g) = fx.try_lock() {
                        if let Some((nw, nh)) = g.0.editor_set_size(w, h) {
                            if (nw, nh) != (w, h) {
                                set_client(hwnd, nw, nh);
                            }
                        }
                    }
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    pub fn create(title: &str) -> Option<HWND> {
        unsafe {
            let inst = GetModuleHandleW(None).ok()?;
            let class = w!("FFMontagePluginWindow");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: inst.into(),
                lpszClassName: class,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let t: Vec<u16> = title.encode_utf16().chain([0]).collect();
            let (s, ex) = style(false);
            CreateWindowExW(ex, class, PCWSTR(t.as_ptr()), s, CW_USEDEFAULT, CW_USEDEFAULT, 400, 300, None, None, Some(inst.into()), None)
                .ok()
        }
    }

    pub fn set_resizable(hwnd: HWND, yes: bool) {
        RESIZABLE.with(|c| c.set(yes));
        let (s, _) = style(yes);
        unsafe {
            SetWindowLongW(hwnd, GWL_STYLE, s.0 as i32);
        }
    }
}

fn editor() {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::*;

    unsafe {
        let _ =
            windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = windows::Win32::System::Ole::OleInitialize(None);
    }
    let mut first = String::new();
    let mut stdin = std::io::stdin().lock();
    if stdin.read_line(&mut first).unwrap_or(0) == 0 {
        fail("no config".into());
    }
    drop(stdin); // дальше stdin читает поток команд
    let cfg: Value = serde_json::from_str(first.trim()).unwrap_or_else(|e| fail(e.to_string()));
    let m = load(&cfg);
    let mut fx = open(&m, &cfg, false, 512);
    fx.activate().unwrap_or_else(|e| fail(e));
    let fx: Shared = Arc::new(Mutex::new(SendFx(fx)));
    win::FX.with(|f| *f.borrow_mut() = Some(fx.clone()));

    // Окно плагина
    let title = cfg["title"].as_str().unwrap_or("Plugin").to_string();
    let mut hwnd: Option<HWND> = None;
    let mut size = (0u32, 0u32);
    let has = fx.lock().map(|mut f| f.0.has_editor()).unwrap_or(false);
    if has {
        if let Some(h) = win::create(&title) {
            let hv = h.0 as isize;
            let resize: ResizeFn = Box::new(move |w, hh| {
                win::set_client(HWND(hv as *mut _), w, hh);
                true
            });
            let opened = fx.lock().ok().and_then(|mut f| f.0.editor_open(hv, resize));
            match opened {
                Some((w, hh, can)) => {
                    win::set_resizable(h, can);
                    win::set_client(h, w, hh);
                    unsafe {
                        let _ = ShowWindow(h, SW_SHOW);
                        let _ = SetForegroundWindow(h);
                    }
                    hwnd = Some(h);
                    size = (w, hh);
                }
                None => unsafe {
                    let _ = DestroyWindow(h);
                },
            }
        }
    }
    let latency = fx.lock().map(|f| f.0.latency()).unwrap_or(0);
    let hwnd_num = hwnd.map(|h| h.0 as isize).unwrap_or(0);
    emit(json!({ "ev": "ready", "hasEditor": hwnd.is_some(), "width": size.0, "height": size.1, "latency": latency, "hwnd": hwnd_num }));

    // Команды из stdin → очередь + WM_APP главному потоку
    let tid = unsafe { GetCurrentThreadId() };
    let cmds: Arc<Mutex<VecDeque<Value>>> = Arc::default();
    {
        let cmds = cmds.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                    cmds.lock().map(|mut q| q.push_back(v)).ok();
                    unsafe {
                        let _ = PostThreadMessageW(tid, WM_APP, WPARAM(0), LPARAM(0));
                    }
                }
            }
            // Программа закрылась — выходим
            cmds.lock().map(|mut q| q.push_back(json!({ "op": "close" }))).ok();
            unsafe {
                let _ = PostThreadMessageW(tid, WM_APP, WPARAM(0), LPARAM(0));
            }
        });
    }

    // Живое прослушивание
    let live = Arc::new(Live::default());
    let audio = cfg["audition"]["wav"].as_str().filter(|s| !s.is_empty()).map(|w| {
        *live.seek.lock().unwrap_or_else(|e| e.into_inner()) = Some(cfg["audition"]["pos"].as_f64().unwrap_or(0.0));
        let (fx, live, w) = (fx.clone(), live.clone(), PathBuf::from(w));
        std::thread::spawn(move || audio_thread(fx, live, w))
    });

    unsafe {
        SetTimer(None, 0, 30, None);
    }
    let mut last_state: Option<(Vec<u8>, Vec<u8>)> = None;
    let mut pending = false;
    let mut need_flush = false;
    let mut last_emit = std::time::Instant::now();
    let send_state = |fx: &Shared, last: &mut Option<(Vec<u8>, Vec<u8>)>, force: bool| {
        if let Ok(mut f) = fx.lock() {
            let s = f.0.get_state();
            if force || last.as_ref() != Some(&s) {
                emit(json!({ "ev": "state", "state": base64(&s.0), "ctrl": base64(&s.1) }));
                *last = Some(s);
            }
        }
    };
    // Исходное состояние — для сравнения (без события)
    if let Ok(mut f) = fx.lock() {
        last_state = Some(f.0.get_state());
    }
    let mut msg = MSG::default();
    'outer: loop {
        let r = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if r.0 <= 0 {
            break;
        }
        if msg.message == WM_APP {
            let list: Vec<Value> = cmds.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
            for c in list {
                match c["op"].as_str().unwrap_or("") {
                    "play" => {
                        *live.seek.lock().unwrap_or_else(|e| e.into_inner()) = Some(c["pos"].as_f64().unwrap_or(0.0));
                        live.playing.store(true, Ordering::SeqCst);
                    }
                    "pause" => live.playing.store(false, Ordering::SeqCst),
                    "seek" => *live.seek.lock().unwrap_or_else(|e| e.into_inner()) = Some(c["pos"].as_f64().unwrap_or(0.0)),
                    "focus" => {
                        if let Some(h) = hwnd {
                            unsafe {
                                let _ = ShowWindow(h, SW_RESTORE);
                                let _ = SetForegroundWindow(h);
                            }
                        }
                    }
                    "params" => {
                        let p = params_of(&c["values"]);
                        if let Ok(mut f) = fx.lock() {
                            f.0.set_params(&p);
                        }
                        need_flush = true;
                    }
                    "close" => break 'outer,
                    _ => {}
                }
            }
            continue;
        }
        if msg.message == WM_TIMER && msg.hwnd.is_invalid() {
            if let Ok(mut f) = fx.try_lock() {
                f.0.idle();
                if need_flush && !live.playing.load(Ordering::SeqCst) {
                    let (z, mut o1, mut o2) = ([0f32; 1], [0f32; 1], [0f32; 1]);
                    f.0.process(&z, &z, &mut o1, &mut o2, 0);
                    need_flush = false;
                }
                if f.0.take_dirty() {
                    pending = true;
                }
            }
            if pending && last_emit.elapsed().as_millis() >= 400 {
                send_state(&fx, &mut last_state, false);
                pending = false;
                last_emit = std::time::Instant::now();
            }
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    live.quit.store(true, Ordering::SeqCst);
    if let Some(t) = audio {
        let _ = t.join();
    }
    // Итоговое состояние — всегда (программа запишет его в проект)
    if need_flush {
        if let Ok(mut f) = fx.lock() {
            let (z, mut o1, mut o2) = ([0f32; 1], [0f32; 1], [0f32; 1]);
            f.0.process(&z, &z, &mut o1, &mut o2, 0);
        }
    }
    send_state(&fx, &mut last_state, true);
    if let Ok(mut f) = fx.lock() {
        f.0.editor_close();
    }
    if let Some(h) = hwnd {
        unsafe {
            let _ = DestroyWindow(h);
        }
    }
    if let Ok(mut f) = fx.lock() {
        f.0.shutdown();
    }
    emit(json!({ "ev": "closed" }));
    m.exit();
}
