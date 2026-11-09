// Правая панель для текста и субтитров (M5.1, M5.3, M5.5): текстовый клип, реплика, дорожка субтитров.
// Вызывается из inspector.js; ui — его помощники { root, liveSlider, secInput, transformSection, num, render, liveStart, liveEnd }.
import { store, MAX_FADE, MIN_CUE } from './store.js';
import { h, icon, iconEl, fmtTime, t, toast, errText } from './util.js';
import { cleanText, TEXT_DEFAULT } from './textModel.js';
import { cleanShape, shapeName, shapeIcon, SHAPE_TYPES, CHAMFER_DEFAULT } from './shapes.js';
import { borderOf, cleanBorder, BORDER_DEFAULT } from './border.js';
import { cleanTimer, fmtClock, RING_DUR, TIMER_STYLES, timerStyleName } from './timer.js';
import { stylePalette } from './timerStyles.js';
import { parseDuration } from './util.js';
import { fontList, addFonts } from './fonts.js';
import { listTextStyles, textStyleById } from './registry.js';
import { getLang } from './i18n.js';
import { tlLen } from './clipTime.js';
import { changeDuration } from './actions.js';
import { SUB_STYLE_DEFAULT } from './subtitles.js';
import { exportSubtitleTrack, importSubtitles } from './subtitlesUi.js';

const label = (v, fb = '') => (typeof v === 'string' ? v : v && typeof v === 'object' ? v[getLang()] || v.ru || v.en || fb : fb);

// Поле многострочного текста: правка «вживую», одна запись в историю за сеанс ввода
function textArea(ui, value, onLive, { rows = 3, id = null } = {}) {
  const ta = h('textarea', { class: 'input text-edit', rows: String(rows), spellcheck: 'true', id });
  ta.value = value;
  ta.addEventListener('focus', () => ui.liveStart());
  ta.addEventListener('input', () => { ui.liveStart(); onLive(ta.value); });
  ta.addEventListener('blur', () => ui.liveEnd());
  ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') ta.blur(); });
  return ta;
}

export function colorInput(value, onSet, title) {
  const inp = h('input', { type: 'color', class: 'color-in', value, title });
  inp.addEventListener('change', () => onSet(inp.value));
  return inp;
}

function select(options, value, onSet, cls = 'input') {
  const s = h('select', { class: cls });
  for (const [v, name] of options) s.append(h('option', { value: v, selected: v === value }, name));
  s.addEventListener('change', () => onSet(s.value));
  return s;
}

function fontSelect(value, onSet) {
  const list = fontList();
  const opts = list.map((f) => [f.name, f.builtin ? f.name : `${f.name} ★`]);
  if (!list.some((f) => f.name === value)) opts.push([value, t('{name} (нет шрифта — запасной)', { name: value })]);
  opts.push(['__add__', t('Добавить свой шрифт…')]);
  const s = select(opts, value, async (v) => {
    if (v !== '__add__') { onSet(v); return; }
    s.value = value;
    try { const added = await addFonts(); if (added.length) onSet(added[0]); } catch (e) { toast(t('Шрифт не добавлен: {err}', { err: errText(e) }), 'error', 5000); }
  });
  s.classList.add('font-select');
  return s;
}

// Ползунок поля оформления (доли, проценты…) с записью в историю за жест
function styleSlider(ui, value, { min, max, step, fmt, live, commit }) {
  const { slider, val } = ui.liveSlider({ min, max, step, value: Math.min(max, Math.max(min, value)), format: fmt, onLive: live, onCommit: commit });
  return { slider, val };
}

// ---------------- Текстовый клип ----------------
export function renderTextClip(ui, sel) {
  const { root } = ui;
  const clip = sel.clip;
  const tx = cleanText(clip.text);
  const locked = !!(sel.lane && sel.lane.locked);
  const setT = (patch) => store.setText([clip.id], patch);
  const liveT = (patch) => { const f = store.findClip(clip.id); if (f) f.clip.text = cleanText(patch, f.clip.text); };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const st = tx.style ? textStyleById(tx.style) : null;

  root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Текст'))));
  root.append(h('div', { class: 'insp-file' }, iconEl('text', 18), h('span', {}, store.clipName(clip)),
    st ? h('span', { class: 'tag', title: t('Стиль') }, label(st.name, st.id)) : null));

  // --- Содержимое и шрифт ---
  const sec = h('div', { class: 'insp-section', dataset: { section: 'text' } }, h('h3', {}, t('Текст')));
  const ta = textArea(ui, tx.content, (v) => liveT({ content: v }), { rows: Math.min(8, Math.max(2, tx.content.split('\n').length + 1)), id: 'text-content' });
  ta.disabled = locked;
  sec.append(ta);
  const weights = [[300, t('Тонкий')], [400, t('Обычный')], [500, t('Средний')], [600, t('Полужирный')], [700, t('Жирный')], [800, t('Очень жирный')], [900, t('Чёрный')]];
  sec.append(
    h('div', { class: 'row gap' }, fontSelect(tx.font, (v) => setT({ font: v })),
      colorInput(tx.color, (v) => setT({ color: v }), t('Цвет текста'))),
    h('div', { class: 'row gap' },
      select(weights.map(([w, n]) => [String(w), n]), String(tx.weight), (v) => setT({ weight: Number(v) })),
      h('button', { class: `chip${tx.italic ? ' on' : ''}`, title: t('Курсив'), onclick: () => setT({ italic: !tx.italic }) }, h('i', {}, 'I')),
      ...['left', 'center', 'right'].map((a) => h('button', {
        class: `chip${tx.align === a ? ' on' : ''}`, dataset: { align: a },
        title: a === 'left' ? t('По левому краю') : a === 'center' ? t('По центру') : t('По правому краю'), onclick: () => setT({ align: a }),
      }, a === 'left' ? '⯇' : a === 'center' ? '≡' : '⯈'))));
  const sizeS = styleSlider(ui, tx.size, { min: 0.02, max: 0.3, step: 0.002, fmt: (v) => pct(v), live: (v) => liveT({ size: v }), commit: (v) => setT({ size: v }) });
  sizeS.slider.dataset.text = 'size';
  const lhS = styleSlider(ui, tx.lineHeight, { min: 0.8, max: 2.5, step: 0.05, fmt: (v) => ui.num(v, 2), live: (v) => liveT({ lineHeight: v }), commit: (v) => setT({ lineHeight: v }) });
  const lsS = styleSlider(ui, tx.letterSpacing, { min: -0.1, max: 0.5, step: 0.005, fmt: (v) => ui.num(v, 3), live: (v) => liveT({ letterSpacing: v }), commit: (v) => setT({ letterSpacing: v }) });
  const wrapS = styleSlider(ui, tx.wrap, { min: 0, max: 1, step: 0.01, fmt: (v) => (v ? pct(v) : t('без переноса')), live: (v) => liveT({ wrap: v }), commit: (v) => setT({ wrap: v }) });
  sec.append(
    h('div', { class: 'row between' }, h('label', {}, t('Размер (от высоты кадра)')), sizeS.val), sizeS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Межстрочный интервал')), lhS.val), lhS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Межбуквенный интервал')), lsS.val), lsS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Ширина строки')), wrapS.val), wrapS.slider);
  root.append(sec);

  // --- Обводка, тень, подложка ---
  const look = h('div', { class: 'insp-section', dataset: { section: 'text-look' } }, h('h3', {}, t('Оформление')));
  const strokeS = styleSlider(ui, tx.strokeWidth, { min: 0, max: 0.25, step: 0.005, fmt: (v) => (v ? ui.num(v * 100, 1) + '%' : t('нет')), live: (v) => liveT({ strokeWidth: v }), commit: (v) => setT({ strokeWidth: v }) });
  const shS = styleSlider(ui, tx.shadowOpacity, { min: 0, max: 1, step: 0.01, fmt: (v) => (v ? pct(v) : t('нет')), live: (v) => liveT({ shadowOpacity: v }), commit: (v) => setT({ shadowOpacity: v }) });
  const boxS = styleSlider(ui, tx.boxOpacity, { min: 0, max: 1, step: 0.01, fmt: pct, live: (v) => liveT({ boxOpacity: v }), commit: (v) => setT({ boxOpacity: v }) });
  look.append(
    h('div', { class: 'row between' }, h('label', {}, t('Обводка')), h('span', { class: 'row gap' }, strokeS.val, colorInput(tx.strokeColor, (v) => setT({ strokeColor: v }), t('Цвет обводки')))), strokeS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Тень')), h('span', { class: 'row gap' }, shS.val, colorInput(tx.shadowColor, (v) => setT({ shadowColor: v }), t('Цвет тени')))), shS.slider,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: tx.box, id: 'text-box', onchange: (e) => setT({ box: e.target.checked }) }), t('Подложка'),
      colorInput(tx.boxColor, (v) => setT({ boxColor: v, box: true }), t('Цвет подложки'))));
  if (tx.box) look.append(h('div', { class: 'row between' }, h('label', {}, t('Непрозрачность подложки')), boxS.val), boxS.slider);
  look.append(h('div', { class: 'row between' }, h('label', {}, t('Движение')),
    select([['none', t('Нет')], ['roll', t('Титры снизу вверх')]], tx.motion, (v) => setT({ motion: v }))));
  look.append(h('div', { class: 'row gap wrap' },
    st ? h('button', { class: 'btn ghost small', title: t('Вернуть оформление стиля, текст останется'), onclick: () => setT({ ...st.text, content: tx.content, style: st.id }) }, t('Сбросить к стилю')) : null,
    h('button', { class: 'btn ghost small', onclick: () => store.emit('show-tab', 'text') }, t('Другой стиль…'))));
  root.append(look);

  // --- Затухание и длительность ---
  const dur = tlLen(clip);
  const maxFade = Math.min(MAX_FADE, dur);
  const fade = h('div', { class: 'insp-section', dataset: { section: 'fade' } }, h('h3', {}, t('Появление и длительность')));
  const fadeRow = (lbl, key, other) => {
    const lim = () => Math.max(0, Math.min(maxFade, dur - (clip[other] || 0)));
    const { slider } = ui.liveSlider({
      min: 0, max: Math.round(maxFade * 10) / 10, step: 0.1, value: clip[key] || 0, format: (v) => ui.num(v),
      onLive: (v) => { store.findClip(clip.id).clip[key] = Math.min(v, lim()); },
      onCommit: (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }),
    });
    return [h('div', { class: 'row between' }, h('label', {}, lbl), ui.secInput(clip[key] || 0, maxFade, (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }))), slider];
  };
  fade.append(...fadeRow(t('Постепенное возникновение'), 'fadeIn', 'fadeOut'), ...fadeRow(t('Постепенное исчезание'), 'fadeOut', 'fadeIn'),
    h('dl', { class: 'kv' }, h('dt', {}, t('Длительность')), h('dd', {}, fmtTime(dur)), h('dt', {}, t('На таймлайне')), h('dd', {}, `${fmtTime(clip.start)} – ${fmtTime(clip.start + dur)}`)),
    h('button', { class: 'btn ghost small', onclick: () => changeDuration(clip.id) }, h('span', { html: icon('clock', 15) }), t('Длительность…')));
  root.append(fade);

  // --- Трансформ: тот же, что у видео (рамка в плеере тоже) ---
  if (tx.motion !== 'roll') root.append(ui.transformSection(clip, sel));
  else root.append(h('p', { class: 'muted small' }, t('Титры едут снизу вверх за время клипа: чем длиннее клип, тем медленнее. Положение по горизонтали и масштаб — в «Трансформе» (снимите «Движение», чтобы его открыть).')));
}

// ---------------- Фигура (0.5.0) ----------------
export function renderShapeClip(ui, sel) {
  const { root } = ui;
  const clip = sel.clip;
  const sh = cleanShape(clip.shape);
  const locked = !!(sel.lane && sel.lane.locked);
  const setS = (patch) => store.setShape([clip.id], patch);
  const liveS = (patch) => { const f = store.findClip(clip.id); if (f) f.clip.shape = cleanShape(patch, f.clip.shape); };
  const pct = (v) => `${Math.round(v * 1000) / 10}%`;

  root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Фигура'))));
  root.append(h('div', { class: 'insp-file' }, iconEl('transform', 18), h('span', {}, store.clipName(clip))));

  // --- Тип и размер ---
  const sec = h('div', { class: 'insp-section', dataset: { section: 'shape' } }, h('h3', {}, t('Фигура')));
  sec.append(h('div', { class: 'presets shape-types' }, ...SHAPE_TYPES.map((ty) => h('button', {
    class: `chip${sh.type === ty ? ' on' : ''}`, dataset: { shapeType: ty }, disabled: locked, title: shapeName(ty),
    onclick: () => setS(ty === 'chamfer' && sh.corner < 0.01 ? { type: ty, corner: CHAMFER_DEFAULT } : { type: ty }),
  }, h('span', { html: shapeIcon(ty, 16) }), shapeName(ty)))));
  const wS = styleSlider(ui, sh.w, { min: 0.01, max: 1.5, step: 0.005, fmt: pct, live: (v) => liveS({ w: v }), commit: (v) => setS({ w: v }) });
  const hS = styleSlider(ui, sh.h, { min: 0.01, max: 1.5, step: 0.005, fmt: pct, live: (v) => liveS({ h: v }), commit: (v) => setS({ h: v }) });
  wS.slider.dataset.shape = 'w'; hS.slider.dataset.shape = 'h';
  sec.append(
    h('div', { class: 'row between' }, h('label', {}, t('Ширина (от ширины кадра)')), wS.val), wS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Высота (от высоты кадра)')), hS.val), hS.slider);
  if (sh.type === 'rect' || sh.type === 'chamfer') {
    const cS = styleSlider(ui, sh.corner, { min: 0, max: 0.5, step: 0.005, fmt: (v) => (v ? pct(v) : t('нет')), live: (v) => liveS({ corner: v }), commit: (v) => setS({ corner: v }) });
    cS.slider.dataset.shape = 'corner';
    sec.append(h('div', { class: 'row between' }, h('label', {}, sh.type === 'rect' ? t('Скругление углов') : t('Срез углов')), cS.val), cS.slider);
  }
  root.append(sec);

  // --- Заливка и контур ---
  const look = h('div', { class: 'insp-section', dataset: { section: 'shape-look' } }, h('h3', {}, t('Оформление')));
  const fS = styleSlider(ui, sh.fillOpacity, { min: 0, max: 1, step: 0.01, fmt: (v) => (v ? `${Math.round(v * 100)}%` : t('нет')), live: (v) => liveS({ fillOpacity: v }), commit: (v) => setS({ fillOpacity: v }) });
  const sS = styleSlider(ui, sh.strokeWidth, { min: 0, max: 0.05, step: 0.0005, fmt: (v) => (v ? pct(v) : t('нет')), live: (v) => liveS({ strokeWidth: v }), commit: (v) => setS({ strokeWidth: v }) });
  fS.slider.dataset.shape = 'fillOpacity'; sS.slider.dataset.shape = 'strokeWidth';
  look.append(
    h('div', { class: 'row between' }, h('label', {}, t('Заливка')), h('span', { class: 'row gap' }, fS.val, colorInput(sh.fill, (v) => setS({ fill: v, fillOpacity: sh.fillOpacity || 1 }), t('Цвет заливки')))), fS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Контур')), h('span', { class: 'row gap' }, sS.val, colorInput(sh.stroke, (v) => setS({ stroke: v, strokeWidth: sh.strokeWidth || 0.004 }), t('Цвет контура')))), sS.slider,
    h('p', { class: 'muted small' }, t('Толщина контура — от высоты кадра; контур идёт внутри фигуры. Заливка «нет» — останется только контур.')));
  root.append(look);

  // --- Появление и длительность ---
  const dur = tlLen(clip);
  const maxFade = Math.min(MAX_FADE, dur);
  const fade = h('div', { class: 'insp-section', dataset: { section: 'fade' } }, h('h3', {}, t('Появление и длительность')));
  const fadeRow = (lbl, key, other) => {
    const lim = () => Math.max(0, Math.min(maxFade, dur - (clip[other] || 0)));
    const { slider } = ui.liveSlider({
      min: 0, max: Math.round(maxFade * 10) / 10, step: 0.1, value: clip[key] || 0, format: (v) => ui.num(v),
      onLive: (v) => { store.findClip(clip.id).clip[key] = Math.min(v, lim()); },
      onCommit: (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }),
    });
    return [h('div', { class: 'row between' }, h('label', {}, lbl), ui.secInput(clip[key] || 0, maxFade, (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }))), slider];
  };
  fade.append(...fadeRow(t('Постепенное возникновение'), 'fadeIn', 'fadeOut'), ...fadeRow(t('Постепенное исчезание'), 'fadeOut', 'fadeIn'),
    h('dl', { class: 'kv' }, h('dt', {}, t('Длительность')), h('dd', {}, fmtTime(dur)), h('dt', {}, t('На таймлайне')), h('dd', {}, `${fmtTime(clip.start)} – ${fmtTime(clip.start + dur)}`)),
    h('button', { class: 'btn ghost small', onclick: () => changeDuration(clip.id) }, h('span', { html: icon('clock', 15) }), t('Длительность…')));
  root.append(fade);

  // --- Трансформ: положение, масштаб, поворот, прозрачность ---
  root.append(ui.transformSection(clip, sel));
}

// ---------------- Таймер (0.5.0) ----------------
export function renderTimerClip(ui, sel) {
  const { root } = ui;
  const clip = sel.clip;
  const tm = cleanTimer(clip.timer);
  const locked = !!(sel.lane && sel.lane.locked);
  const setTm = (patch) => store.setTimer([clip.id], patch);
  const liveTm = (patch) => { const f = store.findClip(clip.id); if (f) f.clip.timer = cleanTimer(patch, f.clip.timer); };

  root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Таймер'))));
  root.append(h('div', { class: 'insp-file' }, iconEl('timer', 18), h('span', {}, store.clipName(clip))));

  const sec = h('div', { class: 'insp-section', dataset: { section: 'timer' } }, h('h3', {}, t('Отсчёт')));
  // Время: «10», «1:30», «0:45»
  const durIn = h('input', { class: 'input', type: 'text', value: fmtClock(tm.duration), id: 'timer-duration', disabled: locked, title: t('Секунды или мин:сек') });
  const applyDur = () => {
    const d = parseDuration(String(durIn.value));
    if (Number.isFinite(d) && d >= 1) setTm({ duration: d }); else durIn.value = fmtClock(tm.duration);
  };
  durIn.addEventListener('change', applyDur);
  durIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); durIn.blur(); } e.stopPropagation(); });
  const quick = [5, 10, 15, 30, 60, 90, 120, 300];
  sec.append(
    h('div', { class: 'row between' }, h('label', { for: 'timer-duration' }, t('Время')), durIn),
    h('div', { class: 'presets' }, ...quick.map((s) => h('button', { class: `chip${Math.abs(tm.duration - s) < 0.01 ? ' on' : ''}`, disabled: locked, onclick: () => setTm({ duration: s }) }, fmtClock(s)))),
    h('div', { class: 'row between' }, h('label', {}, t('Направление')),
      select([['down', t('Обратный отсчёт')], ['up', t('Прямой отсчёт')]], tm.mode, (v) => setTm({ mode: v }))),
    h('div', { class: 'row between' }, h('label', {}, t('Звонок')),
      select([['once', t('Один раз')], ['loop', t('Повторять до конца клипа')], ['none', t('Без звонка')]], tm.ring, (v) => setTm({ ring: v }))),
    h('div', { class: 'row between' }, h('label', {}, t('Сектор')),
      select([['elapsed', t('Прошедшее время')], ['remaining', t('Оставшееся время')]], tm.progress, (v) => setTm({ progress: v }))),
    h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', checked: tm.digits, disabled: locked, onchange: (e) => setTm({ digits: e.target.checked }) }),
      h('span', {}, t('Цифры'))),
    h('p', { class: 'muted small' }, tm.ring === 'once'
      ? t('Клип длится время отсчёта и ещё {s} с — звонок (анимация, без звука).', { s: ui.num(RING_DUR) })
      : tm.ring === 'loop'
        ? t('Звонок повторяется до конца клипа — растяните клип на таймлайне, сколько нужно.')
        : t('Клип длится ровно время отсчёта; если растянуть его, таймер остановится на последней цифре.')));
  root.append(sec);

  const look = h('div', { class: 'insp-section', dataset: { section: 'timer-look' } }, h('h3', {}, t('Оформление')));
  const styles = h('div', { class: 'presets timer-styles' }, ...TIMER_STYLES.map((id) => h('button', {
    class: `chip${tm.style === id ? ' on' : ''}`, dataset: { timerStyle: id }, disabled: locked, onclick: () => setTm({ style: id }),
  }, timerStyleName(id))));
  const sz = styleSlider(ui, tm.size, { min: 0.1, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, live: (v) => liveTm({ size: v }), commit: (v) => setTm({ size: v }) });
  const COLORS = [['case', t('Корпус')], ['face', t('Циферблат')], ['fill', t('Сектор')], ['ink', t('Контур')], ['accent', t('Акцент')], ['digits', t('Цифры')]];
  look.append(
    h('label', {}, t('Стиль')), styles,
    h('div', { class: 'row between' }, h('label', {}, t('Размер (от высоты кадра)')), sz.val), sz.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Цвета')), h('span', { class: 'row gap' },
      ...COLORS.map(([k, name]) => colorInput(tm.colors[k], (v) => setTm({ colors: { ...tm.colors, [k]: v } }), name)))),
    h('button', { class: 'btn ghost small', disabled: locked, onclick: () => setTm({ colors: stylePalette(tm.style) }) }, t('Цвета стиля')));
  root.append(look);

  const dur = tlLen(clip);
  root.append(h('div', { class: 'insp-section', dataset: { section: 'fade' } }, h('h3', {}, t('На таймлайне')),
    h('dl', { class: 'kv' }, h('dt', {}, t('Длительность')), h('dd', {}, fmtTime(dur)), h('dt', {}, t('На таймлайне')), h('dd', {}, `${fmtTime(clip.start)} – ${fmtTime(clip.start + dur)}`))));
  root.append(ui.transformSection(clip, sel));
}

// ---------------- Обводка видео / картинки (0.5.0) ----------------
export function borderSection(ui, clip, locked = false) {
  const b = borderOf(clip);
  const cur = b || { ...BORDER_DEFAULT, width: 0 };
  const setB = (patch) => store.setBorder([clip.id], patch);
  const liveB = (patch) => { const f = store.findClip(clip.id); if (!f) return; const x = cleanBorder(patch, f.clip.border || { ...BORDER_DEFAULT, width: 0 }); if (x) f.clip.border = x; else delete f.clip.border; };
  const pct = (v) => `${Math.round(v * 1000) / 10}%`;
  const sec = h('div', { class: 'insp-section', dataset: { section: 'border' } }, h('h3', {}, t('Обводка и углы')));
  const wS = styleSlider(ui, cur.width, { min: 0, max: 0.03, step: 0.0005, fmt: (v) => (v ? pct(v) : t('нет')), live: (v) => liveB({ width: v }), commit: (v) => setB({ ...(b || { width: 0 }), width: v }) });
  const rS = styleSlider(ui, cur.radius, { min: 0, max: 0.2, step: 0.002, fmt: (v) => (v ? pct(v) : t('нет')), live: (v) => liveB({ radius: v }), commit: (v) => setB({ ...(b || { width: 0 }), radius: v }) });
  wS.slider.dataset.border = 'width'; rS.slider.dataset.border = 'radius';
  wS.slider.disabled = locked; rS.slider.disabled = locked;
  const presets = [
    [t('Нет'), null],
    [t('Тонкая'), { width: 0.002 }],
    [t('Средняя'), { width: 0.004 }],
    [t('Толстая'), { width: 0.01 }],
    [t('Карточка'), { width: 0.002, radius: 0.03 }],
  ];
  sec.append(
    h('div', { class: 'row between' }, h('label', {}, t('Толщина обводки')), h('span', { class: 'row gap' }, wS.val,
      colorInput(cur.color, (v) => setB({ ...(b || {}), color: v, width: cur.width || BORDER_DEFAULT.width }), t('Цвет обводки')))), wS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Скругление углов')), rS.val), rS.slider,
    h('div', { class: 'presets' }, ...presets.map(([name, p]) => h('button', {
      class: 'chip', disabled: locked, onclick: () => setB(p ? { color: cur.color, radius: 0, ...p } : null),
    }, name))),
    h('p', { class: 'muted small' }, t('Цветная рамка по краю картинки (внутри неё) и скруглённые углы. Толщина и радиус — от высоты кадра и не меняются при масштабе клипа.')));
  return sec;
}

// ---------------- Реплика субтитров ----------------
export function renderCue(ui, id) {
  const { root } = ui;
  const f = store.findCue(id);
  const { cue, track } = f;
  root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Реплика'))));
  root.append(h('div', { class: 'insp-file' }, iconEl('subtitles', 18), h('span', {}, store.subtitleTrackName(track.id))));
  const sec = h('div', { class: 'insp-section', dataset: { section: 'cue' } }, h('h3', {}, t('Текст')));
  const ta = textArea(ui, cue.text, (v) => { const x = store.findCue(id); if (x) x.cue.text = v; store.live(() => {}); }, { rows: 3, id: 'cue-text' });
  ta.disabled = !!track.locked;
  sec.append(ta);
  const timeRow = (lbl, key) => ui.secInput(cue[key], 24 * 3600, (v) => {
    const c = store.findCue(id).cue;
    if (key === 'start') store.setCue(id, { start: v, end: Math.max(v + MIN_CUE, c.end) });
    else store.setCue(id, { end: Math.max(c.start + MIN_CUE, v) });
  });
  sec.append(
    h('div', { class: 'row between' }, h('label', {}, t('Начало')), timeRow(t('Начало'), 'start')),
    h('div', { class: 'row between' }, h('label', {}, t('Конец')), timeRow(t('Конец'), 'end')),
    h('p', { class: 'muted small' }, t('Длится {d}. Тяните края реплики на таймлайне; двойной щелчок по пустому месту дорожки — новая реплика.', { d: fmtTime(cue.end - cue.start) })),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost small', onclick: () => store.setCue(id, { start: store.time, end: Math.max(store.time + MIN_CUE, cue.end) }) }, t('Начало по курсору')),
      h('button', { class: 'btn ghost small', onclick: () => store.setCue(id, { end: Math.max(cue.start + MIN_CUE, store.time) }) }, t('Конец по курсору')),
      h('button', { class: 'btn danger-ghost small', onclick: () => store.deleteCue(id) }, h('span', { html: icon('trash', 15) }), t('Удалить'))));
  root.append(sec);
  root.append(h('div', { class: 'insp-section' },
    h('button', { class: 'btn ghost small', onclick: () => store.select({ kind: 'strack', id: track.id }) }, t('Оформление дорожки…'))));
}

// ---------------- Дорожка субтитров ----------------
export function renderSubTrack(ui, id) {
  const { root } = ui;
  const tr = store.subtitleTrack(id);
  const s = { ...SUB_STYLE_DEFAULT, ...tr.style };
  const set = (patch) => store.setSubtitleTrack(id, { style: patch });
  const liveS = (patch) => { const x = store.project.subtitleTracks.find((y) => y.id === id); if (x) x.style = { ...x.style, ...patch }; };
  const pct = (v) => `${Math.round(v * 1000) / 10}%`;
  root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Субтитры'))));
  root.append(h('div', { class: 'insp-file' }, iconEl('subtitles', 18), h('span', {}, store.subtitleTrackName(id)),
    h('span', { class: 'tag' }, t('{n} реплик', { n: tr.cues.length }))));
  const sec = h('div', { class: 'insp-section', dataset: { section: 'strack' } }, h('h3', {}, t('Оформление')));
  const sizeS = styleSlider(ui, s.size, { min: 0.02, max: 0.15, step: 0.001, fmt: pct, live: (v) => liveS({ size: v }), commit: (v) => set({ size: v }) });
  const olS = styleSlider(ui, s.outline, { min: 0, max: 0.01, step: 0.0005, fmt: (v) => (v ? pct(v) : t('нет')), live: (v) => liveS({ outline: v }), commit: (v) => set({ outline: v }) });
  const mS = styleSlider(ui, s.margin, { min: 0, max: 0.3, step: 0.005, fmt: pct, live: (v) => liveS({ margin: v }), commit: (v) => set({ margin: v }) });
  sec.append(
    h('div', { class: 'row gap' }, fontSelect(s.font, (v) => set({ font: v })), colorInput(s.color, (v) => set({ color: v }), t('Цвет текста'))),
    h('div', { class: 'row gap' },
      h('button', { class: `chip${s.bold ? ' on' : ''}`, onclick: () => set({ bold: !s.bold }) }, h('b', {}, 'B')),
      h('button', { class: `chip${s.italic ? ' on' : ''}`, onclick: () => set({ italic: !s.italic }) }, h('i', {}, 'I')),
      select([['bottom', t('Внизу')], ['middle', t('По центру')], ['top', t('Вверху')]], s.position, (v) => set({ position: v })),
      select([['center', t('По центру')], ['left', t('Слева')], ['right', t('Справа')]], s.align, (v) => set({ align: v }))),
    h('div', { class: 'row between' }, h('label', {}, t('Размер')), sizeS.val), sizeS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Обводка')), h('span', { class: 'row gap' }, olS.val, colorInput(s.outlineColor, (v) => set({ outlineColor: v }), t('Цвет обводки')))), olS.slider,
    h('div', { class: 'row between' }, h('label', {}, t('Отступ от края')), mS.val), mS.slider,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.box, onchange: (e) => set({ box: e.target.checked }) }), t('Подложка вместо обводки'),
      colorInput(s.boxColor, (v) => set({ boxColor: v, box: true }), t('Цвет подложки'))));
  root.append(sec);
  const none = t('не указан');
  const langs = [['', none], ['rus', 'Русский'], ['eng', 'English'], ['ukr', 'Українська'], ['deu', 'Deutsch'], ['fra', 'Français'], ['spa', 'Español'], ['ita', 'Italiano'], ['por', 'Português'], ['jpn', '日本語'], ['kor', '한국어'], ['zho', '中文']]; // i18n-ignore
  const file = h('div', { class: 'insp-section', dataset: { section: 'strack-file' } }, h('h3', {}, t('Файл и экспорт')),
    h('div', { class: 'row between' }, h('label', {}, t('Язык (для мягких субтитров)')),
      select(langs, tr.lang || '', (v) => store.setSubtitleTrack(id, { lang: v }))),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost small', onclick: () => importSubtitles(id) }, h('span', { html: icon('upload', 15) }), t('Заменить из файла…')),
      ...['srt', 'vtt', 'ass'].map((fmt) => h('button', { class: 'btn ghost small', disabled: !tr.cues.length, dataset: { save: fmt }, onclick: () => exportSubtitleTrack(id, fmt) }, t('Сохранить {fmt}…', { fmt: fmt.toUpperCase() })))),
    h('p', { class: 'muted small' }, t('При экспорте видео субтитры вшиваются в кадр (по умолчанию) или добавляются отдельной дорожкой MP4 — выбор в окне экспорта.')),
    h('button', { class: 'btn danger-ghost small', onclick: () => store.removeSubtitleTrack(id) }, h('span', { html: icon('trash', 15) }), t('Удалить дорожку субтитров')));
  root.append(file);
}

export { TEXT_DEFAULT };
