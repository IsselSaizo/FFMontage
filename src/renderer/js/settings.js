// Окно настроек внутри главного окна (M2.3): Общие (язык, запуск), Горячие клавиши (пресеты, переназначение,
// конфликты, экспорт/импорт), Папки, Кэш, ИИ-ассистент, О программе.
// Хранятся в config.json → "settings" (команды settings_get / settings_set в Rust).
import { h, icon, toast, confirmDialog, fmtBytes, errText } from './util.js';
import { t, tIn, LANGS, getLang, rememberLang, langChosen, systemLang } from './i18n.js';
import {
  ACTIONS, CATEGORIES, PRESETS, keysOf, baseKeysOf, isCustom, keyLabel, comboFromEvent,
  configureKeymap, keymapState, conflicts, actionById,
} from './keymap.js';
import { foldersForm } from './folders.js';
import { store } from './store.js';

const api = window.api;
let data = {};
// Действия главного окна: перезагрузка с сохранением проекта, обновления, диалог MCP, сохранение перед перезапуском
let hooks = { reload: () => location.reload(), checkUpdates: () => {}, showMcp: () => {}, beforeRestart: async () => {} };

export async function initSettings(appHooks = {}) {
  hooks = { ...hooks, ...appHooks };
  try { data = (await api.settingsGet()).settings || {}; } catch (e) { console.warn('settings', e); }
  configureKeymap(data.keymap || {});
}

export const getSetting = (key, def) => (data && key in data ? data[key] : def);

export async function setSettings(patch) {
  data = await api.settingsSet(patch);
  return data;
}

async function switchLang(l) {
  if (l === getLang()) { await setSettings({ lang: l }).catch(() => {}); return; }
  await setSettings({ lang: l }).catch((e) => toast(errText(e), 'error'));
  rememberLang(l);
  hooks.reload();
}

// ---------------------------------------------------------------------------
// Первый запуск этой версии: предложить язык (по языку системы и раскладке)
// ---------------------------------------------------------------------------
export function maybeAskLanguage() {
  const boot = window.__FFM_BOOT || {};
  if (langChosen() || boot.selftest || data.lang) return;
  askLanguage();
}

export function askLanguage() {
  const sys = systemLang();
  const overlay = h('div', { class: 'modal-overlay lang-ask' });
  const choose = (l) => { overlay.remove(); switchLang(l); };
  const order = sys === 'en' ? ['en', 'ru'] : ['ru', 'en'];
  overlay.append(h('div', { class: 'modal small' },
    h('div', { class: 'modal-head' }, h('h2', {}, order.map((l) => tIn(l, 'Язык интерфейса')).join(' / '))),
    h('div', { class: 'modal-body' },
      ...order.map((l) => h('p', { class: 'muted small' }, tIn(l, 'Язык можно сменить в любой момент: меню ☰ → «Настройки».'))),
      h('div', { class: 'lang-choice' }, ...order.map((id) => h('button', {
        class: `btn ${id === sys ? 'primary' : 'ghost'}`, dataset: { lang: id }, onclick: () => choose(id),
      }, LANGS.find((x) => x.id === id).name))))));
  document.body.append(overlay);
}

// ---------------------------------------------------------------------------
// Окно настроек
// ---------------------------------------------------------------------------
const SECTIONS = () => [
  { id: 'general', title: t('Общие'), icon: 'palette', render: renderGeneral },
  { id: 'hotkeys', title: t('Горячие клавиши'), icon: 'keyboard', render: renderHotkeys },
  { id: 'folders', title: t('Папки'), icon: 'folder', render: renderFolders },
  { id: 'cache', title: t('Кэш'), icon: 'trash', render: renderCache },
  { id: 'mcp', title: t('ИИ-ассистент'), icon: 'ai', render: renderMcp },
  { id: 'about', title: t('О программе'), icon: 'info', render: renderAbout },
];

let current = null; // { overlay, show(id) }

export function openSettings(section = 'general') {
  if (current && !current.overlay.isConnected) current.close();
  if (current) { current.show(section); return; }
  const nav = h('nav', { class: 'set-nav' });
  const body = h('div', { class: 'set-body' });
  const overlay = h('div', { class: 'modal-overlay settings-overlay' });
  const close = () => { overlay.remove(); current = null; document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape' && !overlay.querySelector('.recording') && document.querySelector('.modal-overlay:last-of-type') === overlay) { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.append(h('div', { class: 'modal settings', id: 'settings' },
    h('div', { class: 'modal-head' }, h('h2', {}, t('Настройки')), h('button', { class: 'icon-btn', title: t('Закрыть'), html: icon('close', 18), onclick: close })),
    h('div', { class: 'set-wrap' }, nav, body)));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  const sections = SECTIONS();
  const show = (id) => {
    const s = sections.find((x) => x.id === id) || sections[0];
    nav.innerHTML = '';
    nav.append(...sections.map((x) => h('button', {
      class: `set-tab${x.id === s.id ? ' on' : ''}`, dataset: { section: x.id }, onclick: () => show(x.id),
    }, h('span', { html: icon(x.icon, 17) }), x.title)));
    body.innerHTML = '';
    body.dataset.section = s.id;
    body.append(h('h3', { class: 'set-title' }, s.title));
    Promise.resolve(s.render(body)).catch((e) => body.append(h('p', { class: 'setup-error' }, errText(e))));
  };
  current = { overlay, show, close };
  document.body.append(overlay);
  show(section);
}
export const closeSettings = () => current && current.close();

// --- Общие ---
function renderGeneral(body) {
  const restore = h('input', { type: 'checkbox', id: 'set-restore' });
  restore.checked = getSetting('restoreSession', true) !== false;
  restore.addEventListener('change', () => setSettings({ restoreSession: restore.checked }).catch((e) => toast(errText(e), 'error')));
  body.append(
    h('div', { class: 'set-row' },
      h('div', { class: 'set-label' }, h('b', {}, t('Язык интерфейса')), h('span', { class: 'muted small' }, t('Окно перезагрузится, открытый проект сохранится.'))),
      h('div', { class: 'row gap' }, ...LANGS.map((l) => h('button', {
        class: `chip${l.id === getLang() ? ' on' : ''}`, dataset: { lang: l.id }, onclick: () => switchLang(l.id),
      }, l.name)))),
    h('label', { class: 'check-row' }, restore, t('При запуске открывать проект, с которым работали в прошлый раз')));
}

// --- Горячие клавиши ---
function saveKeymap(st) {
  configureKeymap(st);
  setSettings({ keymap: st }).catch((e) => toast(errText(e), 'error'));
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function setKeys(id, keys) {
  const st = keymapState();
  if (same(keys, baseKeysOf(id))) delete st.keys[id]; else st.keys[id] = keys;
  saveKeymap(st);
}

function renderHotkeys(body) {
  let filter = '';
  let recording = null; // id действия, для которого ждём сочетание
  const presetSel = h('select', { class: 'input', id: 'hk-preset' },
    ...Object.entries(PRESETS).map(([id, p]) => h('option', { value: id }, p.name)));
  presetSel.value = keymapState().preset;
  presetSel.addEventListener('change', () => { saveKeymap({ ...keymapState(), preset: presetSel.value }); draw(); });
  const search = h('input', { class: 'input', id: 'hk-search', type: 'search', placeholder: t('Поиск по действию или клавише'), spellcheck: 'false' });
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); draw(); });
  const list = h('div', { class: 'hk-list' });

  const stopRec = () => { recording = null; window.removeEventListener('keydown', onRecKey, true); draw(); };
  function onRecKey(e) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopRec(); return; }
    const combo = comboFromEvent(e);
    if (!combo) return; // одни модификаторы — ждём клавишу
    const id = recording;
    const keys = keysOf(id).filter((k) => k !== combo);
    keys.push(combo);
    setKeys(id, keys);
    stopRec();
  }

  function draw() {
    list.innerHTML = '';
    const conf = conflicts();
    for (const cat of CATEGORIES) {
      const rows = ACTIONS.filter((a) => a.cat === cat.id).filter((a) => !filter
        || a.title.toLowerCase().includes(filter)
        || keysOf(a.id).some((k) => keyLabel(k).toLowerCase().includes(filter)));
      if (!rows.length) continue;
      list.append(h('div', { class: 'hk-cat' }, cat.title));
      for (const a of rows) {
        const keys = keysOf(a.id);
        const chips = keys.map((k) => {
          const others = (conf.get(k) || []).filter((x) => x !== a.id);
          return h('span', {
            class: `hk-key${others.length ? ' conflict' : ''}`,
            title: others.length ? t('Это же сочетание: {list}', { list: others.map((x) => actionById(x).title).join(', ') }) : null,
          }, h('kbd', {}, keyLabel(k)),
          h('button', { class: 'hk-x', title: t('Убрать сочетание'), html: icon('close', 11), onclick: () => { setKeys(a.id, keysOf(a.id).filter((x) => x !== k)); draw(); } }));
        });
        const rec = recording === a.id;
        list.append(h('div', { class: `hk-row${rec ? ' recording' : ''}`, dataset: { action: a.id } },
          h('span', { class: 'hk-title' }, a.title),
          h('span', { class: 'hk-keys' },
            ...chips,
            rec ? h('span', { class: 'hk-wait' }, t('Нажмите сочетание… (Esc — отмена)')) : null,
            keys.length || rec ? null : h('span', { class: 'muted small' }, t('нет'))),
          h('span', { class: 'hk-tools' },
            h('button', { class: 'icon-btn small', title: t('Добавить сочетание'), html: icon('plus', 15), onclick: () => {
              if (recording) window.removeEventListener('keydown', onRecKey, true);
              recording = a.id; window.addEventListener('keydown', onRecKey, true); draw();
            } }),
            isCustom(a.id) ? h('button', { class: 'icon-btn small', title: t('Вернуть клавиши пресета'), html: icon('undo', 15), onclick: () => { setKeys(a.id, baseKeysOf(a.id)); draw(); } }) : null)));
      }
    }
    const n = conflicts().size;
    confBox.textContent = n ? t('Конфликтов: {n} — одно сочетание назначено нескольким действиям (выделены красным). Сработает первое по списку.', { n }) : '';
  }
  const confBox = h('p', { class: 'hk-conf small' });

  const exportKeys = () => {
    const st = keymapState();
    const text = JSON.stringify({ format: 'ff-montage-keymap', version: 1, preset: st.preset, keys: st.keys }, null, 2);
    textDialog(t('Экспорт горячих клавиш'), t('Скопируйте текст и сохраните его в файл .json.'), text, null);
  };
  const importKeys = () => textDialog(t('Импорт горячих клавиш'), t('Вставьте JSON, полученный через «Экспорт».'), '', (text) => {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || (j.keys && typeof j.keys !== 'object')) throw new Error(t('Это не файл горячих клавиш FF Montage'));
    const keys = {};
    for (const [id, v] of Object.entries(j.keys || {})) {
      if (actionById(id) && Array.isArray(v)) keys[id] = v.filter((k) => typeof k === 'string');
    }
    saveKeymap({ preset: PRESETS[j.preset] ? j.preset : 'native', keys });
    presetSel.value = keymapState().preset;
    draw();
    toast(t('Горячие клавиши загружены'), 'success', 2000);
  });

  body.append(
    h('div', { class: 'hk-head' },
      h('label', { class: 'set-label' }, h('b', {}, t('Пресет')), presetSel),
      h('label', { class: 'set-label grow' }, h('b', {}, t('Поиск')), search)),
    h('p', { class: 'muted small' }, t('Пресет повторяет основные клавиши другой программы. Свои сочетания хранятся поверх пресета.')),
    confBox,
    list,
    h('div', { class: 'row gap set-actions' },
      h('button', { class: 'btn ghost small', id: 'hk-reset', onclick: async () => {
        if (!Object.keys(keymapState().keys).length) return;
        if (!(await confirmDialog(t('Сбросить свои сочетания?'), t('Останутся клавиши выбранного пресета.'), t('Сбросить')))) return;
        saveKeymap({ preset: keymapState().preset, keys: {} }); draw();
      } }, t('Сбросить свои')),
      h('button', { class: 'btn ghost small', onclick: exportKeys }, t('Экспорт в JSON…')),
      h('button', { class: 'btn ghost small', onclick: importKeys }, t('Импорт из JSON…'))));
  draw();
  // Подсказки о других полезных приёмах (раньше были в справке)
  body.append(h('div', { class: 'set-hints' },
    h('b', {}, t('Мышь и модификаторы')),
    h('ul', { class: 'muted small' },
      h('li', {}, t('Ctrl + колесо — масштаб таймлайна.')),
      h('li', {}, t('Alt при перетаскивании — без магнита и без наложения.')),
      h('li', {}, t('Правая кнопка мыши на клипе — меню действий.')),
      h('li', {}, t('«+» на стыке клипов — переход.')),
      h('li', {}, t('Корзина на пустом месте дорожки убирает пустоту.')))));
}

function textDialog(title, hint, text, onApply) {
  const area = h('textarea', { class: 'input mono', rows: 14, spellcheck: 'false' });
  area.value = text;
  const err = h('p', { class: 'setup-error' });
  const overlay = h('div', { class: 'modal-overlay' });
  const close = () => overlay.remove();
  overlay.append(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', html: icon('close', 18), onclick: close })),
    h('div', { class: 'modal-body prompt' }, h('p', { class: 'muted small' }, hint), area, err),
    h('div', { class: 'modal-foot' },
      onApply ? null : h('button', { class: 'btn ghost', onclick: async () => {
        try { await navigator.clipboard.writeText(area.value); toast(t('Скопировано'), 'success', 1500); } catch { area.select(); }
      } }, t('Копировать')),
      h('button', { class: 'btn ghost', onclick: close }, t('Закрыть')),
      onApply ? h('button', { class: 'btn primary', onclick: () => {
        try { onApply(area.value); close(); } catch (e) { err.textContent = errText(e); }
      } }, t('Загрузить')) : null)));
  overlay.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.append(overlay);
  area.focus();
  if (!onApply) area.select();
}

// --- Папки ---
async function renderFolders(body) {
  const info = await api.setupInfo();
  const form = foldersForm(info);
  const err = h('div', { class: 'setup-error' });
  const save = h('button', { class: 'btn primary', id: 'folders-save', onclick: async () => {
    err.textContent = '';
    save.disabled = true;
    await hooks.beforeRestart().catch(() => {});
    const r = await api.saveSetup({ ...form.values(), restart: true });
    if (!r.ok) { err.textContent = r.error; save.disabled = false; return; }
    save.textContent = t('Перезапуск…');
  } }, t('Сохранить и перезапустить'));
  body.append(
    h('p', { class: 'muted small' }, t('Новые папки начнут использоваться после перезапуска программы. Старые файлы не переносятся.')),
    form.el, err,
    h('div', { class: 'row gap set-actions' }, save,
      h('span', { class: 'muted small cfg-path', title: info.configFile }, t('Настройки: {path}', { path: info.configFile }))));
  form.check();
}

// --- Кэш ---
async function renderCache(body) {
  const box = h('div', { class: 'cache-box' }, h('p', { class: 'muted' }, t('Считаю…')));
  body.append(box);
  const draw = (s) => {
    box.innerHTML = '';
    const rows = [
      { id: 'media', title: t('Миниатюры, волны звука, прокси'), desc: t('Пересоздаются сами, когда файл снова понадобится. Файлы открытого проекта не трогаем.'), size: s.media, on: true },
      { id: 'temp', title: t('Временные файлы'), desc: t('Остатки экспорта и окна.'), size: s.temp, on: true },
      { id: 'logs', title: t('Журналы'), desc: t('Нужны, только если вы сообщаете об ошибке.'), size: s.logs, on: false },
      { id: 'anim', title: t('Сохранённые анимации'), desc: t('Это материалы ваших проектов — не очищаются.'), size: s.anim, fixed: true },
      { id: 'webview', title: t('Данные окна'), desc: t('Служебные файлы WebView — не очищаются.'), size: s.webview, fixed: true },
    ];
    const checks = {};
    for (const r of rows) {
      const cb = r.fixed ? null : h('input', { type: 'checkbox', dataset: { cat: r.id } });
      if (cb) { cb.checked = r.on; checks[r.id] = cb; }
      box.append(h('label', { class: `cache-row${r.fixed ? ' fixed' : ''}` },
        cb || h('span', { class: 'cb-space' }),
        h('span', { class: 'set-label' }, h('b', {}, r.title), h('span', { class: 'muted small' }, r.desc)),
        h('span', { class: 'cache-size' }, fmtBytes(r.size || 0))));
    }
    const total = rows.reduce((a, r) => a + (r.size || 0), 0);
    const clear = h('button', { class: 'btn primary', id: 'cache-clear', onclick: async () => {
      const cats = Object.entries(checks).filter(([, c]) => c.checked).map(([id]) => id);
      if (!cats.length) return;
      clear.disabled = true;
      const keep = [];
      for (const m of Object.values(store.project.media || {})) { if (m.key) keep.push(m.key); if (m.path) keep.push(m.path); }
      try {
        const r = await api.cacheClear(cats, keep);
        toast(t('Освобождено: {size}', { size: fmtBytes(r.freed) }) + (r.failed ? ` · ${t('не удалось удалить: {n}', { n: r.failed })}` : ''), 'success', 3000);
        draw(r.stats);
      } catch (e) { toast(errText(e), 'error', 5000); clear.disabled = false; }
    } }, t('Очистить выбранное'));
    box.append(
      h('div', { class: 'row gap set-actions' }, clear,
        h('button', { class: 'btn ghost', onclick: () => api.openPath(s.cacheDir) }, h('span', { html: icon('folder', 16) }), t('Открыть папку кэша')),
        h('span', { class: 'muted small' }, t('Всего: {size}', { size: fmtBytes(total) }))));
  };
  draw(await api.cacheStats());
}

// --- ИИ-ассистент ---
function renderMcp(body) {
  body.append(
    h('p', {}, t('FF Montage можно подключить к ИИ-ассистенту (Claude Desktop, Cursor, VS Code, Claude Code) по протоколу MCP: ассистент сможет импортировать файлы, резать клипы, ставить переходы и запускать экспорт по вашей просьбе.')),
    h('button', { class: 'btn primary', onclick: () => hooks.showMcp() }, h('span', { html: icon('ai', 17) }), t('Как подключить…')));
}

// --- О программе ---
async function renderAbout(body) {
  const i = await api.info();
  const row = (k, v) => h('div', { class: 'about-row' }, h('span', { class: 'muted' }, k), h('span', { class: 'sel' }, v));
  body.append(
    h('div', { class: 'about-head' }, h('div', { class: 'logo', html: icon('logo', 40) }),
      h('div', {}, h('b', {}, 'FF Montage'), h('div', { class: 'muted small' }, t('Версия {v} · Tauri {tauri} · WebView {wv}', { v: i.version, tauri: i.tauri, wv: i.webview })))),
    row('FFmpeg', i.ffmpegVersion || t('FFmpeg не найден!')),
    row(t('Путь к FFmpeg'), i.ffmpeg),
    row(t('Кэш'), i.cacheDir),
    row(t('Экспорт'), i.outputDir),
    row(t('Проекты'), i.projectsDir),
    row(t('Файл настроек'), i.configFile),
    h('div', { class: 'row gap set-actions' },
      h('button', { class: 'btn primary', onclick: () => hooks.checkUpdates() }, h('span', { html: icon('refresh', 16) }), t('Проверить обновления…')),
      h('button', { class: 'btn ghost', onclick: () => api.openPath(i.logsDir) }, h('span', { html: icon('folder', 16) }), t('Папка журналов'))));
}
