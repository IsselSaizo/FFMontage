// Таймлайн: основная видеодорожка (клипы по времени, с пустотами и переходами) + аудиодорожки.
// Клипы «магнитятся» к краям соседей, курсору и началу; пустоты убираются кнопкой-корзиной,
// на стыке клипов, стоящих впритык, — кнопка «+» для перехода.
import { store, MIN_CLIP, ADJ, placeVideo, overwriteVideo, overwriteAudio, newTrack } from './store.js';
import { h, $, clamp, icon, fmtTime, rafThrottle, toast } from './util.js';
import { importPaths, peaksOf, streamCount } from './media.js';
import { openClipMenu, openLaneMenu, splitClip } from './actions.js';
import { isReversed, isFreeze } from './fx.js';
import { transitionById } from './transitions.js';

const HEAD_W = 168;
const VIDEO_H = 76;
const AUDIO_H = 56;
const SNAP_PX = 12;
const DRAG_THRESHOLD = 4;
const MIN_PPS = 0.2;
const MAX_PPS = 800;

const clipEnd = (c) => c.start + c.out - c.in;
const clone = (x) => JSON.parse(JSON.stringify(x));

export class Timeline {
  constructor(root) {
    this.root = root;
    this.pps = 40;          // пикселей на секунду
    this.autoFit = true;    // подгонять масштаб, пока пользователь сам не изменит
    this.drag = null;
    this.magnet = localStorage.getItem('ffm.magnet') !== '0';

    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.scroll = h('div', { class: 'tl-scroll' });
    this.content = h('div', { class: 'tl-content' });
    this.scroll.append(this.content);
    root.append(this.toolbar, this.scroll);
    this.buildToolbar();

    this.playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'ph-knob' }));
    this.marker = h('div', { class: 'tl-insert' });
    this.snapLine = h('div', { class: 'tl-snapline' });
    this.bladeLine = h('div', { class: 'tl-bladeline' });
    this.content.addEventListener('pointermove', (e) => this.onBladeHover(e));
    this.content.addEventListener('pointerleave', () => { this.bladeLine.style.display = 'none'; });

    const rerender = rafThrottle(() => this.render());
    store.on('project', () => { if (this.autoFit && !this.drag) this.fit(false); rerender(); });
    store.on('media', rerender);
    store.on('selection', rerender);
    store.on('busy', rerender);
    store.on('time', () => this.updatePlayhead());
    this.scroll.addEventListener('scroll', rafThrottle(() => this.render()));
    const onResize = rafThrottle(() => { if (this.autoFit) this.fit(false); this.render(); });
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
    const b = (name, title, fn, id) => {
      const el = h('button', { class: 'icon-btn', title, onclick: fn, id });
      el.innerHTML = icon(name, 19);
      return el;
    };
    this.zoomSlider = h('input', { type: 'range', min: '0', max: '1000', value: '500', class: 'zoom-slider', title: 'Масштаб (Ctrl + колесо мыши)' });
    this.zoomSlider.addEventListener('input', () => {
      const v = Number(this.zoomSlider.value) / 1000;
      this.setZoom(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v), null, true);
    });
    this.magnetBtn = b('magnet', '', () => this.toggleMagnet(), 'tb-magnet');
    this.toolbar.append(
      h('div', { class: 'tb-group' },
        b('undo', 'Отменить (Ctrl+Z)', () => store.undo(), 'tb-undo'),
        b('redo', 'Повторить (Ctrl+Y)', () => store.redo(), 'tb-redo')),
      h('div', { class: 'tb-sep' }),
      h('div', { class: 'tb-group' },
        this.pointerBtn = b('pointer', 'Выделение (A)', () => this.setTool('select'), 'tb-pointer'),
        this.bladeBtn = b('blade', 'Лезвие (B): щелчок по клипу разрезает его в этом месте вместе со связанным звуком; Alt+щелчок — только этот клип', () => this.setTool(this.tool === 'blade' ? 'select' : 'blade'), 'tb-blade'),
        h('div', { class: 'tb-sep small' }),
        b('split', 'Разрезать по курсору (S); всё под курсором — видео и звук (Alt+S)', (e) => (e.altKey ? this.splitAllAction() : this.splitAction()), 'tb-split'),
        b('trash', 'Удалить выделенное (Delete)', () => this.deleteAction(), 'tb-delete'),
        this.magnetBtn),
      h('div', { class: 'tb-time', id: 'tb-time' }),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group zoom' },
        b('minus', 'Уменьшить', () => this.setZoom(this.pps / 1.4, null, true)),
        this.zoomSlider,
        b('plus', 'Увеличить', () => this.setZoom(this.pps * 1.4, null, true)),
        b('fit', 'Весь проект (Ctrl+0)', () => { this.autoFit = true; this.fit(true); })),
    );
    this.updateMagnetBtn();
    this.setTool('select');
  }

  // Инструмент: 'select' — выделение и перетаскивание, 'blade' — лезвие (как в DaVinci Resolve)
  setTool(tool) {
    this.tool = tool;
    const blade = tool === 'blade';
    this.root.classList.toggle('blade-mode', blade);
    this.bladeBtn.classList.toggle('on', blade);
    this.pointerBtn.classList.toggle('on', !blade);
    if (!blade && this.bladeLine) this.bladeLine.style.display = 'none';
  }

  // Время лезвия под мышью: с магнитом к курсору воспроизведения
  bladeTime(ev) {
    const t = this.xToTime(ev.clientX);
    return this.snap(t, [store.time], ev).t;
  }

  onBladeHover(ev) {
    if (this.tool !== 'blade' || this.drag) return;
    const overLanes = ev.target.closest && ev.target.closest('.tl-lane') && !ev.target.closest('.ruler-lane');
    if (!overLanes) { this.bladeLine.style.display = 'none'; return; }
    this.bladeLine.style.display = 'block';
    this.bladeLine.style.transform = `translateX(${HEAD_W + this.bladeTime(ev) * this.pps}px)`;
  }

  splitAllAction() {
    if (!store.splitAll(store.time)) toast('Под курсором нет клипов, которые можно разрезать', 'info', 2200);
  }

  toggleMagnet() {
    this.magnet = !this.magnet;
    localStorage.setItem('ffm.magnet', this.magnet ? '1' : '0');
    this.updateMagnetBtn();
    toast(this.magnet ? 'Магнит включён: клипы липнут к краям соседей' : 'Магнит выключен', 'info', 1600);
  }

  updateMagnetBtn() {
    this.magnetBtn.classList.toggle('on', this.magnet);
    this.magnetBtn.title = this.magnet
      ? 'Магнит включён — клипы прилипают к соседям, курсору и началу (Alt при перетаскивании — без магнита и без наложения: клип не затирает соседей, а встаёт рядом)'
      : 'Магнит выключен — клипы ставятся куда угодно';
  }

  updateToolbar() {
    $('#tb-undo').disabled = !store.undoStack.length;
    $('#tb-redo').disabled = !store.redoStack.length;
    $('#tb-delete').disabled = !store.selection || store.selection.kind === 'transition';
    $('#tb-split').disabled = !this.canSplit();
    this.zoomSlider.value = String(Math.round(1000 * Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)));
  }

  canSplit() {
    const t = store.time;
    if (store.selection && store.selection.kind !== 'transition') {
      const f = store.findClip(store.selection.id);
      if (f) return t > f.clip.start + MIN_CLIP && t < clipEnd(f.clip) - MIN_CLIP;
    }
    return store.videoLayout().some((s) => t > s.start + MIN_CLIP / 2 && t < s.end - MIN_CLIP / 2);
  }

  splitAction() {
    const t = store.time;
    const sel = store.selection && store.selection.kind !== 'transition' ? store.findClip(store.selection.id) : null;
    if (sel && t > sel.clip.start && t < clipEnd(sel.clip)) { splitClip(sel.clip.id, t); return; }
    if (!store.splitAt(t)) toast('Поставьте курсор внутрь клипа, чтобы разрезать', 'info', 2200);
  }

  deleteAction(ripple = false) {
    const s = store.selection;
    if (!s) return;
    if (s.kind === 'transition') { store.setTransition(s.id, null); return; }
    store.deleteClip(s.id, { ripple });
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

    // Линейка
    const rulerLane = h('div', { class: 'tl-lane ruler-lane', style: { width: `${laneW}px` } });
    this.content.append(h('div', { class: 'tl-row ruler' }, h('div', { class: 'tl-head corner' }), rulerLane));
    this.drawRuler(rulerLane);

    // Видео
    const vLane = h('div', { class: 'tl-lane video-lane', dataset: { lane: 'video' }, style: { width: `${laneW}px`, height: `${VIDEO_H}px` } });
    const vHead = h('div', { class: 'tl-head' }, h('span', { class: 'th-ic', html: icon('film', 18) }), this.trackNameEl('video'));
    this.content.append(h('div', { class: 'tl-row video' }, vHead, vLane));
    const layout = store.videoLayout();
    if (!layout.length) vLane.append(h('div', { class: 'lane-hint' }, 'Перетащите сюда видео из «Ваши медиа»'));
    if (!this.drag) for (const g of store.gaps('video')) vLane.append(this.gapEl(g, 'video'));
    for (const seg of layout) vLane.append(this.videoClipEl(seg));
    if (!this.drag || this.drag.mode === 'fade') this.renderJunctions(vLane, layout);

    // Аудио
    const solo = store.anySolo();
    store.project.audioTracks.forEach((t, i) => {
      const silent = t.muted || (solo && !t.solo);
      const lane = h('div', { class: `tl-lane audio-lane${silent ? ' muted' : ''}`, dataset: { lane: 'audio', track: t.id }, style: { width: `${laneW}px`, height: `${AUDIO_H}px` } });
      const muteBtn = h('button', { class: `icon-btn tiny th-mute${t.muted ? ' on' : ''}`, title: t.muted ? 'Включить звук дорожки' : 'Выключить звук дорожки', onclick: () => store.toggleTrackMute(t.id) });
      muteBtn.innerHTML = icon(t.muted ? 'mute' : 'speaker', 15);
      const soloBtn = h('button', {
        class: `th-solo${t.solo ? ' on' : ''}`, title: t.solo ? 'Снять «соло»' : 'Соло: слушать только эту дорожку (только в предпросмотре, на экспорт не влияет)',
        onclick: () => store.toggleTrackSolo(t.id),
      }, 'S');
      const delBtn = h('button', { class: 'icon-btn tiny', title: 'Удалить дорожку', onclick: () => store.removeAudioTrack(t.id) });
      delBtn.innerHTML = icon('close', 13);
      const head = h('div', { class: 'tl-head audio-head' },
        h('div', { class: 'th-row' },
          h('span', { class: 'th-ic', html: icon('music', 15) }), this.trackNameEl(t.id),
          h('span', { class: 'th-actions' }, soloBtn, muteBtn, store.project.audioTracks.length > 1 || t.clips.length ? delBtn : null)),
        this.trackVolumeEl(t));
      this.content.append(h('div', { class: 'tl-row audio', dataset: { track: t.id } }, head, lane));
      if (!t.clips.length && i === 0) lane.append(h('div', { class: 'lane-hint' }, 'Музыка и звук'));
      // На аудиодорожках показываем только пустоты между клипами (музыка может начинаться не с нуля)
      if (!this.drag) for (const g of store.gaps(t.id)) if (g[0] > ADJ) lane.append(this.gapEl(g, t.id));
      for (const c of t.clips) lane.append(this.audioClipEl(c, t));
    });

    // Строка для новой дорожки
    const addBtn = h('button', { class: 'btn ghost tiny', onclick: () => store.addAudioTrack() }, '+ Дорожка');
    this.content.append(h('div', { class: 'tl-row newtrack', dataset: { lane: 'newtrack' } },
      h('div', { class: 'tl-head' }, addBtn),
      h('div', { class: 'tl-lane newtrack-lane', dataset: { lane: 'newtrack' }, style: { width: `${laneW}px` } },
        h('span', { class: 'lane-hint left' }, 'Перетащите аудио сюда, чтобы создать новую дорожку'))));

    this.content.append(this.playhead, this.marker, this.snapLine, this.bladeLine);
    this.updatePlayhead();
    this.updateToolbar();
  }

  // Имя дорожки: двойной щелчок — переименовать
  trackNameEl(trackId) {
    const name = store.trackName(trackId);
    const el = h('span', { class: 'th-name', title: `${name} — двойной щелчок, чтобы переименовать` }, name);
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
  trackVolumeEl(t) {
    const pct = () => Math.round((t.volume ?? 1) * 100);
    const val = h('span', { class: 'th-volval' }, `${pct()}%`);
    const r = h('input', { type: 'range', min: '0', max: '200', step: '1', value: String(pct()), class: 'th-vol', title: 'Громкость дорожки (двойной щелчок — 100%)' });
    let before = null;
    r.addEventListener('pointerdown', (e) => { e.stopPropagation(); before = store.snapshot(); });
    r.addEventListener('input', () => {
      if (!before) before = store.snapshot();
      const v = Number(r.value) / 100;
      store.live((p) => { const x = p.audioTracks.find((y) => y.id === t.id); if (x) x.volume = v; });
      val.textContent = `${r.value}%`;
    });
    r.addEventListener('change', () => { store.commitFrom(before); before = null; });
    r.addEventListener('dblclick', () => store.setTrack(t.id, { volume: 1 }));
    return h('div', { class: 'th-row vol' }, r, val);
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
        class: 'gap-del', title: `Удалить пустоту (${fmtTime(g1 - g0)}) — клипы правее сдвинутся влево`,
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
        title: tr ? `Переход: ${transitionById(tr.type).name}, ${String(tr.duration).replace('.', ',')} с — нажмите, чтобы изменить` : 'Добавить переход',
        style: { left: `${x}px` },
        onclick: (e) => { e.stopPropagation(); store.select({ kind: 'transition', id: b.clip.id }); store.emit('focus-inspector', 'transition'); },
      });
      btn.innerHTML = icon(tr ? 'transition' : 'plus', tr ? 15 : 16);
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
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
      title: `${store.clipName(c)}\n${fmtTime(c.out - c.in)} (из файла ${fmtTime(c.in)} – ${fmtTime(c.out)})\nПравая кнопка мыши — действия`,
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
        h('div', { class: 'fade-knob in', title: 'Потяните, чтобы сделать плавное появление', style: { left: `${Math.min(width - 10, c.fadeIn * this.pps)}px` } }),
        h('div', { class: 'fade-knob out', title: 'Потяните, чтобы сделать плавное исчезание', style: { right: `${Math.min(width - 10, c.fadeOut * this.pps)}px` } }));
    }
  }

  clipLabel(c, m, extra = null) {
    const label = h('div', { class: 'clip-label' });
    if (isReversed(c)) label.append(h('span', { class: 'ci fx', title: 'Задом наперёд', html: icon('reverse', 13) }));
    if (isFreeze(c)) label.append(h('span', { class: 'ci fx', title: 'Стоп-кадр', html: icon('freeze', 13) }));
    if (c.link && store.linkedOf(c.id).length) label.append(h('span', { class: 'ci link', title: 'Связан со звуком/видео: двигаются и режутся вместе (Alt — только этот клип)', html: icon('link', 13) }));
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
    const el = this.clipBase('video', c, left, width);
    const sel = el.classList.contains('selected');
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
        const t = c.in + (x + tileW / 2) / this.pps;
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
    el.append(this.clipLabel(c, m, h('span', { class: 'cd' }, fmtTime(c.out - c.in, { ms: false }))));
    this.decorate(el, c, width, sel);
    return el;
  }

  audioClipEl(c, track) {
    const m = store.media(c.mediaId) || {};
    const left = c.start * this.pps;
    const width = (c.out - c.in) * this.pps;
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
    el.append(this.clipLabel(c, m, streams > 1 ? h('span', { class: 'ci stream', title: 'Звуковой поток файла' }, `#${(c.stream || 0) + 1}`) : null));
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
    const dur = c.out - c.in;
    for (let x = 0; x < w; x += 2) {
      const lt = (cx0 + x) / this.pps;            // время от начала клипа
      const t0 = c.in + lt;
      const t1 = c.in + (cx0 + x + 2) / this.pps;
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
  snapPoints(exclude, videoClips = store.project.videoClips) {
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
    const clipEl = e.target.closest('.clip');
    if (clipEl) store.setTime(this.xToTime(e.clientX));
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
    const lane = laneEl.dataset.lane === 'video' ? 'video' : laneEl.dataset.lane === 'audio' ? laneEl.dataset.track : null;
    if (lane) openLaneMenu(lane, e.clientX, e.clientY, t);
  }

  onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('.tl-head')) return;
    const clipEl = e.target.closest('.clip');
    const handle = e.target.closest('.handle');
    const knob = e.target.closest('.fade-knob');
    e.preventDefault();

    // Лезвие: щелчок по клипу разрезает его в этом месте (вместе со связанными; Alt — только его), курсор не двигается
    if (this.tool === 'blade' && !e.target.closest('.ruler-lane')) {
      if (clipEl) {
        const t = this.bladeTime(e);
        const n = store.splitAt(t, clipEl.dataset.id, { withLinked: !e.altKey });
        if (!n) toast('Слишком близко к краю клипа', 'info', 1500);
      }
      return;
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
    const origVideo = clone(store.project.videoClips);
    const origTracks = clone(store.project.audioTracks);
    const x0 = e.clientX; const y0 = e.clientY;
    const media = store.media(f.clip.mediaId) || { duration: orig.out };
    // Связанные клипы (видео и его звук) двигаются и обрезаются вместе
    const partners = store.linkedOf(id).map((x) => ({ id: x.clip.id, kind: x.kind, o: clone(x.clip) }));
    const groupIds = new Set([id, ...partners.map((x) => x.id)]);
    const vOrig = kind === 'video' ? orig : (partners.find((x) => x.kind === 'video') || {}).o || null;
    const pts = this.snapPoints(groupIds, origVideo);
    let moved = false;
    const mode = knob ? (knob.classList.contains('in') ? 'fade-in' : 'fade-out')
      : handle ? (handle.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move';
    this.drag = { mode: mode.startsWith('fade') ? 'fade' : mode, id };
    document.body.classList.add(mode === 'move' ? 'is-moving' : 'is-trimming');

    // Соседи видеоклипа группы (для ограничений обрезки)
    const sorted = origVideo.slice().sort((a, b) => a.start - b.start);
    const vi = vOrig ? sorted.findIndex((c) => c.id === vOrig.id) : -1;
    const prevEnd = vi > 0 ? clipEnd(sorted[vi - 1]) : 0;
    const nextStart = vi >= 0 && vi < sorted.length - 1 ? sorted[vi + 1].start : Infinity;
    const mediaDur = (c) => { const m = store.media(c.mediaId); return m ? m.duration : c.out; };
    // Обрезка партнёров на тот же сдвиг (Alt — только этот клип)
    const trimPartners = (ev, side, d) => {
      if (ev.altKey) return;
      for (const pt of partners) {
        const f2 = store.findClip(pt.id);
        if (!f2) continue;
        const c = f2.clip; const o = pt.o;
        if (side === 'l') {
          c.in = clamp(o.in + d, 0, o.out - MIN_CLIP);
          if (pt.kind === 'video') c.start = o.start + (c.in - o.in);
        } else {
          c.out = clamp(o.out + d, o.in + MIN_CLIP, mediaDur(c));
        }
      }
    };

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(ev.clientY - y0) < DRAG_THRESHOLD) return;
      moved = true;
      const dt = dx / this.pps;
      let snapAt = null;
      const len = orig.out - orig.in;

      if (mode === 'fade-in' || mode === 'fade-out') {
        const v = clamp((mode === 'fade-in' ? orig.fadeIn : orig.fadeOut) + (mode === 'fade-in' ? dt : -dt), 0, len);
        store.live(() => { const c = store.findClip(id).clip; if (mode === 'fade-in') c.fadeIn = v; else c.fadeOut = v; });
      } else if (mode === 'trim-l') {
        let nin = clamp(orig.in + dt, 0, orig.out - MIN_CLIP);
        let nstart = orig.start + (nin - orig.in);
        const sn = this.snap(nstart, pts, ev);
        if (sn.snapped) { nin += sn.t - nstart; nstart = sn.t; snapAt = sn.t; }
        // Не залезаем на предыдущий клип / за ноль / за начало файла (и то же для связанного видео)
        const useV = vOrig && (kind === 'video' || !ev.altKey);
        const lo = Math.max(0, orig.start - orig.in, useV ? orig.start + (prevEnd - vOrig.start) : 0, useV ? orig.start - vOrig.in : 0);
        if (nstart < lo) { nin += lo - nstart; nstart = lo; }
        nin = clamp(nin, 0, orig.out - MIN_CLIP); nstart = orig.start + (nin - orig.in);
        store.live(() => { const c = store.findClip(id).clip; c.in = nin; c.start = nstart; trimPartners(ev, 'l', nin - orig.in); });
        if (kind === 'video') store.setTime(nstart);
      } else if (mode === 'trim-r') {
        let nout = clamp(orig.out + dt, orig.in + MIN_CLIP, media.duration);
        const sn = this.snap(orig.start + (nout - orig.in), pts, ev);
        if (sn.snapped) { nout = clamp(orig.in + (sn.t - orig.start), orig.in + MIN_CLIP, media.duration); snapAt = sn.t; }
        const useV = vOrig && (kind === 'video' || !ev.altKey);
        if (useV) nout = Math.min(nout, orig.out + (nextStart - clipEnd(vOrig)), orig.out + (mediaDur(vOrig) - vOrig.out));
        nout = Math.max(nout, orig.in + MIN_CLIP);
        store.live(() => { store.findClip(id).clip.out = nout; trimPartners(ev, 'r', nout - orig.out); });
        if (kind === 'video') store.setTime(Math.max(orig.start, orig.start + (nout - orig.in) - 0.001));
      } else if (kind === 'video' || vOrig) {
        // Перемещение видео (или звука, связанного с видео, — тогда едет видео, а звук за ним).
        // Каждый раз от исходного состояния: раздвинутые/затёртые соседи возвращаются на место.
        // Без Alt — наложение: клип затирает то, что под ним; с Alt — как раньше (в пустоту или раздвинуть).
        let nstart = Math.max(0, orig.start + dt);
        const s1 = this.snap(nstart, pts, ev); const s2 = this.snap(nstart + len, pts, ev);
        if (s1.snapped && (!s2.snapped || Math.abs(s1.t - nstart) <= Math.abs(s2.t - nstart - len))) { nstart = s1.t; snapAt = s1.t; } else if (s2.snapped) { nstart = s2.t - len; snapAt = s2.t; }
        const vstart = Math.max(0, vOrig.start + (nstart - orig.start));
        const target = kind === 'audio' ? this.trackAt(ev.clientY) : null;
        store.live((p) => {
          p.videoClips = clone(origVideo);
          p.audioTracks = clone(origTracks);
          if (kind === 'audio' && target && target !== 'new') {
            const from = p.audioTracks.find((t) => t.clips.some((x) => x.id === id));
            const to = p.audioTracks.find((t) => t.id === target);
            if (from && to && from !== to) { const c = from.clips.find((x) => x.id === id); from.clips = from.clips.filter((x) => x !== c); to.clips.push(c); }
          }
          const v = p.videoClips.find((x) => x.id === vOrig.id);
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
          p.videoClips = clone(origVideo);
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

  showMarker(x, lane = 'video') {
    const row = this.content.querySelector(lane === 'video' ? '.tl-row.video' : `.tl-row.audio[data-track="${lane}"]`)
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
    return lane.dataset.lane === 'audio' ? { kind: 'audio', track: lane.dataset.track } : { kind: lane.dataset.lane };
  }

  // true — курсор над таймлайном
  dragHover(x, y, mediaId = null) {
    const tg = this.dropTargetAt(x, y);
    if (!tg) { this.dragLeave(); return false; }
    const m = mediaId ? store.media(mediaId) : null;
    this.highlightNewTrack(tg.kind === 'newtrack');
    const wantsVideo = tg.kind === 'video' && (!m || m.hasVideo);
    if (wantsVideo) this.showMarker(this.dropTime(x) * this.pps, 'video');
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
  placeDropped(ids, tg, t, vt, alt = false) {
      let at = t;
      for (const id of ids) {
        const m = store.media(id);
        if (!m) continue;
        if (tg.kind === 'video' && m.hasVideo) {
          const c = store.insertVideoClip(id, vt, alt ? 'auto' : 'overwrite');
          if (c) vt = clipEnd(store.findClip(c.id).clip);
        } else if (m.hasAudio) {
          const track = tg.kind === 'audio' ? tg.track : tg.kind === 'newtrack' ? 'new' : null;
          const c = store.addAudioClip(id, tg.kind === 'video' ? store.time : at, track, { overwrite: !alt && tg.kind === 'audio' });
          if (c) at = clipEnd(c);
        } else {
          toast(`${m.name}: в файле нет звука — на аудиодорожку не добавить`, 'error');
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
