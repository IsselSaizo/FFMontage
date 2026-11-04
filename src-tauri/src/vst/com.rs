// COM-объекты стороны хоста VST3 (то, что плагин получает от нас): IHostApplication, IMessage/IAttributeList
// (для связи компонента и контроллера, их создаёт плагин через createInstance), IBStream (состояние),
// IComponentHandler (правки из окна плагина), IPlugFrame (окно меняет размер), IParameterChanges/IParamValueQueue,
// пустой IEventList. Все — в одном процессе хоста (`ff-montage --vst-host`), см. host.rs.
#![allow(non_snake_case)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};

use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComWrapper, Interface};

pub fn guid_eq(a: *const TUID, iid: &[u8; 16]) -> bool {
    if a.is_null() {
        return false;
    }
    let a = unsafe { &*(a as *const [u8; 16]) };
    a == iid
}

pub fn str16(s: &[TChar]) -> String {
    let n = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..n])
}

pub fn str8(s: &[char8]) -> String {
    let b: Vec<u8> = s.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&b).into_owned()
}

pub fn copy16(src: &str, dst: &mut [TChar]) {
    let mut n = 0;
    for (s, d) in src.encode_utf16().zip(dst.iter_mut()) {
        *d = s;
        n += 1;
    }
    let last = dst.len().saturating_sub(1);
    dst[n.min(last)] = 0;
}

// ---------------------------------------------------------------------------
// IHostApplication
// ---------------------------------------------------------------------------
pub struct HostApp;

impl Class for HostApp {
    type Interfaces = (IHostApplication, IPlugInterfaceSupport);
}

impl IHostApplicationTrait for HostApp {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        if name.is_null() {
            return kInvalidArgument;
        }
        copy16("FF Montage", &mut *name);
        kResultOk
    }

    unsafe fn createInstance(&self, cid: *mut TUID, iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        if obj.is_null() {
            return kInvalidArgument;
        }
        *obj = std::ptr::null_mut();
        let want = |i: &[u8; 16]| guid_eq(cid, i) || guid_eq(iid, i);
        // Объект → «сырой» указатель с +1 к счётчику (как ждёт createInstance)
        let raw = if want(&IMessage::IID) {
            ComWrapper::new(Message::new()).to_com_ptr::<IMessage>().map(|p| p.into_raw() as *mut c_void)
        } else if want(&IAttributeList::IID) {
            ComWrapper::new(AttrList::default()).to_com_ptr::<IAttributeList>().map(|p| p.into_raw() as *mut c_void)
        } else {
            None
        };
        match raw {
            Some(p) => {
                *obj = p;
                kResultOk
            }
            None => kNoInterface,
        }
    }
}

impl IPlugInterfaceSupportTrait for HostApp {
    unsafe fn isPlugInterfaceSupported(&self, iid: *const TUID) -> tresult {
        let ok = [
            IComponent::IID,
            IAudioProcessor::IID,
            IEditController::IID,
            IConnectionPoint::IID,
            IPlugView::IID,
            IComponentHandler::IID,
            IPlugFrame::IID,
        ]
        .iter()
        .any(|i| guid_eq(iid, i));
        if ok {
            kResultTrue
        } else {
            kResultFalse
        }
    }
}

// ---------------------------------------------------------------------------
// IMessage + IAttributeList
// ---------------------------------------------------------------------------
pub struct Message {
    id: RefCell<CString>,
    attrs: ComPtr<IAttributeList>,
}

impl Message {
    fn new() -> Self {
        let a = ComWrapper::new(AttrList::default());
        Message { id: RefCell::new(CString::default()), attrs: a.to_com_ptr::<IAttributeList>().expect("attrs") }
    }
}

impl Class for Message {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for Message {
    unsafe fn getMessageID(&self) -> FIDString {
        self.id.borrow().as_ptr()
    }
    unsafe fn setMessageID(&self, id: FIDString) {
        *self.id.borrow_mut() = if id.is_null() { CString::default() } else { CStr::from_ptr(id).to_owned() };
    }
    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        // Как в SDK (HostMessage): без addRef
        self.attrs.as_ptr()
    }
}

enum Attr {
    Int(i64),
    Float(f64),
    Str(Vec<u16>),
    Bin(Vec<u8>),
}

#[derive(Default)]
pub struct AttrList {
    map: RefCell<HashMap<Vec<u8>, Attr>>,
}

impl Class for AttrList {
    type Interfaces = (IAttributeList,);
}

unsafe fn key(id: IAttributeList_::AttrID) -> Option<Vec<u8>> {
    if id.is_null() {
        None
    } else {
        Some(CStr::from_ptr(id).to_bytes().to_vec())
    }
}

impl IAttributeListTrait for AttrList {
    unsafe fn setInt(&self, id: IAttributeList_::AttrID, value: int64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        self.map.borrow_mut().insert(k, Attr::Int(value));
        kResultOk
    }
    unsafe fn getInt(&self, id: IAttributeList_::AttrID, value: *mut int64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Int(v)) if !value.is_null() => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setFloat(&self, id: IAttributeList_::AttrID, value: f64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        self.map.borrow_mut().insert(k, Attr::Float(value));
        kResultOk
    }
    unsafe fn getFloat(&self, id: IAttributeList_::AttrID, value: *mut f64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Float(v)) if !value.is_null() => {
                *value = *v;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setString(&self, id: IAttributeList_::AttrID, string: *const TChar) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        let mut v = vec![];
        if !string.is_null() {
            let mut i = 0;
            while *string.add(i) != 0 && i < 1 << 20 {
                v.push(*string.add(i));
                i += 1;
            }
        }
        self.map.borrow_mut().insert(k, Attr::Str(v));
        kResultOk
    }
    unsafe fn getString(&self, id: IAttributeList_::AttrID, string: *mut TChar, sizeInBytes: uint32) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Str(v)) if !string.is_null() && sizeInBytes >= 2 => {
                let cap = (sizeInBytes / 2) as usize - 1;
                let n = v.len().min(cap);
                std::ptr::copy_nonoverlapping(v.as_ptr(), string, n);
                *string.add(n) = 0;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
    unsafe fn setBinary(&self, id: IAttributeList_::AttrID, data: *const c_void, sizeInBytes: uint32) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        let v = if data.is_null() { vec![] } else { std::slice::from_raw_parts(data as *const u8, sizeInBytes as usize).to_vec() };
        self.map.borrow_mut().insert(k, Attr::Bin(v));
        kResultOk
    }
    unsafe fn getBinary(&self, id: IAttributeList_::AttrID, data: *mut *const c_void, sizeInBytes: *mut uint32) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        match self.map.borrow().get(&k) {
            Some(Attr::Bin(v)) if !data.is_null() && !sizeInBytes.is_null() => {
                *data = v.as_ptr() as *const c_void;
                *sizeInBytes = v.len() as uint32;
                kResultOk
            }
            _ => kResultFalse,
        }
    }
}

// ---------------------------------------------------------------------------
// IBStream в памяти
// ---------------------------------------------------------------------------
#[derive(Default)]
pub struct MemStream {
    pub data: RefCell<Vec<u8>>,
    pos: Cell<usize>,
}

impl MemStream {
    pub fn with(data: Vec<u8>) -> ComWrapper<MemStream> {
        ComWrapper::new(MemStream { data: RefCell::new(data), pos: Cell::new(0) })
    }
    pub fn empty() -> ComWrapper<MemStream> {
        ComWrapper::new(MemStream::default())
    }
    pub fn rewind(&self) {
        self.pos.set(0);
    }
}

impl Class for MemStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemStream {
    unsafe fn read(&self, buffer: *mut c_void, numBytes: int32, numBytesRead: *mut int32) -> tresult {
        let d = self.data.borrow();
        let p = self.pos.get().min(d.len());
        let n = (numBytes.max(0) as usize).min(d.len() - p);
        if n > 0 && !buffer.is_null() {
            std::ptr::copy_nonoverlapping(d.as_ptr().add(p), buffer as *mut u8, n);
        }
        self.pos.set(p + n);
        if !numBytesRead.is_null() {
            *numBytesRead = n as int32;
        }
        kResultOk
    }
    unsafe fn write(&self, buffer: *mut c_void, numBytes: int32, numBytesWritten: *mut int32) -> tresult {
        if numBytes < 0 || (buffer.is_null() && numBytes > 0) {
            return kInvalidArgument;
        }
        let n = numBytes as usize;
        let mut d = self.data.borrow_mut();
        let p = self.pos.get();
        if d.len() < p + n {
            d.resize(p + n, 0);
        }
        if n > 0 {
            std::ptr::copy_nonoverlapping(buffer as *const u8, d.as_mut_ptr().add(p), n);
        }
        self.pos.set(p + n);
        if !numBytesWritten.is_null() {
            *numBytesWritten = n as int32;
        }
        kResultOk
    }
    unsafe fn seek(&self, pos: int64, mode: int32, result: *mut int64) -> tresult {
        let len = self.data.borrow().len() as i64;
        let base = match mode {
            0 => 0,
            1 => self.pos.get() as i64,
            2 => len,
            _ => return kInvalidArgument,
        };
        let np = base + pos;
        if np < 0 {
            return kInvalidArgument;
        }
        self.pos.set(np as usize);
        if !result.is_null() {
            *result = np;
        }
        kResultOk
    }
    unsafe fn tell(&self, pos: *mut int64) -> tresult {
        if pos.is_null() {
            return kInvalidArgument;
        }
        *pos = self.pos.get() as i64;
        kResultOk
    }
}

// ---------------------------------------------------------------------------
// IComponentHandler: правки параметров из окна плагина → процессор (через очередь), «грязное» состояние
// ---------------------------------------------------------------------------
#[derive(Default)]
pub struct Shared {
    /// Правки для процессора (ParamID, значение 0..1) — забирает поток звука
    pub edits: Mutex<Vec<(u32, f64)>>,
    /// Выходные параметры процессора (индикаторы) → контроллер на главном потоке
    pub out: Mutex<Vec<(u32, f64)>>,
    /// Состояние изменилось — окно программы надо уведомить
    pub dirty: AtomicBool,
    /// Окно плагина хочет закрыться/переоткрыться и т.п. — флаги restartComponent
    pub restart: AtomicI32,
}

pub struct Handler {
    pub shared: Arc<Shared>,
}

impl Class for Handler {
    type Interfaces = (IComponentHandler, IComponentHandler2);
}

impl IComponentHandlerTrait for Handler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn performEdit(&self, id: ParamID, v: ParamValue) -> tresult {
        if let Ok(mut e) = self.shared.edits.lock() {
            e.retain(|x| x.0 != id);
            e.push((id, v));
        }
        self.shared.dirty.store(true, Ordering::SeqCst);
        kResultOk
    }
    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        self.shared.dirty.store(true, Ordering::SeqCst);
        kResultOk
    }
    unsafe fn restartComponent(&self, flags: int32) -> tresult {
        self.shared.restart.fetch_or(flags, Ordering::SeqCst);
        self.shared.dirty.store(true, Ordering::SeqCst);
        kResultOk
    }
}

impl IComponentHandler2Trait for Handler {
    unsafe fn setDirty(&self, state: TBool) -> tresult {
        if state != 0 {
            self.shared.dirty.store(true, Ordering::SeqCst);
        }
        kResultOk
    }
    unsafe fn requestOpenEditor(&self, _name: FIDString) -> tresult {
        kResultFalse
    }
    unsafe fn startGroupEdit(&self) -> tresult {
        kResultOk
    }
    unsafe fn finishGroupEdit(&self) -> tresult {
        kResultOk
    }
}

// ---------------------------------------------------------------------------
// IPlugFrame: плагин просит другой размер окна
// ---------------------------------------------------------------------------
/// (view, rect) → true, если окно хоста приняло размер
pub type FrameResize = Box<dyn Fn(*mut IPlugView, &ViewRect) -> bool>;

pub struct Frame {
    pub resize: FrameResize,
}

impl Class for Frame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for Frame {
    unsafe fn resizeView(&self, view: *mut IPlugView, newSize: *mut ViewRect) -> tresult {
        if view.is_null() || newSize.is_null() {
            return kInvalidArgument;
        }
        if (self.resize)(view, &*newSize) {
            kResultOk
        } else {
            kResultFalse
        }
    }
}

// ---------------------------------------------------------------------------
// IParameterChanges / IParamValueQueue
// ---------------------------------------------------------------------------
pub struct Queue {
    id: Cell<u32>,
    points: RefCell<Vec<(i32, f64)>>,
}

impl Class for Queue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for Queue {
    unsafe fn getParameterId(&self) -> ParamID {
        self.id.get()
    }
    unsafe fn getPointCount(&self) -> int32 {
        self.points.borrow().len() as int32
    }
    unsafe fn getPoint(&self, index: int32, sampleOffset: *mut int32, value: *mut ParamValue) -> tresult {
        match self.points.borrow().get(index.max(0) as usize) {
            Some(&(o, v)) if index >= 0 => {
                if !sampleOffset.is_null() {
                    *sampleOffset = o;
                }
                if !value.is_null() {
                    *value = v;
                }
                kResultOk
            }
            _ => kInvalidArgument,
        }
    }
    unsafe fn addPoint(&self, sampleOffset: int32, value: ParamValue, index: *mut int32) -> tresult {
        let mut p = self.points.borrow_mut();
        let i = p.iter().position(|x| x.0 >= sampleOffset).unwrap_or(p.len());
        if p.get(i).is_some_and(|x| x.0 == sampleOffset) {
            p[i].1 = value;
        } else {
            p.insert(i, (sampleOffset, value));
        }
        if !index.is_null() {
            *index = i as int32;
        }
        kResultOk
    }
}

pub struct Changes {
    queues: RefCell<Vec<ComWrapper<Queue>>>,
    used: Cell<usize>,
}

impl Changes {
    pub fn new() -> ComWrapper<Changes> {
        ComWrapper::new(Changes { queues: RefCell::new(vec![]), used: Cell::new(0) })
    }
    pub fn clear(&self) {
        for q in self.queues.borrow().iter() {
            q.points.borrow_mut().clear();
        }
        self.used.set(0);
    }
    pub fn add(&self, id: u32, offset: i32, value: f64) {
        let q = self.queue_for(id);
        unsafe {
            q.addPoint(offset, value, std::ptr::null_mut());
        }
    }
    fn queue_for(&self, id: u32) -> ComWrapper<Queue> {
        let used = self.used.get();
        {
            let qs = self.queues.borrow();
            if let Some(q) = qs[..used].iter().find(|q| q.id.get() == id) {
                return q.clone();
            }
        }
        let mut qs = self.queues.borrow_mut();
        if qs.len() <= used {
            qs.push(ComWrapper::new(Queue { id: Cell::new(id), points: RefCell::new(vec![]) }));
        }
        let q = qs[used].clone();
        q.id.set(id);
        q.points.borrow_mut().clear();
        self.used.set(used + 1);
        q
    }
    /// Последние значения каждого параметра (выходные изменения процессора → контроллер)
    pub fn last_values(&self) -> Vec<(u32, f64)> {
        let qs = self.queues.borrow();
        qs[..self.used.get()].iter().filter_map(|q| q.points.borrow().last().map(|p| (q.id.get(), p.1))).collect()
    }
}

impl Class for Changes {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for Changes {
    unsafe fn getParameterCount(&self) -> int32 {
        self.used.get() as int32
    }
    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        let qs = self.queues.borrow();
        if index < 0 || index as usize >= self.used.get() {
            return std::ptr::null_mut();
        }
        // Как в SDK: без addRef
        qs[index as usize].as_com_ref::<IParamValueQueue>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut())
    }
    unsafe fn addParameterData(&self, id: *const ParamID, index: *mut int32) -> *mut IParamValueQueue {
        if id.is_null() {
            return std::ptr::null_mut();
        }
        let id = *id;
        let q = self.queue_for(id);
        if !index.is_null() {
            let qs = self.queues.borrow();
            *index = qs[..self.used.get()].iter().position(|x| x.id.get() == id).unwrap_or(0) as int32;
        }
        let p = q.as_com_ref::<IParamValueQueue>().map(|r| r.as_ptr()).unwrap_or(std::ptr::null_mut());
        p
    }
}

// ---------------------------------------------------------------------------
// IEventList — MIDI не передаём, но некоторым плагинам нужен непустой указатель
// ---------------------------------------------------------------------------
pub struct Events;

impl Class for Events {
    type Interfaces = (IEventList,);
}

impl IEventListTrait for Events {
    unsafe fn getEventCount(&self) -> int32 {
        0
    }
    unsafe fn getEvent(&self, _index: int32, _e: *mut Event) -> tresult {
        kInvalidArgument
    }
    unsafe fn addEvent(&self, _e: *mut Event) -> tresult {
        kResultOk
    }
}
