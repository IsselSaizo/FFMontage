// Таймлайн: основная видеодорожка (клипы встык) + аудиодорожки со свободным размещением.
import { store, MIN_CLIP } from './store.js';
import { h, $, clamp, icon, fmtTime, rafThrottle, toast } from './util.js';
import { importPaths } from './media.js';

const HEAD_W = 132;
const VIDEO_H = 76;
const AUDIO_H = 56;
const SNAP_PX = 9;
const DRAG_THRESHOLD = 4;
const MIN_PPS = 0.2;
const MAX_PPS = 800;

export class Timeline {
  constructor(root) {
    this.root = root;
    this.pps = 40;          // пикселей на секунду
    this.autoFit = true;    // подгонять масштаб, пока пользователь сам не изменит
    this.drag = null;

    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.scroll = h('div', { class: 'tl-scroll' });
    this.content = h('div', { class: 'tl-content' });
    this.scroll.append(this.content);
    root.append(this.toolbar, this.scroll);
    this.buildToolbar();

    this.playhead = h('div', { class: 'tl-playhead' }, h('div', { class: 'ph-knob' }));
    this.marker = h('div', { class: 'tl-insert' });
    this.ghost = null;

    const rerender = rafThrottle(() => this.render());
    store.on('project', () => { if (this.autoFit) this.fit(false); rerender(); });
    store.on('media', rerender);
    store.on('selection', rerender);
    store.on('time', () => this.updatePlayhead());
    this.scroll.addEventListener('scroll', rafThrottle(() => this.render()));
    const onResize = rafThrottle(() => { if (this.autoFit) this.fit(false); this.render(); });
    new ResizeObserver(() => onResize()).observe(this.scroll);

    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.content.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.content.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.content.addEventListener('contextmenu', (e) => e.preventDefault());
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
    this.toolbar.append(
      h('div', { class: 'tb-group' },
        b('undo', 'Отменить (Ctrl+Z)', () => store.undo(), 'tb-undo'),
        b('redo', 'Повторить (Ctrl+Y)', () => store.redo(), 'tb-redo')),
      h('div', { class: 'tb-sep' }),
      h('div', { class: 'tb-group' },
        b('split', 'Разрезать по курсору (S)', () => this.splitAction(), 'tb-split'),
        b('trash', 'Удалить выделенное (Delete)', () => this.deleteAction(), 'tb-delete')),
      h('div', { class: 'tb-time', id: 'tb-time' }),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group zoom' },
        b('minus', 'Уменьшить', () => this.setZoom(this.pps / 1.4, null, true)),
        this.zoomSlider,
        b('plus', 'Увеличить', () => this.setZoom(this.pps * 1.4, null, true)),
        b('fit', 'Весь проект (Ctrl+0)', () => { this.autoFit = true; this.fit(true); })),
    );
  }

  updateToolbar() {
    $('#tb-undo').disabled = !store.undoStack.length;
    $('#tb-redo').disabled = !store.redoStack.length;
    $('#tb-delete').disabled = !store.selection;
    $('#tb-split').disabled = !this.canSplit();
    this.zoomSlider.value = String(Math.round(1000 * Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)));
  }

  canSplit() {
    const t = store.time;
    if (store.selection) {
      const f = store.findClip(store.selection.id);
      if (f && f.kind === 'audio') return t > f.clip.start + MIN_CLIP && t < f.clip.start + f.clip.out - f.clip.in - MIN_CLIP;
    }
    return store.videoLayout().some((s) => t > s.start + MIN_CLIP / 2 && t < s.end - MIN_CLIP / 2);
  }

  splitAction() {
    const t = store.time;
    let id = null;
    if (store.selection) {
      const f = store.findClip(store.selection.id);
      if (f && f.kind === 'audio' && t > f.clip.start && t < f.clip.start + f.clip.out - f.clip.in) id = f.clip.id;
      if (f && f.kind === 'video') {
        const seg = store.videoLayout().find((s) => s.clip.id === f.clip.id);
        if (seg && t > seg.start && t < seg.end) id = f.clip.id;
      }
    }
    if (!store.splitAt(t, id)) toast('Поставьте курсор внутрь клипа, чтобы разрезать', 'info', 2200);
  }

  deleteAction() {
    if (store.selection) store.deleteClip(store.selection.id);
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

  // координата X внутри дорожки (с) по клиентскому X
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
    const vHead = h('div', { class: 'tl-head' }, h('span', { class: 'th-ic', html: icon('film', 18) }), h('span', { class: 'th-name' }, 'Видео'));
    this.content.append(h('div', { class: 'tl-row video' }, vHead, vLane));
    const layout = store.videoLayout();
    if (!layout.length) vLane.append(h('div', { class: 'lane-hint' }, 'Перетащите сюда видео из «Ваши медиа»'));
    for (const seg of layout) vLane.append(this.videoClipEl(seg));

    // Аудио
    store.project.audioTracks.forEach((t, i) => {
      const lane = h('div', { class: `tl-lane audio-lane${t.muted ? ' muted' : ''}`, dataset: { lane: 'audio', track: t.id }, style: { width: `${laneW}px`, height: `${AUDIO_H}px` } });
      const muteBtn = h('button', { class: `icon-btn tiny${t.muted ? ' on' : ''}`, title: t.muted ? 'Включить звук дорожки' : 'Выключить звук дорожки', onclick: () => store.toggleTrackMute(t.id) });
      muteBtn.innerHTML = icon(t.muted ? 'mute' : 'speaker', 16);
      const delBtn = h('button', { class: 'icon-btn tiny', title: 'Удалить дорожку', onclick: () => store.removeAudioTrack(t.id) });
      delBtn.innerHTML = icon('close', 14);
      const head = h('div', { class: 'tl-head' },
        h('span', { class: 'th-ic', html: icon('music', 17) }), h('span', { class: 'th-name' }, `Аудио ${i + 1}`),
        h('span', { class: 'th-actions' }, muteBtn, store.project.audioTracks.length > 1 || t.clips.length ? delBtn : null));
      this.content.append(h('div', { class: 'tl-row audio', dataset: { track: t.id } }, head, lane));
      if (!t.clips.length && i === 0) lane.append(h('div', { class: 'lane-hint' }, 'Музыка и звук'));
      for (const c of t.clips) lane.append(this.audioClipEl(c, t));
    });

    // Строка для новой дорожки
    const addBtn = h('button', { class: 'btn ghost tiny', onclick: () => store.addAudioTrack() }, '+ Дорожка');
    this.content.append(h('div', { class: 'tl-row newtrack', dataset: { lane: 'newtrack' } },
      h('div', { class: 'tl-head' }, addBtn),
      h('div', { class: 'tl-lane newtrack-lane', dataset: { lane: 'newtrack' }, style: { width: `${laneW}px` } },
        h('span', { class: 'lane-hint left' }, 'Перетащите аудио сюда, чтобы создать новую дорожку'))));

    this.content.append(this.playhead, this.marker);
    if (this.ghost) this.content.append(this.ghost);
    this.updatePlayhead();
    this.updateToolbar();
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

  clipBase(kind, c, left, width, extraClass = '') {
    const sel = store.selection && store.selection.id === c.id;
    const m = store.media(c.mediaId);
    const rt = store.runtime[c.mediaId] || {};
    const el = h('div', {
      class: `clip ${kind}${sel ? ' selected' : ''}${c.muted ? ' clip-muted' : ''}${rt.missing ? ' missing' : ''} ${extraClass}`,
      dataset: { id: c.id, kind },
      style: { left: `${left}px`, width: `${Math.max(2, width)}px` },
      title: `${m ? m.name : '?'}\n${fmtTime(c.out - c.in)} (из файла ${fmtTime(c.in)} – ${fmtTime(c.out)})`,
    });
    return el;
  }

  videoClipEl(seg) {
    const c = seg.clip;
    const m = store.media(c.mediaId) || {};
    const rt = store.runtime[c.mediaId] || {};
    const left = seg.start * this.pps;
    const width = (seg.end - seg.start) * this.pps;
    const el = this.clipBase('video', c, left, width);
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

    // Полоска звука внизу клипа
    if (m.hasAudio && width > 8) {
      const wave = this.waveCanvas(c, rt.peaks, left, width, 18, c.muted ? 0 : c.volume, 'rgba(255,255,255,0.85)');
      if (wave) el.append(h('div', { class: 'clip-wavestrip' }, wave));
    }

    const label = h('div', { class: 'clip-label' });
    if (c.muted && m.hasAudio) label.append(h('span', { class: 'ci', html: icon('mute', 13) }));
    else if (m.hasAudio && Math.abs(c.volume - 1) > 0.01) label.append(h('span', { class: 'ci vol' }, `${Math.round(c.volume * 100)}%`));
    label.append(h('span', { class: 'cn' }, m.name || '?'));
    label.append(h('span', { class: 'cd' }, fmtTime(c.out - c.in, { ms: false })));
    el.append(label, h('div', { class: 'handle l' }), h('div', { class: 'handle r' }));
    return el;
  }

  audioClipEl(c, track) {
    const m = store.media(c.mediaId) || {};
    const rt = store.runtime[c.mediaId] || {};
    const left = c.start * this.pps;
    const width = (c.out - c.in) * this.pps;
    const el = this.clipBase('audio', c, left, width, track.muted ? 'track-muted' : '');
    const wave = this.waveCanvas(c, rt.peaks, left, width, AUDIO_H - 6, c.muted ? 0 : c.volume, 'rgba(210,255,240,0.9)');
    if (wave) el.append(wave);
    const label = h('div', { class: 'clip-label' });
    if (c.muted) label.append(h('span', { class: 'ci', html: icon('mute', 13) }));
    else if (Math.abs(c.volume - 1) > 0.01) label.append(h('span', { class: 'ci vol' }, `${Math.round(c.volume * 100)}%`));
    label.append(h('span', { class: 'cn' }, m.name || '?'));
    el.append(label, h('div', { class: 'handle l' }), h('div', { class: 'handle r' }));
    return el;
  }

  // Волна звука: рисуем только видимую часть клипа
  waveCanvas(c, peaks, clipLeft, clipW, height, gain, color) {
    if (!peaks || !peaks.data.length) return null;
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
    for (let x = 0; x < w; x += 2) {
      const t0 = c.in + (cx0 + x) / this.pps;
      const t1 = c.in + (cx0 + x + 2) / this.pps;
      const i0 = Math.floor(t0 * rate); const i1 = Math.max(i0 + 1, Math.ceil(t1 * rate));
      let v = 0;
      for (let i = i0; i < i1 && i < data.length; i++) if (data[i] > v) v = data[i];
      const hh = Math.max(0.5, Math.min(mid, v * mid * g));
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
  // Мышь
  // ------------------------------------------------------------------------
  snapPoints(excludeId) {
    const pts = [0, store.time];
    for (const s of store.videoLayout()) pts.push(s.start, s.end);
    for (const t of store.project.audioTracks) {
      for (const c of t.clips) if (c.id !== excludeId) pts.push(c.start, c.start + c.out - c.in);
    }
    return pts;
  }

  snap(t, pts) {
    const tol = SNAP_PX / this.pps;
    let best = t; let d = tol;
    for (const p of pts) { const dd = Math.abs(p - t); if (dd < d) { d = dd; best = p; } }
    return { t: best, snapped: best !== t };
  }

  onDblClick(e) {
    const clipEl = e.target.closest('.clip');
    if (clipEl) store.setTime(this.xToTime(e.clientX));
  }

  onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('.tl-head')) return;
    const clipEl = e.target.closest('.clip');
    const handle = e.target.closest('.handle');
    e.preventDefault();

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
    if (!store.selection || store.selection.id !== id) store.select({ kind, id });

    const before = store.snapshot();
    const orig = { ...f.clip };
    const x0 = e.clientX; const y0 = e.clientY;
    const seg = kind === 'video' ? store.videoLayout().find((s) => s.clip.id === id) : null;
    const media = store.media(f.clip.mediaId);
    const pts = this.snapPoints(id);
    let moved = false;
    let mode = handle ? (handle.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move';
    this.drag = { mode, id };
    document.body.classList.add(mode === 'move' ? 'is-moving' : 'is-trimming');

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(ev.clientY - y0) < DRAG_THRESHOLD) return;
      moved = true;
      const dt = dx / this.pps;
      if (kind === 'video') {
        if (mode === 'trim-l') {
          const nin = clamp(orig.in + dt, 0, orig.out - MIN_CLIP);
          store.live(() => { store.findClip(id).clip.in = nin; });
          store.setTime(seg.start);
        } else if (mode === 'trim-r') {
          let nout = clamp(orig.out + dt, orig.in + MIN_CLIP, media.duration);
          const sn = this.snap(seg.start + (nout - orig.in), pts.filter((p) => p !== seg.end));
          if (sn.snapped) nout = clamp(orig.in + (sn.t - seg.start), orig.in + MIN_CLIP, media.duration);
          store.live(() => { store.findClip(id).clip.out = nout; });
          store.setTime(Math.max(seg.start, seg.start + (nout - orig.in) - 0.001));
        } else {
          this.moveVideoGhost(ev, id, clipEl);
        }
      } else {
        if (mode === 'trim-l') {
          let nin = clamp(orig.in + dt, 0, orig.out - MIN_CLIP);
          let nstart = orig.start + (nin - orig.in);
          if (nstart < 0) { nin -= nstart; nstart = 0; }
          const sn = this.snap(nstart, pts);
          if (sn.snapped) { const d = sn.t - nstart; if (orig.in + (nstart + d - orig.start) >= 0 && nin + d <= orig.out - MIN_CLIP) { nin += d; nstart += d; } }
          store.live(() => { const c = store.findClip(id).clip; c.in = nin; c.start = nstart; });
        } else if (mode === 'trim-r') {
          let nout = clamp(orig.out + dt, orig.in + MIN_CLIP, media.duration);
          const sn = this.snap(orig.start + nout - orig.in, pts);
          if (sn.snapped) nout = clamp(sn.t - orig.start + orig.in, orig.in + MIN_CLIP, media.duration);
          store.live(() => { store.findClip(id).clip.out = nout; });
        } else {
          let nstart = Math.max(0, orig.start + dt);
          const d = orig.out - orig.in;
          const s1 = this.snap(nstart, pts); const s2 = this.snap(nstart + d, pts);
          if (s1.snapped) nstart = s1.t; else if (s2.snapped) nstart = s2.t - d;
          nstart = Math.max(0, nstart);
          const target = this.trackAt(ev.clientY);
          this.highlightNewTrack(target === 'new');
          store.live(() => {
            const cur = store.findClip(id);
            cur.clip.start = nstart;
            if (target && target !== 'new' && target !== cur.track.id) {
              cur.track.clips = cur.track.clips.filter((x) => x.id !== id);
              store.project.audioTracks.find((t) => t.id === target).clips.push(cur.clip);
            }
          });
          this.dropTarget = target;
        }
      }
      this.autoScroll(ev.clientX);
    };

    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-moving', 'is-trimming');
      this.drag = null;
      this.highlightNewTrack(false);
      if (!moved) {
        // Простой клик по клипу — переместить курсор
        store.setTime(this.xToTime(ev.clientX));
        this.render();
        return;
      }
      if (kind === 'video' && mode === 'move') {
        const idx = this.insertIndex;
        this.clearGhost();
        const from = store.project.videoClips.findIndex((c) => c.id === id);
        let to = idx > from ? idx - 1 : idx;
        if (idx !== undefined && to !== from) store.moveVideoClip(id, to);
        else this.render();
        return;
      }
      if (kind === 'audio' && mode === 'move' && this.dropTarget === 'new') {
        store.live(() => {
          const cur = store.findClip(id);
          cur.track.clips = cur.track.clips.filter((x) => x.id !== id);
          store.project.audioTracks.push({ id: `trk_${Date.now().toString(36)}`, muted: false, clips: [cur.clip] });
        });
      }
      this.dropTarget = null;
      store.commitFrom(before);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  startScrub(e) {
    const was = store.playing;
    const go = (ev) => store.setTime(this.xToTime(ev.clientX));
    go(e);
    this.drag = { mode: 'scrub' };
    const onMove = (ev) => { go(ev); this.autoScroll(ev.clientX); };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.drag = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return was;
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

  // Индекс вставки на видеодорожке по X
  videoInsertIndex(clientX, excludeId = null) {
    const t = this.xToTime(clientX);
    const layout = store.videoLayout();
    let idx = 0;
    for (const s of layout) {
      if (s.clip.id === excludeId) { if (t > (s.start + s.end) / 2) idx = s.index + 1; continue; }
      if (t > (s.start + s.end) / 2) idx = s.index + 1;
    }
    const xAt = idx < layout.length ? layout[idx].start : (layout.length ? layout[layout.length - 1].end : 0);
    return { idx, x: xAt * this.pps };
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

  moveVideoGhost(ev, id, clipEl) {
    if (!this.ghost) {
      const w = Math.min(clipEl.offsetWidth, 220);
      this.ghost = h('div', { class: 'clip-ghost' }, clipEl.querySelector('.clip-label')?.cloneNode(true) || '');
      this.ghost.style.width = `${w}px`;
      this.ghost.style.height = `${VIDEO_H - 8}px`;
      this.content.append(this.ghost);
      const orig = this.content.querySelector(`.clip[data-id="${id}"]`);
      if (orig) orig.classList.add('drag-src');
    }
    const r = this.content.getBoundingClientRect();
    const row = this.content.querySelector('.tl-row.video');
    this.ghost.style.transform = `translate(${ev.clientX - r.left - 40}px, ${row.offsetTop + 4}px)`;
    const { idx, x } = this.videoInsertIndex(ev.clientX, id);
    this.insertIndex = idx;
    this.showMarker(x);
  }

  clearGhost() {
    if (this.ghost) { this.ghost.remove(); this.ghost = null; }
    this.insertIndex = undefined;
    this.hideMarker();
  }

  // ------------------------------------------------------------------------
  // Перетаскивание из медиатеки и из Проводника
  // ------------------------------------------------------------------------
  initDrop() {
    const target = (e) => {
      const lane = e.target.closest('[data-lane]');
      if (!lane) return null;
      return lane.dataset.lane === 'audio' ? { kind: 'audio', track: lane.dataset.track } : { kind: lane.dataset.lane };
    };
    this.scroll.addEventListener('dragover', (e) => {
      const isMedia = e.dataTransfer.types.includes('application/x-ffm-media');
      const isFiles = e.dataTransfer.types.includes('Files');
      if (!isMedia && !isFiles) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      const tg = target(e);
      const m = window.__ffmDragMedia ? store.media(window.__ffmDragMedia) : null;
      this.highlightNewTrack(tg && tg.kind === 'newtrack');
      if (!tg) { this.hideMarker(); return; }
      const wantsVideo = tg.kind === 'video' && (!m || m.hasVideo);
      if (wantsVideo) {
        const { x } = this.videoInsertIndex(e.clientX);
        this.showMarker(x, 'video');
      } else if (tg.kind === 'audio') {
        this.showMarker(this.xToTime(e.clientX) * this.pps, tg.track);
      } else {
        this.hideMarker();
      }
    });
    this.scroll.addEventListener('dragleave', (e) => {
      if (!this.scroll.contains(e.relatedTarget)) { this.hideMarker(); this.highlightNewTrack(false); }
    });
    this.scroll.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideMarker();
      this.highlightNewTrack(false);
      const tg = target(e) || { kind: 'video' };
      const t = this.xToTime(e.clientX);
      const ins = this.videoInsertIndex(e.clientX).idx;
      let ids = [];
      const mid = e.dataTransfer.getData('application/x-ffm-media');
      if (mid) ids = [mid];
      else if (e.dataTransfer.files.length) {
        const paths = Array.from(e.dataTransfer.files).map((f) => window.api.pathForFile(f)).filter(Boolean);
        ids = await importPaths(paths);
      }
      let vi = ins; let at = t;
      for (const id of ids) {
        const m = store.media(id);
        if (!m) continue;
        if (tg.kind === 'video' && m.hasVideo) {
          store.insertVideoClip(id, vi++);
        } else if (m.hasAudio) {
          const track = tg.kind === 'audio' ? tg.track : tg.kind === 'newtrack' ? 'new' : null;
          const c = store.addAudioClip(id, tg.kind === 'video' ? store.time : at, track);
          if (c) at = c.start + c.out - c.in;
        } else {
          toast(`${m.name}: в файле нет звука — на аудиодорожку не добавить`, 'error');
        }
      }
    });
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
