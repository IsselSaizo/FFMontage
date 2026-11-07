#!/usr/bin/env node
// Таблица горячих клавиш из реестра действий (src/renderer/js/keymap.js) и пресетов (keymapPresets.js) → docs/Guides/HOTKEYS.md.
//   node tools/hotkeys-doc.mjs          — записать docs/Guides/HOTKEYS.md
//   node tools/hotkeys-doc.mjs --check  — сравнить с закоммиченным файлом (для CI); код выхода 1, если файл устарел
// Названия — на русском: в Node окна нет, i18n.js выбирает русский язык.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'src', 'renderer', 'js');
const OUT = path.join(ROOT, 'docs', 'Guides', 'HOTKEYS.md');

// Минимальное окружение на случай, если модули реестра когда-нибудь тронут браузерные объекты при загрузке.
// Сейчас keymap.js и i18n.js сами проверяют typeof window/document; window не задаём — иначе i18n.js
// стал бы искать window.__FFM_BOOT, а язык должен остаться русским.
if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

const load = (f) => import(pathToFileURL(path.join(JS, f)).href);
const { CATEGORIES, ACTIONS, baseKeysOf, keyLabel } = await load('keymap.js');
const { PRESETS } = await load('keymapPresets.js');

const COLUMNS = [
  { id: 'native', title: 'Родные' },
  { id: 'resolve', title: 'DaVinci Resolve' },
  { id: 'premiere', title: 'Premiere Pro' },
  { id: 'capcut', title: 'CapCut' },
];
for (const c of COLUMNS) if (!PRESETS[c.id]) throw new Error(`нет пресета ${c.id} в keymapPresets.js`);

// Подпись сочетания в ячейке таблицы: <kbd>, символы Markdown/HTML экранированы
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\\/g, '&#92;').replace(/`/g, '&#96;').replace(/\|/g, '&#124;').replace(/\*/g, '&#42;').replace(/_/g, '&#95;');
const cell = (keys) => (keys.length ? keys.map((k) => `<kbd>${esc(keyLabel(k))}</kbd>`).join(' ') : '—');

const lines = [
  '# Горячие клавиши FF Montage',
  '',
  '<!-- Файл создан tools/hotkeys-doc.mjs из src/renderer/js/keymap.js и keymapPresets.js. Не править вручную: -->',
  '<!-- после изменения клавиш выполните `node tools/hotkeys-doc.mjs` (CI проверяет, что файл свежий). -->',
  '',
  'Пресет выбирается в окне настроек: **Настройки → Горячие клавиши** (там же можно назначить свои клавиши,',
  'найти конфликты, экспортировать и импортировать JSON). В таблице — клавиши пресетов без ваших изменений.',
  '',
  '- Сочетания привязаны к физическим клавишам, поэтому работают в любой раскладке (S — это клавиша S и в русской раскладке).',
  '- ¹ — действие работает и во время ввода текста.',
  '- «—» — в этом пресете у действия клавиши нет.',
  '- Пресеты Resolve, Premiere Pro и CapCut собраны по памяти и ещё сверяются с самими программами.',
  '- Действия плагинов и пресеты из плагинов здесь не показаны — они видны в настройках, когда плагин включён.',
  '',
];

for (const cat of CATEGORIES) {
  const acts = ACTIONS.filter((a) => a.cat === cat.id && !a.plugin);
  if (!acts.length) continue;
  lines.push(`## ${cat.title}`, '');
  lines.push(`| Действие | ${COLUMNS.map((c) => c.title).join(' | ')} |`);
  lines.push(`|---|${COLUMNS.map(() => '---').join('|')}|`);
  for (const a of acts) {
    const title = `${a.title.replace(/\|/g, '&#124;')}${a.global ? ' ¹' : ''}`;
    lines.push(`| ${title} | ${COLUMNS.map((c) => cell(baseKeysOf(a.id, c.id))).join(' | ')} |`);
  }
  lines.push('');
}

const text = `${lines.join('\n').trimEnd()}\n`;
const norm = (s) => s.replace(/\r\n/g, '\n');
if (process.argv.includes('--check')) {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (norm(old) !== text) {
    console.error('docs/Guides/HOTKEYS.md устарел: выполните `node tools/hotkeys-doc.mjs` и закоммитьте результат');
    process.exit(1);
  }
  console.log('docs/Guides/HOTKEYS.md актуален');
} else {
  fs.writeFileSync(OUT, text);
  console.log(`Записан ${path.relative(ROOT, OUT)}: действий ${ACTIONS.filter((a) => !a.plugin).length}`);
}
