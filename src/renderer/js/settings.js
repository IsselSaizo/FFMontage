// Окно настроек внутри главного окна (M2.3): Общие (язык, запуск), Горячие клавиши (пресеты, переназначение,
// конфликты, экспорт/импорт), Папки, Кэш, ИИ-ассистент, Плагины (M3.6), О программе.
// Хранятся в settings.json (Rust settings.rs) через js/prefs.js: getSetting/setSettings — его обёртки.
import { h, icon, toast, confirmDialog, promptDialog, fmtBytes, errText, debounce } from './util.js';
import { loadPrefs, getPref, setPref, setPrefs } from './prefs.js';
import { invoke } from './tauri.js';
import { t, tIn, LANGS, getLang, rememberLang, langChosen, systemLang } from './i18n.js';
import {
  ACTIONS, CATEGORIES, PRESETS, keysOf, baseKeysOf, isCustom, keyLabel, comboFromEvent,
  configureKeymap, keymapState, conflicts, actionById,
} from './keymap.js';
import { foldersForm } from './folders.js';
import { store } from './store.js';
import { renderPaths } from './vst.js';

const api = window.api;
// Действия главного окна: перезагрузка с сохранением проекта, обновления, диалог MCP, сохранение перед перезапуском
let hooks = { reload: () => location.reload(), checkUpdates: () => {}, showMcp: () => {}, beforeRestart: async () => {} };

export async function initSettings(appHooks = {}) {
  hooks = { ...hooks, ...appHooks };
  await loadPrefs();
  configureKeymap(getPref('keymap', {}) || {});
}

export const getSetting = (key, def) => getPref(key, def);

export const setSettings = (patch) => setPrefs(patch);

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
  if (langChosen() || boot.selftest || getPref('lang')) return;
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
  { id: 'plugins', title: t('Плагины'), icon: 'link', render: renderPlugins },
  { id: 'vst', title: t('Аудиоплагины (VST3, CLAP)'), icon: 'music', render: renderVst },
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
      h('li', {}, t('Колесо — прокрутка таймлайна по времени, Shift + колесо — дорожки вверх и вниз.')),
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
  const where = await invoke('paths_info').catch(() => null);
  if (where) body.append(dataPlaces(where));
  form.check();
}

// Где лежат настройки, свои шрифты и плагины (M0.5): режим portable / системные папки и как его сменить
function dataPlaces(p) {
  const MODE = {
    portable: t('Переносной режим: настройки, свои шрифты и плагины хранятся в папке программы.'),
    system: t('Системные папки: настройки, свои шрифты и плагины хранятся в папке пользователя.'),
    custom: t('Папки заданы переменной окружения FFM_CONFIG (автотест или ИИ-клиент).'),
  };
  const row = (title, path) => h('div', { class: 'about-row', style: { gridTemplateColumns: '140px 1fr auto', alignItems: 'center' } },
    h('span', { class: 'muted' }, title),
    h('span', { class: 'sel cfg-path', title: path }, path),
    h('button', { class: 'icon-btn small', title: t('Открыть папку'), html: icon('folder', 15), onclick: () => api.openPath(path).then((e) => { if (e) toast(e, 'error'); }) }));
  const files = 'config.json, settings.json, user-fonts, plugins';
  const hint = p.mode === 'portable' && p.other
    ? t('Чтобы перейти на системные папки, закройте программу, перенесите {files} в {dir} и удалите portable.txt и config.json рядом с программой.', { files, dir: p.other.configDir })
    : p.mode === 'system'
      ? t('Чтобы сделать программу переносной, закройте её, положите рядом с программой пустой файл portable.txt и перенесите туда {files} из {dir}.', { files, dir: p.configDir })
      : '';
  return h('div', { class: 'set-places', id: 'data-places', dataset: { mode: p.mode }, style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '18px' } },
    h('b', {}, t('Где хранятся данные')),
    h('p', { class: 'muted small' }, MODE[p.mode] || p.mode),
    row(t('Настройки'), p.configDir),
    p.dataDir !== p.configDir ? row(t('Данные'), p.dataDir) : null,
    row(t('Плагины'), p.pluginsDir),
    row(t('Свои шрифты'), p.fontsDir),
    hint ? h('p', { class: 'muted small' }, hint) : null,
    p.other && p.other.hasData
      ? h('p', { class: 'plg-warn small' }, t('В {dir} есть данные другого режима — программа их сейчас не использует. Автоматически они не переносятся.', { dir: p.other.configDir }))
      : null);
}

// --- Кэш ---
// Ключи кэша и пути медиа открытого проекта: их кэш (прокси, реверс, стоп-кадры, анимации) не удаляется
export function projectCacheKeep() {
  const keep = [];
  for (const m of Object.values(store.project.media || {})) { if (m.key) keep.push(m.key); if (m.path) keep.push(m.path); }
  // Рендеры аудиоплагинов (категория audiofx), готовые в этом сеансе
  keep.push(...renderPaths());
  return keep;
}

/** Автоочистка кэша до лимита (после смены лимита; при запуске её делает программа сама) */
export const cacheAutoclean = () => invoke('cache_autoclean', { keep: projectCacheKeep() });

const gb = (n) => t('{n} ГБ', { n });

async function renderCache(body) {
  const box = h('div', { class: 'cache-box' }, h('p', { class: 'muted' }, t('Считаю…')));
  body.append(box);
  let stats = null;
  // Лимит: 1..50 ГБ, по умолчанию 1. Лишнее удаляется само (Rust cache.rs autoclean), начиная с давно неиспользованного
  const limitIn = h('input', { type: 'range', id: 'cache-limit', min: 1, max: 50, step: 1 });
  const limitVal = h('b', { id: 'cache-limit-val', class: 'cache-limit-val' });
  const usedNow = h('span', { id: 'cache-used', class: 'muted small' });
  const showUsed = () => { if (stats) usedNow.textContent = t('Сейчас занято: {size}', { size: fmtBytes(stats.auto || 0) }); };
  const applyLimit = debounce(async () => {
    try {
      const r = await cacheAutoclean();
      if (r && r.freed > 0) toast(t('Автоочистка: освобождено {size}', { size: fmtBytes(r.freed) }), 'success', 3000);
      if (limitIn.isConnected) draw(await api.cacheStats());
    } catch (e) { toast(errText(e), 'error', 5000); }
  }, 800);
  limitIn.addEventListener('input', () => {
    const n = Math.max(1, Math.min(50, Math.round(Number(limitIn.value) || 1)));
    limitVal.textContent = gb(n);
    setPref('cache', { ...(getPref('cache', {}) || {}), limitGb: n });
    applyLimit();
  });
  limitIn.style.flex = '1';
  limitVal.style.whiteSpace = 'nowrap';
  usedNow.style.whiteSpace = 'nowrap';
  const limitRow = h('div', { class: 'cache-limit', style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px', marginBottom: '6px' } },
    h('div', { class: 'set-label' },
      h('b', {}, t('Сколько места оставлять под старый кэш')),
      h('span', { class: 'muted small' }, t('Лишнее удаляется само, начиная с давно неиспользованного. Файлы открытого проекта не удаляются, даже если они больше лимита.'))),
    h('div', { class: 'row gap', style: { alignItems: 'center' } }, limitIn, limitVal, usedNow));
  const list = h('div', { class: 'cache-list' });

  const draw = (s) => {
    stats = s;
    const lim = Math.max(1, Math.min(50, Math.round(Number(getPref('cache.limitGb', s.limitGb || 1)) || 1)));
    limitIn.value = String(lim);
    limitVal.textContent = gb(lim);
    showUsed();
    list.innerHTML = '';
    const rows = [
      { id: 'thumbs', title: t('Миниатюры'), desc: t('Кадры на таймлайне и в медиатеке. Пересоздаются сами.'), size: s.thumbs, on: true },
      { id: 'peaks', title: t('Волны звука'), desc: t('Пересоздаются сами, когда файл снова понадобится.'), size: s.peaks, on: true },
      { id: 'proxy', title: t('Прокси'), desc: t('Облегчённые копии видео для плавного просмотра. Пересоздаются, но не сразу.'), size: s.proxy, on: true },
      { id: 'fx', title: t('Реверс и стоп-кадры'), desc: t('Пересоздаются по проекту, но долго. Файлы открытого проекта не трогаем.'), size: s.fx, on: false },
      { id: 'assets', title: t('Тексты и субтитры для экспорта'), desc: t('Картинки и файлы субтитров, которые готовятся перед каждым экспортом.'), size: s.assets, on: true },
      { id: 'fonts', title: t('Шрифты для субтитров'), desc: t('Копии шрифтов для экспорта субтитров (libass).'), size: s.fonts, on: true },
      ...(s.audiofx !== undefined ? [{ id: 'audiofx', title: t('Звук после аудиоплагинов'), desc: t('Результаты VST3 / CLAP для плеера и экспорта. Пересоздаются сами. Файлы открытого проекта не трогаем.'), size: s.audiofx, on: true }] : []),
      { id: 'temp', title: t('Прочее'), desc: t('Временные файлы экспорта и окна, неопознанные файлы кэша.'), size: s.temp, on: true },
      { id: 'anim', title: t('Сохранённые анимации'), desc: t('Это материалы ваших проектов: удаляйте, только если они больше не нужны. Анимации открытого проекта не трогаем.'), size: s.anim, on: false },
      { id: 'logs', title: t('Журналы'), desc: t('Нужны, только если вы сообщаете об ошибке.'), size: s.logs, on: false },
      { id: 'webview', title: t('Данные окна'), desc: t('Служебные файлы WebView — не очищаются.'), size: s.webview, fixed: true },
    ];
    const checks = {};
    for (const r of rows) {
      const cb = r.fixed ? null : h('input', { type: 'checkbox', dataset: { cat: r.id } });
      if (cb) { cb.checked = r.on; checks[r.id] = cb; }
      list.append(h('label', { class: `cache-row${r.fixed ? ' fixed' : ''}`, dataset: { row: r.id } },
        cb || h('span', { class: 'cb-space' }),
        h('span', { class: 'set-label' }, h('b', {}, r.title), h('span', { class: 'muted small' }, r.desc)),
        h('span', { class: 'cache-size' }, fmtBytes(r.size || 0))));
    }
    const clear = h('button', { class: 'btn primary', id: 'cache-clear', onclick: async () => {
      const cats = Object.entries(checks).filter(([, c]) => c.checked).map(([id]) => id);
      if (!cats.length) return;
      clear.disabled = true;
      try {
        const r = await api.cacheClear(cats, projectCacheKeep());
        toast(t('Освобождено: {size}', { size: fmtBytes(r.freed) }) + (r.failed ? ` · ${t('не удалось удалить: {n}', { n: r.failed })}` : ''), 'success', 3000);
        draw(r.stats);
      } catch (e) { toast(errText(e), 'error', 5000); clear.disabled = false; }
    } }, t('Очистить выбранное'));
    list.append(
      h('div', { class: 'row gap set-actions' }, clear,
        h('button', { class: 'btn ghost', onclick: () => api.openPath(s.cacheDir) }, h('span', { html: icon('folder', 16) }), t('Открыть папку кэша')),
        h('span', { class: 'muted small', id: 'cache-total' }, t('Всего: {size}', { size: fmtBytes(s.total || 0) }))));
  };
  const s = await api.cacheStats();
  box.innerHTML = '';
  box.append(limitRow, list);
  draw(s);
}

// --- ИИ-ассистент ---
function renderMcp(body) {
  body.append(
    h('p', {}, t('FF Montage можно подключить к ИИ-ассистенту (Claude Desktop, Cursor, VS Code, Claude Code) по протоколу MCP: ассистент сможет импортировать файлы, резать клипы, ставить переходы и запускать экспорт по вашей просьбе.')),
    h('button', { class: 'btn primary', onclick: () => hooks.showMcp() }, h('span', { html: icon('ai', 17) }), t('Как подключить…')));
}

// --- Плагины ---
// Хост грузится лениво: если с ним что-то не так, остальные разделы настроек работают
const GH_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ghRepo = (v) => String(v || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');

// Окно с правами плагина: true — пользователь согласен
function permsDialog(item, { title, text, okText, cancelText = t('Отмена'), notes = [] }) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); resolve(v); };
    const perms = item.permissions || [];
    const overlay = h('div', { class: 'modal-overlay plg-perms-dialog' },
      h('div', { class: 'modal small' },
        h('div', { class: 'modal-head' }, h('h2', {}, title)),
        h('div', { class: 'modal-body' },
          item.description ? h('p', { class: 'muted small' }, item.description) : null,
          h('p', {}, text),
          perms.length
            ? h('ul', { class: 'plg-perms' }, ...perms.map((p) => h('li', { class: p.warn ? 'warn' : '' }, p.text)))
            : h('p', { class: 'muted small' }, t('Особых прав не просит: только эффекты, переходы и клавиши из описания.')),
          ...notes.map((n) => h('p', { class: `small ${n.warn ? 'plg-warn' : 'muted'}` }, n.text))),
        h('div', { class: 'modal-foot' },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, cancelText),
          h('button', { class: 'btn primary', onclick: () => close(true) }, okText))));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    document.body.append(overlay);
    overlay.querySelector('.btn.primary').focus();
  });
}

async function renderPlugins(body) {
  const host = await import('./plugins/host.js');
  const listBox = h('div', { class: 'plg-list' });
  const status = h('p', { class: 'setup-error' });
  const busyBtns = [];
  const setBusy = (on) => { for (const b of busyBtns) b.disabled = on; };
  const btn = (label, iconName, fn, cls = 'btn ghost small') => {
    const b = h('button', { class: cls, onclick: async () => {
      status.textContent = '';
      try { await fn(); } catch (e) { status.textContent = errText(e); }
    } }, iconName ? h('span', { html: icon(iconName, 15) }) : null, label);
    busyBtns.push(b);
    return b;
  };

  // После установки: показать права и спросить, включать ли (до согласия плагин выключен)
  async function finishInstall(run, fromGithub) {
    setBusy(true);
    let r;
    try { r = await run(); } catch (e) {
      setBusy(false);
      toast(t('Не удалось установить плагин: {e}', { e: errText(e) }), 'error', 7000);
      return;
    }
    setBusy(false);
    const item = host.pluginList().find((x) => x.id === r.id)
      || { id: r.id, name: r.id, manifest: r.manifest, permissions: host.describePermissions(r.manifest || {}) };
    if (item.error) { toast(t('Плагин «{name}» установлен, но в его манифесте ошибка: {e}', { name: item.name, e: item.error }), 'error', 8000); return; }
    const notes = [];
    if (r.replaced) notes.push({ text: t('Заменена ранее установленная версия.') });
    if (fromGithub && !r.sha256Verified) notes.push({ warn: true, text: t('Контрольная сумма архива (sha256) не проверена — в релизе нет файла с ней. Включайте, только если доверяете автору.') });
    if (fromGithub && r.asset) notes.push({ text: t('Файл релиза: {name}', { name: typeof r.asset === 'string' ? r.asset : r.asset.name || '' }) });
    const ok = await permsDialog(item, {
      title: t('Плагин «{name}» установлен', { name: item.name }),
      text: t('Включить его? Плагин получит такие права:'),
      okText: t('Включить'), cancelText: t('Оставить выключенным'), notes,
    });
    if (ok) {
      await host.setEnabled(r.id, true);
      toast(t('Плагин «{name}» включён', { name: item.name }), 'success', 2500);
    }
  }

  const trust = () => confirmDialog(t('Установить плагин?'),
    t('Устанавливайте плагины только из источников, которым доверяете. Код плагина работает в песочнице, а перед включением программа покажет, какие права он просит.'),
    t('Продолжить'));
  const installPick = async (kind) => {
    if (!(await trust())) return;
    const src = await api.pluginsPick(kind);
    if (!src) return;
    await finishInstall(() => host.installFrom(src), false);
  };
  const installGh = async () => {
    const v = await promptDialog(t('Установка с GitHub'), t('Репозиторий (owner/repo)'), '', {
      okText: t('Установить'),
      hint: t('Будет скачан последний релиз репозитория (первый файл .zip).'),
      validate: (x) => (GH_REPO.test(ghRepo(x)) ? null : t('Укажите репозиторий в виде owner/repo')),
    });
    if (!v) return;
    if (!(await trust())) return;
    await finishInstall(() => host.installGithub(ghRepo(v)), true);
  };

  function card(p) {
    const m = p.manifest || {};
    const head = h('div', { class: 'plg-head' },
      h('div', { class: 'set-label grow' },
        h('div', { class: 'plg-title' },
          h('b', {}, p.name || p.id),
          m.version ? h('span', { class: 'muted small' }, t('версия {v}', { v: String(m.version) })) : null,
          p.builtin ? h('span', { class: 'plg-tag' }, t('встроенный')) : null),
        h('span', { class: 'muted small' }, [m.author ? t('Автор: {name}', { name: String(m.author) }) : null, `id: ${p.id}`].filter(Boolean).join(' · '))));
    const tools = h('div', { class: 'plg-tools' });
    if (!p.builtin) {
      if (!p.error) {
        const sw = h('input', { type: 'checkbox', class: 'plg-toggle', dataset: { plugin: p.id } });
        sw.checked = p.enabled;
        sw.addEventListener('change', async () => {
          sw.disabled = true;
          try {
            if (sw.checked) {
              const ok = await permsDialog(p, { title: t('Включить плагин «{name}»?', { name: p.name }), text: t('Плагин получит такие права:'), okText: t('Включить') });
              if (!ok) { sw.checked = false; return; }
            }
            await host.setEnabled(p.id, sw.checked);
          } catch (e) { toast(errText(e), 'error', 5000); sw.checked = !sw.checked; } finally { sw.disabled = false; }
        });
        tools.append(h('label', { class: 'plg-switch', title: p.enabled ? t('Выключить') : t('Включить') }, sw, h('span', {}, t('Включён'))));
      }
      tools.append(
        h('button', { class: 'icon-btn small', title: t('Открыть папку'), html: icon('folder', 15), onclick: () => api.pluginsOpenDir(p.id).catch((e) => toast(errText(e), 'error')) }),
        h('button', { class: 'icon-btn small plg-remove', title: t('Удалить'), dataset: { plugin: p.id }, html: icon('trash', 15), onclick: async () => {
          if (!(await confirmDialog(t('Удалить плагин «{name}»?', { name: p.name }),
            t('Папка плагина будет удалена. Проекты с его эффектами откроются, но эти эффекты не будут применяться, пока плагин не установят снова.'),
            t('Удалить'), t('Отмена'), true))) return;
          try { await host.removePlugin(p.id); toast(t('Плагин удалён'), 'success', 2000); } catch (e) { toast(t('Не удалось удалить плагин: {e}', { e: errText(e) }), 'error', 6000); }
        } }));
    }
    head.append(tools);
    return h('div', { class: `plg-item${p.enabled ? '' : ' off'}${p.error ? ' bad' : ''}`, dataset: { plugin: p.id } },
      head,
      p.description ? h('p', { class: 'muted small plg-desc' }, p.description) : null,
      !p.builtin && p.permissions.length ? h('ul', { class: 'plg-perms small' }, ...p.permissions.map((x) => h('li', { class: x.warn ? 'warn' : '' }, x.text))) : null,
      p.error ? h('p', { class: 'setup-error' }, t('Ошибка в манифесте: {e}', { e: p.error })) : null,
      ...p.problems.map((x) => h('p', { class: 'setup-error' }, x)));
  }

  function draw() {
    listBox.innerHTML = '';
    const all = host.pluginList();
    if (host.listError()) listBox.append(h('p', { class: 'setup-error' }, t('Список плагинов не загрузился: {e}', { e: host.listError() })));
    for (const p of all) listBox.append(card(p));
    if (!all.some((p) => !p.builtin)) listBox.append(h('p', { class: 'muted small' }, t('Установленных плагинов нет.')));
    dirBox.textContent = host.pluginsDir() ? t('Папка плагинов: {path}', { path: host.pluginsDir() }) : '';
  }
  const dirBox = h('span', { class: 'muted small cfg-path' });
  const off = host.onPluginsChange(() => { if (!listBox.isConnected) { off(); return; } draw(); });

  body.append(
    h('p', { class: 'muted small' }, t('Плагины добавляют эффекты, переходы, панели и действия с горячими клавишами. Код плагина работает в песочнице: без доступа к файлам и к самой программе — только то, что разрешают его права.')),
    h('div', { class: 'row gap set-actions plg-install' },
      btn(t('Из папки…'), 'folder', () => installPick('folder'), 'btn primary small'),
      btn(t('Из zip…'), 'upload', () => installPick('zip')),
      btn(t('С GitHub…'), 'link', installGh),
      btn(t('Открыть папку плагинов'), 'folder', () => api.pluginsOpenDir(null)),
      btn(t('Обновить список'), 'refresh', () => host.refreshList())),
    status,
    listBox,
    dirBox);
  draw();
}

// --- Аудиоплагины VST3 / CLAP (js/vst.js; Rust — src-tauri/src/vst) ---
async function renderVst(body) {
  const vst = await import('./vst.js');
  await vst.initVst();
  const s = vst.vstStatus();
  if (!s.supported) {
    body.append(h('p', { class: 'muted' }, t('Аудиоплагины VST3 / CLAP работают только в Windows (x64).')));
    return;
  }
  const status = h('p', { class: 'muted small', id: 'vst-scan-status' });
  const err = h('p', { class: 'setup-error' });
  const folderBox = h('div', { class: 'vst-list', id: 'vst-folders' });
  const listBox = h('div', { id: 'vst-plugins' });
  const failBox = h('div', { class: 'vst-failed', id: 'vst-failed' });
  const btns = [];
  const btn = (label, iconName, fn, cls = 'btn ghost small', id = null) => {
    const b = h('button', { class: cls, id, onclick: async () => {
      err.textContent = '';
      for (const x of btns) x.disabled = true;
      try { await fn(); } catch (e) { err.textContent = errText(e); } finally { for (const x of btns) x.disabled = false; draw(); }
    } }, iconName ? h('span', { html: icon(iconName, 15) }) : null, label);
    btns.push(b);
    return b;
  };
  const showScan = () => {
    const p = s.scanning;
    status.textContent = p ? (p.total ? t('Сканирование: {done} из {total} — {path}', { done: p.done || 0, total: p.total, path: p.path || '' }) : t('Сканирование…')) : '';
  };
  const folderRow = (path, removable) => h('div', { class: 'vst-row' },
    h('span', { class: 'sel cfg-path', title: path }, path),
    removable ? h('span') : h('span', { class: 'muted small' }, t('стандартная')),
    removable
      ? h('button', { class: 'icon-btn small', title: t('Убрать папку'), html: icon('trash', 15), onclick: async () => {
        try { await vst.setVstFolders(s.folders.filter((x) => x !== path)); } catch (e) { err.textContent = errText(e); }
        draw();
      } })
      : h('span'));

  function draw() {
    if (!listBox.isConnected && body.isConnected === false) return;
    folderBox.innerHTML = '';
    for (const f of s.defaults) folderBox.append(folderRow(f, false));
    for (const f of s.folders) folderBox.append(folderRow(f, true));
    if (!s.defaults.length && !s.folders.length) folderBox.append(h('p', { class: 'muted small' }, t('Папок нет.')));
    listBox.innerHTML = '';
    const all = s.plugins;
    listBox.append(h('p', { class: 'muted small' }, all.length ? t('Найдено плагинов: {n}', { n: all.length }) : t('Плагины не найдены. Добавьте папку или плагин и запустите сканирование.')));
    const groups = new Map();
    for (const p of all) { const v = String(p.vendor || '') || t('Без производителя'); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(p); }
    for (const v of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      listBox.append(h('div', { class: 'vst-vendor' }, v));
      const box = h('div', { class: 'vst-list' });
      for (const p of groups.get(v).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
        const kind = [p.category, p.sub].filter(Boolean).join(' · ');
        box.append(h('div', { class: 'vst-row', dataset: { vstUid: String(p.uid) }, title: p.path || '' },
          h('span', { class: 'set-label' },
            h('b', {}, String(p.name || p.uid)),
            h('span', { class: 'muted small cfg-path' }, [p.version ? t('версия {v}', { v: String(p.version) }) : '', kind, p.instrument ? t('инструмент — в стойку эффектов не ставится') : ''].filter(Boolean).join(' · '))),
          h('span', { class: 'fmt-tag' }, vst.formatLabel(vst.pluginFormat(p))),
          h('span', { class: 'muted small cfg-path', title: p.path || '' }, String(p.path || '').split(/[\\/]/).pop())));
      }
      listBox.append(box);
    }
    failBox.innerHTML = '';
    if (s.failed.length) {
      failBox.append(h('b', {}, t('Не загрузились ({n})', { n: s.failed.length })),
        h('p', { class: 'muted small' }, t('Эти файлы не сканируются повторно, пока не изменятся. «Пересканировать всё» проверит их снова.')),
        h('div', { class: 'vst-list' }, ...s.failed.map((f) => h('div', { class: 'vst-row' },
          h('span', { class: 'sel cfg-path', title: f.path }, f.path),
          h('span', { class: 'setup-error small' }, String(f.error || '')),
          h('span')))));
    }
    if (s.error) err.textContent = s.error;
    showScan();
  }
  const off = vst.onVstChange((kind) => {
    if (!body.isConnected || body.dataset.section !== 'vst') { off(); return; }
    if (kind === 'scan') showScan(); else if (kind === 'list') draw();
  });

  body.append(
    h('p', { class: 'muted small' }, t('Эффекты VST3 и CLAP из папок ниже можно ставить в стойку эффектов клипа или дорожки (вкладка «Аудио»). Плагины работают в отдельном процессе: если плагин упадёт, программа продолжит работу.')),
    h('div', { class: 'row gap set-actions' },
      btn(t('Сканировать'), 'refresh', () => vst.scanVst(false), 'btn primary small', 'vst-scan'),
      btn(t('Пересканировать всё'), 'refresh', () => vst.scanVst(true), 'btn ghost small', 'vst-rescan'),
      btn(t('Добавить плагин…'), 'plus', () => vst.installVst(null), 'btn ghost small', 'vst-install'),
      btn(t('Добавить папку…'), 'folder', async () => {
        const dir = await vst.pickVstFolder();
        if (dir && !s.folders.includes(dir)) await vst.setVstFolders([...s.folders, dir]);
      }, 'btn ghost small', 'vst-add-folder')),
    status, err,
    h('b', {}, t('Папки с плагинами')),
    folderBox,
    h('b', { style: { display: 'block', marginTop: '14px' } }, t('Найденные плагины')),
    listBox,
    failBox);
  draw();
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
    ...(await invoke('paths_info').then((p) => [
      row(t('Настройки интерфейса'), p.settingsFile),
      row(t('Хранение данных'), p.mode === 'portable' ? t('переносной режим (рядом с программой)') : p.mode === 'system' ? t('системные папки') : 'FFM_CONFIG'),
    ]).catch(() => [])),
    // Отчёты об ошибках (crashlog.rs): только на этом компьютере, никуда не отправляются
    ...(await api.crashReports(false).then((r) => (r ? [
      row(t('Отчёты об ошибках'), r.total ? t('{n} — последний: {name}', { n: r.total, name: r.last }) : t('нет')),
    ] : [])).catch(() => [])),
    h('div', { class: 'row gap set-actions' },
      h('button', { class: 'btn primary', onclick: () => hooks.checkUpdates() }, h('span', { html: icon('refresh', 16) }), t('Проверить обновления…')),
      h('button', { class: 'btn ghost', onclick: () => api.openPath(i.logsDir) }, h('span', { html: icon('folder', 16) }), t('Папка журналов'))),
    h('p', { class: 'muted small' }, t('Журналы и отчёты об ошибках хранятся только на этом компьютере и никуда не отправляются. Если сообщаете об ошибке — приложите файлы из папки reports.')));
}
