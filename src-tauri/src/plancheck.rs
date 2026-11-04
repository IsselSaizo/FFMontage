// Проверка плана экспорта перед запуском FFmpeg (M3.4 / M0.2).
// План собирает окно (js/exportPlan.js exportCommand, js/animRain.js rainBakePlan); сюда он приходит как данные,
// поэтому FFmpeg получает только то, что мы понимаем:
//   • граф — разбирается так же, как в FFmpeg (libavfilter/graphparser.c + ff_filter_opt_parse, два уровня кавычек),
//     каждый фильтр ∈ SAFE_FILTERS, ключи опций — обычные имена и не FORBIDDEN_OPTION (файлы, модели, команды);
//   • аргументы — только известные опции с проверенными значениями; @@FILTER@@ и @@OUT@@ — ровно по разу;
//   • -i — существующий файл, разрешённый окну (импорт / кэш медиа / папка плагинов); у движка без окна — любой существующий;
//   • output — абсолютный .mp4/.mov/.mkv/.webm, не совпадает со входом.
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
    while *p < b.len() && WS.contains(&b[*p]) { *p += 1; }
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
            while *p < b.len() && b[*p] != b'\'' { out.push(b[*p]); *p += 1; }
            if *p < b.len() { *p += 1; end = out.len(); }
        } else {
            out.push(c);
        }
    }
    while out.len() > end && out.last().is_some_and(|c| WS.contains(c)) { out.pop(); }
    String::from_utf8_lossy(&out).into_owned()
}

fn skip_ws(b: &[u8], p: &mut usize) { while *p < b.len() && WS.contains(&b[*p]) { *p += 1; } }

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
        if name.is_empty() || *p >= b.len() || b[*p] != b']' { return Err(tr!("неверная метка в графе", "invalid label in the graph").into()); }
        *p += 1;
        skip_ws(b, p);
    }
    Ok(())
}

/// is_key_char из libavutil/opt.c
fn is_key_char(c: u8) -> bool { c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'/' || c == b'.' }

/// ff_filter_opt_parse: «key=value:позиционное:…», значения — через av_get_token(":")
fn parse_opts(s: &str) -> Vec<(Option<String>, String)> {
    let b = s.as_bytes();
    let mut p = 0;
    let mut out = vec![];
    while p < b.len() {
        let mut q = p;
        skip_ws(b, &mut q);
        let ks = q;
        while q < b.len() && is_key_char(b[q]) { q += 1; }
        let ke = q;
        skip_ws(b, &mut q);
        let key = if q < b.len() && b[q] == b'=' { p = q + 1; Some(String::from_utf8_lossy(&b[ks..ke]).into_owned()) } else { None };
        let val = get_token(b, &mut p, b":");
        out.push((key, val));
        if p < b.len() { p += 1; }
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
        if name.is_empty() { return Err(tr!("пустое имя фильтра", "empty filter name").into()); }
        if let Some(i) = name.find('@') { name.truncate(i); }
        let mut opts = vec![];
        if p < b.len() && b[p] == b'=' {
            p += 1;
            opts = parse_opts(&get_token(b, &mut p, b"[],;"));
        }
        labels(b, &mut p)?;
        skip_ws(b, &mut p);
        out.push(Filter { name, opts });
        if p < b.len() {
            if b[p] == b',' || b[p] == b';' { p += 1; skip_ws(b, &mut p); } else {
                return Err(tr!("лишние символы в графе: «{}»", "trailing characters in the graph: \"{}\"", String::from_utf8_lossy(&b[p..(p + 20).min(b.len())])));
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
    match name { "curves" | "selectivecolor" | "firequalizer" => 2, _ => usize::MAX }
}

pub fn check_graph(s: &str) -> Result<(), String> {
    if s.len() > 8 * 1024 * 1024 { return Err(tr!("граф больше 8 МБ", "the graph is larger than 8 MB").into()); }
    let filters = parse_graph(s)?;
    if filters.is_empty() { return Err(tr!("пустой граф", "empty graph").into()); }
    for f in &filters {
        if !plugins::is_safe_filter(&f.name) { return Err(tr!("фильтр «{}» не разрешён", "filter \"{}\" is not allowed", f.name)); }
        let mut positional = 0;
        for (k, _) in &f.opts {
            match k {
                Some(k) => {
                    if !valid_key(k) || plugins::forbidden_option(k) { return Err(tr!("опция «{}» фильтра {} не разрешена", "option \"{}\" of filter {} is not allowed", k, f.name)); }
                }
                None => positional += 1,
            }
        }
        if positional > max_positional(&f.name) { return Err(tr!("слишком много позиционных опций у фильтра {}", "too many positional options for filter {}", f.name)); }
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
}

const VCODECS: &[&str] = &["libx264", "libx265", "libsvtav1", "h264_nvenc", "hevc_nvenc", "av1_nvenc", "libvpx-vp9"];

/// Опции из exportPlan.js exportCommand/encoderArgs и animRain.js rainBakePlan
fn spec(opt: &str) -> Option<V> {
    Some(match opt {
        "-hide_banner" | "-y" | "-nostdin" | "-nostats" | "-an" => V::Flag,
        "-i" => V::Input,
        "-/filter_complex" | "-filter_complex_script" => V::Filter,
        "-map" => V::Map,
        "-c:v" => V::Enum(VCODECS),
        "-c:a" => V::Enum(&["aac", "libopus"]),
        "-preset" | "-tune" | "-rc" | "-profile:v" | "-pix_fmt" => V::Word,
        "-cq" | "-crf" | "-g" | "-spatial-aq" | "-temporal-aq" | "-rc-lookahead" | "-cpu-used" | "-row-mt" | "-auto-alt-ref"
        | "-loop" | "-framerate" | "-t" | "-ss" | "-ar" | "-r" => V::Num,
        "-b:v" | "-b:a" => V::Bitrate,
        "-tag:v" => V::Enum(&["hvc1", "hev1", "avc1"]),
        "-fps_mode" | "-vsync" => V::Enum(&["cfr", "vfr", "passthrough", "auto"]),
        "-movflags" => V::Enum(&["+faststart"]),
        "-f" => V::Enum(&["mp4", "mov", "webm", "matroska"]),
        "-progress" => V::Enum(&["pipe:1"]),
        "-deadline" => V::Enum(&["realtime", "good", "best"]),
        _ => return None,
    })
}

fn is_num(v: &str) -> bool {
    let v = v.strip_prefix('-').unwrap_or(v);
    let (a, b) = v.split_once('.').unwrap_or((v, "0"));
    !a.is_empty() && a.len() <= 12 && a.bytes().all(|c| c.is_ascii_digit()) && !b.is_empty() && b.len() <= 9 && b.bytes().all(|c| c.is_ascii_digit())
}

fn is_word(v: &str) -> bool {
    !v.is_empty() && v.len() <= 32 && v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c == b'+' || c == b'.') && !v.starts_with('-')
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
    if cfg!(windows) { n.to_lowercase().replace('/', "\\") } else { n }
}

fn under(p: &Path, dir: &Path) -> bool {
    let sep = if cfg!(windows) { "\\" } else { "/" };
    norm(p).starts_with(&format!("{}{sep}", norm(dir).trim_end_matches(sep)))
}

fn input_ok(v: &str, inputs: Inputs) -> Result<PathBuf, String> {
    let p = PathBuf::from(v);
    let bad = || tr!("входной файл не разрешён: {}", "input file is not allowed: {}", v);
    #[cfg(test)]
    {
        if inputs == Inputs::Any { return if p.is_absolute() { Ok(p) } else { Err(bad()) }; }
    }
    if !p.is_absolute() || !p.is_file() { return Err(bad()); }
    let ok = match inputs {
        Inputs::Engine => true,
        Inputs::Window => protocol::is_allowed(&p) || under(&p, &paths::get().plugins_dir),
        #[cfg(test)]
        Inputs::Any => true,
    };
    if ok { Ok(p) } else { Err(bad()) }
}

const OUT_EXT: &[&str] = &["mp4", "mov", "mkv", "webm"];

/// Проверка аргументов, графа и выходного файла. Ошибка — уже с префиксом «План экспорта отклонён: …».
pub fn check(args: &[String], filter: &str, duration: f64, output: &str, inputs: Inputs) -> Result<(), String> {
    check_inner(args, filter, duration, output, inputs).map_err(|e| tr!("План экспорта отклонён: {}", "Export plan rejected: {}", e))
}

fn check_inner(args: &[String], filter: &str, duration: f64, output: &str, inputs: Inputs) -> Result<(), String> {
    let out = PathBuf::from(output);
    let ext = crate::ff::ext_of(&out);
    if !out.is_absolute() || !OUT_EXT.contains(&ext.as_str()) || output.contains(['\n', '\r']) {
        return Err(tr!("выходной файл должен быть абсолютным путём .mp4/.mov/.mkv/.webm: {}", "the output must be an absolute .mp4/.mov/.mkv/.webm path: {}", output));
    }
    if !duration.is_finite() || !(0.0..=7.0 * 24.0 * 3600.0).contains(&duration) {
        return Err(tr!("неверная длительность", "invalid duration").into());
    }
    if args.len() > 20000 { return Err(tr!("слишком много аргументов", "too many arguments").into()); }
    let (mut n_filter, mut n_out, mut seen_format) = (0, 0, false);
    let mut ins: Vec<PathBuf> = vec![];
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "@@OUT@@" {
            n_out += 1;
            if i != args.len() - 1 { return Err(tr!("@@OUT@@ должен быть последним аргументом", "@@OUT@@ must be the last argument").into()); }
            i += 1;
            continue;
        }
        let Some(kind) = spec(a) else { return Err(tr!("неизвестный аргумент «{}»", "unknown argument \"{}\"", a)) };
        if let V::Flag = kind { i += 1; continue; }
        let Some(v) = args.get(i + 1).map(String::as_str) else { return Err(tr!("нет значения у {}", "no value for {}", a)) };
        let ok = match kind {
            V::Flag => true,
            V::Num => is_num(v),
            V::Bitrate => { let n = v.trim_end_matches(['k', 'K', 'm', 'M']); is_num(n) && !n.starts_with('-') && v.len() - n.len() <= 1 }
            V::Word => is_word(v),
            V::Enum(list) => list.contains(&v),
            V::Map => is_map(v),
            V::Filter => { n_filter += 1; v == "@@FILTER@@" }
            V::Input => {
                // -f перед -i выбрал бы демультиплексор входа (concat, lavfi…) — -f только для выхода
                if seen_format { return Err(tr!("-f перед -i не разрешён", "-f before -i is not allowed").into()); }
                ins.push(input_ok(v, inputs)?);
                true
            }
        };
        if a == "-f" { seen_format = true; }
        if !ok { return Err(tr!("недопустимое значение {} {}", "invalid value {} {}", a, v)); }
        i += 2;
    }
    if n_filter != 1 { return Err(tr!("граф (@@FILTER@@) должен быть указан ровно один раз", "the graph (@@FILTER@@) must be given exactly once").into()); }
    if n_out != 1 { return Err(tr!("@@OUT@@ должен быть указан ровно один раз", "@@OUT@@ must be given exactly once").into()); }
    if ins.is_empty() { return Err(tr!("нет входных файлов", "no input files").into()); }
    let o = norm(&out);
    let part = norm(Path::new(&format!("{output}.part")));
    if ins.iter().any(|p| { let n = norm(p); n == o || n == part }) {
        return Err(tr!("выходной файл совпадает со входным", "the output file is the same as an input").into());
    }
    check_graph(filter)
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn abs(name: &str) -> String {
        if cfg!(windows) { format!("C:\\media\\{name}") } else { format!("/media/{name}") }
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
        check_graph(&real_graph()).unwrap();
        check_graph(&rain_graph()).unwrap();
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
            assert!(check_graph(g).is_err(), "должен быть отклонён: {g}"); // i18n-ignore — тест
        }
    }

    fn export_args(input: &str) -> Vec<String> {
        let mut a: Vec<&str> = vec!["-hide_banner", "-y", "-nostdin",
            "-loop", "1", "-framerate", "30", "-t", "5.500000", "-i", input,
            "-ss", "1.000000", "-t", "3.500000", "-i", input,
            "-c:v", "libvpx-vp9", "-ss", "0.000000", "-t", "2.000000", "-i", input,
            "-/filter_complex", "@@FILTER@@", "-map", "[vout]", "-map", "[aout]"];
        a.extend(["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0",
            "-spatial-aq", "1", "-temporal-aq", "1", "-rc-lookahead", "20", "-profile:v", "high", "-g", "60",
            "-fps_mode", "cfr", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", "6.000000",
            "-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats", "@@OUT@@"]);
        a.into_iter().map(String::from).collect()
    }

    #[test]
    fn export_plan_ok() {
        let inp = abs("a.mp4");
        check(&export_args(&inp), &real_graph(), 6.0, &abs("out.mp4"), Inputs::Any).unwrap();
        // все кодеки encoderArgs
        for enc in [
            vec!["-c:v", "av1_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "33", "-b:v", "0", "-spatial-aq", "1", "-rc-lookahead", "20", "-g", "60"],
            vec!["-c:v", "hevc_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "26", "-b:v", "0", "-spatial-aq", "1", "-temporal-aq", "1", "-rc-lookahead", "20", "-g", "60", "-tag:v", "hvc1"],
            vec!["-c:v", "libx265", "-preset", "medium", "-crf", "24", "-g", "60", "-tag:v", "hvc1"],
            vec!["-c:v", "libsvtav1", "-preset", "8", "-crf", "33", "-g", "60"],
            vec!["-c:v", "libx264", "-preset", "medium", "-crf", "21", "-profile:v", "high", "-g", "60"],
        ] {
            let mut a: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-ss", "0.000000", "-t", "4.5", "-i", &inp, "-filter_complex_script", "@@FILTER@@", "-map", "[vout]", "-map", "[aout]"]
                .iter().map(|x| x.to_string()).collect();
            a.extend(enc.iter().map(|x| x.to_string()));
            a.extend(["-vsync", "cfr", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", "4.000000", "-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats", "@@OUT@@"].iter().map(|x| x.to_string()));
            check(&a, &real_graph(), 4.0, &abs("out.mp4"), Inputs::Any).unwrap();
        }
        // rainBakePlan
        let rain: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-loop", "1", "-framerate", "30", "-t", "2.500000", "-i", &abs("sprite.png"),
            "-/filter_complex", "@@FILTER@@", "-map", "[vout]", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
            "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", "-t", "2.000000", "-an", "-f", "webm",
            "-progress", "pipe:1", "-nostats", "@@OUT@@"].iter().map(|x| x.to_string()).collect();
        check(&rain, &rain_graph(), 2.0, &abs("rain-1.webm"), Inputs::Any).unwrap();
    }

    #[test]
    fn export_plan_rejected() {
        let inp = abs("a.mp4");
        let out = abs("out.mp4");
        let base = export_args(&inp);
        let with = |f: &dyn Fn(&mut Vec<String>)| { let mut a = base.clone(); f(&mut a); check(&a, &real_graph(), 6.0, &out, Inputs::Any) };
        let at = |a: &Vec<String>, s: &str| a.iter().position(|x| x == s).unwrap();
        // лишний путь в аргументах
        assert!(with(&|a| { let i = at(a, "@@OUT@@"); a.insert(i, abs("other.mp4")); }).is_err());
        // второй выход / путь вместо @@OUT@@
        assert!(with(&|a| { let n = a.len(); a[n - 1] = abs("x.mp4"); }).is_err());
        assert!(with(&|a| a.push("@@OUT@@".into())).is_err());
        // неизвестные опции, опасные значения
        assert!(with(&|a| { a.insert(0, "-filter_script".into()); a.insert(1, "/tmp/x".into()); }).is_err());
        assert!(with(&|a| { a.insert(0, "-dump_attachment:t".into()); a.insert(1, "/tmp/x".into()); }).is_err());
        assert!(with(&|a| { let i = at(a, "-preset"); a[i + 1] = "p5:x=/tmp/y".into(); }).is_err());
        assert!(with(&|a| { let i = at(a, "-c:v"); a[i + 1] = "copy".into(); }).is_err());
        assert!(with(&|a| { let i = at(a, "-map"); a[i + 1] = "[vout];movie".into(); }).is_err());
        // -f перед -i, относительный вход, второй граф, нет графа
        assert!(with(&|a| { a.insert(3, "-f".into()); a.insert(4, "mp4".into()); }).is_err());
        assert!(with(&|a| { let i = at(a, "-i"); a[i + 1] = "a.mp4".into(); }).is_err());
        assert!(with(&|a| { a.insert(3, "-/filter_complex".into()); a.insert(4, "@@FILTER@@".into()); }).is_err());
        assert!(with(&|a| { let i = at(a, "-/filter_complex"); a[i + 1] = abs("graph.txt"); }).is_err());
        // выходной файл
        assert!(check(&base, &real_graph(), 6.0, "out.mp4", Inputs::Any).is_err());
        assert!(check(&base, &real_graph(), 6.0, &abs("out.exe"), Inputs::Any).is_err());
        assert!(check(&base, &real_graph(), 6.0, &inp, Inputs::Any).is_err());
        assert!(check(&base, &real_graph(), f64::NAN, &out, Inputs::Any).is_err());
        // граф с movie
        assert!(check(&base, "movie=x.mp4[vout]", 6.0, &out, Inputs::Any).is_err());
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
