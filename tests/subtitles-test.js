'use strict';
// Субтитры (src/renderer/js/subtitles.js):
//   1) разбор SRT / VTT / ASS (теги, кириллица, короткие метки времени, стили ASS);
//   2) круговые проверки: parse(toSrt), parse(toVtt), parse(toAss) возвращают те же реплики и стиль;
//   3) настоящий FFmpeg: читает сгенерированные .srt/.vtt/.ass, прожигает .ass фильтром ass (шрифт из fonts/Inter),
//      положение текста внизу/вверху, спецсимволы ({}, \, %, ', :, кириллица) остаются буквальными.
// Запуск: node tests/subtitles-test.js
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ff = require('./engine');

let fails = 0; let n = 0;
const ok = (c, msg) => { n++; if (!c) fails++; console.log(`${c ? '  ok ' : '  FAIL'} ${msg}`); };
const J = (x) => JSON.stringify(x);
const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.test-cache', 'tmp', 'subs-test');

const sameCues = (a, b) => a.length === b.length && a.every((c, i) => c.start === b[i].start && c.end === b[i].end && c.text === b[i].text);
const diffCues = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (J(a[i]) !== J(b[i])) return `#${i}: ${J(a[i])} ≠ ${J(b[i])}`; return ''; };

// Имя семейства из таблицы name TTF: nameID 16 (типографское), иначе 1; платформа 3 (Windows), UTF-16BE
function ttfFamily(file) {
  const b = fs.readFileSync(file);
  const numTables = b.readUInt16BE(4);
  let off = -1;
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (b.toString('latin1', o, o + 4) === 'name') off = b.readUInt32BE(o + 8);
  }
  if (off < 0) return null;
  const count = b.readUInt16BE(off + 2); const strings = off + b.readUInt16BE(off + 4);
  const found = {};
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12;
    const platform = b.readUInt16BE(r); const lang = b.readUInt16BE(r + 4); const id = b.readUInt16BE(r + 6);
    const len = b.readUInt16BE(r + 8); const so = b.readUInt16BE(r + 10);
    if (platform !== 3 || (id !== 16 && id !== 1)) continue;
    let s = ''; for (let j = 0; j < len; j += 2) s += String.fromCharCode(b.readUInt16BE(strings + so + j));
    if (!found[id] || lang === 0x409) found[id] = s; // английское имя предпочтительнее
  }
  return found[16] || found[1] || null;
}

(async () => {
  const S = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'subtitles.js')).href);
  const E = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'core', 'ffEscape.js')).href);

  console.log('Разбор SRT:');
  const srt1 = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Привет,</i> <font color="#ff0000">мир</font>!\r\n{\\an8}Вторая <b>строка</b>\r\n\r\n'
    + '2\r\n00:00:04,000 --> 00:00:05,250 X1:10 X2:20\r\n  Ёлка   \r\n\r\n\r\n'
    + 'мусор\r\n00:00:06,000 --> 00:00:06,000\r\nнулевая\r\n\r\n'
    + '3\r\n00:00:07,000 --> 00:00:08,000\r\n<i></i>\r\n\r\n'
    + '4\r\n00:00:02,000 --> 00:00:02,500\r\nраньше\r\n5\r\n00:00:09,000 --> 00:00:10,000\r\nбез пустой строки';
  ok(S.detectFormat(srt1) === 'srt', 'detectFormat: srt');
  let r = S.parseSubtitles(srt1);
  ok(r.format === 'srt' && sameCues(r.cues, [
    { start: 1, end: 3.5, text: 'Привет, мир!\nВторая строка' },
    { start: 2, end: 2.5, text: 'раньше' },
    { start: 4, end: 5.25, text: 'Ёлка' },
    { start: 9, end: 10, text: 'без пустой строки' },
  ]), `SRT: теги, {\\an8}, кириллица, CRLF, BOM, сортировка, пустые/нулевые отброшены ${J(r.cues)}`);
  const srt2 = '1\n0:00:01.5 --> 0:00:02.25\nодна цифра часов\n\n00:03,100 --> 00:04,200\nбез часов и без номера\n\n\n7\n1:02:03,004 --> 1:02:04,000\nчас\n';
  r = S.parseSubtitles(srt2);
  ok(sameCues(r.cues, [
    { start: 1.5, end: 2.25, text: 'одна цифра часов' },
    { start: 3.1, end: 4.2, text: 'без часов и без номера' },
    { start: 3723.004, end: 3724, text: 'час' },
  ]), `SRT: часы одной цифрой, «.» в миллисекундах, без часов ${J(r.cues)}`);

  console.log('Разбор VTT:');
  const vtt = 'WEBVTT - заголовок\nKind: captions\n\nNOTE это комментарий\n00:00:01.000 --> 00:00:02.000 не реплика\n\n'
    + 'STYLE\n::cue { color: red }\n\nREGION\nid:fred width:40%\n\n'
    + 'intro\n00:01.000 --> 00:02.500 align:start position:10%\n<v Иван>Привет</v> &amp; <c.yellow>пока</c> &lt;3&gt;\n<00:00:01.500>второй&nbsp;раз&lrm;\n\n'
    + '00:00:03.000 --> 00:00:04.000\n<i>курсив</i> &rlm;x\n\n01:00:00.000 --> 01:00:01.000 line:0\nчас\n';
  ok(S.detectFormat(vtt) === 'vtt', 'detectFormat: vtt');
  r = S.parseSubtitles(vtt);
  ok(sameCues(r.cues, [
    { start: 1, end: 2.5, text: 'Привет & пока <3>\nвторой\u00a0раз\u200e' },
    { start: 3, end: 4, text: 'курсив \u200fx' },
    { start: 3600, end: 3601, text: 'час' },
  ]) && !r.errors.length, `VTT: заголовок, NOTE/STYLE/REGION, MM:SS.mmm, настройки, теги, сущности ${J(r.cues)} ${J(r.errors)}`);

  console.log('Разбор ASS:');
  const ass = '[Script Info]\nTitle: проба\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n'
    + '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
    + 'Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,20,1\n'
    + 'Style: Top,Open Sans,72,&H0000CCFF,&H000000FF,&H66202020,&H80102030,-1,1,0,0,100,100,0,0,3,10,3.6,8,10,10,36,1\n\n'
    + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    + 'Comment: 0,0:00:00.00,0:00:09.00,Top,,0,0,0,,комментарий\n'
    + 'Dialogue: 0,0:00:01.50,0:00:03.00,Top,Иван,0,0,0,,{\\an8\\b1}Первая, с запятой\\NВторая{\\i1} строка\\hконец\n'
    + 'Dialogue: 0,0:00:00.20,0:00:01.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}рисунок убран\n'
    + 'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,\\{скобки\\} и \\\u2060N обратная черта\n'
    + 'Dialogue: 0,0:00:06.00,0:00:06.00,Default,,0,0,0,,нулевая\n';
  ok(S.detectFormat(ass) === 'ass', 'detectFormat: ass');
  r = S.parseSubtitles(ass);
  ok(sameCues(r.cues, [
    { start: 0.2, end: 1, text: 'рисунок убран' },
    { start: 1.5, end: 3, text: 'Первая, с запятой\nВторая строка конец' },
    { start: 4, end: 5, text: '{скобки} и \\N обратная черта' },
  ]), `ASS: теги, \\N, \\h, рисование \\p1, запятые в тексте, \\{ \\} ${J(r.cues)}`);
  const st = r.style || {};
  ok(st.font === 'Open Sans' && Math.abs(st.size - 0.1) < 1e-9 && st.bold && st.italic && st.color === '#ffcc00'
    && st.box && st.boxColor === '#202020' && Math.abs(st.boxOpacity - 0.6) < 0.005 && st.shadowColor === '#302010'
    && Math.abs(st.shadow - 0.005) < 1e-9 && st.position === 'top' && st.align === 'center' && Math.abs(st.margin - 0.05) < 1e-9,
  `ASS: стиль первой реплики (Alignment 8, BorderStyle 3, цвета &HAABBGGRR) ${J(st)}`);
  const ssa = '[Script Info]\nScriptType: v4.00\n\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\n'
    + 'Style: *Default,Tahoma,28.8,16777215,65535,255,0,-1,0,1,2,0,11,10,10,14.4,0,1\n\n'
    + '[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,*Default,,0000,0000,0000,,SSA текст\n';
  r = S.parseSubtitles(ssa);
  ok(r.format === 'ass' && sameCues(r.cues, [{ start: 1, end: 2, text: 'SSA текст' }]) && r.style && r.style.font === 'Tahoma'
    && Math.abs(r.style.size - 0.1) < 1e-9 && r.style.position === 'middle' && r.style.align === 'right' && r.style.outlineColor === '#ff0000'
    && r.style.bold, `SSA v4: PlayResY по умолчанию 288, старое выравнивание 11, десятичные цвета ${J(r.style)}`);
  r = S.parseSubtitles('просто текст');
  ok(r.format === null && !r.cues.length && r.errors.length === 1, 'неизвестный формат → errors');

  console.log('Стиль и помощники:');
  const cs = S.cleanSubStyle({ size: 5, outline: -1, shadow: 0.2, margin: 0.9, color: 'red', outlineColor: '#ABCDEF', boxOpacity: 3, position: 'left', align: 'right', font: '  ', bold: 1 });
  ok(cs.size === 0.3 && cs.outline === 0 && cs.shadow === 0.05 && cs.margin === 0.45 && cs.color === '#ffffff' && cs.outlineColor === '#abcdef'
    && cs.boxOpacity === 1 && cs.position === 'bottom' && cs.align === 'right' && cs.font === 'Inter' && cs.bold === true && cs.italic === false,
  `cleanSubStyle: ограничения и умолчания ${J(cs)}`);
  ok(J(S.cleanSubStyle()) === J(S.SUB_STYLE_DEFAULT), 'cleanSubStyle() = SUB_STYLE_DEFAULT');
  ok([['bottom', 'left', 1], ['bottom', 'center', 2], ['middle', 'right', 6], ['top', 'left', 7], ['top', 'center', 8], ['top', 'right', 9]]
    .every(([position, align, a]) => S.subAlignment({ position, align }) === a) && S.subAlignment({}) === 2, 'subAlignment: numpad');
  const nc = S.normalizeCues([{ start: 2, end: 1, text: ' b \n\n  c ' }, { start: -1, end: 0.5004, text: 'a' }, { start: 3, end: 4, text: '  ' }, null, { start: 1.00049, end: 1.05, text: 'x' }]);
  ok(sameCues(nc, [{ start: 0, end: 0.5, text: 'a' }, { start: 1, end: 1.1, text: 'x' }, { start: 2, end: 2.1, text: 'b\nc' }]), `normalizeCues ${J(nc)}`);
  const ca = S.cueAt([{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'b' }, { start: 3, end: 4, text: 'c' }], 1.5);
  ok(ca.map((c) => c.text).join() === 'a,b' && S.cueAt(nc, 0.5).length === 0 && S.cueAt(nc, 0).length === 1, 'cueAt: перекрытия, конец не включён');

  console.log('Круговые проверки:');
  const cues = [
    { start: 0.5, end: 1.75, text: 'Первая строка\nвторая' },
    { start: 1.75, end: 3.333, text: 'Цена: 50% — it\'s "ok"' },
    { start: 3600.001, end: 3601.999, text: 'час с лишним' },
  ];
  r = S.parseSubtitles(S.toSrt(cues));
  ok(sameCues(r.cues, cues), `parse(toSrt) ${diffCues(r.cues, cues)}`);
  const vcues = [...cues.slice(0, 2), { start: 5, end: 6, text: 'a & b <c> --> d &amp;' }, cues[2]];
  r = S.parseSubtitles(S.toVtt(vcues));
  ok(sameCues(r.cues, vcues) && S.toVtt(vcues).startsWith('WEBVTT\n\n'), `parse(toVtt), & < > экранированы ${diffCues(r.cues, vcues)}`);
  const tricky = 'Привет {скобки} и {\\i1}теги\\N, обратная \\ черта \\h \\{ }{';
  const acues = [
    { start: 0.5, end: 1.75, text: 'Первая строка\nвторая' },
    { start: 1.75, end: 3.33, text: tricky },
    { start: 3600.01, end: 3601.99, text: 'час' },
  ];
  const styleA = { font: 'Inter', size: 0.07, bold: true, italic: false, color: '#ffcc00', outline: 0.003, outlineColor: '#112233', shadow: 0.002, shadowColor: '#445566', position: 'top', align: 'left', margin: 0.08 };
  const styleB = { font: 'Open Sans', size: 0.045, italic: true, color: '#00ff80', box: true, boxColor: '#202040', boxOpacity: 0.5, shadow: 0.004, position: 'middle', align: 'right', margin: 0.1 };
  const H = 720;
  const styleClose = (got, want, skip = []) => {
    const w = S.cleanSubStyle(want); const bad = [];
    for (const k of Object.keys(w)) {
      if (skip.includes(k)) continue;
      const ok1 = typeof w[k] === 'number' ? Math.abs(got[k] - w[k]) <= 0.5 / H + 1e-6 : got[k] === w[k];
      if (!ok1) bad.push(`${k}: ${J(got[k])} ≠ ${J(w[k])}`);
    }
    return bad;
  };
  for (const [nm, sty, skip] of [['обводка', styleA, []], ['плашка', styleB, ['outline', 'outlineColor', 'shadowColor']]]) {
    const text = S.toAss([{ style: sty, cues: acues }], { W: 1280, H });
    r = S.parseSubtitles(text);
    const bad = styleClose(r.style || {}, sty, skip);
    ok(sameCues(r.cues, acues), `parse(toAss) ${nm}: реплики ${diffCues(r.cues, acues)}`);
    ok(!bad.length, `parse(toAss) ${nm}: стиль ${bad.join('; ')}`);
  }
  // Сотые: стык реплик сохраняется, не перекрываются
  const touch = S.toAss([{ style: {}, cues: [{ start: 0.004, end: 1.005, text: 'a' }, { start: 1.005, end: 2.996, text: 'b' }, { start: 2.996, end: 4, text: 'c' }] }], { W: 640, H: 360 });
  const times = [...touch.matchAll(/^Dialogue: 0,([^,]+),([^,]+),/gm)].map((m) => [m[1], m[2]]);
  ok(J(times) === J([['0:00:00.00', '0:00:01.01'], ['0:00:01.01', '0:00:03.00'], ['0:00:03.00', '0:00:04.00']]), `toAss: сотые без перекрытий ${J(times)}`);
  const two = S.toAss([{ style: styleA, cues: [{ start: 0, end: 1, text: 'a' }] }, { name: 'B', style: styleB, cues: [{ start: 0, end: 1, text: 'b' }] }], { W: 1280, H: 720, fontName: (f) => `${f} X` });
  ok(/^Style: T1,Inter X,50,&H0000CCFF,/m.test(two) && /^Style: T2,Open Sans X,32,&H0080FF00,&H0080FF00,&H80402020,&H80402020,0,-1,0,0,100,100,0,0,3,8,2.88,6,51,51,72,1$/m.test(two)
    && /^Dialogue: 0,0:00:00\.00,0:00:01\.00,T2,,0,0,0,,b$/m.test(two) && /YCbCr Matrix: None/.test(two) && /ScaledBorderAndShadow: yes/.test(two),
  'toAss: две дорожки — стили T1/T2, цвета, плашка, поля, выравнивание');

  console.log('Шрифты:');
  const interTtf = path.join(ROOT, 'fonts', 'Inter', 'InterVariable.ttf');
  const interFamily = ttfFamily(interTtf);
  const osFamily = ttfFamily(path.join(ROOT, 'fonts', 'OpenSans', 'OpenSans-Variable.ttf'));
  ok(!!interFamily && !!osFamily, `семейства: Inter → ${J(interFamily)}, OpenSans → ${J(osFamily)}`);
  const fontName = (f) => (f === 'Inter' ? interFamily : f === 'Open Sans' ? osFamily : f);

  console.log('Настоящий FFmpeg:');
  await ff.ready;
  const bin = ff.findBinaries().ffmpeg;
  fs.mkdirSync(TMP, { recursive: true });
  const run = (args, opts) => ff.run(bin, ['-hide_banner', '-loglevel', 'error', ...args], opts).catch((e) => ({ error: e, stderr: e.stderr || '' }));
  const errText = (res) => (res.error ? ` ОШИБКА: ${String(res.error.message || res.error).slice(0, 300)}` : '');
  const filters = await run(['-filters']);
  ok(/\bass\b/.test(filters.stdout || ''), `в FFmpeg есть фильтр ass (${bin})`);

  // (а) чтение сгенерированных файлов
  const many = Array.from({ length: 7 }, (_, i) => ({ start: i * 1.5, end: i * 1.5 + 1.2, text: `Реплика ${i + 1}\nстрока 2: 100% it's` }));
  const files = {
    srt: S.toSrt(many), vtt: S.toVtt(many), ass: S.toAss([{ style: {}, cues: many }], { W: 640, H: 360, fontName }),
  };
  for (const [ext, body] of Object.entries(files)) {
    const f = path.join(TMP, `gen.${ext}`);
    fs.writeFileSync(f, body);
    const res = await run(['-i', f, '-f', 'srt', '-']);
    const back = res.error ? [] : S.parseSubtitles(res.stdout, 'srt').cues;
    ok(!res.error && back.length === many.length && back.every((c, i) => c.text === many[i].text && Math.abs(c.start - many[i].start) < 0.011),
      `FFmpeg читает .${ext} → ${back.length} реплик${errText(res)}`);
  }
  const mp4 = path.join(TMP, 'movtext.mp4');
  let res = await run(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:d=11', '-i', path.join(TMP, 'gen.srt'), '-map', '0:v', '-map', '1:s', '-c:v', 'mpeg4', '-c:s', 'mov_text', mp4]);
  if (!res.error) res = await run(['-i', mp4, '-map', '0:s', '-f', 'srt', '-']);
  ok(!res.error && S.parseSubtitles(res.stdout || '', 'srt').cues.length === many.length, `SRT → mov_text в MP4 и обратно${errText(res)}`);

  // (б) прожиг фильтром ass
  const black = path.join(TMP, 'black.mkv');
  res = await run(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=2:r=25', '-c:v', 'ffv1', black]);
  ok(!res.error && fs.existsSync(black), `чёрное видео 640×360, 2 с${errText(res)}`);
  const fontsDir = path.join(ROOT, 'fonts', 'Inter');
  const assFile = path.join(TMP, "burn it's [1],50%;x.ass"); // путь со спецсимволами графа — проверка ffPath
  const burn = async (tracks, { t = 1, small = true, loglevel = 'error' } = {}) => {
    fs.writeFileSync(assFile, S.toAss(tracks, { W: 640, H: 360, fontName }));
    const vf = `ass=filename=${E.ffPath(assFile)}:fontsdir=${E.ffPath(fontsDir)},${small ? 'scale=64:36:flags=area,format=rgb24' : 'format=gray'}`;
    const rr = await ff.run(bin, ['-hide_banner', '-loglevel', loglevel, '-i', black, '-vf', vf, '-ss', String(t), '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { binaryStdout: true })
      .catch((e) => ({ error: e, stderr: e.stderr || '' }));
    const buf = rr.stdout && Buffer.isBuffer(rr.stdout) ? rr.stdout : Buffer.alloc(0);
    const w = small ? 64 : 640; const h = small ? 36 : 360; const ch = small ? 3 : 1;
    const lum = (x, y) => { const i = (y * w + x) * ch; return ch === 3 ? (buf[i] + buf[i + 1] + buf[i + 2]) / 3 : buf[i]; };
    const region = (y0, y1) => { let max = 0; let lit = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { const v = lum(x, y); if (v > max) max = v; if (v > 128) lit++; } return { max, lit }; };
    const rows = []; for (let y = 0; y < h; y++) { let any = false; for (let x = 0; x < w; x++) if (lum(x, y) > 128) any = true; if (any) rows.push(y); }
    return { error: rr.error, stderr: rr.stderr || '', ok: buf.length === w * h * ch, region, lit: region(0, h).lit, rows };
  };
  const cue = [{ start: 0.5, end: 1.5, text: 'Субтитры ЁЖ' }];
  const white = { color: '#ffffff', size: 0.1, position: 'bottom' };
  let b = await burn([{ style: white, cues: cue }], { loglevel: 'verbose' });
  let bot = b.region(27, 36); let top = b.region(0, 18);
  ok(!b.error && b.ok && bot.max > 120 && top.max < 16, `прожиг: текст внизу (низ max ${Math.round(bot.max)}, верх max ${Math.round(top.max)})${errText(b)}`);
  const fsel = /fontselect: \(([^,]+), \d+, \d+\) -> (\S+)/.exec(b.stderr);
  ok(!!fsel && fsel[1] === interFamily && /^InterVariable/.test(fsel[2]), `libass нашёл шрифт из fontsdir: ${fsel ? fsel[0] : 'нет строки fontselect'}`);
  b = await burn([{ style: { ...white, position: 'top' }, cues: cue }]);
  bot = b.region(18, 36); top = b.region(0, 9);
  ok(!b.error && b.ok && top.max > 120 && bot.max < 16, `прожиг: position 'top' — текст вверху (верх max ${Math.round(top.max)}, низ max ${Math.round(bot.max)})${errText(b)}`);
  b = await burn([{ style: white, cues: cue }], { t: 1.8 });
  ok(!b.error && b.ok && b.region(0, 36).max < 16, `прожиг: после конца реплики кадр чёрный${errText(b)}`);
  b = await burn([{ style: { ...white, box: true, boxColor: '#ffffff', boxOpacity: 1, color: '#000000' }, cues: cue }]);
  bot = b.region(27, 36);
  ok(!b.error && b.ok && bot.lit > 20, `прожиг: белая плашка (BorderStyle 3) — ${bot.lit} светлых пикселей внизу${errText(b)}`);

  // (в) спецсимволы
  const special = "Привет, мир: 100% it's {скобки} back\\slash \\N не перевод \\h {\\i1}";
  const sCue = [{ start: 0.5, end: 1.5, text: special }];
  fs.writeFileSync(path.join(TMP, 'special.ass'), S.toAss([{ style: white, cues: sCue }], { W: 640, H: 360, fontName }));
  r = S.parseSubtitles(fs.readFileSync(path.join(TMP, 'special.ass'), 'utf8'));
  ok(r.cues.length === 1 && r.cues[0].text === special, `parse(toAss): текст со спецсимволами без изменений ${J(r.cues[0] && r.cues[0].text)}`);
  b = await burn([{ style: { ...white, size: 0.05 }, cues: sCue }], { small: false, loglevel: 'warning' });
  // в fonts/Inter лежит LICENSE.txt — libass пробует открыть его как шрифт и предупреждает; это не ошибка разбора
  const warn = b.stderr.split('\n').filter((l) => l.trim() && !/memory font/.test(l)).join(' | ');
  ok(!b.error && b.ok && b.lit > 500 && !warn, `прожиг спецсимволов без ошибок (${b.lit} светлых пикселей)${errText(b)}${warn ? ' | ' + warn.slice(0, 300) : ''}`);
  res = await run(['-i', path.join(TMP, 'special.ass'), '-f', 'srt', '-']);
  const srtBack = res.error ? '' : S.parseSubtitles(res.stdout, 'srt').cues.map((c) => c.text).join('|');
  // в SRT от FFmpeg остаются наши escape-последовательности ASS: «\{», «\}» и U+2060 после «\»
  const srtPlain = srtBack.replace(/\\([{}])/g, '$1').replace(/\u2060/g, '');
  ok(!res.error && srtPlain === special, `FFmpeg ASS → SRT сохраняет буквальные {}, \\, \\N: ${J(srtBack)}${errText(res)}`);
  // libass: «{AB}» в нашем экранировании рисуется (скобки видны), а «\N» из текста — не перевод строки
  const lit1 = (await burn([{ style: white, cues: [{ start: 0.5, end: 1.5, text: 'AB' }] }], { small: false })).lit;
  const lit2 = (await burn([{ style: white, cues: [{ start: 0.5, end: 1.5, text: '{AB}' }] }], { small: false })).lit;
  ok(lit1 > 100 && lit2 > lit1 * 1.2, `libass рисует скобки: «AB» ${lit1}, «{AB}» ${lit2} светлых пикселей`);
  const one = await burn([{ style: white, cues: [{ start: 0.5, end: 1.5, text: 'x\\Ny' }] }], { small: false });
  const twoL = await burn([{ style: white, cues: [{ start: 0.5, end: 1.5, text: 'x\ny' }] }], { small: false });
  const span = (q) => (q.rows.length ? q.rows[q.rows.length - 1] - q.rows[0] + 1 : 0);
  ok(span(one) > 10 && span(twoL) > span(one) * 1.5, `«\\N» в тексте — одна строка (высота ${span(one)} px), настоящий перевод — две (${span(twoL)} px)`);

  console.log(`\nпроверок: ${n}, провалов: ${fails}`);
  console.log(fails ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ОК');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
