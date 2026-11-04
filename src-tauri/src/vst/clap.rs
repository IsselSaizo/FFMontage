// CLAP (открытый формат, MIT): модуль .clap (DLL с символом clap_entry) и экземпляр плагина за интерфейсом Fx.
// Хост даёт плагину расширения: thread-check, log, params, state, gui, latency, audio-ports, timer-support.
// Значения параметров CLAP — «как есть» (min..max); наружу (окно программы, проект) — нормированные 0..1.
use super::fx::{ClassInfo, Fx, ParamInfo, ResizeFn, SR};
use super::vst3::{load_library, Bus};
use clap_sys::audio_buffer::clap_audio_buffer;
use clap_sys::entry::clap_plugin_entry;
use clap_sys::events::*;
use clap_sys::ext::audio_ports::*;
use clap_sys::ext::gui::*;
use clap_sys::ext::latency::*;
use clap_sys::ext::log::*;
use clap_sys::ext::params::*;
use clap_sys::ext::render::*;
use clap_sys::ext::state::*;
use clap_sys::ext::thread_check::*;
use clap_sys::ext::timer_support::*;
use clap_sys::factory::plugin_factory::*;
use clap_sys::host::clap_host;
use clap_sys::id::clap_id;
use clap_sys::plugin::*;
use clap_sys::process::*;
use clap_sys::stream::*;
use clap_sys::version::CLAP_VERSION;
use std::cell::{Cell, RefCell};
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use windows::Win32::System::LibraryLoader::GetProcAddress;

pub const PREFIX: &str = "clap:";

fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p).to_string_lossy().into_owned() }
    }
}

pub struct Module {
    entry: *const clap_plugin_entry,
    factory: *const clap_plugin_factory,
}

impl Module {
    pub fn load(path: &Path) -> Result<Module, String> {
        unsafe {
            let lib = load_library(path)?;
            let sym = GetProcAddress(lib, windows::core::s!("clap_entry")).ok_or("clap_entry not exported")?;
            let entry = sym as *const c_void as *const clap_plugin_entry;
            if !clap_sys::version::clap_version_is_compatible((*entry).clap_version) {
                return Err("incompatible CLAP version".into());
            }
            let p = CString::new(path.to_string_lossy().as_bytes()).unwrap_or_default();
            if !(*entry).init.is_some_and(|f| f(p.as_ptr())) {
                return Err("clap_entry.init failed".into());
            }
            let get = (*entry).get_factory.ok_or("no get_factory")?;
            let factory = get(CLAP_PLUGIN_FACTORY_ID.as_ptr()) as *const clap_plugin_factory;
            if factory.is_null() {
                return Err("no clap.plugin-factory".into());
            }
            Ok(Module { entry, factory })
        }
    }

    pub fn classes(&self) -> Vec<ClassInfo> {
        let mut out = vec![];
        unsafe {
            let f = &*self.factory;
            let n = f.get_plugin_count.map(|g| g(self.factory)).unwrap_or(0);
            for i in 0..n {
                let Some(d) = f.get_plugin_descriptor.map(|g| g(self.factory, i)) else { continue };
                if d.is_null() {
                    continue;
                }
                let d = &*d;
                let mut feats = vec![];
                if !d.features.is_null() {
                    let mut k = 0;
                    while !(*d.features.add(k)).is_null() && k < 64 {
                        feats.push(cstr(*d.features.add(k)));
                        k += 1;
                    }
                }
                let instrument = feats.iter().any(|x| x == "instrument") && !feats.iter().any(|x| x == "audio-effect");
                out.push(ClassInfo {
                    format: "clap",
                    uid: format!("{PREFIX}{}", cstr(d.id)),
                    name: cstr(d.name),
                    vendor: cstr(d.vendor),
                    version: cstr(d.version),
                    category: "CLAP".into(),
                    sub: feats.join("|"),
                    sdk: format!("CLAP {}.{}.{}", d.clap_version.major, d.clap_version.minor, d.clap_version.revision),
                    instrument,
                });
            }
        }
        out
    }

    pub fn exit(&self) {
        unsafe {
            if let Some(d) = (*self.entry).deinit {
                d();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Хост: данные и обратные вызовы
// ---------------------------------------------------------------------------
std::thread_local! {
    static IN_AUDIO: Cell<bool> = const { Cell::new(false) };
}

struct HostData {
    main: std::thread::ThreadId,
    callback: AtomicBool,
    restart: AtomicBool,
    flush: AtomicBool,
    dirty: AtomicBool,
    latency_changed: AtomicBool,
    resize: Mutex<Option<ResizeFn>>,
    /// (id, период мс, последний вызов)
    timers: Mutex<Vec<(clap_id, u32, std::time::Instant)>>,
    next_timer: Cell<clap_id>,
}

unsafe fn hd<'a>(h: *const clap_host) -> &'a HostData {
    &*((*h).host_data as *const HostData)
}

unsafe extern "C" fn h_get_extension(_h: *const clap_host, id: *const c_char) -> *const c_void {
    if id.is_null() {
        return std::ptr::null();
    }
    let id = CStr::from_ptr(id);
    if id == CLAP_EXT_THREAD_CHECK {
        &THREAD_CHECK as *const _ as *const c_void
    } else if id == CLAP_EXT_LOG {
        &LOG as *const _ as *const c_void
    } else if id == CLAP_EXT_PARAMS {
        &PARAMS as *const _ as *const c_void
    } else if id == CLAP_EXT_STATE {
        &STATE as *const _ as *const c_void
    } else if id == CLAP_EXT_GUI {
        &GUI as *const _ as *const c_void
    } else if id == CLAP_EXT_LATENCY {
        &LATENCY as *const _ as *const c_void
    } else if id == CLAP_EXT_AUDIO_PORTS {
        &PORTS as *const _ as *const c_void
    } else if id == CLAP_EXT_TIMER_SUPPORT {
        &TIMERS as *const _ as *const c_void
    } else {
        std::ptr::null()
    }
}
unsafe extern "C" fn h_request_restart(h: *const clap_host) {
    hd(h).restart.store(true, Ordering::SeqCst);
}
unsafe extern "C" fn h_request_process(_h: *const clap_host) {}
unsafe extern "C" fn h_request_callback(h: *const clap_host) {
    hd(h).callback.store(true, Ordering::SeqCst);
}

unsafe extern "C" fn tc_main(h: *const clap_host) -> bool {
    std::thread::current().id() == hd(h).main && !IN_AUDIO.with(|c| c.get())
}
unsafe extern "C" fn tc_audio(_h: *const clap_host) -> bool {
    IN_AUDIO.with(|c| c.get())
}
static THREAD_CHECK: clap_host_thread_check = clap_host_thread_check { is_main_thread: Some(tc_main), is_audio_thread: Some(tc_audio) };

unsafe extern "C" fn log_fn(_h: *const clap_host, sev: clap_log_severity, msg: *const c_char) {
    if sev >= CLAP_LOG_WARNING {
        eprintln!("[clap] {}", cstr(msg));
    }
}
static LOG: clap_host_log = clap_host_log { log: Some(log_fn) };

unsafe extern "C" fn p_rescan(h: *const clap_host, _f: clap_param_rescan_flags) {
    hd(h).dirty.store(true, Ordering::SeqCst);
}
unsafe extern "C" fn p_clear(_h: *const clap_host, _id: clap_id, _f: clap_param_clear_flags) {}
unsafe extern "C" fn p_request_flush(h: *const clap_host) {
    hd(h).flush.store(true, Ordering::SeqCst);
}
static PARAMS: clap_host_params = clap_host_params { rescan: Some(p_rescan), clear: Some(p_clear), request_flush: Some(p_request_flush) };

unsafe extern "C" fn s_mark_dirty(h: *const clap_host) {
    hd(h).dirty.store(true, Ordering::SeqCst);
}
static STATE: clap_host_state = clap_host_state { mark_dirty: Some(s_mark_dirty) };

unsafe extern "C" fn g_hints(_h: *const clap_host) {}
unsafe extern "C" fn g_request_resize(h: *const clap_host, w: u32, hh: u32) -> bool {
    match hd(h).resize.try_lock() {
        Ok(g) => g.as_ref().is_some_and(|f| f(w, hh)),
        Err(_) => false,
    }
}
unsafe extern "C" fn g_show(_h: *const clap_host) -> bool {
    true
}
unsafe extern "C" fn g_hide(_h: *const clap_host) -> bool {
    false
}
unsafe extern "C" fn g_closed(_h: *const clap_host, _destroyed: bool) {}
static GUI: clap_host_gui = clap_host_gui {
    resize_hints_changed: Some(g_hints),
    request_resize: Some(g_request_resize),
    request_show: Some(g_show),
    request_hide: Some(g_hide),
    closed: Some(g_closed),
};

unsafe extern "C" fn l_changed(h: *const clap_host) {
    hd(h).latency_changed.store(true, Ordering::SeqCst);
}
static LATENCY: clap_host_latency = clap_host_latency { changed: Some(l_changed) };

unsafe extern "C" fn ap_supported(_h: *const clap_host, _f: u32) -> bool {
    false
}
unsafe extern "C" fn ap_rescan(h: *const clap_host, _f: u32) {
    hd(h).restart.store(true, Ordering::SeqCst);
}
static PORTS: clap_host_audio_ports = clap_host_audio_ports { is_rescan_flag_supported: Some(ap_supported), rescan: Some(ap_rescan) };

unsafe extern "C" fn t_register(h: *const clap_host, period: u32, id: *mut clap_id) -> bool {
    let d = hd(h);
    let n = d.next_timer.get();
    d.next_timer.set(n + 1);
    if let Ok(mut t) = d.timers.lock() {
        t.push((n, period.max(10), std::time::Instant::now()));
    }
    if !id.is_null() {
        *id = n;
    }
    true
}
unsafe extern "C" fn t_unregister(h: *const clap_host, id: clap_id) -> bool {
    if let Ok(mut t) = hd(h).timers.lock() {
        t.retain(|x| x.0 != id);
    }
    true
}
static TIMERS: clap_host_timer_support = clap_host_timer_support { register_timer: Some(t_register), unregister_timer: Some(t_unregister) };

// ---------------------------------------------------------------------------
// Списки событий
// ---------------------------------------------------------------------------
struct InEvents {
    list: Vec<clap_event_param_value>,
}

unsafe extern "C" fn in_size(l: *const clap_input_events) -> u32 {
    (*((*l).ctx as *const InEvents)).list.len() as u32
}
unsafe extern "C" fn in_get(l: *const clap_input_events, i: u32) -> *const clap_event_header {
    let e = &*((*l).ctx as *const InEvents);
    e.list.get(i as usize).map(|x| &x.header as *const _).unwrap_or(std::ptr::null())
}

struct OutEvents {
    dirty: bool,
}

unsafe extern "C" fn out_push(l: *const clap_output_events, ev: *const clap_event_header) -> bool {
    if !ev.is_null() && (*ev).space_id == CLAP_CORE_EVENT_SPACE_ID {
        let t = (*ev).type_;
        if t == CLAP_EVENT_PARAM_VALUE || t == CLAP_EVENT_PARAM_GESTURE_END {
            (*((*l).ctx as *mut OutEvents)).dirty = true;
        }
    }
    true
}

fn param_event(id: clap_id, value: f64) -> clap_event_param_value {
    clap_event_param_value {
        header: clap_event_header {
            size: std::mem::size_of::<clap_event_param_value>() as u32,
            time: 0,
            space_id: CLAP_CORE_EVENT_SPACE_ID,
            type_: CLAP_EVENT_PARAM_VALUE,
            flags: 0,
        },
        param_id: id,
        cookie: std::ptr::null_mut(),
        note_id: -1,
        port_index: -1,
        channel: -1,
        key: -1,
        value,
    }
}

// ---------------------------------------------------------------------------
// Потоки состояния
// ---------------------------------------------------------------------------
unsafe extern "C" fn os_write(s: *const clap_ostream, buf: *const c_void, size: u64) -> i64 {
    let v = &mut *((*s).ctx as *mut Vec<u8>);
    if size > 0 && !buf.is_null() {
        v.extend_from_slice(std::slice::from_raw_parts(buf as *const u8, size as usize));
    }
    size as i64
}

struct ReadState<'a> {
    data: &'a [u8],
    pos: usize,
}

unsafe extern "C" fn is_read(s: *const clap_istream, buf: *mut c_void, size: u64) -> i64 {
    let r = &mut *((*s).ctx as *mut ReadState);
    let n = (size as usize).min(r.data.len() - r.pos);
    if n > 0 && !buf.is_null() {
        std::ptr::copy_nonoverlapping(r.data.as_ptr().add(r.pos), buf as *mut u8, n);
    }
    r.pos += n;
    n as i64
}

// ---------------------------------------------------------------------------
// Экземпляр
// ---------------------------------------------------------------------------
#[derive(Clone, Copy)]
struct PInfo {
    id: clap_id,
    min: f64,
    max: f64,
}

pub struct Instance {
    plugin: *const clap_plugin,
    host: Box<clap_host>,
    data: Box<HostData>,
    params_ext: *const clap_plugin_params,
    state_ext: *const clap_plugin_state,
    gui_ext: *const clap_plugin_gui,
    latency_ext: *const clap_plugin_latency,
    infos: RefCell<Vec<PInfo>>,
    pending: Mutex<Vec<clap_event_param_value>>,
    ins: Vec<Bus>,
    outs: Vec<Bus>,
    max: usize,
    active: bool,
    processing: bool,
    gui_open: bool,
    steady: i64,
    playing: bool,
    pos: i64,
    latency: u32,
}

impl Instance {
    pub fn new(m: &Module, uid: &str, offline: bool, max_block: usize) -> Result<Instance, String> {
        let id = uid.strip_prefix(PREFIX).ok_or("bad CLAP uid")?;
        let cid = CString::new(id).map_err(|_| "bad CLAP uid")?;
        let data = Box::new(HostData {
            main: std::thread::current().id(),
            callback: AtomicBool::new(false),
            restart: AtomicBool::new(false),
            flush: AtomicBool::new(false),
            dirty: AtomicBool::new(false),
            latency_changed: AtomicBool::new(false),
            resize: Mutex::new(None),
            timers: Mutex::new(vec![]),
            next_timer: Cell::new(1),
        });
        let host = Box::new(clap_host {
            clap_version: CLAP_VERSION,
            host_data: &*data as *const HostData as *mut c_void,
            name: c"FF Montage".as_ptr(),
            vendor: c"FF Montage".as_ptr(),
            url: c"https://github.com/".as_ptr(),
            version: c"0.4.0".as_ptr(),
            get_extension: Some(h_get_extension),
            request_restart: Some(h_request_restart),
            request_process: Some(h_request_process),
            request_callback: Some(h_request_callback),
        });
        unsafe {
            let f = &*m.factory;
            let create = f.create_plugin.ok_or("no create_plugin")?;
            let plugin = create(m.factory, &*host, cid.as_ptr());
            if plugin.is_null() {
                return Err("create_plugin failed".into());
            }
            let p = &*plugin;
            if !p.init.is_some_and(|i| i(plugin)) {
                if let Some(d) = p.destroy {
                    d(plugin);
                }
                return Err("clap_plugin.init failed".into());
            }
            let ext = |id: &CStr| p.get_extension.map(|g| g(plugin, id.as_ptr())).unwrap_or(std::ptr::null());
            let ports = ext(CLAP_EXT_AUDIO_PORTS) as *const clap_plugin_audio_ports;
            let count_ch = |input: bool| -> Vec<usize> {
                if ports.is_null() {
                    return vec![2]; // без audio-ports — одна стерео-шина
                }
                let pp = &*ports;
                let n = pp.count.map(|c| c(plugin, input)).unwrap_or(0);
                (0..n)
                    .map(|i| {
                        let mut info: clap_audio_port_info = std::mem::zeroed();
                        if pp.get.is_some_and(|g| g(plugin, i, input, &mut info)) {
                            info.channel_count as usize
                        } else {
                            2
                        }
                    })
                    .collect()
            };
            let ins = count_ch(true);
            let outs = count_ch(false);
            if outs.is_empty() {
                if let Some(d) = p.destroy {
                    d(plugin);
                }
                return Err("plugin has no audio outputs".into());
            }
            let render = ext(CLAP_EXT_RENDER) as *const clap_plugin_render;
            if offline && !render.is_null() {
                if let Some(s) = (*render).set {
                    s(plugin, CLAP_RENDER_OFFLINE);
                }
            }
            Ok(Instance {
                plugin,
                params_ext: ext(CLAP_EXT_PARAMS) as *const clap_plugin_params,
                state_ext: ext(CLAP_EXT_STATE) as *const clap_plugin_state,
                gui_ext: ext(CLAP_EXT_GUI) as *const clap_plugin_gui,
                latency_ext: ext(CLAP_EXT_LATENCY) as *const clap_plugin_latency,
                host,
                data,
                infos: RefCell::new(vec![]),
                pending: Mutex::new(vec![]),
                ins: ins.iter().map(|&c| Bus::new(c, max_block)).collect(),
                outs: outs.iter().map(|&c| Bus::new(c, max_block)).collect(),
                max: max_block,
                active: false,
                processing: false,
                gui_open: false,
                steady: 0,
                playing: false,
                pos: 0,
                latency: 0,
            })
        }
    }

    fn infos(&self) -> Vec<PInfo> {
        if self.infos.borrow().is_empty() && !self.params_ext.is_null() {
            let mut v = vec![];
            unsafe {
                let pe = &*self.params_ext;
                let n = pe.count.map(|c| c(self.plugin)).unwrap_or(0);
                for i in 0..n {
                    let mut info: clap_param_info = std::mem::zeroed();
                    if pe.get_info.is_some_and(|g| g(self.plugin, i, &mut info)) {
                        v.push(PInfo { id: info.id, min: info.min_value, max: info.max_value });
                    }
                }
            }
            *self.infos.borrow_mut() = v;
        }
        self.infos.borrow().clone()
    }

    fn norm(i: &PInfo, v: f64) -> f64 {
        if i.max > i.min {
            ((v - i.min) / (i.max - i.min)).clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    fn take_events(&self) -> InEvents {
        InEvents { list: self.pending.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default() }
    }

    /// Параметры без обработки звука (плагин не обрабатывает или стоит на паузе)
    fn flush(&mut self) {
        if self.params_ext.is_null() {
            return;
        }
        let mut ev = self.take_events();
        let mut out = OutEvents { dirty: false };
        let inl = clap_input_events { ctx: &mut ev as *mut InEvents as *mut c_void, size: Some(in_size), get: Some(in_get) };
        let outl = clap_output_events { ctx: &mut out as *mut OutEvents as *mut c_void, try_push: Some(out_push) };
        unsafe {
            if let Some(f) = (*self.params_ext).flush {
                IN_AUDIO.with(|c| c.set(self.processing));
                f(self.plugin, &inl, &outl);
                IN_AUDIO.with(|c| c.set(false));
            }
        }
        if out.dirty || !ev.list.is_empty() {
            self.data.dirty.store(true, Ordering::SeqCst);
        }
    }
}

impl Fx for Instance {
    fn activate(&mut self) -> Result<(), String> {
        unsafe {
            let p = &*self.plugin;
            if !p.activate.is_some_and(|a| a(self.plugin, SR, 1, self.max as u32)) {
                return Err("clap activate failed".into());
            }
            self.active = true;
            if !self.latency_ext.is_null() {
                self.latency = (*self.latency_ext).get.map(|g| g(self.plugin)).unwrap_or(0);
            }
        }
        Ok(())
    }

    fn latency(&self) -> u32 {
        self.latency
    }

    fn set_state(&mut self, comp: &[u8], _ctrl: &[u8]) {
        if comp.is_empty() || self.state_ext.is_null() {
            return;
        }
        let mut rs = ReadState { data: comp, pos: 0 };
        let s = clap_istream { ctx: &mut rs as *mut ReadState as *mut c_void, read: Some(is_read) };
        unsafe {
            if let Some(l) = (*self.state_ext).load {
                l(self.plugin, &s);
            }
        }
        self.infos.borrow_mut().clear();
    }

    fn get_state(&mut self) -> (Vec<u8>, Vec<u8>) {
        let mut v: Vec<u8> = vec![];
        if !self.state_ext.is_null() {
            let s = clap_ostream { ctx: &mut v as *mut Vec<u8> as *mut c_void, write: Some(os_write) };
            unsafe {
                if let Some(f) = (*self.state_ext).save {
                    f(self.plugin, &s);
                }
            }
        }
        (v, vec![])
    }

    fn set_params(&mut self, p: &[(u32, f64)]) {
        let infos = self.infos();
        if let Ok(mut q) = self.pending.lock() {
            for &(id, v) in p {
                if let Some(i) = infos.iter().find(|x| x.id == id) {
                    q.retain(|e| e.param_id != id);
                    q.push(param_event(id, i.min + v.clamp(0.0, 1.0) * (i.max - i.min)));
                }
            }
        }
        if !self.active {
            self.flush();
        }
        self.data.dirty.store(true, Ordering::SeqCst);
    }

    fn params(&mut self) -> Vec<ParamInfo> {
        let mut out = vec![];
        if self.params_ext.is_null() {
            return out;
        }
        unsafe {
            let pe = &*self.params_ext;
            let n = pe.count.map(|c| c(self.plugin)).unwrap_or(0);
            for i in 0..n {
                let mut info: clap_param_info = std::mem::zeroed();
                if !pe.get_info.is_some_and(|g| g(self.plugin, i, &mut info)) {
                    continue;
                }
                let mut v = info.default_value;
                if let Some(g) = pe.get_value {
                    g(self.plugin, info.id, &mut v);
                }
                let mut buf = [0 as c_char; 128];
                let display = if pe.value_to_text.is_some_and(|f| f(self.plugin, info.id, v, buf.as_mut_ptr(), buf.len() as u32)) {
                    cstr(buf.as_ptr())
                } else {
                    String::new()
                };
                let pi = PInfo { id: info.id, min: info.min_value, max: info.max_value };
                let stepped = info.flags & CLAP_PARAM_IS_STEPPED != 0;
                out.push(ParamInfo {
                    id: info.id,
                    title: cstr(info.name.as_ptr()),
                    units: String::new(),
                    def: Self::norm(&pi, info.default_value),
                    value: Self::norm(&pi, v),
                    steps: if stepped { (info.max_value - info.min_value).round().max(0.0) as i32 } else { 0 },
                    display,
                    read_only: info.flags & CLAP_PARAM_IS_READONLY != 0,
                    hidden: info.flags & CLAP_PARAM_IS_HIDDEN != 0,
                    bypass: info.flags & CLAP_PARAM_IS_BYPASS != 0,
                });
            }
        }
        out
    }

    fn process(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32], n: usize) {
        let n = n.min(self.max);
        if n == 0 {
            self.flush();
            return;
        }
        unsafe {
            IN_AUDIO.with(|c| c.set(true));
            if !self.processing {
                self.processing = (*self.plugin).start_processing.map(|s| s(self.plugin)).unwrap_or(true);
            }
            if let Some(b) = self.ins.first_mut() {
                b.fill_from(in_l, in_r, n);
            }
            for b in self.ins.iter_mut().skip(1) {
                b.silence(n);
            }
            let mut ev = self.take_events();
            let mut out = OutEvents { dirty: false };
            let inl = clap_input_events { ctx: &mut ev as *mut InEvents as *mut c_void, size: Some(in_size), get: Some(in_get) };
            let outl = clap_output_events { ctx: &mut out as *mut OutEvents as *mut c_void, try_push: Some(out_push) };
            let bufs = |b: &mut Bus| clap_audio_buffer {
                data32: if b.ptrs.is_empty() { std::ptr::null_mut() } else { b.ptrs.as_mut_ptr() },
                data64: std::ptr::null_mut(),
                channel_count: b.ptrs.len() as u32,
                latency: 0,
                constant_mask: 0,
            };
            let ins: Vec<clap_audio_buffer> = self.ins.iter_mut().map(bufs).collect();
            let mut outs: Vec<clap_audio_buffer> = self.outs.iter_mut().map(bufs).collect();
            let secs = self.pos as f64 / SR;
            let mut flags = CLAP_TRANSPORT_HAS_TEMPO | CLAP_TRANSPORT_HAS_SECONDS_TIMELINE | CLAP_TRANSPORT_HAS_BEATS_TIMELINE;
            if self.playing {
                flags |= CLAP_TRANSPORT_IS_PLAYING;
            }
            let transport = clap_event_transport {
                header: clap_event_header {
                    size: std::mem::size_of::<clap_event_transport>() as u32,
                    time: 0,
                    space_id: CLAP_CORE_EVENT_SPACE_ID,
                    type_: CLAP_EVENT_TRANSPORT,
                    flags: 0,
                },
                flags,
                song_pos_beats: (secs * 2.0 * (1i64 << 31) as f64) as i64,
                song_pos_seconds: (secs * (1i64 << 31) as f64) as i64,
                tempo: 120.0,
                tempo_inc: 0.0,
                loop_start_beats: 0,
                loop_end_beats: 0,
                loop_start_seconds: 0,
                loop_end_seconds: 0,
                bar_start: 0,
                bar_number: 0,
                tsig_num: 4,
                tsig_denom: 4,
            };
            let pr = clap_process {
                steady_time: self.steady,
                frames_count: n as u32,
                transport: &transport,
                audio_inputs: if ins.is_empty() { std::ptr::null() } else { ins.as_ptr() },
                audio_outputs: outs.as_mut_ptr(),
                audio_inputs_count: ins.len() as u32,
                audio_outputs_count: outs.len() as u32,
                in_events: &inl,
                out_events: &outl,
            };
            if let Some(f) = (*self.plugin).process {
                f(self.plugin, &pr);
            }
            IN_AUDIO.with(|c| c.set(false));
            self.steady += n as i64;
            self.pos += n as i64;
            self.outs[0].copy_to(out_l, out_r, n);
            if out.dirty {
                self.data.dirty.store(true, Ordering::SeqCst);
            }
        }
    }

    fn set_playing(&mut self, playing: bool, pos: i64) {
        self.playing = playing;
        self.pos = pos;
    }

    fn take_dirty(&self) -> bool {
        self.data.dirty.swap(false, Ordering::SeqCst)
    }

    fn idle(&mut self) {
        unsafe {
            if self.data.callback.swap(false, Ordering::SeqCst) {
                if let Some(f) = (*self.plugin).on_main_thread {
                    f(self.plugin);
                }
            }
            if self.data.latency_changed.swap(false, Ordering::SeqCst) && !self.latency_ext.is_null() {
                self.latency = (*self.latency_ext).get.map(|g| g(self.plugin)).unwrap_or(0);
            }
            // Таймеры окна плагина
            let due: Vec<clap_id> = match self.data.timers.lock() {
                Ok(mut t) => {
                    let now = std::time::Instant::now();
                    t.iter_mut()
                        .filter(|x| now.duration_since(x.2).as_millis() as u32 >= x.1)
                        .map(|x| {
                            x.2 = now;
                            x.0
                        })
                        .collect()
                }
                Err(_) => vec![],
            };
            if !due.is_empty() {
                let ts = (*self.plugin).get_extension.map(|g| g(self.plugin, CLAP_EXT_TIMER_SUPPORT.as_ptr())).unwrap_or(std::ptr::null())
                    as *const clap_plugin_timer_support;
                if !ts.is_null() {
                    if let Some(f) = (*ts).on_timer {
                        for id in due {
                            f(self.plugin, id);
                        }
                    }
                }
            }
        }
        if self.data.flush.swap(false, Ordering::SeqCst) && !self.processing {
            self.flush();
        }
    }

    fn has_editor(&mut self) -> bool {
        !self.gui_ext.is_null()
            && unsafe { (*self.gui_ext).is_api_supported.is_some_and(|f| f(self.plugin, CLAP_WINDOW_API_WIN32.as_ptr(), false)) }
    }

    fn editor_open(&mut self, parent: isize, resize: ResizeFn) -> Option<(u32, u32, bool)> {
        if !self.has_editor() {
            return None;
        }
        unsafe {
            let g = &*self.gui_ext;
            if !g.create.is_some_and(|c| c(self.plugin, CLAP_WINDOW_API_WIN32.as_ptr(), false)) {
                return None;
            }
            self.gui_open = true;
            if let Ok(mut r) = self.data.resize.lock() {
                *r = Some(resize);
            }
            let (mut w, mut h) = (0u32, 0u32);
            if let Some(f) = g.get_size {
                f(self.plugin, &mut w, &mut h);
            }
            let win = clap_window { api: CLAP_WINDOW_API_WIN32.as_ptr(), specific: clap_window_handle { win32: parent as *mut c_void } };
            if !g.set_parent.is_some_and(|f| f(self.plugin, &win)) {
                self.editor_close();
                return None;
            }
            if let Some(f) = g.show {
                f(self.plugin);
            }
            let can = g.can_resize.is_some_and(|f| f(self.plugin));
            Some((w.max(100), h.max(60), can))
        }
    }

    fn editor_set_size(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        if !self.gui_open {
            return None;
        }
        unsafe {
            let g = &*self.gui_ext;
            if !g.can_resize.is_some_and(|f| f(self.plugin)) {
                return None;
            }
            let (mut w, mut h) = (w, h);
            if let Some(f) = g.adjust_size {
                f(self.plugin, &mut w, &mut h);
            }
            if let Some(f) = g.set_size {
                f(self.plugin, w, h);
            }
            Some((w, h))
        }
    }

    fn editor_close(&mut self) {
        if self.gui_open {
            unsafe {
                if let Some(f) = (*self.gui_ext).destroy {
                    f(self.plugin);
                }
            }
            self.gui_open = false;
        }
        if let Ok(mut r) = self.data.resize.lock() {
            *r = None;
        }
    }

    fn shutdown(&mut self) {
        self.editor_close();
        unsafe {
            let p = &*self.plugin;
            if self.processing {
                if let Some(f) = p.stop_processing {
                    f(self.plugin);
                }
                self.processing = false;
            }
            if self.active {
                if let Some(f) = p.deactivate {
                    f(self.plugin);
                }
                self.active = false;
            }
            if let Some(f) = p.destroy {
                f(self.plugin);
            }
        }
        let _ = &self.host;
    }
}
