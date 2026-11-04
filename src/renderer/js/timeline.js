// Таймлайн: основная видеодорожка (клипы по времени, с пустотами и переходами) + аудиодорожки.
// Клипы «магнитятся» к краям соседей, курсору и началу; пустоты убираются кнопкой-корзиной,
// на стыке клипов, стоящих впритык, — кнопка «+» для перехода.
import { store, MIN_CUE, MIN_CLIP, ADJ, placeVideo, overwriteVideo, overwriteAudio, newTrack, moveToLane, MAIN_LANE } from './store.js';
import { isIdentity, tfOf } from './transform.js';
import { h, $, clamp, icon, fmtTime, rafThrottle, toast } from './util.js';
import { importPaths, peaksOf, streamCount } from './media.js';
import { openClipMenu, openLaneMenu, splitClip } from './actions.js';
import { isReversed, isFreeze } from './fx.js';
import { transitionById } from './transitions.js';
import { clipEffects, effectById } from './effects.js';
import { speedOf, tlLen, clipEnd, fmtSpeed, srcAt } from './clipTime.js';
import { neighbours, rippleTrim, rollEdit, slipClip, slideClip, trimFrames, snapFrame } from './editOps.js';
import { reportSkipped } from './edit.js';
import { activeFx, fxSummary } from './audioFx.js';
import { t, getLang } from './i18n.js';
import { withKey } from './keymap.js';
import { isText, TEXT_MAX } from './textModel.js';
import { fontFamilies } from './textRender.js';
import { subtitleRows, importSubtitles } from './subtitlesUi.js';
import { getPref, setPref } from './prefs.js';

const HEAD_W = 168;
const VIDEO_H = 76;
const AUDIO_H = 56;
const SNAP_PX = 12;
const DRAG_THRESHOLD = 4;
const MIN_PPS = 0.2;
const MAX_PPS = 800;

const clone = (x) => JSON.parse(JSON.stringify(x));
// «0:04.20 (из файла 0:01.00 – 0:05.20, скорость ×2)» — для подсказки клипа
const clipTimes = (c) => {
  const p = { len: fmtTime(tlLen(c)), a: fmtTime(c.in), b: fmtTime(c.out) };
  return speedOf(c) !== 1
    ? t('{len} (из файла {a} – {b}, скорость {speed})', { ...p, speed: fmtSpeed(speedOf(c)) })
    : t('{len} (из файла {a} – {b})', p);
};
// Десятичная дробь для подписей: 0,5 / 0.5
const dec = (x) => (getLang() === 'ru' ? String(x).replace('.', ',') : String(x));

export class Timeline {
  constructor(root) {
    this.root = root;
    this.pps = 40;          // пикселей на секунду
    this.autoFit = true;    // подгонять масштаб, пока пользователь сам не изменит
    this.drag = null;
    this.magnet = getPref('ui.magnet', true) !== false; // settings.json (js/prefs.js)

    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.scroll = h('div', { class: 'tl-scroll' });
    this.content = h('div', { class: 'tl-content' });
    this.scroll.append(this.content);
    root.append(this.toolbar, this.scroll);
    this.buildToolbar();

    this.playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'ph-knob' }));
    this.marker = h('div', { class: 'tl-insert' });
    this.snapLine = h('div', { class: 'tl-snapline' });
    this.bladeTc = h('span', { class: 'bl-tc' });
    this.bladeImg = h('img', { class: 'bl-img', draggable: 'false' });
    this.bladeLine = h('div', { class: 'tl-bladeline' }, h('div', { class: 'bl-label' }, this.bladeImg, this.bladeTc));
    this.markBand = h('div', { class: 'tl-markband' });
    this.content.addEventListener('pointermove', (e) => this.onBladeHover(e));
    this.content.addEventListener('pointerleave', () => { this.bladeLine.style.display = 'none'; if (this.tool === 'trim' && !this.drag) this.setHint(''); });

    const rerender = rafThrottle(() => this.render());
    store.on('project', () => { if (this.autoFit && !this.drag) this.fit(false); rerender(); });
    store.on('media', rerender);
    store.on('selection', rerender);
    store.on('busy', rerender);
    store.on('mode', rerender);
    store.on('marks', rerender);
    store.on('time', () => this.updatePlayhead());
    this.scroll.addEventListener('scroll', rafThrottle(() => this.render()));
    // Во время перетаскивания масштаб не трогаем: иначе клип «уезжает» из-под мыши
    const onResize = rafThrottle(() => { if (this.autoFit && !this.drag) this.fit(false); this.render(); });
    new ResizeObserver(() => onResize()).observe(this.scroll);

    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.content.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.content.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.content.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.initDrop();
    this.render();
  }

  // ------------------------------------------------------------------------
  // Панель инструментов
  // ------------------------------------------------------------------------
  buildToolbar() {
    // tip: строка или [текст, id действия] — подсказка с текущей клавишей
    const b = (name, tip, fn, id) => {
      const el = h('button', { class: 'icon-btn', ...(Array.isArray(tip) ? { tip } : { title: tip }), onclick: fn, id });
      el.innerHTML = icon(name, 19);
      return el;
    };
    this.zoomSlider = h('input', { type: 'range', min: '0', max: '1000', value: '500', class: 'zoom-slider', title: t('Масштаб (Ctrl + колесо мыши)') });
    this.zoomSlider.addEventListener('input', () => {
      const v = Number(this.zoomSlider.value) / 1000;
      this.setZoom(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v), null, true);
    });
    this.magnetBtn = b('magnet', '', () => this.toggleMagnet(), 'tb-magnet');
    this.toolbar.append(
      h('div', { class: 'tb-group' },
        b('undo', [t('Отменить'), 'edit.undo'], () => store.undo(), 'tb-undo'),
        b('redo', [t('Повторить'), 'edit.redo'], () => store.redo(), 'tb-redo')),
      h('div', { class: 'tb-sep' }),
      h('div', { class: 'tb-group' },
        this.pointerBtn = b('pointer', [t('Выделение'), 'tool.select'], () => this.setTool('select'), 'tb-pointer'),
        this.bladeBtn = b('blade', '', () => this.setTool(this.tool === 'blade' ? 'select' : 'blade'), 'tb-blade'),
        this.trimBtn = b('trim', '', () => this.setTool(this.tool === 'trim' ? 'select' : 'trim'), 'tb-trim'),
        h('div', { class: 'tb-sep small' }),
        this.splitBtn = b('split', '', (e) => (e.altKey ? this.splitAllAction() : this.splitAction()), 'tb-split'),
        b('trash', [t('Удалить выделенное'), 'clip.delete'], () => this.deleteAction(), 'tb-delete'),
        this.magnetBtn),
      h('div', { class: 'tb-time', id: 'tb-time' }),
      this.hintEl = h('div', { class: 'tb-hint', id: 'tb-hint' }),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group zoom' },
        b('minus', t('Уменьшить'), () => this.setZoom(this.pps / 1.4, null, true)),
        this.zoomSlider,
        b('plus', t('Увеличить'), () => this.setZoom(this.pps * 1.4, null, true)),
        b('fit', [t('Весь проект'), 'view.zoomFit'], () => { this.autoFit = true; this.fit(true); })),
    );
    this.updateMagnetBtn();
    this.updateKeyTips();
    this.setTool('select');
  }

  // Подсказки, где клавиша стоит посередине текста (обновляются при каждой отрисовке — после смены клавиш тоже)
  updateKeyTips() {
    this.bladeBtn.title = `${withKey(t('Лезвие'), 'tool.blade')}: ${t('щелчок по клипу разрезает его в этом месте вместе со связанным звуком; Alt+щелчок — только этот клип')}`;
    this.splitBtn.title = `${withKey(t('Разрезать по курсору'), 'clip.split')}; ${withKey(t('всё под курсором — видео и звук'), 'clip.splitAll')}`;
    this.bladeBtn.title += `; ${t('Shift+щелчок — все дорожки')}`;
    this.trimBtn.title = `${withKey(t('Обрезка'), 'tool.trim')}: ${t('край клипа — ripple (следующие едут следом), стык двух клипов — roll, нижняя часть клипа — slip, верхняя (с названием) — slide')}`;
  }

  // Инструмент: 'select' — выделение и перетаскивание, 'blade' — лезвие (как в DaVinci Resolve),
  // 'trim' — обрезка (0.4.3): ripple / roll / slip / slide в зависимости от места на клипе
  setTool(tool) {
    this.tool = tool;
    const blade = tool === 'blade';
    this.root.classList.toggle('blade-mode', blade);
    this.root.classList.toggle('trim-mode', tool === 'trim');
    this.bladeBtn.classList.toggle('on', blade);
    this.trimBtn.classList.toggle('on', tool === 'trim');
    this.pointerBtn.classList.toggle('on', tool === 'select');
    if (!blade && this.bladeLine) this.bladeLine.style.display = 'none';
    if (tool !== 'trim') { delete this.content.dataset.trimOp; this.setHint(''); }
  }

  setHint(text) { if (this.hintEl && this.hintEl.textContent !== text) this.hintEl.textContent = text; }

  // Время лезвия под мышью: магнит к курсору воспроизведения и краям клипов, затем — ко кадру
  bladeTime(ev) {
    const t = this.xToTime(ev.clientX);
    return store.frameT(this.snap(t, this.snapPoints(null), ev).t);
  }

  onBladeHover(ev) {
    if (this.tool === 'trim' && !this.drag) { this.onTrimHover(ev); return; }
    if (this.tool !== 'blade' || this.drag) return;
    const overLanes = ev.target.closest && ev.target.closest('.tl-lane') && !ev.target.closest('.ruler-lane');
    if (!overLanes) { this.bladeLine.style.display = 'none'; return; }
    const bt = this.bladeTime(ev);
    this.bladeLine.style.display = 'block';
    this.bladeLine.style.transform = `translateX(${HEAD_W + bt * this.pps}px)`;
    // Таймкод и кадр под лезвием (миниатюра — из плёнки клипа)
    this.bladeTc.textContent = fmtTime(bt);
    const clipEl = ev.target.closest('.clip');
    const f = clipEl && store.findClip(clipEl.dataset.id);
    const rt = f && f.kind === 'video' && !isText(f.clip) ? store.runtime[f.clip.mediaId] : null;
    if (rt && rt.thumbs && rt.thumbs.urls.length) {
      const idx = clamp(Math.round(srcAt(f.clip, bt) / rt.thumbs.interval), 0, rt.thumbs.urls.length - 1);
      if (this.bladeImg.dataset.src !== rt.thumbs.urls[idx]) { this.bladeImg.dataset.src = rt.thumbs.urls[idx]; this.bladeImg.src = rt.thumbs.urls[idx]; }
      this.bladeImg.style.display = 'block';
    } else this.bladeImg.style.display = 'none';
  }

  // ------------------------------------------------------------------------
  // Инструмент обрезки (0.4.3)
  // ------------------------------------------------------------------------
  // Что сделает перетаскивание в этой точке: { op: 'ripple-l'|'ripple-r'|'roll'|'slip'|'slide', id } или null
  trimOpAt(ev) {
    const clipEl = ev.target.closest && ev.target.closest('.clip');
    if (!clipEl) return null;
    const id = clipEl.dataset.id;
    const n = neighbours(store.project, id);
    if (!n) return null;
    const r = clipEl.getBoundingClientRect();
    const x = ev.clientX;
    const EDGE = Math.min(12, r.width / 4);
    const ROLL = 5;
    if (x - r.left <= EDGE) {
      // У стыка с соседом впритык (или с Alt) — roll левого стыка, иначе ripple начала
      if (n.prev && n.prevAdj && (x - r.left <= ROLL || ev.altKey)) return { op: 'roll', id: n.prev.id };
      return { op: 'ripple-l', id };
    }
    if (r.right - x <= EDGE) {
      if (n.next && n.nextAdj && (r.right - x <= ROLL || ev.altKey)) return { op: 'roll', id };
      return { op: 'ripple-r', id };
    }
    if (isText(n.clip)) return { op: 'slide', id };
    return { op: ev.clientY - r.top < r.height * 0.45 ? 'slide' : 'slip', id };
  }

  onTrimHover(ev) {
    const o = this.trimOpAt(ev);
    if (o) this.content.dataset.trimOp = o.op; else delete this.content.dataset.trimOp;
    const HINT = {
      'ripple-l': t('Ripple: начало клипа, всё правее сдвинется'),
      'ripple-r': t('Ripple: конец клипа, всё правее сдвинется'),
      roll: t('Roll: двигать стык, длина ролика не меняется'),
      slip: t('Slip: двигать содержимое внутри клипа'),
      slide: t('Slide: двигать клип между соседями'),
    };
    this.setHint(o ? HINT[o.op] : t('Обрезка: наведите на край, стык или середину клипа'));
  }

  // Перетаскивание инструментом обрезки: каждый шаг — от исходного проекта; в плеере — два кадра правки
  startTrimDrag(e, o) {
    const f = store.findClip(o.id);
    if (!f) return;
    if ((f.lane && f.lane.locked) || (f.track && f.track.locked)) {
      toast(t('Дорожка «{name}» закрыта замком', { name: store.trackName(f.lane ? f.lane.id : f.track.id) }), 'info', 1600);
      return;
    }
    if (store.busy[o.id]) return;
    store.select({ kind: f.kind, id: o.id });
    const before = store.snapshot();
    const x0 = e.clientX;
    const fps = store.fps();
    let moved = false; let got = 0;
    const NAMES = { 'ripple-l': 'Ripple', 'ripple-r': 'Ripple', roll: 'Roll', slip: 'Slip', slide: 'Slide' };
    this.drag = { mode: 'trim', id: o.id };
    document.body.classList.add('is-trimming');
    const apply = (ev) => {
      const d = snapFrame((ev.clientX - x0) / this.pps, fps);
      store.live(() => {
        store.project = JSON.parse(before);
        const p = store.project;
        const linked = !ev.altKey || o.op === 'roll';
        if (o.op === 'ripple-l') got = rippleTrim(p, o.id, 'l', d, { linked });
        else if (o.op === 'ripple-r') got = rippleTrim(p, o.id, 'r', d, { linked });
        else if (o.op === 'roll') got = rollEdit(p, o.id, d);
        else if (o.op === 'slip') got = -slipClip(p, o.id, -d); // содержимое едет вслед за мышью
        else got = slideClip(p, o.id, d);
      });
      const frames = trimFrames(store.project, o.op, o.id);
      store.emit('trim-preview', { op: o.op, frames });
      this.setHint(`${NAMES[o.op]} ${got >= 0 ? '+' : '−'}${fmtTime(Math.abs(got))}`);
      this.autoScroll(ev.clientX);
    };
    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD) return;
      moved = true;
      apply(ev);
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-trimming');
      this.drag = null;
      store.emit('trim-preview', null);
      this.setHint('');
      if (!moved) { store.setTime(this.xToTime(ev.clientX)); this.render(); return; }
      store.commitFrom(before);
      this.render();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  splitAllAction() {
    if (!store.splitAll(store.time)) toast(t('Под курсором нет клипов, которые можно разрезать'), 'info', 2200);
  }

  toggleMagnet() {
    this.magnet = !this.magnet;
    setPref('ui.magnet', this.magnet);
    this.updateMagnetBtn();
    toast(this.magnet ? t('Магнит включён: клипы липнут к краям соседей') : t('Магнит выключен'), 'info', 1600);
  }

  updateMagnetBtn() {
    this.magnetBtn.classList.toggle('on', this.magnet);
    this.magnetBtn.title = this.magnet
      ? t('Магнит включён — клипы прилипают к соседям, курсору и началу (Alt при перетаскивании — без магнита и без наложения: клип не затирает соседей, а встаёт рядом)')
      : t('Магнит выключен — клипы ставятся куда угодно');
  }

  updateToolbar() {
    $('#tb-undo').disabled = !store.undoStack.length;
    $('#tb-redo').disabled = !store.redoStack.length;
    $('#tb-delete').disabled = !store.selection || store.selection.kind === 'transition' || store.selection.kind === 'track' || store.selection.kind === 'strack';
    $('#tb-split').disabled = !this.canSplit();
    this.updateKeyTips();
    this.zoomSlider.value = String(Math.round(1000 * Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)));
  }

  canSplit() {
    const t = store.time;
    if (store.selection && store.selection.kind === 'cue') {
      const q = store.findCue(store.selection.id);
      if (q) return t > q.cue.start + MIN_CUE && t < q.cue.end - MIN_CUE;
    }
    if (store.selection && store.selection.kind !== 'transition') {
      const f = store.findClip(store.selection.id);
      if (f) return t > f.clip.start + MIN_CLIP && t < clipEnd(f.clip) - MIN_CLIP;
    }
    return store.videoLayout().some((s) => t > s.start + MIN_CLIP && t < s.end - MIN_CLIP);
  }

  splitAction() {
    const at = store.time;
    if (store.selection && store.selection.kind === 'cue') {
      if (!store.splitCue(store.selection.id, at)) toast(t('Поставьте курсор внутрь реплики, чтобы разрезать'), 'info', 2200);
      return;
    }
    const sel = store.selection && store.selection.kind !== 'transition' ? store.findClip(store.selection.id) : null;
    if (sel && at > sel.clip.start && at < clipEnd(sel.clip)) { splitClip(sel.clip.id, at); return; }
    if (!store.splitAt(at)) toast(t('Поставьте курсор внутрь клипа, чтобы разрезать'), 'info', 2200);
  }

  deleteAction(ripple = false) {
    const s = store.selection;
    if (!s || s.kind === 'track' || s.kind === 'strack') return;
    if (s.kind === 'transition') { store.setTransition(s.id, null); return; }
    if (s.kind === 'cue') { const f = store.findCue(s.id); if (f && !f.track.locked) store.deleteCue(s.id); return; }
    const f = store.findClip(s.id);
    if (f && ((f.lane && f.lane.locked) || (f.track && f.track.locked))) { toast(t('Дорожка «{name}» закрыта замком', { name: store.trackName(f.lane ? f.lane.id : f.track.id) }), 'info', 1600); return; }
    const r = store.deleteClip(s.id, { ripple });
    if (ripple && r) reportSkipped(r.skipped);
  }

  // ------------------------------------------------------------------------
  // Масштаб и прокрутка
  // ------------------------------------------------------------------------
  viewW() { return Math.max(100, this.scroll.clientWidth - HEAD_W); }

  fit(render = true) {
    const dur = Math.max(store.duration(), 10);
    this.pps = clamp((this.viewW() - 40) / dur, MIN_PPS, MAX_PPS);
    this.scroll.scrollLeft = 0;
    if (render) this.render();
  }

  setZoom(pps, anchorClientX = null, manual = false) {
    const old = this.pps;
    pps = clamp(pps, MIN_PPS, MAX_PPS);
    if (manual) this.autoFit = false;
    const rect = this.scroll.getBoundingClientRect();
    const vx = anchorClientX !== null ? anchorClientX - rect.left - HEAD_W
      : (store.time * old - this.scroll.scrollLeft); // по умолчанию держим курсор на месте
    const anchorT = (this.scroll.scrollLeft + vx) / old;
    this.pps = pps;
    this.render();
    this.scroll.scrollLeft = Math.max(0, anchorT * pps - vx);
    this.render();
  }

  onWheel(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      this.setZoom(this.pps * Math.pow(1.0018, -e.deltaY), e.clientX, true);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.content.scrollHeight <= this.scroll.clientHeight + 2) {
      // Нечего прокручивать по вертикали — крутим по горизонтали
      e.preventDefault();
      this.scroll.scrollLeft += e.deltaY;
    }
  }

  // время (с) по клиентскому X
  xToTime(clientX) {
    const r = this.content.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEAD_W) / this.pps);
  }

  visibleRange() {
    const s = this.scroll.scrollLeft;
    return [s - 200, s + this.viewW() + 200];
  }

  // ------------------------------------------------------------------------
  // Отрисовка
  // ------------------------------------------------------------------------
  render() {
    const dur = store.duration();
    const contentSec = Math.max(dur + 30, (this.viewW()) / this.pps);
    const laneW = Math.ceil(contentSec * this.pps);
    this.content.style.width = `${HEAD_W + laneW}px`;
    this.content.innerHTML = '';

    // Линейка; в углу — «+ видеодорожка»
    const rulerLane = h('div', { class: 'tl-lane ruler-lane', style: { width: `${laneW}px` } });
    const addV = h('button', { class: 'btn ghost tiny', id: 'tl-add-vtrack', title: t('Новая видеодорожка сверху: картинка в картинке, наложения, титры'), onclick: () => store.addVideoTrack() }, t('+ Видео'));
    this.content.append(h('div', { class: 'tl-row ruler' }, h('div', { class: 'tl-head corner' }, addV), rulerLane));
    this.drawRuler(rulerLane);

    // Видеодорожки: сверху вниз (верхняя дорожка перекрывает нижние), основная — последней
    const lanes = store.vlanes();
    for (let i = lanes.length - 1; i >= 0; i--) this.content.append(this.videoRow(lanes[i], i, laneW));
    // Субтитры (M5.5) — между видео и звуком
    for (const row of subtitleRows(this, laneW)) this.content.append(row);

    // Аудио
    const solo = store.anySolo();
    store.project.audioTracks.forEach((trk, i) => {
      const silent = trk.muted || (solo && !trk.solo);
      const lane = h('div', { class: `tl-lane audio-lane${silent ? ' muted' : ''}`, dataset: { lane: 'audio', track: trk.id }, style: { width: `${laneW}px`, height: `${AUDIO_H}px` } });
      const muteBtn = h('button', { class: `icon-btn tiny th-mute${trk.muted ? ' on' : ''}`, title: trk.muted ? t('Включить звук дорожки') : t('Выключить звук дорожки'), onclick: () => store.toggleTrackMute(trk.id) });
      muteBtn.innerHTML = icon(trk.muted ? 'mute' : 'speaker', 15);
      const soloBtn = h('button', {
        class: `th-solo${trk.solo ? ' on' : ''}`, title: trk.solo ? t('Снять «соло»') : t('Соло: слушать только эту дорожку (только в предпросмотре, на экспорт не влияет)'),
        onclick: () => store.toggleTrackSolo(trk.id),
      }, 'S');
      const delBtn = h('button', { class: 'icon-btn tiny', title: t('Удалить дорожку'), onclick: () => store.removeAudioTrack(trk.id) });
      delBtn.innerHTML = icon('close', 13);
      // Замок (0.4.3): клипы дорожки не двигаются, не режутся и не сдвигаются при ripple
      const lockBtn = h('button', {
        class: `icon-btn tiny th-lock${trk.locked ? ' on' : ''}`,
        title: trk.locked ? t('Снять замок') : t('Замок: клипы дорожки нельзя двигать и менять, ripple их не сдвигает'),
        onclick: () => store.setTrack(trk.id, { locked: !trk.locked }),
      });
      lockBtn.innerHTML = icon(trk.locked ? 'lock' : 'unlock', 13);
      const trSel = store.selection && store.selection.kind === 'track' && store.selection.id === trk.id;
      const head = h('div', {
        class: `tl-head audio-head${trSel ? ' selected' : ''}`, dataset: { trackHead: trk.id },
        title: t('Щелчок — выбрать дорожку (эффекты дорожки — во вкладке «Аудио»)'),
        onclick: (e) => { if (e.target.closest('button, input')) return; store.select({ kind: 'track', id: trk.id }); },
      },
        h('div', { class: 'th-row' },
          h('span', { class: 'th-ic', html: icon('music', 15) }), this.trackNameEl(trk.id),
          activeFx(trk.afx).length ? h('span', { class: 'th-fx', title: t('Эффекты дорожки: {fx}', { fx: fxSummary(trk.afx) }) }, 'ƒx') : null,
          h('span', { class: 'th-actions' }, soloBtn, muteBtn, lockBtn, store.project.audioTracks.length > 1 || trk.clips.length ? delBtn : null)),
        this.trackVolumeEl(trk));
      this.content.append(h('div', { class: `tl-row audio${trk.locked ? ' lane-locked' : ''}`, dataset: { track: trk.id } }, head, lane));
      if (!trk.clips.length && i === 0) lane.append(h('div', { class: 'lane-hint' }, t('Музыка и звук')));
      // На аудиодорожках показываем только пустоты между клипами (музыка может начинаться не с нуля)
      if (!this.drag) for (const g of store.gaps(trk.id)) if (g[0] > ADJ) lane.append(this.gapEl(g, trk.id));
      for (const c of trk.clips) lane.append(this.audioClipEl(c, trk));
    });

    // Строка для новой дорожки
    const addBtn = h('button', { class: 'btn ghost tiny', onclick: () => store.addAudioTrack() }, t('+ Дорожка'));
    const addSub = h('button', {
      class: 'btn ghost tiny', id: 'tl-add-subs', title: t('Новая дорожка субтитров (щелчок с Alt — открыть файл SRT / VTT / ASS)'),
      onclick: (e) => { if (e.altKey) importSubtitles(); else store.select({ kind: 'strack', id: store.addSubtitleTrack() }); },
    }, t('+ Субтитры'));
    this.content.append(h('div', { class: 'tl-row newtrack', dataset: { lane: 'newtrack' } },
      h('div', { class: 'tl-head' }, addBtn, addSub),
      h('div', { class: 'tl-lane newtrack-lane', dataset: { lane: 'newtrack' }, style: { width: `${laneW}px` } },
        h('span', { class: 'lane-hint left' }, t('Перетащите аудио сюда, чтобы создать новую дорожку')))));

    this.content.append(this.playhead, this.marker, this.snapLine, this.bladeLine);
    this.drawMarks(rulerLane);
    this.updatePlayhead();
    this.updateToolbar();
  }

  // Строка видеодорожки: заголовок (имя, видимость, замок, порядок, удалить) и клипы
  videoRow(lane, index, laneW) {
    const main = lane.main;
    const vLane = h('div', {
      class: `tl-lane ${main ? 'video-lane' : 'vtrack-lane'}`,
      dataset: { lane: main ? 'video' : 'vtrack', vlane: lane.id },
      style: { width: `${laneW}px`, height: `${VIDEO_H}px` },
    });
    const vb = (name, tip, on, fn, cls) => {
      const b = h('button', { class: `th-vbtn ${cls}${on ? ' on' : ''}`, title: tip, onclick: (e) => { e.stopPropagation(); fn(); } });
      b.innerHTML = icon(name, 15);
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };
    const n = store.videoTracks().length;
    const acts = h('span', { class: 'th-actions' },
      vb(lane.hidden ? 'eyeoff' : 'eye', lane.hidden ? t('Показать дорожку') : t('Скрыть дорожку (в плеере и в экспорте; звук клипов остаётся)'), lane.hidden, () => store.setVideoTrack(lane.id, { hidden: !lane.hidden }), 'th-hide'),
      vb(lane.locked ? 'lock' : 'unlock', lane.locked ? t('Снять замок') : t('Замок: клипы дорожки нельзя двигать и менять'), lane.locked, () => store.setVideoTrack(lane.id, { locked: !lane.locked }), 'th-lock'),
      !main && index < n ? vb('up', t('Поднять дорожку выше'), false, () => store.moveVideoTrack(lane.id, 1), 'th-up') : null,
      !main && index > 1 ? vb('down', t('Опустить дорожку ниже'), false, () => store.moveVideoTrack(lane.id, -1), 'th-down') : null,
      !main ? vb('close', t('Удалить видеодорожку'), false, () => store.removeVideoTrack(lane.id), 'th-del') : null);
    const head = h('div', { class: 'tl-head video-head', dataset: { vtrackHead: lane.id } },
      h('div', { class: 'th-row' }, h('span', { class: 'th-ic', html: icon('film', main ? 18 : 15) }), this.trackNameEl(lane.id)),
      h('div', { class: 'th-row' }, acts));
    const row = h('div', { class: `tl-row ${main ? 'video' : 'vtrack'}${lane.hidden ? ' lane-hidden' : ''}${lane.locked ? ' lane-locked' : ''}`, dataset: { vlane: lane.id } }, head, vLane);
    const layout = store.videoLayout(lane.id);
    if (!layout.length) vLane.append(h('div', { class: 'lane-hint' }, main ? t('Перетащите сюда видео из «Ваши медиа»') : t('Видео, картинки и анимации поверх нижних дорожек')));
    if (!this.drag && !lane.locked) for (const g of store.gaps(lane.id)) if (main || g[0] > ADJ) vLane.append(this.gapEl(g, lane.id));
    for (const seg of layout) vLane.append(this.videoClipEl(seg));
    if ((!this.drag || this.drag.mode === 'fade') && !lane.locked) this.renderJunctions(vLane, layout);
    return row;
  }

  // Имя дорожки: двойной щелчок — переименовать
  trackNameEl(trackId) {
    const name = store.trackName(trackId);
    const el = h('span', { class: 'th-name', title: t('{name} — двойной щелчок, чтобы переименовать', { name }) }, name);
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const inp = h('input', { class: 'th-rename', value: name, maxlength: '40' });
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (ok && v !== name) store.setTrack(trackId, { name: v });
        else this.render();
      };
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        else if (ev.key === 'Escape') finish(false);
      });
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      el.replaceWith(inp);
      inp.focus(); inp.select();
    });
    return el;
  }

  // Громкость дорожки (умножается на громкость каждого клипа; влияет и на экспорт)
  trackVolumeEl(trk) {
    const pct = () => Math.round((trk.volume ?? 1) * 100);
    const val = h('span', { class: 'th-volval' }, `${pct()}%`);
    const r = h('input', { type: 'range', min: '0', max: '200', step: '1', value: String(pct()), class: 'th-vol', title: t('Громкость дорожки (двойной щелчок — 100%)') });
    let before = null;
    r.addEventListener('pointerdown', (e) => { e.stopPropagation(); before = store.snapshot(); });
    r.addEventListener('input', () => {
      if (!before) before = store.snapshot();
      const v = Number(r.value) / 100;
      store.live((p) => { const x = p.audioTracks.find((y) => y.id === trk.id); if (x) x.volume = v; });
      val.textContent = `${r.value}%`;
    });
    r.addEventListener('change', () => { store.commitFrom(before); before = null; });
    r.addEventListener('dblclick', () => store.setTrack(trk.id, { volume: 1 }));
    return h('div', { class: 'th-row vol' }, r, val);
  }

  // Метки In / Out (0.4.3): скобки на линейке и полупрозрачная полоса через все дорожки
  drawMarks(rulerLane) {
    const m = store.project.marks || {};
    const has = (k) => typeof m[k] === 'number';
    if (!has('in') && !has('out')) return;
    const a = has('in') ? m.in : 0;
    const b = has('out') ? m.out : Math.max(store.duration(), a);
    const x0 = a * this.pps; const w = Math.max(0, (b - a) * this.pps);
    rulerLane.append(h('div', { class: 'mark-range', style: { left: `${x0}px`, width: `${w}px` } }));
    if (has('in')) rulerLane.append(h('div', { class: 'mark-flag in', title: t('In {t}', { t: fmtTime(m.in) }), style: { left: `${m.in * this.pps}px` } }));
    if (has('out')) rulerLane.append(h('div', { class: 'mark-flag out', title: t('Out {t}', { t: fmtTime(m.out) }), style: { left: `${m.out * this.pps}px` } }));
    if (has('in') && has('out')) {
      this.markBand.style.left = `${HEAD_W + x0}px`;
      this.markBand.style.width = `${w}px`;
      this.content.append(this.markBand);
    }
  }

  drawRuler(lane) {
    const [x0, x1] = this.visibleRange();
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
    const step = steps.find((s) => s * this.pps >= 90) || 3600;
    const minor = step / (step >= 60 && step % 60 === 0 && step / 60 < 5 ? step / 15 : 5);
    const per = Math.round(step / minor);
    const i0 = Math.max(0, Math.floor(x0 / this.pps / minor));
    const i1 = Math.ceil(x1 / this.pps / minor);
    const frag = document.createDocumentFragment();
    for (let i = i0; i <= i1; i++) {
      const t = Math.round(i * minor * 1000) / 1000; // без накопления ошибки
      const major = i % per === 0;
      const x = t * this.pps;
      frag.append(h('div', { class: `tick${major ? ' major' : ''}`, style: { left: `${x}px` } }));
      if (major) {
        const label = step < 1 ? fmtTime(t + 1e-6) : fmtTime(t + 1e-6, { ms: false });
        frag.append(h('div', { class: 'tick-label', style: { left: `${x + 4}px` } }, label));
      }
    }
    lane.append(frag);
  }

  // Пустота на дорожке: при наведении — корзина «удалить пустоту»
  gapEl([g0, g1], lane) {
    const w = (g1 - g0) * this.pps;
    const el = h('div', { class: 'tl-gap', dataset: { lane, from: String(g0) }, style: { left: `${g0 * this.pps}px`, width: `${w}px` } });
    if (w >= 18) {
      const btn = h('button', {
        class: 'gap-del', title: t('Удалить пустоту ({len}) — клипы правее сдвинутся влево', { len: fmtTime(g1 - g0) }),
        onclick: (e) => { e.stopPropagation(); store.closeGap(lane, (g0 + g1) / 2); },
      });
      btn.innerHTML = icon('trash', 15);
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.append(btn);
    }
    return el;
  }

  // Стыки клипов, стоящих впритык: «+» (добавить переход) или значок перехода
  renderJunctions(lane, layout) {
    for (let i = 1; i < layout.length; i++) {
      const a = layout[i - 1]; const b = layout[i];
      if (Math.abs(a.end - b.start) > ADJ) continue;
      const x = b.start * this.pps;
      const tr = b.clip.transition;
      const sel = store.selection && store.selection.kind === 'transition' && store.selection.id === b.clip.id;
      if (tr) {
        const w = tr.duration * this.pps;
        lane.append(h('div', { class: `tr-zone${sel ? ' selected' : ''}`, style: { left: `${x - w / 2}px`, width: `${w}px` } }));
      }
      const btn = h('button', {
        class: `junction${tr ? ' has' : ''}${sel ? ' selected' : ''}`,
        dataset: { clip: b.clip.id },
        title: tr ? t('Переход: {name}, {d} с — нажмите, чтобы изменить', { name: transitionById(tr.type).name, d: dec(tr.duration) }) : t('Добавить переход'),
        style: { left: `${x}px` },
        onclick: (e) => { e.stopPropagation(); store.select({ kind: 'transition', id: b.clip.id }); store.emit('focus-inspector', 'transition'); },
      });
      btn.innerHTML = icon(tr ? 'transition' : 'plus', tr ? 15 : 16);
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      // Наведение на переход — он проигрывается в плеере
      if (tr) {
        btn.addEventListener('mouseenter', () => store.emit('preview-transition', { bId: b.clip.id, type: tr.type, duration: tr.duration, el: btn }));
        btn.addEventListener('mouseleave', () => store.emit('preview-transition', null));
      }
      lane.append(btn);
    }
  }

  clipBase(kind, c, left, width, extraClass = '') {
    const sel = store.selection && store.selection.kind !== 'transition' && store.selection.id === c.id;
    const rt = store.runtime[c.mediaId] || {};
    const el = h('div', {
      class: `clip ${kind}${sel ? ' selected' : ''}${c.muted ? ' clip-muted' : ''}${rt.missing ? ' missing' : ''} ${extraClass}`,
      dataset: { id: c.id, kind },
      style: { left: `${left}px`, width: `${Math.max(2, width)}px` },
      title: `${store.clipName(c)}\n${clipTimes(c)}\n${t('Правая кнопка мыши — действия')}`,
    });
    return el;
  }

  // Общие украшения клипа: затухания, значки, «идёт обработка», ручки
  decorate(el, c, width, sel) {
    if (c.fadeIn > 0.001) el.append(h('div', { class: 'fade-zone in', style: { width: `${Math.min(width, c.fadeIn * this.pps)}px` } }));
    if (c.fadeOut > 0.001) el.append(h('div', { class: 'fade-zone out', style: { width: `${Math.min(width, c.fadeOut * this.pps)}px` } }));
    const busy = store.busy[c.id];
    if (busy) {
      el.append(h('div', { class: 'clip-busy' },
        h('span', {}, `${busy.label}… ${Math.round((busy.progress || 0) * 100)}%`),
        h('div', { class: 'bar', style: { width: `${Math.round((busy.progress || 0) * 100)}%` } })));
    }
    el.append(h('div', { class: 'handle l' }), h('div', { class: 'handle r' }));
    if (sel && width > 40) {
      el.append(
        h('div', { class: 'fade-knob in', title: t('Потяните, чтобы сделать плавное появление'), style: { left: `${Math.min(width - 10, c.fadeIn * this.pps)}px` } }),
        h('div', { class: 'fade-knob out', title: t('Потяните, чтобы сделать плавное исчезание'), style: { right: `${Math.min(width - 10, c.fadeOut * this.pps)}px` } }));
    }
  }

  clipLabel(c, m, extra = null) {
    const label = h('div', { class: 'clip-label' });
    if (isText(c)) label.append(h('span', { class: 'ci fxb', title: t('Текст — двойной щелчок, чтобы изменить') }, 'T'));
    if (isReversed(c)) label.append(h('span', { class: 'ci fx', title: t('Задом наперёд'), html: icon('reverse', 13) }));
    if (isFreeze(c)) label.append(h('span', { class: 'ci fx', title: t('Стоп-кадр'), html: icon('freeze', 13) }));
    const fxl = clipEffects(c);
    if (fxl.length) label.append(h('span', { class: 'ci fxb', title: t('Эффекты: {list}', { list: fxl.map((x) => effectById(x).name).join(', ') }) }, 'fx'));
    if (c.fit === 'cover') label.append(h('span', { class: 'ci fxb', title: t('Заполняет кадр (края обрезаны)') }, '▣'));
    if (c.fit === 'stretch') label.append(h('span', { class: 'ci fxb', title: t('Растянут на весь кадр') }, '⇔'));
    if (activeFx(c.afx).length) label.append(h('span', { class: 'ci fxb', title: t('Аудиоэффекты: {fx}', { fx: fxSummary(c.afx) }) }, 'ƒx'));
    if (speedOf(c) !== 1) label.append(h('span', { class: 'ci speed', title: t('Скорость клипа') }, fmtSpeed(speedOf(c))));
    if (c.transform && !isIdentity(tfOf(c))) label.append(h('span', { class: 'ci tf', title: t('Положение, масштаб или поворот изменены (инспектор → «Трансформ»)'), html: icon('transform', 13) }));
    if (m.anim) label.append(h('span', { class: 'ci fxb', title: t('Анимация из пресета — двойной щелчок, чтобы изменить') }, '✦'));
    if (c.link && store.linkedOf(c.id).length) label.append(h('span', { class: 'ci link', title: t('Связан со звуком/видео: двигаются и режутся вместе (Alt — только этот клип)'), html: icon('link', 13) }));
    if (c.muted && m.hasAudio && !c.noAudio) label.append(h('span', { class: 'ci', html: icon('mute', 13) }));
    else if (m.hasAudio && !c.noAudio && Math.abs(c.volume - 1) > 0.01) label.append(h('span', { class: 'ci vol' }, `${Math.round(c.volume * 100)}%`));
    label.append(h('span', { class: 'cn' }, store.clipName(c)));
    if (extra) label.append(extra);
    return label;
  }

  videoClipEl(seg) {
    const c = seg.clip;
    const m = store.media(c.mediaId) || {};
    const rt = store.runtime[c.mediaId] || {};
    const left = seg.start * this.pps;
    const width = (seg.end - seg.start) * this.pps;
    const el = this.clipBase('video', c, left, width, isText(c) ? 'text' : '');
    const sel = el.classList.contains('selected');
    if (isText(c)) {
      // Текст: образец оформления (цвет, жирность, курсив) вместо плёнки
      const tx = c.text || {};
      el.append(h('div', { class: 'text-strip', style: { color: tx.color || '#fff', fontWeight: String(tx.weight || 700), fontStyle: tx.italic ? 'italic' : '', fontFamily: fontFamilies(tx.font || 'Inter') } },
        (tx.content || '').replace(/\s*\n\s*/g, ' · ')));
      el.append(this.clipLabel(c, m, h('span', { class: 'cd' }, fmtTime(tlLen(c), { ms: false }))));
      this.decorate(el, c, width, sel);
      return el;
    }
    const [vx0, vx1] = this.visibleRange();

    // Плёнка из миниатюр (только видимая часть)
    const strip = h('div', { class: 'filmstrip' });
    const tileH = VIDEO_H - 4;
    const tileW = Math.max(24, Math.round(tileH * ((m.width || 16) / (m.height || 9))));
    if (rt.thumbs && rt.thumbs.urls.length) {
      const n = rt.thumbs.urls.length;
      const i0 = Math.max(0, Math.floor((vx0 - left) / tileW));
      const i1 = Math.min(Math.ceil(width / tileW), Math.ceil((vx1 - left) / tileW));
      for (let i = i0; i < i1; i++) {
        const x = i * tileW;
        const t = c.in + ((x + tileW / 2) / this.pps) * speedOf(c);
        const idx = clamp(Math.round(t / rt.thumbs.interval), 0, n - 1);
        strip.append(h('img', { src: rt.thumbs.urls[idx], draggable: 'false', style: { left: `${x}px`, width: `${tileW}px`, height: `${tileH}px` } }));
      }
    }
    el.append(strip);

    // Полоска звука внизу клипа (если звук не вынесен на аудиодорожку)
    if (m.hasAudio && !c.noAudio && width > 8) {
      const wave = this.waveCanvas(c, rt.peaks, left, width, 18, c.muted ? 0 : c.volume, 'rgba(255,255,255,0.85)');
      if (wave) el.append(h('div', { class: 'clip-wavestrip' }, wave));
    }
    el.append(this.clipLabel(c, m, h('span', { class: 'cd' }, fmtTime(tlLen(c), { ms: false }))));
    this.decorate(el, c, width, sel);
    return el;
  }

  audioClipEl(c, track) {
    const m = store.media(c.mediaId) || {};
    const left = c.start * this.pps;
    const width = tlLen(c) * this.pps;
    const el = this.clipBase('audio', c, left, width, track.muted ? 'track-muted' : '');
    const peaks = peaksOf(c.mediaId, c.stream || 0);
    const gain = c.muted ? 0 : c.volume * (track.volume ?? 1);
    const col = 'rgba(210,255,240,0.9)';
    // Стерео — две полосы (левый и правый канал), моно — одна
    if (peaks && peaks.channels && peaks.channels.length === 2) {
      const hh = Math.floor((AUDIO_H - 8) / 2);
      const box = h('div', { class: 'wave-stereo' });
      peaks.channels.forEach((data, k) => {
        const cv = this.waveCanvas(c, { rate: peaks.rate, data }, left, width, hh, gain, col);
        if (cv) { cv.style.top = `${3 + k * (hh + 2)}px`; box.append(cv); }
      });
      el.append(box);
      el.classList.add('stereo');
    } else {
      const wave = this.waveCanvas(c, peaks, left, width, AUDIO_H - 6, gain, col);
      if (wave) el.append(wave);
    }
    const streams = streamCount(m);
    el.append(this.clipLabel(c, m, streams > 1 ? h('span', { class: 'ci stream', title: t('Звуковой поток файла') }, `#${(c.stream || 0) + 1}`) : null));
    this.decorate(el, c, width, el.classList.contains('selected'));
    return el;
  }

  // Волна звука: рисуем только видимую часть клипа
  waveCanvas(c, peaks, clipLeft, clipW, height, gain, color) {
    if (!peaks || !peaks.data || !peaks.data.length) return null;
    const [vx0, vx1] = this.visibleRange();
    const cx0 = Math.max(0, Math.floor(vx0 - clipLeft));
    const cx1 = Math.min(Math.ceil(clipW), Math.ceil(vx1 - clipLeft));
    if (cx1 <= cx0) return null;
    const w = cx1 - cx0;
    const dpr = window.devicePixelRatio || 1;
    const cv = h('canvas', { class: 'wave', style: { left: `${cx0}px`, width: `${w}px`, height: `${height}px` } });
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(height * dpr));
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = gain > 0 ? color : 'rgba(255,255,255,0.25)';
    const rate = peaks.rate; const data = peaks.data;
    const g = gain > 0 ? Math.min(1.6, Math.sqrt(gain)) : 0.6;
    const mid = height / 2;
    const dur = tlLen(c);
    const sp = speedOf(c);
    for (let x = 0; x < w; x += 2) {
      const lt = (cx0 + x) / this.pps;            // время от начала клипа (таймлайн)
      const t0 = c.in + lt * sp;                  // время файла
      const t1 = c.in + ((cx0 + x + 2) / this.pps) * sp;
      const i0 = Math.floor(t0 * rate); const i1 = Math.max(i0 + 1, Math.ceil(t1 * rate));
      let v = 0;
      for (let i = i0; i < i1 && i < data.length; i++) if (data[i] > v) v = data[i];
      // Затухания видны на волне
      let fg = 1;
      if (c.fadeIn > 0.001 && lt < c.fadeIn) fg = Math.min(fg, lt / c.fadeIn);
      if (c.fadeOut > 0.001 && lt > dur - c.fadeOut) fg = Math.min(fg, (dur - lt) / c.fadeOut);
      const hh = Math.max(0.5, Math.min(mid, v * mid * g * Math.max(0.08, fg)));
      ctx.fillRect(x, mid - hh, 1.4, hh * 2);
    }
    return cv;
  }

  updatePlayhead() {
    const x = HEAD_W + store.time * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    const vx = x - this.scroll.scrollLeft;
    this.playhead.style.visibility = vx < HEAD_W - 1 ? 'hidden' : 'visible';
    // Автопрокрутка при воспроизведении
    if (store.playing && !this.drag) {
      const right = this.scroll.scrollLeft + this.scroll.clientWidth;
      if (x > right - 30 || x < this.scroll.scrollLeft + HEAD_W) {
        this.scroll.scrollLeft = Math.max(0, x - HEAD_W - 40);
      }
    }
    const tt = $('#tb-time');
    if (tt) tt.textContent = `${fmtTime(store.time)} / ${fmtTime(store.duration())}`;
    $('#tb-split') && ($('#tb-split').disabled = !this.canSplit());
  }

  // ------------------------------------------------------------------------
  // Магнит
  // ------------------------------------------------------------------------
  // Точки притяжения: начало, курсор, края всех клипов (кроме перетаскиваемого)
  snapPoints(exclude, videoClips = store.allVideo()) {
    const skip = (id) => (exclude instanceof Set ? exclude.has(id) : id === exclude);
    const pts = [0, store.time];
    for (const c of videoClips) if (!skip(c.id)) pts.push(c.start, clipEnd(c));
    for (const t of store.project.audioTracks) {
      for (const c of t.clips) if (!skip(c.id)) pts.push(c.start, clipEnd(c));
    }
    return pts;
  }

  snap(t, pts, ev) {
    if (!this.magnet || (ev && ev.altKey)) return { t, snapped: false };
    const tol = SNAP_PX / this.pps;
    let best = t; let d = tol;
    for (const p of pts) { const dd = Math.abs(p - t); if (dd < d) { d = dd; best = p; } }
    return { t: best, snapped: best !== t };
  }

  showSnap(t) {
    if (t === null || t === undefined) { this.snapLine.style.display = 'none'; return; }
    this.snapLine.style.display = 'block';
    this.snapLine.style.left = `${HEAD_W + t * this.pps - 1}px`;
  }

  // ------------------------------------------------------------------------
  // Мышь
  // ------------------------------------------------------------------------
  onDblClick(e) {
    const cueEl = e.target.closest('.cue');
    if (cueEl) { store.select({ kind: 'cue', id: cueEl.dataset.id }); store.emit('focus-inspector', 'cue'); return; }
    const subLane = e.target.closest('.sub-lane');
    if (subLane) {
      const tr = store.subtitleTrack(subLane.dataset.strack);
      if (tr && !tr.locked) { const id = store.addCue(tr.id, { start: this.xToTime(e.clientX), text: t('Новая реплика') }); store.select({ kind: 'cue', id }); store.emit('focus-inspector', 'cue'); }
      return;
    }
    const clipEl = e.target.closest('.clip');
    if (!clipEl) return;
    // Анимация из пресета — открыть её в редакторе «Анимации»
    const f = store.findClip(clipEl.dataset.id);
    if (f && isText(f.clip)) { store.emit('focus-inspector', 'text'); return; }
    const m = f && store.media(f.clip.mediaId);
    if (m && m.anim) { store.emit('anim-edit', f.clip.id); return; }
    store.setTime(this.xToTime(e.clientX));
  }

  onContextMenu(e) {
    e.preventDefault();
    if (e.target.closest('.tl-head') || e.target.closest('.ruler-lane')) return;
    const t = this.xToTime(e.clientX);
    const clipEl = e.target.closest('.clip');
    if (clipEl) {
      const id = clipEl.dataset.id;
      if (!store.selection || store.selection.id !== id) store.select({ kind: clipEl.dataset.kind, id });
      openClipMenu(id, e.clientX, e.clientY, t);
      return;
    }
    const laneEl = e.target.closest('[data-lane]');
    if (!laneEl) return;
    const lane = laneEl.dataset.lane === 'video' || laneEl.dataset.lane === 'vtrack' ? laneEl.dataset.vlane || 'video' : laneEl.dataset.lane === 'audio' ? laneEl.dataset.track : null;
    if (lane) openLaneMenu(lane, e.clientX, e.clientY, t);
  }

  onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('.tl-head')) return;
    const clipEl = e.target.closest('.clip');
    const handle = e.target.closest('.handle');
    const knob = e.target.closest('.fade-knob');
    e.preventDefault();

    // Лезвие: щелчок по клипу разрезает его в этом месте (вместе со связанными; Alt — только его), курсор не двигается
    // Shift+щелчок лезвием — все дорожки без замка в этой точке
    if (this.tool === 'blade' && !e.target.closest('.ruler-lane')) {
      if (e.shiftKey && e.target.closest('.tl-lane')) {
        if (!store.splitAll(this.bladeTime(e))) toast(t('Здесь нечего разрезать'), 'info', 1500);
        return;
      }
      if (clipEl) {
        const bt = this.bladeTime(e);
        const f0 = store.findClip(clipEl.dataset.id);
        if (f0 && ((f0.lane && f0.lane.locked) || (f0.track && f0.track.locked))) { toast(t('Дорожка «{name}» закрыта замком', { name: store.trackName(f0.lane ? f0.lane.id : f0.track.id) }), 'info', 1600); return; }
        const n = store.splitAt(bt, clipEl.dataset.id, { withLinked: !e.altKey });
        if (!n) toast(t('Слишком близко к краю клипа'), 'info', 1500);
      }
      return;
    }

    // Обрезка (0.4.3): ripple / roll / slip / slide; мимо клипа — перемотка
    if (this.tool === 'trim' && clipEl) {
      const o = this.trimOpAt(e);
      if (o) { this.startTrimDrag(e, o); return; }
    }

    if (!clipEl) {
      // Клик по пустому месту / линейке: перемотка
      if (!e.target.closest('.ruler-lane') && !e.target.closest('.tl-playhead')) store.select(null);
      this.startScrub(e);
      return;
    }

    const id = clipEl.dataset.id;
    const kind = clipEl.dataset.kind;
    const f = store.findClip(id);
    if (!f) return;
    if (!store.selection || store.selection.id !== id || store.selection.kind === 'transition') store.select({ kind, id });
    if (store.busy[id]) return; // клип обрабатывается — не двигаем

    const before = store.snapshot();
    const orig = clone(f.clip);
    const origVideo = clone(store.allVideo());
    const origMain = clone(store.project.videoClips);
    const origVT = store.project.videoTracks ? clone(store.project.videoTracks) : null;
    const origTracks = clone(store.project.audioTracks);
    const x0 = e.clientX; const y0 = e.clientY;
    const txt = isText(orig);
    // У текста нет файла: длина — любая (обрезка слева двигает начало, fixup держит in = 0)
    const media = txt ? { duration: TEXT_MAX } : store.media(f.clip.mediaId) || { duration: orig.out };
    // Связанные клипы (видео и его звук) двигаются и обрезаются вместе
    const partners = store.linkedOf(id).map((x) => ({ id: x.clip.id, kind: x.kind, o: clone(x.clip) }));
    const groupIds = new Set([id, ...partners.map((x) => x.id)]);
    const vOrig = kind === 'video' ? orig : (partners.find((x) => x.kind === 'video') || {}).o || null;
    // Видеодорожка с замком: клип (и связанный с ним звук) только выделяется
    const vFound = vOrig && store.findClip(vOrig.id);
    const fromLane = vFound && vFound.lane ? vFound.lane.id : null;
    // Аудиодорожка с замком (0.4.3): клип только выделяется
    if (f.kind === 'audio' && f.track.locked) {
      if (!knob && !handle) store.setTime(this.xToTime(e.clientX));
      toast(t('Дорожка «{name}» закрыта замком', { name: store.trackName(f.track.id) }), 'info', 1600);
      return;
    }
    if (vFound && vFound.lane && vFound.lane.locked) {
      if (!knob && !handle) store.setTime(this.xToTime(e.clientX));
      toast(t('Дорожка «{name}» закрыта замком', { name: store.trackName(fromLane) }), 'info', 1600);
      return;
    }
    const pts = this.snapPoints(groupIds, origVideo);
    let moved = false;
    const mode = knob ? (knob.classList.contains('in') ? 'fade-in' : 'fade-out')
      : handle ? (handle.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move';
    this.drag = { mode: mode.startsWith('fade') ? 'fade' : mode, id };
    document.body.classList.add(mode === 'move' ? 'is-moving' : 'is-trimming');

    // Соседи видеоклипа группы на его дорожке (для ограничений обрезки)
    const sorted = (vFound ? clone(vFound.lane.clips) : []).sort((a, b) => a.start - b.start);
    const vi = vOrig ? sorted.findIndex((c) => c.id === vOrig.id) : -1;
    const prevEnd = vi > 0 ? clipEnd(sorted[vi - 1]) : 0;
    const nextStart = vi >= 0 && vi < sorted.length - 1 ? sorted[vi + 1].start : Infinity;
    const mediaDur = (c) => { if (isText(c)) return TEXT_MAX; const m = store.media(c.mediaId); return m ? m.duration : c.out; };
    // Обрезка партнёров на тот же сдвиг (Alt — только этот клип)
    const trimPartners = (ev, side, d) => {
      if (ev.altKey) return;
      for (const pt of partners) {
        const f2 = store.findClip(pt.id);
        if (!f2) continue;
        const c = f2.clip; const o = pt.o;
        if (side === 'l') {
          c.in = clamp(o.in + d, 0, o.out - MIN_CLIP * speedOf(o));
          if (pt.kind === 'video') c.start = o.start + (c.in - o.in) / speedOf(o);
        } else {
          c.out = clamp(o.out + d, o.in + MIN_CLIP * speedOf(o), mediaDur(c));
        }
      }
    };

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(ev.clientY - y0) < DRAG_THRESHOLD) return;
      moved = true;
      const dt = dx / this.pps;
      let snapAt = null;
      const len = tlLen(orig);
      const sp = speedOf(orig);  // экранные секунды × sp = секунды файла

      if (mode === 'fade-in' || mode === 'fade-out') {
        const v = clamp((mode === 'fade-in' ? orig.fadeIn : orig.fadeOut) + (mode === 'fade-in' ? dt : -dt), 0, len);
        store.live(() => { const c = store.findClip(id).clip; if (mode === 'fade-in') c.fadeIn = v; else c.fadeOut = v; });
      } else if (mode === 'trim-l') {
        const inLo = txt ? orig.in - orig.start : 0;
        let nin = clamp(orig.in + dt * sp, inLo, orig.out - MIN_CLIP * sp);
        let nstart = orig.start + (nin - orig.in) / sp;
        const sn = this.snap(nstart, pts, ev);
        if (sn.snapped) { nin += (sn.t - nstart) * sp; nstart = sn.t; snapAt = sn.t; }
        // Не залезаем на предыдущий клип / за ноль / за начало файла (и то же для связанного видео)
        const useV = vOrig && (kind === 'video' || !ev.altKey);
        const lo = Math.max(0, txt ? 0 : orig.start - orig.in / sp, useV ? orig.start + (prevEnd - vOrig.start) : 0, useV && !txt ? orig.start - vOrig.in / sp : 0);
        if (nstart < lo) { nin += (lo - nstart) * sp; nstart = lo; }
        nin = clamp(nin, inLo, orig.out - MIN_CLIP * sp); nstart = orig.start + (nin - orig.in) / sp;
        store.live(() => { const c = store.findClip(id).clip; c.in = nin; c.start = nstart; trimPartners(ev, 'l', nin - orig.in); });
        if (kind === 'video') store.setTime(nstart);
      } else if (mode === 'trim-r') {
        let nout = clamp(orig.out + dt * sp, orig.in + MIN_CLIP * sp, media.duration);
        const sn = this.snap(orig.start + (nout - orig.in) / sp, pts, ev);
        if (sn.snapped) { nout = clamp(orig.in + (sn.t - orig.start) * sp, orig.in + MIN_CLIP * sp, media.duration); snapAt = sn.t; }
        const useV = vOrig && (kind === 'video' || !ev.altKey);
        if (useV) nout = Math.min(nout, orig.out + (nextStart - clipEnd(vOrig)) * sp, orig.out + (mediaDur(vOrig) - vOrig.out));
        nout = Math.max(nout, orig.in + MIN_CLIP * sp);
        store.live(() => { store.findClip(id).clip.out = nout; trimPartners(ev, 'r', nout - orig.out); });
        if (kind === 'video') store.setTime(Math.max(orig.start, orig.start + (nout - orig.in) / sp - 0.001));
      } else if (kind === 'video' || vOrig) {
        // Перемещение видео (или звука, связанного с видео, — тогда едет видео, а звук за ним).
        // Каждый раз от исходного состояния: раздвинутые/затёртые соседи возвращаются на место.
        // Без Alt — наложение: клип затирает то, что под ним; с Alt — как раньше (в пустоту или раздвинуть).
        let nstart = Math.max(0, orig.start + dt);
        const s1 = this.snap(nstart, pts, ev); const s2 = this.snap(nstart + len, pts, ev);
        if (s1.snapped && (!s2.snapped || Math.abs(s1.t - nstart) <= Math.abs(s2.t - nstart - len))) { nstart = s1.t; snapAt = s1.t; } else if (s2.snapped) { nstart = s2.t - len; snapAt = s2.t; }
        const vstart = Math.max(0, vOrig.start + (nstart - orig.start));
        const target = kind === 'audio' ? this.trackAt(ev.clientY) : null;
        // Видеоклип можно перенести на другую видеодорожку (кроме закрытых замком)
        let vTarget = kind === 'video' ? this.vlaneAt(ev.clientY) : null;
        if (vTarget && (store.vlane(vTarget) || {}).locked) vTarget = null;
        this.highlightVLane(vTarget && vTarget !== fromLane ? vTarget : null);
        store.live((p) => {
          p.videoClips = clone(origMain);
          if (origVT) p.videoTracks = clone(origVT); else delete p.videoTracks;
          p.audioTracks = clone(origTracks);
          if (kind === 'audio' && target && target !== 'new') {
            const from = p.audioTracks.find((t) => t.clips.some((x) => x.id === id));
            const to = p.audioTracks.find((t) => t.id === target);
            if (from && to && from !== to) { const c = from.clips.find((x) => x.id === id); from.clips = from.clips.filter((x) => x !== c); to.clips.push(c); }
          }
          const v = store.allVideo().find((x) => x.id === vOrig.id);
          if (vTarget && vTarget !== fromLane) moveToLane(p, v, vTarget);
          if (ev.altKey) placeVideo(p, v, vstart, 'auto');
          else overwriteVideo(p, v, vstart);
        });
        this.dropTarget = null;
      } else {
        let nstart = Math.max(0, orig.start + dt);
        const s1 = this.snap(nstart, pts, ev); const s2 = this.snap(nstart + len, pts, ev);
        if (s1.snapped) { nstart = s1.t; snapAt = s1.t; } else if (s2.snapped) { nstart = s2.t - len; snapAt = s2.t; }
        nstart = Math.max(0, nstart);
        const target = this.trackAt(ev.clientY);
        this.highlightNewTrack(target === 'new');
        store.live((p) => {
          p.videoClips = clone(origMain);
          if (origVT) p.videoTracks = clone(origVT); else delete p.videoTracks;
          p.audioTracks = clone(origTracks);
          let tr = p.audioTracks.find((t) => t.clips.some((x) => x.id === id));
          const c = tr.clips.find((x) => x.id === id);
          c.start = nstart;
          if (target && target !== 'new' && target !== tr.id) {
            tr.clips = tr.clips.filter((x) => x.id !== id);
            tr = p.audioTracks.find((t) => t.id === target);
            tr.clips.push(c);
          }
          if (!ev.altKey && target !== 'new') overwriteAudio(tr, c);
        });
        this.dropTarget = target;
      }
      this.showSnap(snapAt);
      this.autoScroll(ev.clientX);
    };

    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-moving', 'is-trimming');
      this.drag = null;
      this.showSnap(null);
      this.highlightNewTrack(false);
      this.highlightVLane(null);
      if (!moved) {
        // Простой клик по клипу — переместить курсор
        store.setTime(this.xToTime(ev.clientX));
        this.render();
        return;
      }
      if (kind === 'audio' && mode === 'move' && this.dropTarget === 'new') {
        store.live(() => {
          const cur = store.findClip(id);
          cur.track.clips = cur.track.clips.filter((x) => x.id !== id);
          store.project.audioTracks.push(newTrack({ clips: [cur.clip] }));
        });
      }
      this.dropTarget = null;
      store.commitFrom(before);
      this.render();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  startScrub(e) {
    const go = (ev) => store.setTime(this.xToTime(ev.clientX));
    go(e);
    this.drag = { mode: 'scrub' };
    const onMove = (ev) => { go(ev); this.autoScroll(ev.clientX); };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.drag = null;
      this.render();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  autoScroll(clientX) {
    const r = this.scroll.getBoundingClientRect();
    if (clientX > r.right - 40) this.scroll.scrollLeft += 18;
    else if (clientX < r.left + HEAD_W + 30) this.scroll.scrollLeft -= 18;
  }

  trackAt(clientY) {
    for (const row of this.content.querySelectorAll('.tl-row.audio, .tl-row.newtrack')) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return row.classList.contains('newtrack') ? 'new' : row.dataset.track;
    }
    return null;
  }

  highlightNewTrack(on) {
    const row = this.content.querySelector('.tl-row.newtrack');
    if (row) row.classList.toggle('drop-hot', on);
  }

  // Видеодорожка под курсором (id) или null
  vlaneAt(clientY) {
    for (const row of this.content.querySelectorAll('.tl-row.video, .tl-row.vtrack')) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return row.dataset.vlane;
    }
    return null;
  }
  highlightVLane(id) {
    for (const row of this.content.querySelectorAll('.tl-row.video, .tl-row.vtrack')) row.classList.toggle('drop-hot', !!id && row.dataset.vlane === id);
  }

  showMarker(x, lane = 'video') {
    const row = this.content.querySelector(lane === 'video' ? '.tl-row.video' : `.tl-row.vtrack[data-vlane="${lane}"], .tl-row.audio[data-track="${lane}"]`)
      || this.content.querySelector('.tl-row.video');
    this.marker.style.display = 'block';
    this.marker.style.left = `${HEAD_W + x - 1}px`;
    this.marker.style.top = `${row.offsetTop}px`;
    this.marker.style.height = `${row.offsetHeight}px`;
  }
  hideMarker() { this.marker.style.display = 'none'; }

  // Время вставки на видеодорожке: под курсором мыши, с магнитом к краям клипов
  dropTime(clientX) {
    const t = this.xToTime(clientX);
    return this.snap(t, this.snapPoints(null)).t;
  }

  // ------------------------------------------------------------------------
  // Перетаскивание из медиатеки и из Проводника
  // ------------------------------------------------------------------------
  // Перетаскивание сделано без HTML5 drag&drop (в Tauri его заменяет перетаскивание файлов из Проводника):
  // медиатека и окно вызывают dragHover / dragLeave / dropAt с координатами курсора.
  dropTargetAt(x, y) {
    const r = this.scroll.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const el = document.elementFromPoint(x, y);
    const lane = el && el.closest('[data-lane]');
    if (!lane) return { kind: 'none' };
    if (lane.dataset.lane === 'audio') return { kind: 'audio', track: lane.dataset.track };
    // Верхняя видеодорожка — тот же «video», но со своим id
    if (lane.dataset.lane === 'vtrack') return { kind: 'video', vlane: lane.dataset.vlane };
    return { kind: lane.dataset.lane };
  }

  // true — курсор над таймлайном
  dragHover(x, y, mediaId = null) {
    const tg = this.dropTargetAt(x, y);
    if (!tg) { this.dragLeave(); return false; }
    const m = mediaId ? store.media(mediaId) : null;
    this.highlightNewTrack(tg.kind === 'newtrack');
    const wantsVideo = tg.kind === 'video' && (!m || m.hasVideo);
    if (wantsVideo) this.showMarker(this.dropTime(x) * this.pps, tg.vlane || 'video');
    else if (tg.kind === 'audio') this.showMarker(this.xToTime(x) * this.pps, tg.track);
    else this.hideMarker();
    return true;
  }

  dragLeave() { this.hideMarker(); this.highlightNewTrack(false); }

  // ids — медиа из медиатеки или paths — файлы из Проводника. false — точка вне таймлайна.
  async dropAt(x, y, { ids = [], paths = [], alt = false } = {}) {
    const tg0 = this.dropTargetAt(x, y);
    this.dragLeave();
    if (!tg0) return false;
    const tg = tg0.kind === 'none' ? { kind: 'video' } : tg0;
    const t = this.xToTime(x);
    let vt = this.dropTime(x);
    if (paths.length) ids = await importPaths(paths);
    this.placeDropped(ids, tg, t, vt, alt);
    return true;
  }

  initDrop() {}

  // Без Alt — наложение (затирает то, что под клипом), с Alt — в пустоту рядом или раздвинуть соседей
  placeDropped(ids, tg, atTime, vt, alt = false) {
      let at = atTime;
      for (const id of ids) {
        const m = store.media(id);
        if (!m) continue;
        if (tg.kind === 'video' && m.hasVideo) {
          const lane = store.vlane(tg.vlane || MAIN_LANE);
          if (lane && lane.locked) { toast(t('Дорожка «{name}» закрыта замком', { name: store.trackName(lane.id) }), 'info', 1600); return; }
          const c = store.insertVideoClip(id, vt, alt ? 'auto' : 'overwrite', {}, { lane: lane ? lane.id : MAIN_LANE });
          if (c) vt = clipEnd(store.findClip(c.id).clip);
        } else if (m.hasAudio) {
          const track = tg.kind === 'audio' ? tg.track : tg.kind === 'newtrack' ? 'new' : null;
          const c = store.addAudioClip(id, tg.kind === 'video' ? store.time : at, track, { overwrite: !alt && tg.kind === 'audio' });
          if (c) at = clipEnd(c);
        } else {
          toast(t('{name}: в файле нет звука — на аудиодорожку не добавить', { name: m.name }), 'error');
        }
      }
  }

  // Добавление по кнопке «+» в медиатеке
  addMedia(mediaId) {
    const m = store.media(mediaId);
    if (!m) return;
    if (m.hasVideo) {
      store.insertVideoClip(mediaId);
      const end = store.videoEnd();
      if (!this.autoFit && end * this.pps > this.scroll.scrollLeft + this.viewW()) this.scroll.scrollLeft = end * this.pps - this.viewW() + 60;
    } else {
      store.addAudioClip(mediaId, store.time >= store.duration() - 0.01 && store.duration() > 0 ? 0 : store.time);
    }
  }
}
