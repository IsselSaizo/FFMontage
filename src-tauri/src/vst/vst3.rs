// VST3: загрузка модуля (.vst3 — файл-DLL или папка-пакет Contents/x86_64-win/*.vst3) и экземпляр плагина:
// компонент + процессор + контроллер (общий объект или отдельный класс, связанные через IConnectionPoint),
// шины, состояние, параметры, окно (IPlugView) и обработка блоков f32. Только в процессе хоста (host.rs).
#![allow(non_snake_case)]

use super::com::*;
use super::fx::{ClassInfo, Fx, ParamInfo, ResizeFn, SR};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{ComPtr, ComRef, ComWrapper, Interface};

use windows::core::PCWSTR;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};

pub fn hex_uid(t: &TUID) -> String {
    t.iter().map(|b| format!("{:02X}", *b as u8)).collect()
}

pub fn parse_uid(s: &str) -> Option<TUID> {
    let s = s.trim();
    if s.len() != 32 {
        return None;
    }
    let mut t: TUID = [0; 16];
    for (i, v) in t.iter_mut().enumerate() {
        *v = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()? as _;
    }
    Some(t)
}

/// Путь к самой DLL: файл .vst3 или пакет <name>.vst3/Contents/x86_64-win/<name>.vst3
pub fn binary_of(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    let dir = path.join("Contents").join(if cfg!(target_arch = "aarch64") { "arm64-win" } else { "x86_64-win" });
    let name = path.file_name()?;
    let p = dir.join(name);
    if p.is_file() {
        return Some(p);
    }
    std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("vst3")))
}

pub fn load_library(bin: &Path) -> Result<HMODULE, String> {
    let w: Vec<u16> = bin.as_os_str().to_string_lossy().encode_utf16().chain([0]).collect();
    unsafe {
        LoadLibraryExW(PCWSTR(w.as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH).map_err(|e| format!("LoadLibrary {}: {e}", bin.display()))
    }
}

pub struct Module {
    _lib: HMODULE,
    exit: Option<unsafe extern "system" fn() -> bool>,
    pub factory: ComPtr<IPluginFactory>,
}

impl Module {
    pub fn load(path: &Path) -> Result<Module, String> {
        let bin = binary_of(path).ok_or_else(|| format!("no plugin binary in {}", path.display()))?;
        unsafe {
            let lib = load_library(&bin)?;
            let init = GetProcAddress(lib, windows::core::s!("InitDll"));
            let exit = GetProcAddress(lib, windows::core::s!("ExitDll"));
            let get = GetProcAddress(lib, windows::core::s!("GetPluginFactory")).ok_or("GetPluginFactory not exported")?;
            if let Some(init) = init {
                let init: unsafe extern "system" fn() -> bool = std::mem::transmute(init);
                if !init() {
                    return Err("InitDll failed".into());
                }
            }
            let get: unsafe extern "system" fn() -> *mut IPluginFactory = std::mem::transmute(get);
            let factory = ComPtr::from_raw(get()).ok_or("GetPluginFactory returned null")?;
            let exit = exit.map(|f| std::mem::transmute::<unsafe extern "system" fn() -> isize, unsafe extern "system" fn() -> bool>(f));
            Ok(Module { _lib: lib, exit, factory })
        }
    }

    /// Классы «Audio Module Class» (эффекты и инструменты)
    pub fn classes(&self) -> Vec<ClassInfo> {
        let mut out = vec![];
        unsafe {
            let mut fi: PFactoryInfo = std::mem::zeroed();
            let fvendor = if self.factory.getFactoryInfo(&mut fi) == kResultOk { str8(&fi.vendor) } else { String::new() };
            let f2 = self.factory.cast::<IPluginFactory2>();
            for i in 0..self.factory.countClasses() {
                let mut c: PClassInfo = std::mem::zeroed();
                if self.factory.getClassInfo(i, &mut c) != kResultOk {
                    continue;
                }
                let category = str8(&c.category);
                if category != "Audio Module Class" {
                    continue;
                }
                let mut info = ClassInfo {
                    format: "vst3",
                    uid: hex_uid(&c.cid),
                    name: str8(&c.name),
                    vendor: fvendor.clone(),
                    version: String::new(),
                    category,
                    sub: String::new(),
                    sdk: String::new(),
                    instrument: false,
                };
                if let Some(f2) = &f2 {
                    let mut c2: PClassInfo2 = std::mem::zeroed();
                    if f2.getClassInfo2(i, &mut c2) == kResultOk {
                        info.sub = str8(&c2.subCategories);
                        let v = str8(&c2.vendor);
                        if !v.is_empty() {
                            info.vendor = v;
                        }
                        info.version = str8(&c2.version);
                        info.sdk = str8(&c2.sdkVersion);
                    }
                }
                info.instrument = info.sub.split('|').any(|s| s == "Instrument") && !info.sub.split('|').any(|s| s == "Fx");
                out.push(info);
            }
        }
        out
    }

    /// ExitDll — перед выходом процесса (FreeLibrary не зовём: процесс всё равно завершается)
    pub fn exit(&self) {
        if let Some(f) = self.exit {
            unsafe {
                f();
            }
        }
    }
}

pub struct Bus {
    /// Каналы шины (буферы по maxBlock)
    pub bufs: Vec<Vec<f32>>,
    pub ptrs: Vec<*mut f32>,
}

impl Bus {
    pub fn new(ch: usize, max: usize) -> Bus {
        let mut bufs: Vec<Vec<f32>> = (0..ch).map(|_| vec![0f32; max]).collect();
        let ptrs = bufs.iter_mut().map(|b| b.as_mut_ptr()).collect();
        Bus { bufs, ptrs }
    }

    /// Стерео-вход → каналы шины (моно — среднее, лишние — тишина)
    pub fn fill_from(&mut self, l: &[f32], r: &[f32], n: usize) {
        match self.bufs.len() {
            0 => {}
            1 => {
                for i in 0..n {
                    self.bufs[0][i] = 0.5 * (l[i] + r[i]);
                }
            }
            _ => {
                self.bufs[0][..n].copy_from_slice(&l[..n]);
                self.bufs[1][..n].copy_from_slice(&r[..n]);
                for ch in self.bufs.iter_mut().skip(2) {
                    ch[..n].fill(0.0);
                }
            }
        }
    }

    pub fn silence(&mut self, n: usize) {
        for ch in self.bufs.iter_mut() {
            ch[..n].fill(0.0);
        }
    }

    /// Каналы шины → стерео-выход (моно — в оба канала)
    pub fn copy_to(&self, l: &mut [f32], r: &mut [f32], n: usize) {
        match self.bufs.len() {
            0 => {
                l[..n].fill(0.0);
                r[..n].fill(0.0);
            }
            1 => {
                l[..n].copy_from_slice(&self.bufs[0][..n]);
                r[..n].copy_from_slice(&self.bufs[0][..n]);
            }
            _ => {
                l[..n].copy_from_slice(&self.bufs[0][..n]);
                r[..n].copy_from_slice(&self.bufs[1][..n]);
            }
        }
        for v in l[..n].iter_mut().chain(r[..n].iter_mut()) {
            if !v.is_finite() {
                *v = 0.0;
            }
        }
    }
}

pub struct Instance {
    component: ComPtr<IComponent>,
    processor: ComPtr<IAudioProcessor>,
    controller: Option<ComPtr<IEditController>>,
    separate: bool,
    conn: Option<(ComPtr<IConnectionPoint>, ComPtr<IConnectionPoint>)>,
    _host: ComWrapper<HostApp>,
    _handler: ComWrapper<Handler>,
    shared: Arc<Shared>,
    ins: Vec<Bus>,
    outs: Vec<Bus>,
    max: usize,
    mode: i32,
    in_changes: ComWrapper<Changes>,
    out_changes: ComWrapper<Changes>,
    events: ComWrapper<Events>,
    ctx: ProcessContext,
    latency: u32,
    active: bool,
    processing: bool,
    view: Option<ComPtr<IPlugView>>,
    frame: Option<ComWrapper<Frame>>,
}

fn channels(arr: SpeakerArrangement) -> usize {
    arr.count_ones() as usize
}

impl Instance {
    pub fn new(module: &Module, uid: &str, offline: bool, max_block: usize) -> Result<Instance, String> {
        let cid = parse_uid(uid).ok_or("bad uid")?;
        let mode = if offline { ProcessModes_::kOffline } else { ProcessModes_::kRealtime };
        unsafe {
            let host = ComWrapper::new(HostApp);
            let host_unk = host.to_com_ptr::<FUnknown>().ok_or("host")?;
            let mut obj: *mut c_void = std::ptr::null_mut();
            let r = module.factory.createInstance(cid.as_ptr(), IComponent::IID.as_ptr() as FIDString, &mut obj);
            let component =
                (r == kResultOk).then(|| ComPtr::from_raw(obj as *mut IComponent)).flatten().ok_or("createInstance(IComponent) failed")?;
            if component.initialize(host_unk.as_ptr()) != kResultOk {
                return Err("IComponent::initialize failed".into());
            }
            let processor = component.cast::<IAudioProcessor>().ok_or("no IAudioProcessor")?;
            // Контроллер: тот же объект или отдельный класс
            let mut separate = false;
            let mut controller = component.cast::<IEditController>();
            if controller.is_none() {
                let mut ccid: TUID = [0; 16];
                if component.getControllerClassId(&mut ccid) == kResultOk && ccid != [0; 16] {
                    let mut o: *mut c_void = std::ptr::null_mut();
                    if module.factory.createInstance(ccid.as_ptr(), IEditController::IID.as_ptr() as FIDString, &mut o) == kResultOk {
                        if let Some(c) = ComPtr::from_raw(o as *mut IEditController) {
                            if c.initialize(host_unk.as_ptr()) == kResultOk {
                                controller = Some(c);
                                separate = true;
                            }
                        }
                    }
                }
            }
            let shared = Arc::new(Shared::default());
            let handler = ComWrapper::new(Handler { shared: shared.clone() });
            let mut conn = None;
            if let Some(c) = &controller {
                if separate {
                    if let (Some(a), Some(b)) = (component.cast::<IConnectionPoint>(), c.cast::<IConnectionPoint>()) {
                        a.connect(b.as_ptr());
                        b.connect(a.as_ptr());
                        conn = Some((a, b));
                    }
                }
                if let Some(h) = handler.to_com_ptr::<IComponentHandler>() {
                    c.setComponentHandler(h.as_ptr());
                }
            }

            // Шины: основная вход/выход — стерео, остальные — как предлагает плагин
            let k_audio = MediaTypes_::kAudio as MediaType;
            let (k_in, k_out) = (BusDirections_::kInput as BusDirection, BusDirections_::kOutput as BusDirection);
            let n_in = component.getBusCount(k_audio, k_in).max(0) as usize;
            let n_out = component.getBusCount(k_audio, k_out).max(0) as usize;
            if n_out == 0 {
                return Err("plugin has no audio outputs".into());
            }
            let cur = |dir, i: usize| {
                let mut a: SpeakerArrangement = 0;
                processor.getBusArrangement(dir, i as i32, &mut a);
                a
            };
            let mut ia: Vec<SpeakerArrangement> = (0..n_in).map(|i| cur(k_in, i)).collect();
            let mut oa: Vec<SpeakerArrangement> = (0..n_out).map(|i| cur(k_out, i)).collect();
            if let Some(a) = ia.first_mut() {
                *a = SpeakerArr::kStereo;
            }
            oa[0] = SpeakerArr::kStereo;
            if processor.setBusArrangements(ia.as_mut_ptr(), n_in as i32, oa.as_mut_ptr(), n_out as i32) != kResultOk {
                // Плагин не согласен на стерео (моно и т.п.) — берём его раскладку, сводим каналы сами
                ia = (0..n_in).map(|i| cur(k_in, i)).collect();
                oa = (0..n_out).map(|i| cur(k_out, i)).collect();
            }
            for i in 0..n_in {
                component.activateBus(k_audio, k_in, i as i32, (i == 0) as TBool);
            }
            for i in 0..n_out {
                component.activateBus(k_audio, k_out, i as i32, (i == 0) as TBool);
            }
            if processor.canProcessSampleSize(SymbolicSampleSizes_::kSample32) != kResultOk {
                return Err("plugin cannot process 32-bit float".into());
            }
            let mut setup = ProcessSetup {
                processMode: mode,
                symbolicSampleSize: SymbolicSampleSizes_::kSample32,
                maxSamplesPerBlock: max_block as i32,
                sampleRate: SR,
            };
            if processor.setupProcessing(&mut setup) != kResultOk {
                return Err("setupProcessing failed".into());
            }
            let mut ctx: ProcessContext = std::mem::zeroed();
            ctx.sampleRate = SR;
            ctx.tempo = 120.0;
            ctx.timeSigNumerator = 4;
            ctx.timeSigDenominator = 4;
            let mut inst = Instance {
                ins: ia.iter().map(|a| Bus::new(channels(*a), max_block)).collect(),
                outs: oa.iter().map(|a| Bus::new(channels(*a), max_block)).collect(),
                component,
                processor,
                controller,
                separate,
                conn,
                _host: host,
                _handler: handler,
                shared,
                max: max_block,
                mode,
                in_changes: Changes::new(),
                out_changes: Changes::new(),
                events: ComWrapper::new(Events),
                ctx,
                latency: 0,
                active: false,
                processing: false,
                view: None,
                frame: None,
            };
            inst.set_playing(false, 0);
            Ok(inst)
        }
    }
}

fn raw<I: Interface>(p: &Option<ComPtr<I>>) -> *mut I {
    p.as_ref().map(|p| p.as_ptr()).unwrap_or(std::ptr::null_mut())
}

impl Fx for Instance {
    fn activate(&mut self) -> Result<(), String> {
        unsafe {
            if self.component.setActive(1) != kResultOk {
                return Err("setActive failed".into());
            }
            self.active = true;
            self.latency = self.processor.getLatencySamples();
            self.processor.setProcessing(1);
            self.processing = true;
        }
        Ok(())
    }

    fn latency(&self) -> u32 {
        self.latency
    }

    /// Состояние компонента и контроллера (из проекта); пустое — не трогаем (настройки по умолчанию)
    fn set_state(&mut self, comp: &[u8], ctrl: &[u8]) {
        unsafe {
            if !comp.is_empty() {
                let s = MemStream::with(comp.to_vec());
                if let Some(p) = s.to_com_ptr::<IBStream>() {
                    self.component.setState(p.as_ptr());
                    if let Some(c) = &self.controller {
                        s.rewind();
                        c.setComponentState(p.as_ptr());
                    }
                }
            }
            if !ctrl.is_empty() {
                if let Some(c) = &self.controller {
                    let s = MemStream::with(ctrl.to_vec());
                    if let Some(p) = s.to_com_ptr::<IBStream>() {
                        c.setState(p.as_ptr());
                    }
                }
            }
        }
    }

    fn get_state(&mut self) -> (Vec<u8>, Vec<u8>) {
        unsafe {
            let a = MemStream::empty();
            if let Some(p) = a.to_com_ptr::<IBStream>() {
                self.component.getState(p.as_ptr());
            }
            let b = MemStream::empty();
            if let (Some(c), Some(p)) = (&self.controller, b.to_com_ptr::<IBStream>()) {
                c.getState(p.as_ptr());
            }
            let x = a.data.borrow().clone();
            let y = b.data.borrow().clone();
            (x, y)
        }
    }

    /// Значения параметров (0..1) — и контроллеру, и процессору (со следующим блоком)
    fn set_params(&mut self, params: &[(u32, f64)]) {
        unsafe {
            if let Some(c) = &self.controller {
                for &(id, v) in params {
                    c.setParamNormalized(id, v.clamp(0.0, 1.0));
                }
            }
        }
        if let Ok(mut e) = self.shared.edits.lock() {
            for &(id, v) in params {
                e.retain(|x| x.0 != id);
                e.push((id, v.clamp(0.0, 1.0)));
            }
        }
        self.shared.dirty.store(true, Ordering::SeqCst);
    }

    fn params(&mut self) -> Vec<ParamInfo> {
        let mut out = vec![];
        let Some(c) = &self.controller else { return out };
        unsafe {
            for i in 0..c.getParameterCount() {
                let mut p: ParameterInfo = std::mem::zeroed();
                if c.getParameterInfo(i, &mut p) != kResultOk {
                    continue;
                }
                let value = c.getParamNormalized(p.id);
                let mut s: String128 = [0; 128];
                let display = if c.getParamStringByValue(p.id, value, &mut s) == kResultOk { str16(&s) } else { String::new() };
                use ParameterInfo_::ParameterFlags_ as F;
                out.push(ParamInfo {
                    id: p.id,
                    title: str16(&p.title),
                    units: str16(&p.units),
                    def: p.defaultNormalizedValue,
                    value,
                    steps: p.stepCount,
                    display,
                    read_only: p.flags & F::kIsReadOnly != 0,
                    hidden: p.flags & F::kIsHidden != 0,
                    bypass: p.flags & F::kIsBypass != 0,
                });
            }
        }
        out
    }

    fn set_playing(&mut self, playing: bool, pos: i64) {
        use ProcessContext_::StatesAndFlags_ as S;
        let base = (S::kTempoValid | S::kTimeSigValid | S::kProjectTimeMusicValid) as u32;
        self.ctx.state = if playing { base | S::kPlaying as u32 } else { base };
        self.ctx.projectTimeSamples = pos;
        self.ctx.projectTimeMusic = pos as f64 / SR * 2.0; // 120 BPM
    }

    fn process(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32], n: usize) {
        let n = n.min(self.max);
        if let Some(b) = self.ins.first_mut() {
            b.fill_from(in_l, in_r, n);
        }
        for b in self.ins.iter_mut().skip(1) {
            b.silence(n);
        }
        // Правки параметров → очередь процессора
        self.in_changes.clear();
        self.out_changes.clear();
        if let Ok(mut e) = self.shared.edits.lock() {
            for (id, v) in e.drain(..) {
                self.in_changes.add(id, 0, v);
            }
        }
        let mut ins: Vec<AudioBusBuffers> = self.ins.iter_mut().map(bus_buffers).collect();
        let mut outs: Vec<AudioBusBuffers> = self.outs.iter_mut().map(bus_buffers).collect();
        let inc = self.in_changes.to_com_ptr::<IParameterChanges>();
        let outc = self.out_changes.to_com_ptr::<IParameterChanges>();
        let ev = self.events.to_com_ptr::<IEventList>();
        let mut data = ProcessData {
            processMode: self.mode,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32,
            numSamples: n as i32,
            numInputs: ins.len() as i32,
            numOutputs: outs.len() as i32,
            inputs: if ins.is_empty() { std::ptr::null_mut() } else { ins.as_mut_ptr() },
            outputs: outs.as_mut_ptr(),
            inputParameterChanges: raw(&inc),
            outputParameterChanges: raw(&outc),
            inputEvents: raw(&ev),
            outputEvents: raw(&ev),
            processContext: &mut self.ctx,
        };
        unsafe {
            self.processor.process(&mut data);
        }
        if n > 0 {
            self.ctx.projectTimeSamples += n as i64;
            self.ctx.continousTimeSamples += n as i64;
            self.ctx.projectTimeMusic = self.ctx.projectTimeSamples as f64 / SR * 2.0;
            self.outs[0].copy_to(out_l, out_r, n);
        }
        // Выходные параметры процессора (индикаторы) → контроллер на главном потоке (idle)
        let outv = self.out_changes.last_values();
        if !outv.is_empty() {
            if let Ok(mut q) = self.shared.out.lock() {
                q.extend(outv);
                if q.len() > 4096 {
                    let extra = q.len() - 4096;
                    q.drain(..extra);
                }
            }
        }
    }

    fn take_dirty(&self) -> bool {
        self.shared.dirty.swap(false, Ordering::SeqCst)
    }

    fn idle(&mut self) {
        let vals: Vec<(u32, f64)> = self.shared.out.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
        if let Some(c) = &self.controller {
            for (id, v) in vals {
                unsafe {
                    c.setParamNormalized(id, v);
                }
            }
        }
    }

    fn has_editor(&mut self) -> bool {
        if self.view.is_some() {
            return true;
        }
        let Some(c) = &self.controller else { return false };
        // Окно создаётся и сразу отпускается: настоящее — в editor_open
        unsafe { ComPtr::from_raw(c.createView(c"editor".as_ptr())).is_some() }
    }

    fn editor_open(&mut self, parent: isize, resize: ResizeFn) -> Option<(u32, u32, bool)> {
        let c = self.controller.as_ref()?;
        unsafe {
            let view = ComPtr::from_raw(c.createView(c"editor".as_ptr()))?;
            if view.isPlatformTypeSupported(kPlatformTypeHWND) != kResultOk {
                return None;
            }
            let frame = ComWrapper::new(Frame {
                resize: Box::new(move |v: *mut IPlugView, r: &ViewRect| {
                    let (w, h) = ((r.right - r.left).max(1) as u32, (r.bottom - r.top).max(1) as u32);
                    let ok = resize(w, h);
                    if ok {
                        if let Some(v) = ComRef::from_raw(v) {
                            let mut rr = ViewRect { left: 0, top: 0, right: w as i32, bottom: h as i32 };
                            v.onSize(&mut rr);
                        }
                    }
                    ok
                }),
            });
            if let Some(f) = frame.to_com_ptr::<IPlugFrame>() {
                view.setFrame(f.as_ptr());
            }
            if view.attached(parent as *mut c_void, kPlatformTypeHWND) != kResultOk {
                view.setFrame(std::ptr::null_mut());
                return None;
            }
            let mut r = ViewRect { left: 0, top: 0, right: 0, bottom: 0 };
            view.getSize(&mut r);
            let (w, h) = ((r.right - r.left).max(100) as u32, (r.bottom - r.top).max(60) as u32);
            let can = view.canResize() == kResultTrue;
            self.view = Some(view);
            self.frame = Some(frame);
            Some((w, h, can))
        }
    }

    fn editor_set_size(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        let v = self.view.as_ref()?;
        unsafe {
            if v.canResize() != kResultTrue {
                return None;
            }
            let mut r = ViewRect { left: 0, top: 0, right: w as i32, bottom: h as i32 };
            v.checkSizeConstraint(&mut r);
            v.onSize(&mut r);
            Some(((r.right - r.left).max(1) as u32, (r.bottom - r.top).max(1) as u32))
        }
    }

    fn editor_close(&mut self) {
        if let Some(v) = self.view.take() {
            unsafe {
                v.removed();
                v.setFrame(std::ptr::null_mut());
            }
        }
        self.frame = None;
    }

    fn shutdown(&mut self) {
        self.editor_close();
        unsafe {
            if self.processing {
                self.processor.setProcessing(0);
                self.processing = false;
            }
            if self.active {
                self.component.setActive(0);
                self.active = false;
            }
            if let Some((a, b)) = self.conn.take() {
                a.disconnect(b.as_ptr());
                b.disconnect(a.as_ptr());
            }
            if let Some(c) = &self.controller {
                c.setComponentHandler(std::ptr::null_mut());
                if self.separate {
                    c.terminate();
                }
            }
            self.component.terminate();
        }
    }
}

fn bus_buffers(b: &mut Bus) -> AudioBusBuffers {
    let mut x: AudioBusBuffers = unsafe { std::mem::zeroed() };
    x.numChannels = b.ptrs.len() as i32;
    x.silenceFlags = 0;
    x.__field0.channelBuffers32 = if b.ptrs.is_empty() { std::ptr::null_mut() } else { b.ptrs.as_mut_ptr() };
    x
}
