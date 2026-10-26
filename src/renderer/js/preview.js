// Предпросмотр: воспроизводит таймлайн без перекодирования.
// Два <video> по очереди (пока один играет, следующий клип уже загружен),
// отдельные <audio> для музыки, громкость через Web Audio (можно > 100%).
import { store } from './store.js';
import { playUrl } from './media.js';
import { h, $, icon, fmtTime } from './util.js';

const EPS = 0.004;

export class Preview {
  constructor(root) {
    this.root = root;
    this.stage = h('div', { class: 'stage' });
    this.slots = [0, 1].map((i) => {
      const v = h('video', { class: 'slot', preload: 'auto', playsinline: true, disablepictureinpicture: true });
      v.dataset.slot = i;
      v.addEventListener('error', () => { v.failed = true; this.updateMessage(); });
      v.addEventListener('loadeddata', () => { v.failed = false; this.updateMessage(); });
      return v;
    });
    this.msg = h('div', { class: 'stage-msg' });
    this.stage.append(...this.slots, this.msg);
    this.frame = h('div', { class: 'stage-frame' }, this.stage);
    root.append(this.frame);

    this.ctx = null;
    this.gains = new Map();      // element -> GainNode
    this.audio = new Map();      // clipId -> { el, url }
    this.active = null;          // текущий <video>
    this.activeClipId = null;
    this.playing = false;
    this.clock = { wall: 0, t: 0 };

    store.on('time', (src) => { if (src !== 'preview') this.onExternalSeek(); });
    store.on('project', () => { this.layoutStage(); if (!this.playing) this.seek(store.time); else this.syncAudio(store.time, true); this.cleanupAudio(); });
    store.on('media', () => { if (!this.playing) this.seek(store.time); });
    new ResizeObserver(() => requestAnimationFrame(() => this.layoutStage())).observe(this.frame);
    this.layoutStage();
    this.seek(0);
  }

  // Подгоняем «экран» под пропорции проекта
  layoutStage() {
    const f = store.sourceFormat();
    const aw = this.frame.clientWidth; const ah = this.frame.clientHeight;
    if (!aw || !ah) return;
    const ar = f.width / f.height;
    let w = aw; let hh = aw / ar;
    if (hh > ah) { hh = ah; w = ah * ar; }
    Object.assign(this.stage.style, { width: `${Math.floor(w)}px`, height: `${Math.floor(hh)}px` });
  }

  // --- звук ---
  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      for (const v of this.slots) this.attach(v);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  attach(el) {
    if (!this.ctx || this.gains.has(el)) return;
    const src = this.ctx.createMediaElementSource(el);
    const g = this.ctx.createGain();
    src.connect(g).connect(this.ctx.destination);
    this.gains.set(el, g);
  }
  setGain(el, v) {
    const g = this.gains.get(el);
    if (g) { g.gain.value = v; el.volume = 1; } else el.volume = Math.min(1, Math.max(0, v));
  }

  // --- поиск сегмента ---
  layout() { return store.videoLayout(); }
  segAt(t, layout = this.layout()) {
    let s = layout.find((x) => t >= x.start - EPS && t < x.end - EPS);
    if (!s && layout.length) {
      const last = layout[layout.length - 1];
      if (Math.abs(t - last.end) < 0.02) s = last; // ровно в конце — показываем последний кадр
    }
    return s || null;
  }

  // Загружает в <video> нужный файл и позицию
  load(el, url, time) {
    if (el.dataset.url !== url) {
      el.failed = false;
      el.dataset.url = url;
      el.src = url;
    }
    if (Math.abs(el.currentTime - time) > 0.001) el.currentTime = Math.max(0, time);
  }

  pickSlot(url) {
    // Предпочитаем элемент, где этот файл уже загружен
    const ready = this.slots.find((s) => s.dataset.url === url && s === this.active)
      || this.slots.find((s) => s.dataset.url === url);
    if (ready) return ready;
    return this.slots.find((s) => s !== this.active) || this.slots[0];
  }

  show(el) {
    for (const s of this.slots) {
      const on = s === el;
      s.classList.toggle('on', on);
      if (!on && !s.paused) s.pause();
    }
    this.active = el;
  }

  preloadNext(seg, layout) {
    const next = seg ? layout[seg.index + 1] : null;
    if (!next) return;
    const url = playUrl(next.clip.mediaId);
    if (!url) return;
    // Если следующий кусок — продолжение того же файла, ничего грузить не надо
    if (next.clip.mediaId === seg.clip.mediaId && Math.abs(next.clip.in - seg.clip.out) < 0.05) return;
    const other = this.slots.find((s) => s !== this.active);
    if (other) this.load(other, url, next.clip.in);
  }

  clipGain(clip) {
    const m = store.media(clip.mediaId);
    return clip.muted || !m || !m.hasAudio ? 0 : clip.volume;
  }

  // --- позиционирование без воспроизведения ---
  seek(t) {
    const layout = this.layout();
    const seg = this.segAt(t, layout);
    this.activeClipId = seg ? seg.clip.id : null;
    if (seg) {
      const url = playUrl(seg.clip.mediaId);
      if (url) {
        const el = this.pickSlot(url);
        this.load(el, url, Math.min(seg.clip.out - 0.001, seg.clip.in + (t - seg.start)));
        this.show(el);
        this.setGain(el, this.clipGain(seg.clip));
        this.preloadNext(seg, layout);
      } else {
        this.show(null);
      }
    } else {
      this.show(null);
    }
    this.syncAudio(t, true);
    this.updateMessage();
  }

  updateMessage() {
    const seg = this.activeClipId ? this.layout().find((s) => s.clip.id === this.activeClipId) : null;
    let text = '';
    if (!store.project.videoClips.length && !store.audioEnd()) {
      text = Object.keys(store.project.media).length
        ? 'Перетащите видео на таймлайн внизу'
        : 'Импортируйте видео, чтобы начать';
    } else if (seg) {
      const rt = store.runtime[seg.clip.mediaId] || {};
      if (rt.missing) text = 'Файл не найден';
      else if (!playUrl(seg.clip.mediaId)) text = `Подготовка файла… ${Math.round((rt.progress || 0) * 100)}%`;
      else if (this.active && this.active.failed) text = 'Этот файл не воспроизводится в предпросмотре';
    }
    this.msg.textContent = text;
    this.msg.classList.toggle('on', !!text);
  }

  // --- воспроизведение ---
  toggle() { if (this.playing) this.pause(); else this.play(); }

  play() {
    const dur = store.duration();
    if (dur <= 0) return;
    if (store.time >= dur - 0.02) store.setTime(0, 'preview');
    this.ensureCtx();
    this.playing = true;
    store.playing = true;
    store.emit('playstate', true);
    this.startAt(store.time);
    this.loop();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    store.playing = false;
    cancelAnimationFrame(this.raf);
    for (const s of this.slots) s.pause();
    for (const { el } of this.audio.values()) el.pause();
    store.emit('playstate', false);
    this.seek(store.time);
  }

  startAt(t, layout = this.layout()) {
    const seg = this.segAt(t, layout);
    this.activeClipId = seg ? seg.clip.id : null;
    this.clock = { wall: performance.now(), t };
    if (seg) {
      const url = playUrl(seg.clip.mediaId);
      if (url) {
        const el = this.pickSlot(url);
        this.load(el, url, seg.clip.in + (t - seg.start));
        this.setGain(el, this.clipGain(seg.clip));
        this.show(el);
        el.play().catch(() => {});
        this.preloadNext(seg, layout);
      } else {
        this.show(null);
      }
    } else {
      this.show(null);
    }
    this.syncAudio(t, true);
    this.updateMessage();
  }

  onExternalSeek() {
    if (this.playing) this.startAt(store.time);
    else this.seek(store.time);
  }

  loop() {
    this.raf = requestAnimationFrame(() => this.tick());
  }

  tick() {
    if (!this.playing) return;
    const layout = this.layout();
    const dur = store.duration();
    let seg = this.activeClipId ? layout.find((s) => s.clip.id === this.activeClipId) : null;
    if (this.activeClipId && !seg) { this.startAt(store.time, layout); return this.loop(); }

    let t;
    const now = performance.now();
    const el = this.active;
    if (seg && el && !el.failed && playUrl(seg.clip.mediaId)) {
      if (el.readyState >= 2 && !el.seeking) {
        t = seg.start + (el.currentTime - seg.clip.in);
        this.clock = { wall: now, t };
        if (el.paused) el.play().catch(() => {});
      } else {
        t = this.clock.t; // ждём, пока загрузится кадр
      }
    } else {
      t = this.clock.t + (now - this.clock.wall) / 1000;
    }

    // Переход на следующий клип
    if (seg && t >= seg.end - EPS) {
      const next = layout[seg.index + 1];
      if (next && next.clip.mediaId === seg.clip.mediaId && Math.abs(next.clip.in - seg.clip.out) < 0.05
        && el && el.dataset.url === playUrl(next.clip.mediaId)) {
        // Продолжение того же файла (после разреза) — просто играем дальше
        this.activeClipId = next.clip.id;
        this.setGain(el, this.clipGain(next.clip));
        this.preloadNext(next, layout);
      } else {
        this.startAt(seg.end, layout);
        t = seg.end;
      }
    } else if (!seg && t < store.videoEnd() - EPS && this.segAt(t, layout)) {
      this.startAt(t, layout);
    }

    if (t >= dur) {
      store.setTime(dur, 'preview');
      this.pause();
      return;
    }
    store.time = t;
    store.emit('time', 'preview');
    this.syncAudio(t, false);
    this.loop();
  }

  // --- музыка и прочие аудиодорожки ---
  syncAudio(t, force) {
    for (const track of store.project.audioTracks) {
      for (const c of track.clips) {
        const url = playUrl(c.mediaId);
        const d = c.out - c.in;
        const active = !track.muted && t >= c.start - EPS && t < c.start + d - 0.02;
        let rec = this.audio.get(c.id);
        if (!active) { if (rec && !rec.el.paused) rec.el.pause(); continue; }
        if (!url) continue;
        if (!rec) {
          const el = new Audio();
          el.preload = 'auto';
          rec = { el, url: null };
          this.audio.set(c.id, rec);
          this.attach(el);
        }
        if (this.ctx && !this.gains.has(rec.el)) this.attach(rec.el);
        if (rec.url !== url) { rec.url = url; rec.el.src = url; }
        const expected = c.in + (t - c.start);
        this.setGain(rec.el, c.muted ? 0 : c.volume);
        if (this.playing) {
          if (rec.el.paused) { rec.el.currentTime = expected; rec.el.play().catch(() => {}); }
          else if (force || Math.abs(rec.el.currentTime - expected) > 0.25) rec.el.currentTime = expected;
        } else {
          if (!rec.el.paused) rec.el.pause();
          if (Math.abs(rec.el.currentTime - expected) > 0.05) rec.el.currentTime = expected;
        }
      }
    }
  }

  cleanupAudio() {
    const ids = new Set();
    for (const t of store.project.audioTracks) for (const c of t.clips) ids.add(c.id);
    for (const [id, rec] of this.audio) {
      if (!ids.has(id)) {
        rec.el.pause();
        rec.el.removeAttribute('src');
        rec.el.load();
        const g = this.gains.get(rec.el);
        if (g) { g.disconnect(); this.gains.delete(rec.el); }
        this.audio.delete(id);
      }
    }
  }

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.frame.requestFullscreen().catch(() => {});
  }
}

// Панель управления под плеером
export function initTransport(preview) {
  const bar = $('#transport');
  const btn = (name, title, fn, cls = '') => {
    const b = h('button', { class: `icon-btn ${cls}`, title, onclick: fn });
    b.innerHTML = icon(name, cls.includes('big') ? 26 : 20);
    return b;
  };
  const fpsStep = () => 1 / (store.sourceFormat().fps || 30);
  const playBtn = btn('play', 'Воспроизвести / пауза (Пробел)', () => preview.toggle(), 'big play');
  const cur = h('span', { class: 'tc cur' }, '0:00.00');
  const tot = h('span', { class: 'tc tot' }, '/ 0:00.00');
  bar.append(
    h('div', { class: 'tr-left' }, cur, tot),
    h('div', { class: 'tr-center' },
      btn('start', 'В начало (Home)', () => store.setTime(0)),
      btn('back5', 'Назад на 5 с (J)', () => store.setTime(store.time - 5)),
      playBtn,
      btn('fwd5', 'Вперёд на 5 с (L)', () => store.setTime(store.time + 5)),
      btn('end', 'В конец (End)', () => store.setTime(store.duration()))),
    h('div', { class: 'tr-right' },
      btn('fullscreen', 'Во весь экран (F)', () => preview.fullscreen())),
  );
  const upd = () => {
    cur.textContent = fmtTime(store.time);
    tot.textContent = '/ ' + fmtTime(store.duration());
  };
  store.on('time', upd);
  store.on('project', upd);
  store.on('playstate', (p) => { playBtn.innerHTML = icon(p ? 'pause' : 'play', 26); });
  upd();
  return { fpsStep };
}
