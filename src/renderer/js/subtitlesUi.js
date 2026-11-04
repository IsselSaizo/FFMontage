// Субтитры в интерфейсе (M5.5): дорожки на таймлайне (реплики двигаются и обрезаются мышью),
// показ реплик в плеере (HTML поверх кадра — приближение к libass), импорт и сохранение SRT / VTT / ASS.
// Модель — store.js (subtitleTracks), разбор и запись форматов — subtitles.js.
import { store, MIN_CUE } from './store.js';
import { h, icon, toast, t, errText, fmtTime, clamp } from './util.js';
import { openMenu } from './contextMenu.js';
import { keyHint } from './keymap.js';
import { parseSubtitles, toSrt, toVtt, toAss, cueAt, SUB_STYLE_DEFAULT } from './subtitles.js';
import { fontFile, fontByFamily } from './fonts.js';
import { fontFamilies } from './textRender.js';

const SUB_H = 38;
const api = () => window.api;

// ---------------- Таймлайн ----------------
// Строки дорожек субтитров (над аудио). tl — Timeline (pps, xToTime, snap, snapPoints, showSnap, render, drag, tool)
export function subtitleRows(tl, laneW, HEAD_W) {
  return store.subtitleTracks().map((tr) => subtitleRow(tl, tr, laneW, HEAD_W));
}

function subtitleRow(tl, tr, laneW) {
  const sel = store.selection;
  const vb = (name, tip, on, fn, cls) => {
    const b = h('button', { class: `th-vbtn ${cls}${on ? ' on' : ''}`, title: tip, onclick: (e) => { e.stopPropagation(); fn(); } });
    b.innerHTML = icon(name, 15);
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  };
  const name = store.subtitleTrackName(tr.id);
  const nameEl = h('span', { class: 'th-name', title: t('{name} — двойной щелчок, чтобы переименовать', { name }) }, name);
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const inp = h('input', { class: 'th-rename', value: name, maxlength: '40' });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; if (ok && inp.value.trim() !== name) store.setSubtitleTrack(tr.id, { name: inp.value.trim() }); else tl.render(); };
    inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    nameEl.replaceWith(inp); inp.focus(); inp.select();
  });
  const head = h('div', {
    class: `tl-head sub-head${sel && sel.kind === 'strack' && sel.id === tr.id ? ' selected' : ''}`, dataset: { strackHead: tr.id },
    title: t('Щелчок — оформление субтитров'),
    onclick: (e) => { if (e.target.closest('button, input')) return; store.select({ kind: 'strack', id: tr.id }); },
  },
  h('div', { class: 'th-row' }, h('span', { class: 'th-ic', html: icon('subtitles', 15) }), nameEl),
  h('div', { class: 'th-row' }, h('span', { class: 'th-actions' },
    vb(tr.hidden ? 'eyeoff' : 'eye', tr.hidden ? t('Показать субтитры') : t('Скрыть субтитры (в плеере и в экспорте)'), tr.hidden, () => store.setSubtitleTrack(tr.id, { hidden: !tr.hidden }), 'th-hide'),
    vb(tr.locked ? 'lock' : 'unlock', tr.locked ? t('Снять замок') : t('Замок: реплики нельзя двигать и менять'), tr.locked, () => store.setSubtitleTrack(tr.id, { locked: !tr.locked }), 'th-lock'),
    vb('close', t('Удалить дорожку субтитров'), false, () => store.removeSubtitleTrack(tr.id), 'th-del'))));
  const lane = h('div', {
    class: 'tl-lane sub-lane', dataset: { lane: 'sub', strack: tr.id },
    style: { width: `${laneW}px`, height: `${SUB_H}px` },
  });
  lane.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openSubLaneMenu(tr.id, e.clientX, e.clientY, tl.xToTime(e.clientX)); });
  if (!tr.cues.length) lane.append(h('div', { class: 'lane-hint' }, t('Двойной щелчок — новая реплика; правая кнопка — импорт SRT / VTT / ASS')));
  const [x0, x1] = tl.visibleRange();
  for (const c of tr.cues) {
    const left = c.start * tl.pps; const w = (c.end - c.start) * tl.pps;
    if (left > x1 || left + w < x0) continue;
    lane.append(cueEl(tl, tr, c, left, w));
  }
  return h('div', { class: `tl-row subs${tr.hidden ? ' lane-hidden' : ''}${tr.locked ? ' lane-locked' : ''}`, dataset: { strack: tr.id } }, head, lane);
}

function cueEl(tl, tr, c, left, w) {
  const sel = store.selection && store.selection.kind === 'cue' && store.selection.id === c.id;
  const el = h('div', {
    class: `cue${sel ? ' selected' : ''}`, dataset: { id: c.id, strack: tr.id },
    style: { left: `${left}px`, width: `${Math.max(3, w)}px` },
    title: `${c.text}\n${fmtTime(c.start)} – ${fmtTime(c.end)}`,
  }, h('span', { class: 'cue-text' }, c.text.replace(/\n/g, ' ⏎ ')), h('div', { class: 'handle l' }), h('div', { class: 'handle r' }));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); store.select({ kind: 'cue', id: c.id }); openCueMenu(c.id, e.clientX, e.clientY, tl.xToTime(e.clientX)); });
  el.addEventListener('pointerdown', (e) => startCueDrag(tl, tr, c, e));
  return el;
}

function startCueDrag(tl, tr, c, e) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  if (!store.selection || store.selection.id !== c.id) store.select({ kind: 'cue', id: c.id });
  if (tr.locked) return;
  if (tl.tool === 'blade') {
    if (!store.splitCue(c.id, tl.bladeTime(e))) toast(t('Слишком близко к краю реплики'), 'info', 1500);
    return;
  }
  const mode = e.target.closest('.handle.l') ? 'l' : e.target.closest('.handle.r') ? 'r' : 'move';
  const o = { start: c.start, end: c.end };
  const len = o.end - o.start;
  const before = store.snapshot();
  const pts = [...tl.snapPoints(null), ...store.subtitleTracks().flatMap((x) => x.cues.filter((q) => q.id !== c.id).flatMap((q) => [q.start, q.end]))];
  const x0 = e.clientX;
  let moved = false;
  tl.drag = { mode: 'cue' };
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 4) return;
    moved = true;
    const dt = (ev.clientX - x0) / tl.pps;
    let patch; let snapAt = null;
    if (mode === 'move') {
      let s = Math.max(0, o.start + dt);
      const a = tl.snap(s, pts, ev); const b = tl.snap(s + len, pts, ev);
      if (a.snapped) { s = a.t; snapAt = a.t; } else if (b.snapped) { s = b.t - len; snapAt = b.t; }
      s = Math.max(0, s);
      patch = { start: s, end: s + len };
    } else if (mode === 'l') {
      let s = clamp(o.start + dt, 0, o.end - MIN_CUE);
      const a = tl.snap(s, pts, ev); if (a.snapped && a.t < o.end - MIN_CUE) { s = a.t; snapAt = s; }
      patch = { start: s };
    } else {
      let en = Math.max(o.start + MIN_CUE, o.end + dt);
      const a = tl.snap(en, pts, ev); if (a.snapped && a.t > o.start + MIN_CUE) { en = a.t; snapAt = en; }
      patch = { end: en };
    }
    tl.showSnap(snapAt);
    store.setCue(c.id, patch, { live: true });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    tl.drag = null;
    tl.showSnap(null);
    if (moved) store.commitFrom(before);
    else store.setTime(tl.xToTime(x0));
    tl.render();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function openCueMenu(id, x, y, at = store.time) {
  const f = store.findCue(id);
  if (!f) return;
  const inside = (q) => q > f.cue.start + MIN_CUE && q < f.cue.end - MIN_CUE;
  const splitAt = inside(store.time) ? store.time : inside(at) ? at : null;
  openMenu(x, y, [
    { id: 'edit', label: t('Изменить текст'), icon: 'rename', onClick: () => { store.select({ kind: 'cue', id }); store.emit('focus-inspector', 'cue'); } },
    { id: 'split', label: t('Разделить'), icon: 'split', key: keyHint('clip.split'), disabled: splitAt === null || f.track.locked, onClick: () => store.splitCue(id, splitAt) },
    { id: 'delete', label: t('Удалить'), icon: 'trash', key: keyHint('clip.delete'), disabled: f.track.locked, onClick: () => store.deleteCue(id) },
    'sep',
    { id: 'style', label: t('Оформление дорожки…'), icon: 'subtitles', onClick: () => store.select({ kind: 'strack', id: f.track.id }) },
  ]);
}

export function openSubLaneMenu(trackId, x, y, at) {
  const tr = store.subtitleTrack(trackId);
  openMenu(x, y, [
    { id: 'add-cue', label: t('Новая реплика здесь'), icon: 'plus', disabled: !tr || tr.locked, onClick: () => { const id = store.addCue(trackId, { start: at, text: t('Новая реплика') }); store.select({ kind: 'cue', id }); store.emit('focus-inspector', 'cue'); } },
    { id: 'import', label: t('Заменить из файла…'), icon: 'upload', disabled: !tr || tr.locked, onClick: () => importSubtitles(trackId) },
    { id: 'export-srt', label: t('Сохранить как SRT…'), disabled: !tr || !tr.cues.length, onClick: () => exportSubtitleTrack(trackId, 'srt') },
    { id: 'export-vtt', label: t('Сохранить как VTT…'), disabled: !tr || !tr.cues.length, onClick: () => exportSubtitleTrack(trackId, 'vtt') },
    { id: 'export-ass', label: t('Сохранить как ASS…'), disabled: !tr || !tr.cues.length, onClick: () => exportSubtitleTrack(trackId, 'ass') },
    'sep',
    { id: 'style', label: t('Оформление…'), icon: 'subtitles', onClick: () => store.select({ kind: 'strack', id: trackId }) },
  ]);
}

// ---------------- Импорт / экспорт файлов ----------------
/** Открыть файл субтитров: на новую дорожку (trackId null) или вместо реплик дорожки. path — без окна выбора (тесты, MCP) */
export async function importSubtitles(trackId = null, path = null) {
  let file;
  try { file = await api().subtitleRead(path); } catch (e) { toast(t('Не удалось открыть субтитры: {err}', { err: errText(e) }), 'error', 5000); return null; }
  if (!file) return null;
  return importSubtitleText(file.text, { trackId, name: (file.name || '').replace(/\.[^.]+$/, '') });
}

export function importSubtitleText(text, { trackId = null, name = null, format = null } = {}) {
  const r = parseSubtitles(text, format);
  if (!r.format || !r.cues.length) {
    toast(r.format ? t('В файле нет реплик') : t('Формат субтитров не распознан (нужен SRT, VTT или ASS)'), 'error', 4000);
    return null;
  }
  const style = r.style ? { ...r.style, font: fontByFamily(r.style.font) } : null;
  const id = store.importCues(r.cues, { trackId, name: name || null, style });
  toast(t('Субтитры: {n} реплик', { n: r.cues.length }) + (r.errors.length ? ` · ${t('пропущено строк с ошибками: {n}', { n: r.errors.length })}` : ''), 'success', 3000);
  store.select({ kind: 'strack', id });
  return id;
}

/** Текст дорожки в формате fmt ('srt' | 'vtt' | 'ass'); ASS — с оформлением в размере кадра проекта */
export function subtitleText(trackId, fmt) {
  const tr = store.subtitleTrack(trackId);
  if (!tr) return '';
  if (fmt === 'vtt') return toVtt(tr.cues);
  if (fmt === 'ass') {
    const f = store.sourceFormat();
    return toAss([{ name: tr.name, style: tr.style, cues: tr.cues }], { W: f.width, H: f.height, fontName: (x) => fontFile(x).family });
  }
  return toSrt(tr.cues);
}

export async function exportSubtitleTrack(trackId, fmt = 'srt') {
  const base = `${(store.project.name || 'subtitles').replace(/[\\/:*?"<>|]+/g, '_')} - ${store.subtitleTrackName(trackId).replace(/[\\/:*?"<>|]+/g, '_')}.${fmt}`;
  try {
    const p = await api().subtitleWrite(null, base, subtitleText(trackId, fmt));
    if (p) toast(t('Субтитры сохранены: {path}', { path: p }), 'success', 3000);
  } catch (e) { toast(t('Не удалось сохранить субтитры: {err}', { err: errText(e) }), 'error', 5000); }
}

// ---------------- Плеер ----------------
// Реплики видимых дорожек поверх кадра. Размеры — как у libass: Fontsize = высота строки (≈ 1,2 em у Inter),
// обводка и отступы — в долях высоты кадра.
const hexA = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
export function initSubtitleOverlay(preview) {
  const layer = h('div', { class: 'sub-overlay' });
  preview.stage.append(layer);
  let sig = '';
  const draw = () => {
    const W = preview.stage.clientWidth; const H = preview.stage.clientHeight;
    const tracks = store.subtitleTracks().filter((tr) => !tr.hidden);
    const shown = tracks.map((tr) => ({ tr, cues: cueAt(tr.cues, store.time) })).filter((x) => x.cues.length);
    const s2 = `${W}x${H}|${JSON.stringify(shown.map((x) => [x.tr.style, x.cues.map((c) => c.id + c.text)]))}`;
    if (s2 === sig) return;
    sig = s2;
    layer.innerHTML = '';
    for (const { tr, cues } of shown) {
      const s = { ...SUB_STYLE_DEFAULT, ...tr.style };
      const px = (s.size * H) / 1.21;
      const ol = s.outline * H;
      const box = h('div', {
        class: `sub-box ${s.position} ${s.align}`,
        style: {
          fontFamily: fontFamilies(s.font), fontSize: `${px.toFixed(2)}px`, fontWeight: s.bold ? '700' : '400', fontStyle: s.italic ? 'italic' : 'normal',
          color: s.color, left: `${0.04 * W}px`, right: `${0.04 * W}px`,
          ...(s.position === 'bottom' ? { bottom: `${s.margin * H}px` } : s.position === 'top' ? { top: `${s.margin * H}px` } : { top: '50%', transform: 'translateY(-50%)' }),
        },
      });
      for (const c of cues) {
        const line = h('div', { class: 'sub-line' }, h('span', {
          style: s.box
            ? { background: hexA(s.boxColor, s.boxOpacity), padding: `0 ${(px * 0.3).toFixed(1)}px`, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }
            : { WebkitTextStroke: ol > 0 ? `${(2 * ol).toFixed(2)}px ${s.outlineColor}` : '', paintOrder: 'stroke fill', textShadow: s.shadow > 0 ? `${(s.shadow * H).toFixed(1)}px ${(s.shadow * H).toFixed(1)}px 0 ${s.shadowColor}` : '' },
        }, c.text));
        box.append(line);
      }
      layer.append(box);
    }
  };
  for (const ev of ['time', 'project']) store.on(ev, draw);
  new ResizeObserver(() => { sig = ''; draw(); }).observe(preview.stage);
  draw();
  return { draw };
}
