// Общий вид аудиоплагина для хоста: VST3 (vst3.rs) и CLAP (clap.rs) за одним интерфейсом Fx.
// uid плагина: VST3 — 32 hex (class id), CLAP — "clap:<id>".
use std::path::Path;

pub const SR: f64 = 48000.0;

#[derive(serde::Serialize, Clone, Debug)]
pub struct ClassInfo {
    pub format: &'static str,
    pub uid: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub category: String,
    pub sub: String,
    pub sdk: String,
    pub instrument: bool,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct ParamInfo {
    pub id: u32,
    pub title: String,
    pub units: String,
    /// Значения — нормированные 0..1 (у CLAP пересчитываются из min..max)
    pub def: f64,
    pub value: f64,
    pub steps: i32,
    pub display: String,
    #[serde(rename = "readOnly")]
    pub read_only: bool,
    pub hidden: bool,
    pub bypass: bool,
}

/// Окно плагина просит размер (ширина, высота клиентской области) → true, если окно хоста его приняло
pub type ResizeFn = Box<dyn Fn(u32, u32) -> bool>;

pub trait Fx {
    /// Включить обработку (offline — экспорт/рендер, иначе — реальное время)
    fn activate(&mut self) -> Result<(), String>;
    fn latency(&self) -> u32;
    fn set_state(&mut self, comp: &[u8], ctrl: &[u8]);
    fn get_state(&mut self) -> (Vec<u8>, Vec<u8>);
    /// Значения параметров 0..1
    fn set_params(&mut self, p: &[(u32, f64)]);
    fn params(&mut self) -> Vec<ParamInfo>;
    /// n кадров стерео; n = 0 — только передать параметры
    fn process(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32], n: usize);
    fn set_playing(&mut self, playing: bool, pos: i64);
    /// Состояние поменялось (правка в окне плагина и т.п.) — сбрасывает флаг
    fn take_dirty(&self) -> bool;
    /// Работа на главном потоке (обратные вызовы CLAP, индикаторы VST3) — из цикла окна
    fn idle(&mut self);
    fn has_editor(&mut self) -> bool;
    /// Встроить окно плагина в parent (HWND). Ответ — (ширина, высота, можно ли тянуть)
    fn editor_open(&mut self, parent: isize, resize: ResizeFn) -> Option<(u32, u32, bool)>;
    /// Пользователь тянет окно хоста: плагин уточняет размер → итоговый
    fn editor_set_size(&mut self, w: u32, h: u32) -> Option<(u32, u32)>;
    fn editor_close(&mut self);
    fn shutdown(&mut self);
}

pub enum Module {
    Vst3(super::vst3::Module),
    Clap(super::clap::Module),
}

pub fn is_clap(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("clap"))
}

impl Module {
    pub fn load(path: &Path) -> Result<Module, String> {
        if is_clap(path) {
            super::clap::Module::load(path).map(Module::Clap)
        } else {
            super::vst3::Module::load(path).map(Module::Vst3)
        }
    }

    pub fn classes(&self) -> Vec<ClassInfo> {
        match self {
            Module::Vst3(m) => m.classes(),
            Module::Clap(m) => m.classes(),
        }
    }

    /// offline — режим рендера (kOffline / CLAP_RENDER_OFFLINE)
    pub fn open(&self, uid: &str, offline: bool, max_block: usize) -> Result<Box<dyn Fx>, String> {
        match self {
            Module::Vst3(m) => Ok(Box::new(super::vst3::Instance::new(m, uid, offline, max_block)?)),
            Module::Clap(m) => Ok(Box::new(super::clap::Instance::new(m, uid, offline, max_block)?)),
        }
    }

    pub fn exit(&self) {
        match self {
            Module::Vst3(m) => m.exit(),
            Module::Clap(m) => m.exit(),
        }
    }
}
