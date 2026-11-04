// Проверка перевода интерфейса (без запуска программы):
//   node tests/i18n-check.js            — все файлы
//   node tests/i18n-check.js timeline.js inspector.js   — только эти (плюс проверка словаря)
// 1) каждая русская строка в src/renderer/js/*.js стоит внутри t('…') / tIn(lang, '…');
//    исключения: строки в console.*( … ) и строки с пометкой «// i18n-ignore» в конце строки кода;
// 2) у каждого t('…') есть перевод в src/renderer/js/i18n/en/*.js, подстановки {x} совпадают;
// 3) в src-tauri/src/*.rs русские строки стоят только в tr!("…", "…").
// Код выхода 1 — есть ошибки.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'src', 'renderer', 'js');
const RS = path.join(ROOT, 'src-tauri', 'src');
const CYR = /[А-Яа-яЁё]/;
const only = process.argv.slice(2);

// --- лексер JS: строки, шаблоны, комментарии, регулярные выражения ---
function jsLiterals(src) {
  const out = []; // { start, end, value, template, interp }
  const n = src.length;
  // Код от i до своей закрывающей } (stop — внутри ${…}) или до конца файла; возвращает позицию после }
  function code(i, stop) {
    let prevSig = ''; // последний значимый символ: отличает / деления от начала regex
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '{') { depth++; prevSig = c; i++; continue; }
      if (c === '}') { if (depth === 0 && stop) return i + 1; depth = Math.max(0, depth - 1); prevSig = c; i++; continue; }
      if (c === '\'' || c === '"') {
        const start = i; i++; let v = '';
        while (i < n && src[i] !== c) { if (src[i] === '\\') { v += src[i + 1]; i += 2; } else { v += src[i]; i++; } }
        i++;
        out.push({ start, end: i, value: v, interp: false });
        prevSig = 'x'; continue;
      }
      if (c === '`') { i = template(i); prevSig = 'x'; continue; }
      if (c === '/') {
        const kw = /\b(return|typeof|case|in|of|delete|void|throw|new)\s*$/.test(src.slice(Math.max(0, i - 10), i));
        if (!prevSig || '(,=:[!&|?{};+-*%<>~^'.includes(prevSig) || kw) {
          i++; let cls = false;
          while (i < n && (src[i] !== '/' || cls) && src[i] !== '\n') { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
          i++; while (/[a-z]/i.test(src[i] || '')) i++;
          prevSig = 'x'; continue;
        }
      }
      if (!/\s/.test(c)) prevSig = /[\w$)\]]/.test(c) ? 'x' : c;
      i++;
    }
    return i;
  }
  function template(i) {
    const start = i; i++;
    let v = ''; let interp = false;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { v += src[i + 1]; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { interp = true; v += '${…}'; i = code(i + 2, true); continue; }
      v += src[i]; i++;
    }
    i++;
    out.push({ start, end: i, value: v, interp });
    return i;
  }
  code(0, false);
  return out;
}

function lineOf(src, pos) { return src.slice(0, pos).split('\n').length; }
function lineText(src, pos) { const a = src.lastIndexOf('\n', pos - 1) + 1; const b = src.indexOf('\n', pos); return src.slice(a, b < 0 ? src.length : b); }

const errors = [];
const keys = new Map(); // ключ → [файл:строка]

function checkJs(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  for (const lit of jsLiterals(src)) {
    if (!CYR.test(lit.value)) continue;
    const line = lineText(src, lit.start);
    if (/\/\/.*i18n-ignore/.test(line) || /\bconsole\.\w+\(/.test(line)) continue;
    const before = src.slice(Math.max(0, lit.start - 60), lit.start);
    const after = src.slice(lit.end).match(/^\s*([,)])/);
    const inT = /(?:^|[^\w.$])t\(\s*$/.test(before) || /(?:^|[^\w.$])tIn\([^,()]*,\s*$/.test(before);
    const ln = lineOf(src, lit.start);
    if (!inT) { errors.push(`${rel}:${ln}: строка без t(): ${JSON.stringify(lit.value.slice(0, 80))}`); continue; }
    if (lit.interp) { errors.push(`${rel}:${ln}: в t() шаблон с \${…} — используйте t('… {x}', { x })`); continue; }
    if (!after) { errors.push(`${rel}:${ln}: в t() склейка строк — передавайте одну строку целиком`); continue; }
    if (!keys.has(lit.value)) keys.set(lit.value, []);
    keys.get(lit.value).push(`${rel}:${ln}`);
  }
  // t('…') без кириллицы тоже ключи (редко, но бывает: t('OK'))
}

function rsLiterals(src) {
  const out = []; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === 'r' && /^r#*"/.test(src.slice(i, i + 4)) && !/[\w]/.test(src[i - 1] || '')) {
      const m = src.slice(i).match(/^r(#*)"/); const close = `"${m[1]}`;
      const start = i; const e = src.indexOf(close, i + m[0].length);
      out.push({ start, value: src.slice(i + m[0].length, e) }); i = e + close.length; continue;
    }
    if (c === '"') {
      const start = i; i++; let v = '';
      while (i < n && src[i] !== '"') { if (src[i] === '\\') { v += src[i + 1]; i += 2; } else { v += src[i]; i++; } }
      i++; out.push({ start, value: v }); continue;
    }
    if (c === '\'') {
      const m = src.slice(i).match(/^'(\\.[^']*|[^'\\])'/u);
      if (m) { i += m[0].length; continue; }
      i++; continue; // время жизни 'a
    }
    i++;
  }
  return out;
}

function checkRs(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const lits = rsLiterals(src);
  for (let k = 0; k < lits.length; k++) {
    const lit = lits[k];
    if (!CYR.test(lit.value)) continue;
    // Пометка может стоять на строке литерала или на одной из двух следующих: cargo fmt переносит `); // i18n-ignore` вниз
    let line = lineText(src, lit.start);
    for (let k2 = 0, p = src.indexOf('\n', lit.start); k2 < 2 && p >= 0; k2++, p = src.indexOf('\n', p + 1)) line += `\n${lineText(src, p + 1)}`;
    if (/\/\/.*i18n-ignore/.test(line)) continue;
    // 200 символов: после cargo fmt строка может стоять на следующей строке после `tr!(` с большим отступом
    const before = src.slice(Math.max(0, lit.start - 200), lit.start);
    if (!/tr!\(\s*$/.test(before)) { errors.push(`${rel}:${lineOf(src, lit.start)}: строка без tr!(): ${JSON.stringify(lit.value.slice(0, 80))}`); continue; }
    const next = lits[k + 1];
    if (!next || CYR.test(next.value)) errors.push(`${rel}:${lineOf(src, lit.start)}: tr!() без английского варианта`);
    else {
      const ph = (s) => (s.match(/\{[^{}]*\}/g) || []).length;
      if (ph(lit.value) !== ph(next.value)) errors.push(`${rel}:${lineOf(src, lit.start)}: tr!() — разное число {} в вариантах`);
    }
  }
}

function walk(dir, ext, skip) {
  const r = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skip.includes(e.name)) r.push(...walk(p, ext, skip)); } else if (e.name.endsWith(ext)) r.push(p);
  }
  return r;
}

(async () => {
  const jsFiles = walk(JS, '.js', ['i18n']).filter((f) => !only.length || only.includes(path.basename(f)));
  jsFiles.forEach(checkJs);
  if (!only.length) {
    walk(RS, '.rs', []).forEach(checkRs);
    for (const html of ['index.html', 'setup.html']) {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', html), 'utf8');
      if (CYR.test(src.replace(/<!--[\s\S]*?-->/g, ''))) errors.push(`src/renderer/${html}: русский текст в HTML — задавайте его из JS через t()`);
    }
  }
  // словарь
  const dict = {};
  const dup = [];
  for (const f of fs.readdirSync(path.join(JS, 'i18n', 'en'))) {
    const mod = await import(pathToFileURL(path.join(JS, 'i18n', 'en', f)).href);
    for (const [k, v] of Object.entries(mod.default || {})) {
      if (k in dict && dict[k] !== v) dup.push(`${f}: «${k}» переведено по-разному: «${dict[k]}» / «${v}»`);
      dict[k] = v;
      if (typeof v !== 'string' || !v.trim()) errors.push(`i18n/en/${f}: пустой перевод для «${k}»`);
      else if (CYR.test(v)) errors.push(`i18n/en/${f}: в переводе осталась кириллица: «${v}»`);
    }
  }
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const [k, where] of keys) {
    if (!(k in dict)) errors.push(`${where[0]}: нет перевода для ${JSON.stringify(k)}`);
    else if (ph(k) !== ph(dict[k])) errors.push(`${where[0]}: подстановки не совпадают: ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`);
  }
  for (const d of dup) console.log(`warning: ${d}`);
  if (!only.length) {
    const unused = Object.keys(dict).filter((k) => !keys.has(k));
    if (unused.length) console.log(`warning: неиспользуемых переводов: ${unused.length}${unused.length <= 15 ? ` — ${unused.map((u) => JSON.stringify(u)).join(', ')}` : ''}`);
  }
  console.log(`i18n: файлов ${jsFiles.length}, строк в t(): ${keys.size}, в словаре: ${Object.keys(dict).length}, ошибок: ${errors.length}`);
  for (const e of errors) console.log(e);
  process.exit(errors.length ? 1 : 0);
})();
