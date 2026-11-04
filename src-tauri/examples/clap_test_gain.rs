// Тестовый CLAP-плагин «усиление» для автотестов (tests/vst-test.js): один параметр Gain (id 0, 0..2, по умолчанию 1),
// состояние — значение усиления (f64). Сборка: cargo build --release --example clap_test_gain → переименовать .dll в .clap
#![allow(non_upper_case_globals)]

use clap_sys::entry::clap_plugin_entry;
use clap_sys::events::*;
use clap_sys::ext::audio_ports::*;
use clap_sys::ext::params::*;
use clap_sys::ext::state::*;
use clap_sys::factory::plugin_factory::*;
use clap_sys::host::clap_host;
use clap_sys::id::clap_id;
use clap_sys::plugin::*;
use clap_sys::process::*;
use clap_sys::stream::*;
use clap_sys::version::CLAP_VERSION;
use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicU64, Ordering};

struct Gain {
    plugin: clap_plugin,
    gain: AtomicU64,
}

fn g(p: *const clap_plugin) -> &'static Gain {
    unsafe { &*((*p).plugin_data as *const Gain) }
}

fn gain_of(p: *const clap_plugin) -> f64 {
    f64::from_bits(g(p).gain.load(Ordering::Relaxed))
}

fn set_gain(p: *const clap_plugin, v: f64) {
    g(p).gain.store(v.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
}

unsafe fn apply_events(p: *const clap_plugin, ev: *const clap_input_events) {
    if ev.is_null() {
        return;
    }
    let n = (*ev).size.map(|f| f(ev)).unwrap_or(0);
    for i in 0..n {
        let h = (*ev).get.map(|f| f(ev, i)).unwrap_or(std::ptr::null());
        if !h.is_null() && (*h).space_id == CLAP_CORE_EVENT_SPACE_ID && (*h).type_ == CLAP_EVENT_PARAM_VALUE {
            let e = &*(h as *const clap_event_param_value);
            if e.param_id == 0 {
                set_gain(p, e.value);
            }
        }
    }
}

unsafe extern "C" fn init(_p: *const clap_plugin) -> bool {
    true
}
unsafe extern "C" fn destroy(p: *const clap_plugin) {
    drop(Box::from_raw((*p).plugin_data as *mut Gain));
}
unsafe extern "C" fn activate(_p: *const clap_plugin, _sr: f64, _min: u32, _max: u32) -> bool {
    true
}
unsafe extern "C" fn deactivate(_p: *const clap_plugin) {}
unsafe extern "C" fn start(_p: *const clap_plugin) -> bool {
    true
}
unsafe extern "C" fn stop(_p: *const clap_plugin) {}
unsafe extern "C" fn reset(_p: *const clap_plugin) {}
unsafe extern "C" fn process(p: *const clap_plugin, pr: *const clap_process) -> clap_process_status {
    let pr = &*pr;
    apply_events(p, pr.in_events);
    let k = gain_of(p) as f32;
    if pr.audio_inputs_count < 1 || pr.audio_outputs_count < 1 {
        return CLAP_PROCESS_CONTINUE;
    }
    let i = &*pr.audio_inputs;
    let o = &*pr.audio_outputs;
    for ch in 0..i.channel_count.min(o.channel_count) as usize {
        let a = *i.data32.add(ch);
        let b = *o.data32.add(ch);
        for s in 0..pr.frames_count as usize {
            *b.add(s) = *a.add(s) * k;
        }
    }
    CLAP_PROCESS_CONTINUE
}
unsafe extern "C" fn on_main(_p: *const clap_plugin) {}

// --- audio-ports: стерео вход и выход ---
unsafe extern "C" fn ports_count(_p: *const clap_plugin, _input: bool) -> u32 {
    1
}
unsafe extern "C" fn ports_get(_p: *const clap_plugin, index: u32, input: bool, info: *mut clap_audio_port_info) -> bool {
    if index != 0 {
        return false;
    }
    let info = &mut *info;
    info.id = if input { 0 } else { 1 };
    info.name = [0; 256];
    for (d, s) in info.name.iter_mut().zip(b"Main") {
        *d = *s as c_char;
    }
    info.flags = CLAP_AUDIO_PORT_IS_MAIN;
    info.channel_count = 2;
    info.port_type = CLAP_PORT_STEREO.as_ptr();
    info.in_place_pair = clap_sys::id::CLAP_INVALID_ID;
    true
}
static PORTS: clap_plugin_audio_ports = clap_plugin_audio_ports { count: Some(ports_count), get: Some(ports_get) };

// --- params ---
unsafe extern "C" fn p_count(_p: *const clap_plugin) -> u32 {
    1
}
unsafe extern "C" fn p_info(_p: *const clap_plugin, i: u32, info: *mut clap_param_info) -> bool {
    if i != 0 {
        return false;
    }
    let info = &mut *info;
    info.id = 0;
    info.flags = CLAP_PARAM_IS_AUTOMATABLE;
    info.cookie = std::ptr::null_mut();
    info.name = [0; 256];
    for (d, s) in info.name.iter_mut().zip(b"Gain") {
        *d = *s as c_char;
    }
    info.module = [0; 1024];
    info.min_value = 0.0;
    info.max_value = 2.0;
    info.default_value = 1.0;
    true
}
unsafe extern "C" fn p_value(p: *const clap_plugin, id: clap_id, out: *mut f64) -> bool {
    if id != 0 {
        return false;
    }
    *out = gain_of(p);
    true
}
unsafe extern "C" fn p_to_text(_p: *const clap_plugin, _id: clap_id, v: f64, buf: *mut c_char, cap: u32) -> bool {
    let s = format!("{v:.3}\0");
    for (i, b) in s.bytes().take(cap as usize).enumerate() {
        *buf.add(i) = b as c_char;
    }
    true
}
unsafe extern "C" fn p_from_text(_p: *const clap_plugin, _id: clap_id, t: *const c_char, out: *mut f64) -> bool {
    match CStr::from_ptr(t).to_string_lossy().trim().parse::<f64>() {
        Ok(v) => {
            *out = v;
            true
        }
        Err(_) => false,
    }
}
unsafe extern "C" fn p_flush(p: *const clap_plugin, i: *const clap_input_events, _o: *const clap_output_events) {
    apply_events(p, i);
}
static PARAMS: clap_plugin_params = clap_plugin_params {
    count: Some(p_count),
    get_info: Some(p_info),
    get_value: Some(p_value),
    value_to_text: Some(p_to_text),
    text_to_value: Some(p_from_text),
    flush: Some(p_flush),
};

// --- state ---
unsafe extern "C" fn s_save(p: *const clap_plugin, s: *const clap_ostream) -> bool {
    let b = gain_of(p).to_le_bytes();
    (*s).write.map(|w| w(s, b.as_ptr() as *const c_void, 8)).unwrap_or(-1) == 8
}
unsafe extern "C" fn s_load(p: *const clap_plugin, s: *const clap_istream) -> bool {
    let mut b = [0u8; 8];
    if (*s).read.map(|r| r(s, b.as_mut_ptr() as *mut c_void, 8)).unwrap_or(-1) == 8 {
        set_gain(p, f64::from_le_bytes(b));
        true
    } else {
        false
    }
}
static STATE: clap_plugin_state = clap_plugin_state { save: Some(s_save), load: Some(s_load) };

unsafe extern "C" fn get_extension(_p: *const clap_plugin, id: *const c_char) -> *const c_void {
    let id = CStr::from_ptr(id);
    if id == CLAP_EXT_AUDIO_PORTS {
        &PORTS as *const _ as *const c_void
    } else if id == CLAP_EXT_PARAMS {
        &PARAMS as *const _ as *const c_void
    } else if id == CLAP_EXT_STATE {
        &STATE as *const _ as *const c_void
    } else {
        std::ptr::null()
    }
}

struct Desc(clap_plugin_descriptor);
unsafe impl Sync for Desc {}
struct Feats([*const c_char; 3]);
unsafe impl Sync for Feats {}
static FEATURES: Feats = Feats([c"audio-effect".as_ptr(), c"utility".as_ptr(), std::ptr::null()]);
static DESC: Desc = Desc(clap_plugin_descriptor {
    clap_version: CLAP_VERSION,
    id: c"ffmontage.test.gain".as_ptr(),
    name: c"FFM Test Gain (CLAP)".as_ptr(),
    vendor: c"FF Montage Tests".as_ptr(),
    url: c"".as_ptr(),
    manual_url: c"".as_ptr(),
    support_url: c"".as_ptr(),
    version: c"1.0.0".as_ptr(),
    description: c"Gain for tests".as_ptr(),
    features: FEATURES.0.as_ptr(),
});

unsafe extern "C" fn f_count(_f: *const clap_plugin_factory) -> u32 {
    1
}
unsafe extern "C" fn f_desc(_f: *const clap_plugin_factory, i: u32) -> *const clap_plugin_descriptor {
    if i == 0 {
        &DESC.0
    } else {
        std::ptr::null()
    }
}
unsafe extern "C" fn f_create(_f: *const clap_plugin_factory, _host: *const clap_host, id: *const c_char) -> *const clap_plugin {
    if CStr::from_ptr(id) != CStr::from_ptr(DESC.0.id) {
        return std::ptr::null();
    }
    let b = Box::into_raw(Box::new(Gain {
        plugin: clap_plugin {
            desc: &DESC.0,
            plugin_data: std::ptr::null_mut(),
            init: Some(init),
            destroy: Some(destroy),
            activate: Some(activate),
            deactivate: Some(deactivate),
            start_processing: Some(start),
            stop_processing: Some(stop),
            reset: Some(reset),
            process: Some(process),
            get_extension: Some(get_extension),
            on_main_thread: Some(on_main),
        },
        gain: AtomicU64::new(1.0f64.to_bits()),
    }));
    (*b).plugin.plugin_data = b as *mut c_void;
    &(*b).plugin
}
static FACTORY: clap_plugin_factory =
    clap_plugin_factory { get_plugin_count: Some(f_count), get_plugin_descriptor: Some(f_desc), create_plugin: Some(f_create) };

unsafe extern "C" fn e_init(_path: *const c_char) -> bool {
    true
}
unsafe extern "C" fn e_deinit() {}
unsafe extern "C" fn e_factory(id: *const c_char) -> *const c_void {
    if CStr::from_ptr(id) == CLAP_PLUGIN_FACTORY_ID {
        &FACTORY as *const _ as *const c_void
    } else {
        std::ptr::null()
    }
}

#[no_mangle]
#[used]
pub static clap_entry: clap_plugin_entry =
    clap_plugin_entry { clap_version: CLAP_VERSION, init: Some(e_init), deinit: Some(e_deinit), get_factory: Some(e_factory) };
