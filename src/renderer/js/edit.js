// «Режим нарезания 2.0» (0.4.3) — действия окна поверх editOps.js: Q/W, метки In/Out, Lift/Extract,
// «Удалить паузы» (silencedetect), подсказки о дорожках, которые не сдвинулись.
import { store, vlanes } from './store.js';
import * as op from './editOps.js';
import { h, toast, errText, fmtTime, icon } from './util.js';
import { t, getLang } from './i18n.js';
import { keyHint } from './keymap.js';
import { clipEnd } from './clipTime.js';
import { isText } from './textModel.js';

const dec = (x) => (getLang() === 'ru' ? String(x).replace('.', ',') : String(x));

/** Сообщить, какие дорожки не сдвинулись (поперёк лежал другой клип) */
export function reportSkipped(skipped) {
  if (!skipped || !skipped.length) return;
  const names = skipped.map((id) => store.trackName(id) || id).slice(0, 3).join(', ');
  toast(t('Не сдвинуто: {names} — мешает клип, который лежит поперёк места правки', { names }), 'info', 4000);
}

/**
 * Клип для Q/W и «отметить клип» в момент t: выделенный (если t внутри), иначе верхний видеоклип
 * на дорожке без замка, иначе первый аудиоклип. null — ничего нет.
 */
export function clipAtTime(tm, { inside = true } = {}) {
  const hit = (c) => (inside ? op.insideClip(c, tm) : tm >= c.start - 1e-6 && tm < clipEnd(c) - 1e-6);
  const s = store.selection;
  if (s && (s.kind === 'video' || s.kind === 'audio')) {
    const f = store.findClip(s.id);
    if (f && hit(f.clip)) return f.clip.id;
  }
  const lanes = vlanes(store.project);
  for (let i = lanes.length - 1; i >= 0; i--) {
    if (lanes[i].locked || lanes[i].hidden) continue;
    const c = lanes[i].clips.find(hit);
    if (c) return c.id;
  }
  for (const tr of store.project.audioTracks) {
    if (tr.locked) continue;
    const c = tr.clips.find(hit);
    if (c) return c.id;
  }
  return null;
}

/** Q / W (side 'start' | 'end'); ripple=false — Shift+Q / Shift+W, без сдвига */
export function trimToPlayhead(side, ripple = true) {
  const at = store.frameT(store.time);
  const id = clipAtTime(at);
  if (!id) { toast(t('Поставьте курсор внутрь клипа'), 'info', 2000); return false; }
  const f = store.findClip(id);
  if (f && f.lane && f.lane.locked) { toast(t('Дорожка «{name}» закрыта замком', { name: store.trackName(f.lane.id) }), 'info', 1600); return false; }
  const start = f.clip.start;
  let res = null;
  store.mutate((p) => { res = op.trimToTime(p, id, side, at, { ripple }); });
  if (!res) { toast(t('Слишком близко к краю клипа'), 'info', 1500); return false; }
  // Курсор — на место правки (как в Premiere / Resolve)
  if (side === 'start') store.setTime(ripple ? start : at);
  reportSkipped(res.skipped);
  return true;
}

// ---------------------------------------------------------------------------
// Метки In / Out
// ---------------------------------------------------------------------------
export const marks = () => store.project.marks || {};
export const hasRange = () => { const m = marks(); return m.in !== undefined && m.out !== undefined && m.out - m.in > 0.001; };

function setMarks(m) {
  store.mutate((p) => {
    const out = {};
    if (m.in !== undefined && m.in !== null) out.in = Math.max(0, m.in);
    if (m.out !== undefined && m.out !== null) out.out = Math.max(0, m.out);
    if (out.in !== undefined && out.out !== undefined && out.out < out.in) [out.in, out.out] = [out.out, out.in];
    if (Object.keys(out).length) p.marks = out; else delete p.marks;
  }, { history: false });
  store.emit('marks');
}
export function markIn(tm = store.time) {
  const m = { ...marks(), in: store.frameT(tm) };
  if (m.out !== undefined && m.out <= m.in) delete m.out;
  setMarks(m);
}
export function markOut(tm = store.time) {
  const m = { ...marks(), out: store.frameT(tm) };
  if (m.in !== undefined && m.in >= m.out) delete m.in;
  setMarks(m);
}
export function clearMarks() { setMarks({}); }
/** X: метки по клипу под курсором */
export function markClip(tm = store.time) {
  const id = clipAtTime(tm, { inside: false });
  if (!id) { toast(t('Под курсором нет клипа'), 'info', 1600); return false; }
  return markClipById(id);
}
export function markClipById(id) {
  const f = store.findClip(id);
  if (!f) return false;
  setMarks({ in: f.clip.start, out: clipEnd(f.clip) });
  return true;
}
export function goToMark(kind) {
  const m = marks();
  if (m[kind] !== undefined) store.setTime(m[kind]);
}

/** Lift (;) — убрать фрагмент In–Out, оставить пустоту; Extract (') — убрать и сдвинуть */
export function liftOrExtract(extract) {
  if (!hasRange()) {
    toast(t('Поставьте метки In ({i}) и Out ({o})', { i: keyHint('mark.in') || 'I', o: keyHint('mark.out') || 'O' }), 'info', 2500);
    return false;
  }
  const { in: a, out: b } = marks();
  let res = null;
  store.mutate((p) => {
    res = extract ? op.extractRange(p, a, b) : op.liftRange(p, a, b);
    delete p.marks;
  });
  store.emit('marks');
  store.setTime(a);
  if (res && res.skipped) reportSkipped(res.skipped);
  return true;
}

// ---------------------------------------------------------------------------
// Удалить паузы (silencedetect)
// ---------------------------------------------------------------------------
const silenceCache = new Map(); // `${path}|${th}|${min}` → [{ start, end }]
async function detect(m, th, min) {
  const k = `${m.path}|${th}|${min}`;
  if (!silenceCache.has(k)) silenceCache.set(k, window.api.fxSilence(m.path, th, min).catch((e) => { silenceCache.delete(k); throw e; }));
  return silenceCache.get(k);
}

/** Промежутки пауз клипа id (время таймлайна) */
export async function findPauses(id, { threshold = -35, minPause = 0.5, margin = 0.15 } = {}) {
  const f = store.findClip(id);
  if (!f) throw new Error(t('Клип не найден'));
  const c = f.clip;
  const m = store.media(c.mediaId);
  if (!m || !m.hasAudio || isText(c)) throw new Error(t('У клипа нет звука'));
  const list = await detect(m, threshold, minPause);
  return op.silenceRanges(c, list, { margin, fps: store.fps(), mediaDur: m.duration, minLen: Math.max(0.05, 2 / store.fps()) });
}

/** Удалить паузы клипа id (и его связанного звука) со сдвигом. → { count, removed } */
export async function removePauses(id, opts = {}) {
  const ranges = await findPauses(id, opts);
  if (!ranges.length) return { count: 0, removed: 0 };
  let res = null;
  store.mutate((p) => { res = op.removeRanges(p, id, ranges); });
  reportSkipped(res.skipped);
  return { count: ranges.length, removed: res.removed };
}

/** Окно «Удалить паузы»: порог, длина паузы, запас; сразу показывает, сколько найдено */
export function openPausesDialog(id) {
  const f = store.findClip(id);
  if (!f) return;
  const m = store.media(f.clip.mediaId);
  if (!m || !m.hasAudio || isText(f.clip)) { toast(t('У клипа нет звука'), 'info', 2000); return; }
  const st = { threshold: -35, minPause: 0.5, margin: 0.15 };
  const info = h('p', { class: 'muted', id: 'pauses-info' }, t('Поиск пауз…'));
  const okBtn = h('button', { class: 'btn primary', id: 'pauses-ok', disabled: true }, t('Удалить паузы'));
  const field = (key, label, min, max, step, fmt) => {
    const val = h('span', { class: 'vol-val' }, fmt(st[key]));
    const r = h('input', { type: 'range', class: 'slider', min: String(min), max: String(max), step: String(step), value: String(st[key]), dataset: { key } });
    r.addEventListener('input', () => { st[key] = Number(r.value); val.textContent = fmt(st[key]); refresh(); });
    return h('label', { class: 'pauses-field' }, h('span', {}, label), r, val);
  };
  let seq = 0; let found = [];
  const refresh = async () => {
    const my = ++seq;
    okBtn.disabled = true;
    info.textContent = t('Поиск пауз…');
    try {
      const r = await findPauses(id, st);
      if (my !== seq) return;
      found = r;
      const total = r.reduce((s, [a, b]) => s + (b - a), 0);
      info.textContent = r.length
        ? t('Найдено пауз: {n}, вместе {d}. Клип станет короче, следующие клипы сдвинутся.', { n: r.length, d: fmtTime(total) })
        : t('Пауз с такими настройками нет.');
      okBtn.disabled = !r.length;
    } catch (e) {
      if (my === seq) info.textContent = t('Не удалось найти паузы: {e}', { e: errText(e) });
    }
  };
  const close = () => overlay.remove();
  okBtn.addEventListener('click', () => {
    if (!found.length) return;
    let res = null;
    store.mutate((p) => { res = op.removeRanges(p, id, found); });
    close();
    toast(t('Удалено пауз: {n} ({d})', { n: found.length, d: fmtTime(res.removed) }), 'success', 3000);
    reportSkipped(res.skipped);
  });
  const overlay = h('div', { class: 'modal-overlay', id: 'pauses-dialog' },
    h('div', { class: 'modal small' },
      h('div', { class: 'modal-head' }, h('h2', {}, t('Удалить паузы')), h('button', { class: 'icon-btn', onclick: close, html: icon('close', 18) })),
      h('div', { class: 'modal-body pauses' },
        h('p', { class: 'muted small' }, t('Тихие места клипа «{name}» вырезаются вместе с видео, остальное сдвигается. Отменить — Ctrl+Z.', { name: store.clipName(f.clip) })),
        field('threshold', t('Тише, чем'), -60, -15, 1, (v) => `${v} dB`),
        field('minPause', t('Пауза не короче'), 0.2, 3, 0.1, (v) => `${dec(Math.round(v * 10) / 10)} ${t('с')}`),
        field('margin', t('Оставить по краям'), 0, 0.5, 0.05, (v) => `${dec(Math.round(v * 100) / 100)} ${t('с')}`),
        info),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn ghost', onclick: close }, t('Отмена')), okBtn)));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  document.body.append(overlay);
  okBtn.focus();
  refresh();
}
