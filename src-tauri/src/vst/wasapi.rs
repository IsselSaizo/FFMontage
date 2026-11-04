// Вывод звука для живого прослушивания плагина (окно плагина открыто): WASAPI, общий режим, устройство по умолчанию,
// float32 стерео 48 кГц — система сама пересчитает в формат устройства (AUTOCONVERTPCM).
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

pub struct Out {
    client: IAudioClient,
    render: IAudioRenderClient,
    event: HANDLE,
    frames: u32,
    started: bool,
}

impl Out {
    pub fn open() -> Result<Out, String> {
        let e = |m: &str, x: windows::core::Error| format!("WASAPI {m}: {x}");
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|x| e("enumerator", x))?;
            let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|x| e("device", x))?;
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|x| e("activate", x))?;
            let fmt = WAVEFORMATEX {
                wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
                nChannels: 2,
                nSamplesPerSec: 48000,
                nAvgBytesPerSec: 48000 * 8,
                nBlockAlign: 8,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    400_000, // 40 мс
                    0,
                    &fmt,
                    None,
                )
                .map_err(|x| e("initialize", x))?;
            let event = CreateEventW(None, false, false, None).map_err(|x| e("event", x))?;
            client.SetEventHandle(event).map_err(|x| e("event", x))?;
            let frames = client.GetBufferSize().map_err(|x| e("buffer", x))?;
            let render: IAudioRenderClient = client.GetService().map_err(|x| e("render", x))?;
            Ok(Out { client, render, event, frames, started: false })
        }
    }

    pub fn start(&mut self) {
        if !self.started {
            unsafe {
                let _ = self.client.Start();
            }
            self.started = true;
        }
    }

    pub fn stop(&mut self) {
        if self.started {
            unsafe {
                let _ = self.client.Stop();
                let _ = self.client.Reset();
            }
            self.started = false;
        }
    }

    /// Ждёт места в буфере устройства (≤ 100 мс) и заполняет его: f(чередующиеся L/R)
    pub fn fill(&mut self, f: &mut dyn FnMut(&mut [f32])) -> Result<(), String> {
        unsafe {
            if self.started && WaitForSingleObject(self.event, 100) != WAIT_OBJECT_0 {
                return Ok(());
            }
            let pad = self.client.GetCurrentPadding().map_err(|x| x.to_string())?;
            let avail = self.frames.saturating_sub(pad);
            if avail == 0 {
                return Ok(());
            }
            let p = self.render.GetBuffer(avail).map_err(|x| x.to_string())?;
            let buf = std::slice::from_raw_parts_mut(p as *mut f32, avail as usize * 2);
            f(buf);
            self.render.ReleaseBuffer(avail, 0).map_err(|x| x.to_string())?;
        }
        Ok(())
    }
}

impl Drop for Out {
    fn drop(&mut self) {
        self.stop();
        unsafe {
            let _ = CloseHandle(self.event);
        }
    }
}
