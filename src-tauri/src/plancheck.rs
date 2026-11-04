// Проверка плана экспорта перед запуском FFmpeg (M3.4 / M0.2).
// План собирает окно (js/exportPlan.js exportCommand, js/animRain.js rainBakePlan); сюда он приходит как данные,
// поэтому FFmpeg получает только то, что мы понимаем:
//   • граф — разбирается так же, как в FFmpeg (libavfilter/graphparser.c + ff_filter_opt_parse, два уровня кавычек),
//     каждый фильтр ∈ SAFE_FILTERS, ключи опций — обычные имена и не FORBIDDEN_OPTION (файлы, модели, команды);
//     исключение — ass (субтитры, M5): только свой набор опций и файлы из папок программы (check_ass), hwupload без опций (VAAPI);
//     DENY_FILTERS (movie, sendcmd, zmq…) запрещены всегда, значения опций не прячут вложенный граф (hidden_danger);
//   • аргументы — только известные опции с проверенными значениями; @@FILTER@@ и @@OUT@@ — ровно по разу;
//   • -i — существующий файл (не протокол concat:/subfile,,/http:… и не устройство \\.\), разрешённый окну
//     (импорт / кэш медиа / файлы экспорта / папка плагинов); у движка без окна — любой существующий;
//   • output — абсолютный .mp4/.mov/.mkv/.webm, не совпадает со входом; у окна — выданный программой
//     (grant_output: export_pick / export_default_path / MCP export_video с path) или внутри папки кэша.
//   Режим Inputs::Engine (ff-montage --engine, tests/engine.js) — входы и выход в любых своих путях, остальное — так же строго.
use crate::{paths, plugins, protocol, tr};
use std::path::{Path, PathBuf};

/// Какие входные файлы разрешены
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Inputs {
    /// Экспорт из окна: файлы, открытые окном (protocol::allow), кэш медиа, папка плагинов
    Window,
    /// Движок без окна (ff-montage --engine export, автотесты): любой существующий файл
    Engine,
    /// Только для юнит-тестов: пути не проверяются на диске
    #[cfg(test)]
    Any,
}

// ---------------------------------------------------------------------------
// Граф фильтров
// ---------------------------------------------------------------------------
const WS: &[u8] = b" \n\t\r";

/// av_get_token: снимает один уровень кавычек '…' и экранирования \x, останавливается на символе из term
fn get_token(b: &[u8], p: &mut usize, term: &[u8]) -> String {
    while *p < b.len() && WS.contains(&b[*p]) {
        *p += 1;
    }
    let mut out: Vec<u8> = vec![];
    let mut end = 0usize;
    while *p < b.len() && !term.contains(&b[*p]) {
        let c = b[*p];
        *p += 1;
        if c == b'\\' && *p < b.len() {
            out.push(b[*p]);
            *p += 1;
            end = out.len();
        } else if c == b'\'' {
            while *p < b.len() && b[*p] != b'\'' {
                out.push(b[*p]);
                *p += 1;
            }
            if *p < b.len() {
                *p += 1;
                end = out.len();
            }
        } else {
            out.push(c);
        }
    }
    while out.len() > end && out.last().is_some_and(|c| WS.contains(c)) {
        out.pop();
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn skip_ws(b: &[u8], p: &mut usize) {
    while *p < b.len() && WS.contains(&b[*p]) {
        *p += 1;
    }
}

#[derive(Debug, PartialEq)]
pub struct Filter {
    pub name: String,
    /// (ключ, значение); ключ None — позиционное значение
    pub opts: Vec<(Option<String>, String)>,
}

fn labels(b: &[u8], p: &mut usize) -> Result<(), String> {
    while *p < b.len() && b[*p] == b'[' {
        *p += 1;
        let name = get_token(b, p, b"]");
        if name.is_empty() || *p >= b.len() || b[*p] != b']' {
            return Err(tr!("неверная метка в графе", "invalid label in the graph").into());
        }
        *p += 1;
        skip_ws(b, p);
    }
    Ok(())
}

/// is_key_char из libavutil/opt.c
fn is_key_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'/' || c == b'.'
}

/// ff_filter_opt_parse: «key=value:позиционное:…», значения — через av_get_token(":")
fn parse_opts(s: &str) -> Vec<(Option<String>, String)> {
    let b = s.as_bytes();
    let mut p = 0;
    let mut out = vec![];
    while p < b.len() {
        let mut q = p;
        skip_ws(b, &mut q);
        let ks = q;
        while q < b.len() && is_key_char(b[q]) {
            q += 1;
        }
        let ke = q;
        skip_ws(b, &mut q);
        let key = if q < b.len() && b[q] == b'=' {
            p = q + 1;
            Some(String::from_utf8_lossy(&b[ks..ke]).into_owned())
        } else {
            None
        };
        let val = get_token(b, &mut p, b":");
        out.push((key, val));
        if p < b.len() {
            p += 1;
        }
    }
    out
}

/// Разбор графа (avfilter_graph_segment_parse): цепочки через «;», фильтры через «,», метки [x]
pub fn parse_graph(s: &str) -> Result<Vec<Filter>, String> {
    let b = s.as_bytes();
    let mut p = 0;
    let mut out = vec![];
    skip_ws(b, &mut p);
    while p < b.len() {
        labels(b, &mut p)?;
        skip_ws(b, &mut p);
        let mut name = get_token(b, &mut p, b"=,;[");
        if name.is_empty() {
            return Err(tr!("пустое имя фильтра", "empty filter name").into());
        }
        if let Some(i) = name.find('@') {
            name.truncate(i);
        }
        let mut opts = vec![];
        if p < b.len() && b[p] == b'=' {
            p += 1;
            opts = parse_opts(&get_token(b, &mut p, b"[],;"));
        }
        labels(b, &mut p)?;
        skip_ws(b, &mut p);
        out.push(Filter { name, opts });
        if p < b.len() {
            if b[p] == b',' || b[p] == b';' {
                p += 1;
                skip_ws(b, &mut p);
            } else {
                return Err(tr!(
                    "лишние символы в графе: «{}»",
                    "trailing characters in the graph: \"{}\"",
                    String::from_utf8_lossy(&b[p..(p + 20).min(b.len())])
                ));
            }
        }
    }
    Ok(out)
}

fn valid_key(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty() && (b[0].is_ascii_alphabetic() || b[0] == b'_') && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// Фильтры, у которых опция-файл достижима позиционно (curves/selectivecolor — psfile, firequalizer — dumpfile):
/// позиционных значений не больше, чем до неё
fn max_positional(name: &str) -> usize {
    match name {
        "curves" | "selectivecolor" | "firequalizer" => 2,
        _ => usize::MAX,
    }
}

/// Фильтр ass (M5, субтитры через libass) — не в SAFE_FILTERS (плагинам он недоступен), только по этому правилу:
/// filename/f/первое позиционное — абсолютный .ass, fontsdir — абсолютная папка, original_size, shaping, alpha.
/// Окно: файл — из <app_cache>/export-assets (assets::save), шрифты — <app_cache>/fonts; движок — любые существующие.
fn check_ass(f: &Filter, inputs: Inputs) -> Result<(), String> {
    let bad = |k: &str| tr!("опция «{}» фильтра ass не разрешена", "option \"{}\" of filter ass is not allowed", k);
    let (mut file, mut fonts): (Option<&str>, Option<&str>) = (None, None);
    let mut seen: Vec<&str> = vec![];
    for (i, (k, v)) in f.opts.iter().enumerate() {
        let key = match k.as_deref() {
            Some("f") => "filename",
            Some(k) => k,
            None if i == 0 => "filename",
            None => return Err(tr!("слишком много позиционных опций у фильтра {}", "too many positional options for filter {}", f.name)),
        };
        if seen.contains(&key) {
            return Err(tr!("опция «{}» фильтра ass указана дважды", "option \"{}\" of filter ass is given twice", key));
        }
        seen.push(key);
        let ok = match key {
            "filename" => {
                file = Some(v.as_str());
                true
            }
            "fontsdir" => {
                fonts = Some(v.as_str());
                true
            }
            "original_size" => v
                .split_once('x')
                .is_some_and(|(w, h)| [w, h].iter().all(|n| (1..=5).contains(&n.len()) && n.bytes().all(|c| c.is_ascii_digit()))),
            "shaping" => matches!(v.as_str(), "auto" | "simple" | "complex"),
            "alpha" => matches!(v.as_str(), "0" | "1"),
            _ => return Err(bad(key)),
        };
        if !ok {
            return Err(tr!("недопустимое значение опции {} фильтра ass: {}", "invalid value of option {} of filter ass: {}", key, v));
        }
    }
    let file = file.ok_or(tr!("у фильтра ass нет файла субтитров", "filter ass has no subtitle file"))?;
    let fp = PathBuf::from(file);
    let bad_file = || tr!("файл субтитров не разрешён: {}", "subtitle file is not allowed: {}", file);
    if file.contains(['\0', '\n', '\r']) || !fp.is_absolute() || crate::ff::ext_of(&fp) != "ass" {
        return Err(bad_file());
    }
    let file_ok = match inputs {
        Inputs::Window => fp.is_file() && under(&fp, &crate::assets::dir()),
        Inputs::Engine => fp.is_file(),
        #[cfg(test)]
        Inputs::Any => true,
    };
    if !file_ok {
        return Err(bad_file());
    }
    if let Some(d) = fonts {
        let dp = PathBuf::from(d);
        let fonts_dir = crate::fonts::export_dir();
        let dir_ok = !d.contains(['\0', '\n', '\r'])
            && dp.is_absolute()
            && match inputs {
                Inputs::Window => {
                    dp.is_dir()
                        && (norm(&dp).trim_end_matches(['\\', '/']) == norm(&fonts_dir).trim_end_matches(['\\', '/'])
                            || under(&dp, &fonts_dir))
                }
                Inputs::Engine => dp.is_dir(),
                #[cfg(test)]
                Inputs::Any => true,
            };
        if !dir_ok {
            return Err(tr!("папка шрифтов не разрешена: {}", "fonts folder is not allowed: {}", d));
        }
    }
    Ok(())
}

/// Фильтры, которые читают/пишут файлы, исполняют команды, ходят в сеть или грузят библиотеки/модели.
/// Их нет и в SAFE_FILTERS (js/core/safeFilters.js) — этот список страхует, если их туда добавят по ошибке.
const DENY_FILTERS: &[&str] = &[
    "movie",
    "amovie",
    "sendcmd",
    "asendcmd",
    "zmq",
    "azmq",
    "subtitles",
    "drawtext",
    "drawvg",
    "qrencode",
    "qrencodesrc",
    "lut3d",
    "ladspa",
    "lv2",
    "frei0r",
    "frei0r_src",
    "arnndn",
    "sofalizer",
    "dnn_processing",
    "dnn_detect",
    "dnn_classify",
    "sr",
    "derain",
    "whisper",
    "ocr",
    "signature",
    "vidstabdetect",
    "vidstabtransform",
    "libplacebo",
    "lensfun",
    "metadata",
    "ametadata",
    "cover_rect",
    "find_rect",
    "removelogo",
    "psnr",
    "ssim",
    "libvmaf",
    "vmafmotion",
    "buffer",
    "abuffer",
    "buffersink",
    "abuffersink",
    "openclsrc",
    "program_opencl",
    "coreimage",
    "coreimagesrc",
];

/// Ключи опций с файлами, путями, моделями, командами — сверх plugins::forbidden_option
fn forbidden_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    plugins::forbidden_option(&k)
        || k.ends_with("path")
        || k.contains("script")
        || k.contains("shader")
        || matches!(k.as_str(), "result" | "input" | "cover" | "object" | "dnn_backend")
}

/// Значение опции не должно прятать в себе вложенный граф с опасным фильтром/опцией
/// («hue=s=0\,movie=x», «'movie=x'», «sendcmd» в выражении): после снятия кавычек и экранирования
/// таких слов в значениях не бывает — выражения, цвета и числа их не содержат.
fn hidden_danger(v: &str) -> bool {
    let flat: String = v.chars().filter(|c| !matches!(c, '\\' | '\'' | '"') && !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
    ["movie=", "movie[", "sendcmd", "zmq", "filename=", "file=", "textfile", "subtitles=", "ladspa", "lv2=", "frei0r"]
        .iter()
        .any(|w| flat.contains(w))
        || flat.split([',', ';', '[', ']']).any(|part| part == "movie" || part == "amovie")
}

pub fn check_graph(s: &str, inputs: Inputs) -> Result<(), String> {
    if s.len() > 8 * 1024 * 1024 {
        return Err(tr!("граф больше 8 МБ", "the graph is larger than 8 MB").into());
    }
    if s.contains('\0') {
        return Err(tr!("недопустимый символ в графе", "invalid character in the graph").into());
    }
    let filters = parse_graph(s)?;
    if filters.is_empty() {
        return Err(tr!("пустой граф", "empty graph").into());
    }
    for f in &filters {
        if DENY_FILTERS.contains(&f.name.to_ascii_lowercase().as_str()) {
            return Err(tr!("фильтр «{}» не разрешён", "filter \"{}\" is not allowed", f.name));
        }
        if f.name == "ass" {
            check_ass(f, inputs)?;
            continue;
        }
        // VAAPI (exportPlan.js exportCommand): кадры в память видеокарты — без опций; плагинам недоступен
        if f.name == "hwupload" {
            if !f.opts.is_empty() {
                return Err(tr!("у фильтра hwupload не должно быть опций", "filter hwupload must have no options").into());
            }
            continue;
        }
        if !plugins::is_safe_filter(&f.name) {
            return Err(tr!("фильтр «{}» не разрешён", "filter \"{}\" is not allowed", f.name));
        }
        let mut positional = 0;
        for (k, v) in &f.opts {
            match k {
                Some(k) => {
                    if !valid_key(k) || forbidden_key(k) {
                        return Err(tr!("опция «{}» фильтра {} не разрешена", "option \"{}\" of filter {} is not allowed", k, f.name));
                    }
                }
                None => positional += 1,
            }
            if hidden_danger(v) {
                return Err(tr!("недопустимое значение опции фильтра {}: {}", "invalid option value of filter {}: {}", f.name, v));
            }
        }
        if positional > max_positional(&f.name) {
            return Err(tr!("слишком много позиционных опций у фильтра {}", "too many positional options for filter {}", f.name));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Аргументы FFmpeg
// ---------------------------------------------------------------------------
#[derive(Clone, Copy)]
enum V {
    Flag,
    Num,
    Bitrate,
    Word,
    Enum(&'static [&'static str]),
    Map,
    Input,
    Filter,
    /// -metadata:s:s:N: language=<2–3 строчные латинские> | title=<1–64 символа без управляющих>
    SubMeta,
    /// -vaapi_device /dev/dri/renderD<N>
    VaapiDevice,
}

/// «<prefix><N>», N — 1–3 цифры (номер потока субтитров)
fn stream_opt(opt: &str, prefix: &str) -> bool {
    opt.strip_prefix(prefix).is_some_and(|n| (1..=3).contains(&n.len()) && n.bytes().all(|c| c.is_ascii_digit()))
}

fn is_sub_meta(v: &str) -> bool {
    if let Some(l) = v.strip_prefix("language=") {
        return (2..=3).contains(&l.len()) && l.bytes().all(|c| c.is_ascii_lowercase());
    }
    if let Some(t) = v.strip_prefix("title=") {
        return (1..=64).contains(&t.chars().count()) && !t.chars().any(char::is_control);
    }
    false
}

const VCODECS: &[&str] = &[
    "libx264",
    "libx265",
    "libsvtav1",
    "libvpx-vp9",
    "h264_nvenc",
    "hevc_nvenc",
    "av1_nvenc",
    // M0.4: Intel Quick Sync, AMD AMF, VAAPI (Linux)
    "h264_qsv",
    "hevc_qsv",
    "av1_qsv",
    "h264_amf",
    "hevc_amf",
    "av1_amf",
    "h264_vaapi",
    "hevc_vaapi",
];

/// Видеокодек плана кодирует на видеокарте (export.rs занимает слот GPU в queue.rs)
pub fn gpu_codec(c: &str) -> bool {
    VCODECS.contains(&c) && ["_nvenc", "_qsv", "_amf", "_vaapi"].iter().any(|s| c.ends_with(s))
}

/// -vaapi_device: только узел /dev/dri/renderD<N>
fn is_vaapi_device(v: &str) -> bool {
    v.strip_prefix("/dev/dri/renderD").is_some_and(|n| (1..=4).contains(&n.len()) && n.bytes().all(|c| c.is_ascii_digit()))
}

/// Опции из exportPlan.js exportCommand/encoderArgs и animRain.js rainBakePlan
fn spec(opt: &str) -> Option<V> {
    Some(match opt {
        "-hide_banner" | "-y" | "-nostdin" | "-nostats" | "-an" => V::Flag,
        "-i" => V::Input,
        "-/filter_complex" | "-filter_complex_script" => V::Filter,
        "-map" => V::Map,
        "-c:v" => V::Enum(VCODECS),
        // 0.4.1: в MKV/MOV ещё FLAC и PCM (без потерь)
        "-c:a" => V::Enum(&["aac", "libopus", "flac", "pcm_s16le", "pcm_s24le", "libmp3lame", "libvorbis"]),
        "-preset" | "-tune" | "-rc" | "-profile:v" | "-pix_fmt" => V::Word,
        "-cq" | "-crf" | "-g" | "-spatial-aq" | "-temporal-aq" | "-rc-lookahead" | "-cpu-used" | "-row-mt" | "-auto-alt-ref" | "-loop"
        | "-framerate" | "-t" | "-ss" | "-ar" | "-r" => V::Num,
        "-b:v" | "-b:a" => V::Bitrate,
        "-tag:v" => V::Enum(&["hvc1", "hev1", "avc1"]),
        "-fps_mode" | "-vsync" => V::Enum(&["cfr", "vfr", "passthrough", "auto"]),
        "-movflags" => V::Enum(&["+faststart"]),
        // 0.4.1: GIF и «только звук» (mp3, m4a = mp4, wav, ogg)
        "-f" => V::Enum(&["mp4", "mov", "webm", "matroska", "gif", "mp3", "wav", "ogg"]),
        "-progress" => V::Enum(&["pipe:1"]),
        "-deadline" => V::Enum(&["realtime", "good", "best"]),
        // M0.4: качество qsv (-global_quality), amf (-usage/-quality/-qp_*), vaapi (-rc_mode/-qp) — exportPlan.js encoderArgs
        "-global_quality" | "-qp" | "-qp_i" | "-qp_p" | "-qp_b" => V::Num,
        "-usage" => V::Enum(&["transcoding", "high_quality"]),
        "-quality" => V::Enum(&["speed", "balanced", "quality", "high_quality"]),
        "-rc_mode" => V::Enum(&["CQP", "ICQ", "VBR", "CBR", "QVBR", "AVBR", "auto"]),
        "-vaapi_device" => V::VaapiDevice,
        // M5: мягкие субтитры
        "-c:s" => V::Enum(&["mov_text", "srt", "ass", "webvtt"]),
        _ if stream_opt(opt, "-metadata:s:s:") => V::SubMeta,
        _ if stream_opt(opt, "-disposition:s:") => V::Enum(&["default", "0"]),
        // 0.4.1: аудиодорожки отдельными потоками (MKV/MOV) — название и язык потока
        _ if stream_opt(opt, "-metadata:s:a:") => V::SubMeta,
        _ if stream_opt(opt, "-disposition:a:") => V::Enum(&["default", "0"]),
        _ => return None,
    })
}

fn is_num(v: &str) -> bool {
    let v = v.strip_prefix('-').unwrap_or(v);
    let (a, b) = v.split_once('.').unwrap_or((v, "0"));
    !a.is_empty()
        && a.len() <= 12
        && a.bytes().all(|c| c.is_ascii_digit())
        && !b.is_empty()
        && b.len() <= 9
        && b.bytes().all(|c| c.is_ascii_digit())
}

fn is_word(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 32
        && v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'+' || c == b'.')
        && !v.starts_with('-')
}

/// -map: метка графа [x] или поток входа 0:v / 1:a:0
fn is_map(v: &str) -> bool {
    if let Some(l) = v.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
        return !l.is_empty() && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_');
    }
    let mut parts = v.split(':');
    parts.next().is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
        && parts.all(|x| matches!(x, "v" | "a" | "s") || (!x.is_empty() && x.bytes().all(|c| c.is_ascii_digit())))
}

fn norm(p: &Path) -> String {
    let n = paths::normalize(p).to_string_lossy().to_string();
    if cfg!(windows) {
        n.to_lowercase().replace('/', "\\")
    } else {
        n
    }
}

fn under(p: &Path, dir: &Path) -> bool {
    let sep = if cfg!(windows) { "\\" } else { "/" };
    norm(p).starts_with(&format!("{}{sep}", norm(dir).trim_end_matches(sep)))
}

/// Строку FFmpeg понял бы как адрес протокола, а не как файл (libavformat/avio.c url_find_protocol):
/// «схема:» из [A-Za-z0-9+-.] (concat:, file:, http:, subfile:, pipe:, tcp:, data:…) или «subfile,,…:».
/// Путь диска Windows «C:\…» — не адрес.
fn looks_like_url(s: &str) -> bool {
    let b = s.as_bytes();
    let dos = cfg!(windows) && b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if dos {
        return false;
    }
    let n = b.iter().take_while(|c| c.is_ascii_alphanumeric() || b"+-.".contains(c)).count();
    (n > 0 && b.get(n) == Some(&b':')) || s.to_ascii_lowercase().starts_with("subfile,")
}

/// Пространства устройств Windows (\\.\pipe\…, \\?\GLOBALROOT…) — не файлы
fn device_path(s: &str) -> bool {
    let s = s.replace('/', "\\");
    s.starts_with("\\\\.\\") || s.starts_with("\\\\?\\")
}

fn input_ok(v: &str, inputs: Inputs) -> Result<PathBuf, String> {
    let p = PathBuf::from(v);
    let bad = || tr!("входной файл не разрешён: {}", "input file is not allowed: {}", v);
    if v.is_empty() || v.contains(['\0', '\n', '\r']) || looks_like_url(v) || device_path(v) || !p.is_absolute() {
        return Err(bad());
    }
    #[cfg(test)]
    {
        if inputs == Inputs::Any {
            return Ok(p);
        }
    }
    if !p.is_file() {
        return Err(bad());
    }
    let ok = match inputs {
        Inputs::Engine => true,
        // Медиа проекта (открытые окном через импорт), кэш медиа, файлы экспорта (тексты, субтитры), папка плагинов
        Inputs::Window => protocol::is_allowed(&p) || under(&p, &crate::assets::dir()) || under(&p, &paths::get().plugins_dir),
        #[cfg(test)]
        Inputs::Any => true,
    };
    if ok {
        Ok(p)
    } else {
        Err(bad())
    }
}

const OUT_EXT: &[&str] = &["mp4", "mov", "mkv", "webm", "gif", "mp3", "m4a", "wav", "ogg"];

// ---------------------------------------------------------------------------
// Выходные файлы, выданные программой (M0.2)
// ---------------------------------------------------------------------------
/// Пути, которые пользователь выбрал в диалоге (export_pick), выдала программа (export_default_path)
/// или передал ИИ-клиент в export_video (control.rs). Окно может экспортировать только в них или в папку кэша.
static GRANTED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
const GRANTED_MAX: usize = 256;

/// Разрешить окну экспорт в этот файл (путь — абсолютный)
pub fn grant_output(p: &Path) {
    if !p.is_absolute() {
        return;
    }
    let n = norm(p);
    let mut g = GRANTED.lock().unwrap_or_else(|e| e.into_inner());
    g.retain(|x| x != &n);
    g.push(n);
    if g.len() > GRANTED_MAX {
        let extra = g.len() - GRANTED_MAX;
        g.drain(..extra);
    }
}

fn output_granted(p: &Path) -> bool {
    let n = norm(p);
    GRANTED.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|x| x == &n)
}

/// Выход окна: выданный путь или файл внутри папки кэша программы (запекание анимаций, автотесты)
fn output_ok(out: &Path, inputs: Inputs) -> bool {
    match inputs {
        Inputs::Window => output_granted(out) || under(out, &paths::get().cache_dir),
        Inputs::Engine => true,
        #[cfg(test)]
        Inputs::Any => true,
    }
}

/// Проверка аргументов, графа и выходного файла. Ошибка — уже с префиксом «План экспорта отклонён: …».
pub fn check(args: &[String], filter: &str, duration: f64, output: &str, inputs: Inputs) -> Result<(), String> {
    check_inner(args, filter, duration, output, inputs).map_err(|e| tr!("План экспорта отклонён: {}", "Export plan rejected: {}", e))
}

/// План звука дорожки для аудиоплагинов (vst/mod.rs render): как экспорт, но выход — сырой PCM в stdout,
/// поэтому -f не допускается (формат выхода ставит программа), а @@OUT@@ заменяется на pipe:1.
pub fn check_pcm(args: &[String], filter: &str, duration: f64, inputs: Inputs) -> Result<(), String> {
    if args.iter().any(|a| a == "-f") {
        return Err(tr!("План экспорта отклонён: {}", "Export plan rejected: {}", tr!("-f не разрешён", "-f is not allowed")));
    }
    let out = crate::cache::audiofx_dir().join("pipe.mkv");
    check(args, filter, duration, &out.to_string_lossy(), inputs)
}

/// Цепочка фильтров одной стадии рендера (встроенные эффекты между плагинами): те же правила, что у графа экспорта
pub fn check_chain(af: &str, inputs: Inputs) -> Result<(), String> {
    check_graph(af, inputs).map_err(|e| tr!("План экспорта отклонён: {}", "Export plan rejected: {}", e))
}

/// Входной файл, разрешённый окну (или любой — у движка без окна)
pub fn input_allowed(v: &str, inputs: Inputs) -> Result<PathBuf, String> {
    input_ok(v, inputs)
}

fn check_inner(args: &[String], filter: &str, duration: f64, output: &str, inputs: Inputs) -> Result<(), String> {
    let out = PathBuf::from(output);
    let ext = crate::ff::ext_of(&out);
    if !out.is_absolute() || !OUT_EXT.contains(&ext.as_str()) || output.contains(['\n', '\r']) {
        return Err(tr!(
            "выходной файл должен быть абсолютным путём .mp4/.mov/.mkv/.webm/.gif/.mp3/.m4a/.wav/.ogg: {}",
            "the output must be an absolute .mp4/.mov/.mkv/.webm/.gif/.mp3/.m4a/.wav/.ogg path: {}",
            output
        ));
    }
    if output.contains('\0') || looks_like_url(output) || device_path(output) || !output_ok(&out, inputs) {
        return Err(tr!("выходной файл не выбран в окне сохранения: {}", "the output file was not chosen in the save dialog: {}", output));
    }
    if !duration.is_finite() || !(0.0..=7.0 * 24.0 * 3600.0).contains(&duration) {
        return Err(tr!("неверная длительность", "invalid duration").into());
    }
    if args.len() > 20000 {
        return Err(tr!("слишком много аргументов", "too many arguments").into());
    }
    let (mut n_filter, mut n_out, mut seen_format) = (0, 0, false);
    let mut ins: Vec<PathBuf> = vec![];
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "@@OUT@@" {
            n_out += 1;
            if i != args.len() - 1 {
                return Err(tr!("@@OUT@@ должен быть последним аргументом", "@@OUT@@ must be the last argument").into());
            }
            i += 1;
            continue;
        }
        let Some(kind) = spec(a) else { return Err(tr!("неизвестный аргумент «{}»", "unknown argument \"{}\"", a)) };
        if let V::Flag = kind {
            i += 1;
            continue;
        }
        let Some(v) = args.get(i + 1).map(String::as_str) else { return Err(tr!("нет значения у {}", "no value for {}", a)) };
        let ok = match kind {
            V::Flag => true,
            V::Num => is_num(v),
            V::Bitrate => {
                let n = v.trim_end_matches(['k', 'K', 'm', 'M']);
                is_num(n) && !n.starts_with('-') && v.len() - n.len() <= 1
            }
            V::Word => is_word(v),
            V::Enum(list) => list.contains(&v),
            V::Map => is_map(v),
            V::SubMeta => is_sub_meta(v),
            V::VaapiDevice => is_vaapi_device(v),
            V::Filter => {
                n_filter += 1;
                v == "@@FILTER@@"
            }
            V::Input => {
                // -f перед -i выбрал бы демультиплексор входа (concat, lavfi…) — -f только для выхода
                if seen_format {
                    return Err(tr!("-f перед -i не разрешён", "-f before -i is not allowed").into());
                }
                ins.push(input_ok(v, inputs)?);
                true
            }
        };
        if a == "-f" {
            seen_format = true;
        }
        if !ok {
            return Err(tr!("недопустимое значение {} {}", "invalid value {} {}", a, v));
        }
        i += 2;
    }
    if n_filter != 1 {
        return Err(tr!("граф (@@FILTER@@) должен быть указан ровно один раз", "the graph (@@FILTER@@) must be given exactly once").into());
    }
    if n_out != 1 {
        return Err(tr!("@@OUT@@ должен быть указан ровно один раз", "@@OUT@@ must be given exactly once").into());
    }
    if ins.is_empty() {
        return Err(tr!("нет входных файлов", "no input files").into());
    }
    let o = norm(&out);
    let part = norm(Path::new(&format!("{output}.part")));
    if ins.iter().any(|p| {
        let n = norm(p);
        n == o || n == part
    }) {
        return Err(tr!("выходной файл совпадает со входным", "the output file is the same as an input").into());
    }
    check_graph(filter, inputs)
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn abs(name: &str) -> String {
        if cfg!(windows) {
            format!("C:\\media\\{name}")
        } else {
            format!("/media/{name}")
        }
    }

    /// Граф как у exportPlan.js: переход «жалюзи» (custom expr в кавычках), наложение с enable='between(…)', звук
    fn real_graph() -> String {
        [
            "[0:v]setpts=PTS-STARTPTS,hue=s=0,fps=30,scale=640:360:force_original_aspect_ratio=decrease:flags=lanczos,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x000000,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=2.500000,trim=duration=3.500000,setpts=PTS-STARTPTS[s0]",
            "color=c=0x000000:s=640x360:r=30,format=yuv420p,setsar=1,trim=duration=1.000000,setpts=PTS-STARTPTS[g1]",
            "[1:v]setpts=(PTS-STARTPTS)/2.000000,crop=w=trunc(iw*0.500000/2)*2:h=trunc(ih*1.000000/2)*2:x=iw*0.000000:y=ih*0.000000,fps=30,scale=640:360:flags=lanczos,setsar=1,format=yuv420p,tpad=start_mode=clone:start_duration=0.500000,trim=duration=3.000000,setpts=PTS-STARTPTS,fade=t=in:st=0.500000:d=1.000000:color=0x000000[s1]",
            "[s0][s1]xfade=transition=custom:expr='if(lt(mod(X,W/10),(1-P)*W/10),B,A)':duration=1.000000:offset=2.500000[x1]",
            "[x1]format=yuv420p[vbase]",
            "[2:v]trim=duration=2.000000,setpts=PTS-STARTPTS+1.000000/TB,fps=30,scale=640:360,format=yuva420p[ov0]",
            "[vbase][ov0]overlay=0:0:format=auto:eof_action=pass:enable='between(t,1,2)',format=yuv420p[vout]",
            "[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atempo=2.000000,volume=1.000000,equalizer=f=440.0:t=q:w=1:g=3.00,afftdn=nr=12.0:nf=-50.0,asetpts=PTS-STARTPTS,apad,atrim=duration=3.500000,afade=t=in:st=0:d=1.000000,adelay=delays=0:all=1[va0]",
            "[va0][m0]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration=6.000000,alimiter=limit=0.98:attack=5:release=50:level=0[aout]",
            "[3:a:1]pan=stereo|c0=c0|c1=0*c0,acompressor=threshold=1.000000:makeup=4[m0]",
        ].join(";\n")
    }

    /// Граф как у animRain.js rainBakePlan
    fn rain_graph() -> String {
        [
            "color=c=black@0.0:s=320x180:r=30:d=2.000000,format=rgba[bg]",
            "[0:v]format=rgba,split=2[s0][s1]",
            "[s0]scale=20:10:flags=lanczos,rotate=a='(120+90.000000*t)*PI/180':c=none:ow=23:oh=23[p0]",
            "[bg][p0]overlay=x='-w+(W+w)*((0.100000+0.100000*t)-floor(0.100000+0.100000*t))':y='-h+(H+h)*((0.5+1*t)-floor(0.5+1*t))':format=auto:eof_action=pass[o0]",
            "[s1]scale=20:10:flags=lanczos,rotate=a='(5+0*t)*PI/180':c=none:ow=23:oh=23[p1]",
            "[o0][p1]overlay=x='-w':y='-h':format=auto:eof_action=pass[ov]",
            "[ov]format=yuva420p[vout]",
        ].join(";\n")
    }

    #[test]
    fn real_graphs_pass() {
        check_graph(&real_graph(), Inputs::Any).unwrap();
        check_graph(&rain_graph(), Inputs::Any).unwrap();
        let f = parse_graph(&real_graph()).unwrap();
        let x = f.iter().find(|f| f.name == "xfade").unwrap();
        assert_eq!(x.opts[1], (Some("expr".into()), "if(lt(mod(X,W/10),(1-P)*W/10),B,A)".into()));
        let o = f.iter().find(|f| f.name == "overlay").unwrap();
        assert!(o.opts.contains(&(Some("enable".into()), "between(t,1,2)".into())), "{:?}", o.opts);
        assert_eq!(o.opts[0], (None, "0".into()));
        let pan = f.iter().find(|f| f.name == "pan").unwrap();
        assert_eq!(pan.opts, vec![(None, "stereo|c0=c0|c1=0*c0".into())]);
        // «black@0.0» — значение, не имя экземпляра; имя фильтра с @экземпляром тоже понимаем
        assert_eq!(parse_graph("color@bg=c=black@0.0").unwrap()[0].name, "color");
    }

    /// M1.7: значение, экранированное js/core/ffEscape.js ffValue (тот же вектор — в tests/ffescape-test.js),
    /// доходит до опции фильтра без изменений, а разделители внутри него не режут граф
    #[test]
    fn ffescape_vectors() {
        let g = r"drawbox=c=C\\:/a\\\'b/\[x\]\,y\;z\\\\w.png:t=2,null";
        let f = parse_graph(g).unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].opts, vec![(Some("c".into()), r"C:/a'b/[x],y;z\w.png".into()), (Some("t".into()), "2".into())]);
        assert_eq!(f[1].name, "null");
    }

    #[test]
    fn dangerous_graphs_rejected() {
        for g in [
            "movie=/etc/passwd[v]",
            "[0:v]null[a];amovie=C\\:/x.wav[b]",
            "sendcmd=f=cmds.txt,null",
            "sendcmd=c='0 hue s 0'",
            "[0:v]lut3d=file=/x.cube[v]",
            "[0:v]lut3d=/x.cube[v]",
            "[0:v]curves=psfile=/x.acv[v]",
            "[0:v]curves=PSFILE=/x.acv[v]",
            "[0:v]curves=none:a:b:c:d:e:/x.acv[v]",
            "[0:v]selectivecolor=psfile=x.asv[v]",
            "[0:a]firequalizer=dumpfile=/tmp/x[a]",
            "[0:v]hue=/s=/tmp/value.txt[v]",
            "[0:v]hue='s=0:psfile=/x'[v]",
            "[0:v]curves='preset=none:psfile=/x.acv'[v]",
            "[0:v]curves=preset\\=none\\:psfile\\=/x[v]",
            "[0:v]drawtext=text=hi[v]",
            "[0:v]subtitles=x.srt[v]",
            "sws_flags=bicubic;[0:v]null[v]",
            "[0:v]hue=s=0[v] garbage",
            "[0:v]=s=0[v]",
            "[0:v]hue==0[v]",
            "",
        ] {
            assert!(check_graph(g, Inputs::Any).is_err(), "должен быть отклонён: {g}");
            // i18n-ignore — тест
        }
    }

    /// Путь как значение опции в графе — так же, как js/core/ffEscape.js ffPath: «\» → «/», затем «\ ' :» и «\ ' [ ] , ;»
    fn ff_path(p: &str) -> String {
        let p = p.replace('\\', "/");
        let opt: String = p.chars().flat_map(|c| if "\\':".contains(c) { vec!['\\', c] } else { vec![c] }).collect();
        opt.chars().flat_map(|c| if "\\'[],;".contains(c) { vec!['\\', c] } else { vec![c] }).collect()
    }

    #[test]
    fn ass_filter() {
        let (a, fonts) = if cfg!(windows) { (r"C:\x\a.ass", r"C:\x\fonts") } else { ("/x/a.ass", "/x/fonts") };
        let g = format!("[vout0]ass=filename={}:fontsdir={}[vout]", ff_path(a), ff_path(fonts));
        if cfg!(windows) {
            assert_eq!(g, r"[vout0]ass=filename=C\\:/x/a.ass:fontsdir=C\\:/x/fonts[vout]");
        }
        check_graph(&g, Inputs::Any).unwrap();
        let f = parse_graph(&g).unwrap();
        assert_eq!(f[0].opts[0].1, a.replace('\\', "/"));
        // позиционное имя файла, f=, остальные опции
        check_graph(&format!("[v]ass={}:original_size=1920x1080:shaping=complex:alpha=1[o]", ff_path(a)), Inputs::Any).unwrap();
        check_graph(&format!("[v]ass=f={}[o]", ff_path(a)), Inputs::Any).unwrap();
        let fs = ff_path(fonts);
        let rel = "ass=filename=sub/a.ass";
        for g in [
            rel.to_string(),
            format!("ass=filename={}", ff_path(&a.replace(".ass", ".srt"))),
            format!("ass=filename={}:fontsdir={fs}:force_style=FontName\\\\=X", ff_path(a)),
            format!("ass=filename={}:charenc=cp1251", ff_path(a)),
            format!("ass=filename={}:fontsdir=fonts", ff_path(a)),
            format!("ass={}:{fs}", ff_path(a)),
            format!("ass=filename={}:f={}", ff_path(a), ff_path(a)),
            format!("ass=filename={}:original_size=big", ff_path(a)),
            format!("ass=filename={}:shaping=x", ff_path(a)),
            format!("ass=/filename={}", ff_path(a)),
            "ass".to_string(),
            format!("[0:v]subtitles={}[v]", ff_path(a)),
            format!("[0:v]subtitles=filename={}[v]", ff_path(a)),
        ] {
            assert!(check_graph(&g, Inputs::Any).is_err(), "должен быть отклонён: {g}");
            // i18n-ignore — тест
        }
        // плагинам ass недоступен
        assert!(!plugins::is_safe_filter("ass"));
        // окно: файл только из <кэш>/export-assets, а такого файла нет
        assert!(check_graph(&g, Inputs::Window).is_err());
    }

    #[test]
    fn ass_filter_engine_and_window() {
        let dir = std::env::temp_dir().join(format!("ffm-ass-{}", std::process::id()));
        let fonts = dir.join("fonts");
        std::fs::create_dir_all(&fonts).unwrap();
        let sub = dir.join("a b'c.ass");
        std::fs::write(&sub, b"[Script Info]\n").unwrap();
        let srt = dir.join("a.srt");
        std::fs::write(&srt, b"1\n").unwrap();
        let p = |x: &Path| ff_path(&x.to_string_lossy());
        let g = format!("[vout0]ass=filename={}:fontsdir={}[vout]", p(&sub), p(&fonts));
        check_graph(&g, Inputs::Engine).unwrap();
        // нет файла / нет папки шрифтов / .srt
        assert!(check_graph(&format!("ass=filename={}", p(&dir.join("nope.ass"))), Inputs::Engine).is_err());
        assert!(check_graph(&format!("ass=filename={}:fontsdir={}", p(&sub), p(&dir.join("nofonts"))), Inputs::Engine).is_err());
        assert!(check_graph(&format!("ass=filename={}", p(&srt)), Inputs::Engine).is_err());
        // окно: временная папка — не <кэш>/export-assets
        assert!(check_graph(&g, Inputs::Window).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subtitle_args() {
        let inp = abs("a.mp4");
        let sub = abs("subs.srt");
        let mut a: Vec<String> = [
            "-hide_banner",
            "-y",
            "-i",
            &inp,
            "-i",
            &sub,
            "-/filter_complex",
            "@@FILTER@@",
            "-map",
            "[vout]",
            "-map",
            "1:s",
            "-c:v",
            "libx264",
            "-c:s",
            "mov_text",
            "-metadata:s:s:0",
            "language=rus",
            "-metadata:s:s:0",
            "title=Русские",
            "-disposition:s:0",
            "default", // i18n-ignore — тест
            "-f",
            "mp4",
            "@@OUT@@",
        ]
        .iter()
        .map(|x| x.to_string())
        .collect();
        check(&a, &real_graph(), 6.0, &abs("out.mp4"), Inputs::Any).unwrap();
        for c in ["srt", "ass", "webvtt"] {
            let i = a.iter().position(|x| x == "-c:s").unwrap();
            a[i + 1] = c.into();
            check(&a, &real_graph(), 6.0, &abs("out.mkv"), Inputs::Any).unwrap();
        }
        let with = |from: &str, to: &[&str]| {
            let mut b = a.clone();
            let i = b.iter().position(|x| x == from).unwrap();
            b.splice(i..i + 2, to.iter().map(|x| x.to_string()));
            check(&b, &real_graph(), 6.0, &abs("out.mp4"), Inputs::Any)
        };
        assert!(with("-c:s", &["-c:s", "copy"]).is_err());
        assert!(with("-c:s", &["-c:s", "dvd_subtitle"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata:s:s:0", "foo=bar"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata:s:s:0", "language=RUS"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata:s:s:0", "language=russian"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata", "title=x"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata:s:v:0", "language=rus"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata:s:s:x", "language=rus"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata:s:s:0", "title=a\nb"]).is_err());
        assert!(with("-metadata:s:s:0", &["-metadata:s:s:0", &format!("title={}", "x".repeat(65))]).is_err());
        assert!(with("-disposition:s:0", &["-disposition:s:0", "forced"]).is_err());
        assert!(with("-disposition:s:0", &["-disposition:s:0", "0"]).is_ok());
    }

    fn export_args(input: &str) -> Vec<String> {
        let mut a: Vec<&str> = vec![
            "-hide_banner",
            "-y",
            "-nostdin",
            "-loop",
            "1",
            "-framerate",
            "30",
            "-t",
            "5.500000",
            "-i",
            input,
            "-ss",
            "1.000000",
            "-t",
            "3.500000",
            "-i",
            input,
            "-c:v",
            "libvpx-vp9",
            "-ss",
            "0.000000",
            "-t",
            "2.000000",
            "-i",
            input,
            "-/filter_complex",
            "@@FILTER@@",
            "-map",
            "[vout]",
            "-map",
            "[aout]",
        ];
        a.extend([
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p5",
            "-tune",
            "hq",
            "-rc",
            "vbr",
            "-cq",
            "23",
            "-b:v",
            "0",
            "-spatial-aq",
            "1",
            "-temporal-aq",
            "1",
            "-rc-lookahead",
            "20",
            "-profile:v",
            "high",
            "-g",
            "60",
            "-fps_mode",
            "cfr",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-t",
            "6.000000",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            "-progress",
            "pipe:1",
            "-nostats",
            "@@OUT@@",
        ]);
        a.into_iter().map(String::from).collect()
    }

    #[test]
    fn export_plan_ok() {
        let inp = abs("a.mp4");
        check(&export_args(&inp), &real_graph(), 6.0, &abs("out.mp4"), Inputs::Any).unwrap();
        // все кодеки encoderArgs
        for enc in [
            vec![
                "-c:v",
                "av1_nvenc",
                "-preset",
                "p5",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                "33",
                "-b:v",
                "0",
                "-spatial-aq",
                "1",
                "-rc-lookahead",
                "20",
                "-g",
                "60",
            ],
            vec![
                "-c:v",
                "hevc_nvenc",
                "-preset",
                "p5",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                "26",
                "-b:v",
                "0",
                "-spatial-aq",
                "1",
                "-temporal-aq",
                "1",
                "-rc-lookahead",
                "20",
                "-g",
                "60",
                "-tag:v",
                "hvc1",
            ],
            vec!["-c:v", "libx265", "-preset", "medium", "-crf", "24", "-g", "60", "-tag:v", "hvc1"],
            vec!["-c:v", "libsvtav1", "-preset", "8", "-crf", "33", "-g", "60"],
            vec!["-c:v", "libx264", "-preset", "medium", "-crf", "21", "-profile:v", "high", "-g", "60"],
        ] {
            let mut a: Vec<String> = [
                "-hide_banner",
                "-y",
                "-nostdin",
                "-ss",
                "0.000000",
                "-t",
                "4.5",
                "-i",
                &inp,
                "-filter_complex_script",
                "@@FILTER@@",
                "-map",
                "[vout]",
                "-map",
                "[aout]",
            ]
            .iter()
            .map(|x| x.to_string())
            .collect();
            a.extend(enc.iter().map(|x| x.to_string()));
            a.extend(
                [
                    "-vsync",
                    "cfr",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-ar",
                    "48000",
                    "-t",
                    "4.000000",
                    "-movflags",
                    "+faststart",
                    "-f",
                    "mp4",
                    "-progress",
                    "pipe:1",
                    "-nostats",
                    "@@OUT@@",
                ]
                .iter()
                .map(|x| x.to_string()),
            );
            check(&a, &real_graph(), 4.0, &abs("out.mp4"), Inputs::Any).unwrap();
        }
        // rainBakePlan
        let rain: Vec<String> = [
            "-hide_banner",
            "-y",
            "-nostdin",
            "-loop",
            "1",
            "-framerate",
            "30",
            "-t",
            "2.500000",
            "-i",
            &abs("sprite.png"),
            "-/filter_complex",
            "@@FILTER@@",
            "-map",
            "[vout]",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-b:v",
            "0",
            "-crf",
            "32",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-row-mt",
            "1",
            "-auto-alt-ref",
            "0",
            "-t",
            "2.000000",
            "-an",
            "-f",
            "webm",
            "-progress",
            "pipe:1",
            "-nostats",
            "@@OUT@@",
        ]
        .iter()
        .map(|x| x.to_string())
        .collect();
        check(&rain, &rain_graph(), 2.0, &abs("rain-1.webm"), Inputs::Any).unwrap();
    }

    #[test]
    fn export_plan_rejected() {
        let inp = abs("a.mp4");
        let out = abs("out.mp4");
        let base = export_args(&inp);
        let with = |f: &dyn Fn(&mut Vec<String>)| {
            let mut a = base.clone();
            f(&mut a);
            check(&a, &real_graph(), 6.0, &out, Inputs::Any)
        };
        let at = |a: &Vec<String>, s: &str| a.iter().position(|x| x == s).unwrap();
        // лишний путь в аргументах
        assert!(with(&|a| {
            let i = at(a, "@@OUT@@");
            a.insert(i, abs("other.mp4"));
        })
        .is_err());
        // второй выход / путь вместо @@OUT@@
        assert!(with(&|a| {
            let n = a.len();
            a[n - 1] = abs("x.mp4");
        })
        .is_err());
        assert!(with(&|a| a.push("@@OUT@@".into())).is_err());
        // неизвестные опции, опасные значения
        assert!(with(&|a| {
            a.insert(0, "-filter_script".into());
            a.insert(1, "/tmp/x".into());
        })
        .is_err());
        assert!(with(&|a| {
            a.insert(0, "-dump_attachment:t".into());
            a.insert(1, "/tmp/x".into());
        })
        .is_err());
        assert!(with(&|a| {
            let i = at(a, "-preset");
            a[i + 1] = "p5:x=/tmp/y".into();
        })
        .is_err());
        assert!(with(&|a| {
            let i = at(a, "-c:v");
            a[i + 1] = "copy".into();
        })
        .is_err());
        assert!(with(&|a| {
            let i = at(a, "-map");
            a[i + 1] = "[vout];movie".into();
        })
        .is_err());
        // -f перед -i, относительный вход, второй граф, нет графа
        assert!(with(&|a| {
            a.insert(3, "-f".into());
            a.insert(4, "mp4".into());
        })
        .is_err());
        assert!(with(&|a| {
            let i = at(a, "-i");
            a[i + 1] = "a.mp4".into();
        })
        .is_err());
        assert!(with(&|a| {
            a.insert(3, "-/filter_complex".into());
            a.insert(4, "@@FILTER@@".into());
        })
        .is_err());
        assert!(with(&|a| {
            let i = at(a, "-/filter_complex");
            a[i + 1] = abs("graph.txt");
        })
        .is_err());
        // выходной файл
        assert!(check(&base, &real_graph(), 6.0, "out.mp4", Inputs::Any).is_err());
        assert!(check(&base, &real_graph(), 6.0, &abs("out.exe"), Inputs::Any).is_err());
        assert!(check(&base, &real_graph(), 6.0, &inp, Inputs::Any).is_err());
        assert!(check(&base, &real_graph(), f64::NAN, &out, Inputs::Any).is_err());
        // граф с movie
        assert!(check(&base, "movie=x.mp4[vout]", 6.0, &out, Inputs::Any).is_err());
    }

    /// M0.2: опасное в любом месте графа — в т.ч. спрятанное в значении опции через экранирование и кавычки
    #[test]
    fn nested_dangers_rejected() {
        for g in [
            "[0:v]hue=s=0\\,movie=/etc/passwd[v]",
            "[0:v]hue='s=0,movie=/x'[v]",
            "[0:v]hue=s='0;amovie=x.wav'[v]",
            "[0:v]null[a];\n  [a] movie=x.mp4 [v]",
            "[0:v]null,'movie'=x[v]",
            "[0:v]null,mov\\ie=x[v]",
            "[0:v]null,movie@m=x[v]",
            "[0:v]null[a];amovie=x.wav,anull[b]",
            "[0:v]null,sendcmd=c='0 hue s 0'[v]",
            "[0:v]null,zmq[v]",
            "[0:a]azmq,anull[a]",
            "[0:v]eq=contrast='1+0*sendcmd'[v]",
            "[0:v]drawbox=c=red:filename=/x[v]",
            "[0:v]drawbox=c=red:textfile=/x[v]",
            "[0:v]drawbox=c='red:file=/x'[v]",
            "[0:v]scale=w=iw:custom_shader_path=/x.glsl[v]",
            "[0:v]scale=iw:ih:log_path=/tmp/x[v]",
            "[0:v]subtitles=f=x.srt[v]",
            "[0:v]drawtext=textfile=x.txt[v]",
            "[0:v]lut3d=x.cube[v]",
            "[0:v]hwupload=derive_device=vaapi[v]",
            "[0:v]null\0,movie=x[v]",
        ] {
            assert!(check_graph(g, Inputs::Any).is_err(), "должен быть отклонён: {g:?}");
            // i18n-ignore — тест
        }
        // список запрещённых фильтров не пересекается с белым списком
        for f in DENY_FILTERS {
            assert!(!plugins::is_safe_filter(f), "{f} в SAFE_FILTERS");
        } // i18n-ignore — тест
          // hwupload без опций (VAAPI) — можно
        check_graph("[vout]format=nv12,hwupload[vhw]", Inputs::Any).unwrap();
    }

    /// M0.2: опасные опции FFmpeg, протоколы во входах и в формате
    #[test]
    fn dangerous_args_rejected() {
        let inp = abs("a.mp4");
        let out = abs("out.mp4");
        let base = export_args(&inp);
        let with = |f: &dyn Fn(&mut Vec<String>)| {
            let mut a = base.clone();
            f(&mut a);
            check(&a, &real_graph(), 6.0, &out, Inputs::Any)
        };
        let at = |a: &Vec<String>, s: &str| a.iter().position(|x| x == s).unwrap();
        for opt in [
            "-filter_script",
            "-filter_script:v",
            "-/vf",
            "-vf",
            "-af",
            "-/af",
            "-filter_complex",
            "-attach",
            "-protocol_whitelist",
            "-safe",
            "-init_hw_device",
            "-filter_hw_device",
            "-dump_attachment:t",
            "-f:i",
            "-i:v",
            "-report",
            "-fflags",
            "-dn",
        ] {
            assert!(
                with(&|a| {
                    a.insert(0, opt.into());
                    a.insert(1, "x".into());
                })
                .is_err(),
                "{opt} должен быть отклонён"
            ); // i18n-ignore — тест
        }
        // -f с протоколами/демультиплексорами: и перед входом, и на выходе
        for fmt in ["concat", "file", "http", "concat:a|b", "file:/x", "http://x", "lavfi", "image2", "null"] {
            assert!(
                with(&|a| {
                    let i = at(a, "-f");
                    a[i + 1] = fmt.into();
                })
                .is_err(),
                "-f {fmt}"
            ); // i18n-ignore — тест
            assert!(
                with(&|a| {
                    a.insert(0, "-f".into());
                    a.insert(1, fmt.into());
                })
                .is_err(),
                "-f {fmt} before -i"
            ); // i18n-ignore — тест
        }
        // -i с протоколами и устройствами
        let drive = if cfg!(windows) { "C:\\a.mp4" } else { "/a.mp4" };
        for v in [
            format!("subfile,,start,0,end,0,,:{drive}"),
            format!("concat:{drive}|{drive}"),
            format!("file:{drive}"),
            "http://example.com/a.mp4".into(),
            "pipe:0".into(),
            "tcp://127.0.0.1:1234".into(),
            "data:video/mp4;base64,AAAA".into(),
            r"\\.\pipe\ffmontage-x".into(),
            r"\\?\GLOBALROOT\Device\x".into(),
            "-".into(),
            "".into(),
            format!("{drive}\nx"),
        ] {
            assert!(
                with(&|a| {
                    let i = at(a, "-i");
                    a[i + 1] = v.clone();
                })
                .is_err(),
                "-i {v:?}"
            ); // i18n-ignore — тест
        }
        // выход-протокол
        for o in ["file:C:/x.mp4", "concat:x.mp4", r"\\.\pipe\x.mp4", "pipe:1.mp4"] {
            assert!(check(&base, &real_graph(), 6.0, o, Inputs::Any).is_err(), "output {o}");
            // i18n-ignore — тест
        }
        assert!(looks_like_url("concat:a") && looks_like_url("SUBFILE,,x:y") && looks_like_url("file:/x"));
        assert!(!looks_like_url(&abs("a.mp4")));
    }

    /// M0.4: параметры кодировщиков qsv/amf/vaapi из exportPlan.js encoderArgs
    #[test]
    fn hw_encoders_pass() {
        let inp = abs("a.mp4");
        for enc in [
            vec!["-c:v", "h264_qsv", "-preset", "slow", "-global_quality", "23", "-profile:v", "high", "-g", "60"],
            vec!["-c:v", "hevc_qsv", "-preset", "slow", "-global_quality", "25", "-g", "60", "-tag:v", "hvc1"],
            vec!["-c:v", "av1_qsv", "-preset", "slow", "-global_quality", "28", "-g", "60"],
            vec![
                "-c:v",
                "h264_amf",
                "-usage",
                "transcoding",
                "-quality",
                "quality",
                "-rc",
                "cqp",
                "-qp_i",
                "23",
                "-qp_p",
                "25",
                "-qp_b",
                "27",
                "-profile:v",
                "high",
                "-g",
                "60",
            ],
            vec![
                "-c:v",
                "hevc_amf",
                "-usage",
                "transcoding",
                "-quality",
                "quality",
                "-rc",
                "cqp",
                "-qp_i",
                "26",
                "-qp_p",
                "28",
                "-g",
                "60",
                "-tag:v",
                "hvc1",
            ],
            vec![
                "-c:v",
                "av1_amf",
                "-usage",
                "transcoding",
                "-quality",
                "quality",
                "-rc",
                "cqp",
                "-qp_i",
                "130",
                "-qp_p",
                "138",
                "-g",
                "60",
            ],
            vec![
                "-vaapi_device",
                "/dev/dri/renderD128",
                "-c:v",
                "h264_vaapi",
                "-rc_mode",
                "CQP",
                "-qp",
                "24",
                "-profile:v",
                "high",
                "-g",
                "60",
            ],
            vec![
                "-vaapi_device",
                "/dev/dri/renderD129",
                "-c:v",
                "hevc_vaapi",
                "-rc_mode",
                "CQP",
                "-qp",
                "26",
                "-g",
                "60",
                "-tag:v",
                "hvc1",
            ],
        ] {
            let mut a: Vec<String> =
                ["-hide_banner", "-y", "-nostdin", "-i", &inp, "-/filter_complex", "@@FILTER@@", "-map", "[vout]", "-map", "[aout]"]
                    .iter()
                    .map(|x| x.to_string())
                    .collect();
            a.extend(enc.iter().map(|x| x.to_string()));
            a.extend(
                ["-fps_mode", "cfr", "-c:a", "aac", "-f", "mp4", "-progress", "pipe:1", "-nostats", "@@OUT@@"]
                    .iter()
                    .map(|x| x.to_string()),
            );
            check(&a, &real_graph(), 6.0, &abs("out.mp4"), Inputs::Any).unwrap();
            assert!(gpu_codec(enc[enc.iter().position(|x| *x == "-c:v").unwrap() + 1]));
        }
        assert!(!gpu_codec("libx264") && !gpu_codec("foo_nvenc"));
        for dev in ["/dev/sda", "/dev/dri/card0", "/dev/dri/renderD", "/dev/dri/renderD128/../x", "C:/x"] {
            assert!(!is_vaapi_device(dev), "{dev}");
        }
    }

    /// M0.2: окно — входы только разрешённые, выход только выданный программой (или в папке кэша)
    #[test]
    fn window_inputs_and_output() {
        let dir = std::env::temp_dir().join(format!("ffm-win-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let media = dir.join("clip.mp4");
        let other = dir.join("secret.mp4");
        std::fs::write(&media, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();
        protocol::allow(&media);
        let out = dir.join("Ролик.mp4"); // i18n-ignore — тест
        let o = out.to_string_lossy().to_string();
        let args = export_args(&media.to_string_lossy());
        // выход ещё не выдан
        assert!(check(&args, &real_graph(), 6.0, &o, Inputs::Window).is_err());
        grant_output(&out);
        check(&args, &real_graph(), 6.0, &o, Inputs::Window).unwrap();
        // регистр и «..» в пути на Windows не мешают
        if cfg!(windows) {
            let alt = format!("{}\\x\\..\\{}", dir.to_string_lossy().to_uppercase(), "Ролик.mp4"); // i18n-ignore — тест
            check(&args, &real_graph(), 6.0, &alt, Inputs::Window).unwrap();
        }
        // чужой выход рядом
        let foreign = dir.join("other.mp4").to_string_lossy().to_string();
        assert!(check(&args, &real_graph(), 6.0, &foreign, Inputs::Window).is_err());
        // вход вне проекта
        let bad = export_args(&other.to_string_lossy());
        assert!(check(&bad, &real_graph(), 6.0, &o, Inputs::Window).is_err());
        // движок (автотесты) — свои пути
        check(&bad, &real_graph(), 6.0, &foreign, Inputs::Engine).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn engine_inputs_must_exist() {
        let dir = std::env::temp_dir().join(format!("ffm-ptest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("in.mp4");
        std::fs::write(&f, b"x").unwrap();
        let out = dir.join("out.mp4").to_string_lossy().to_string();
        let args = export_args(&f.to_string_lossy());
        check(&args, &real_graph(), 6.0, &out, Inputs::Engine).unwrap();
        let missing = export_args(&dir.join("nope.mp4").to_string_lossy());
        assert!(check(&missing, &real_graph(), 6.0, &out, Inputs::Engine).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
