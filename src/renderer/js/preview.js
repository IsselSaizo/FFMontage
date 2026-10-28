// Предпросмотр: воспроизводит таймлайн без перекодирования.
// Два <video>: обычно один играет, а во второй заранее грузится следующий клип;
// на переходе играют оба, а картинку смешивает CSS (см. transitions.js).
// Музыка — отдельные <audio>, громкость (можно > 100%) и затухания — через Web Audio.
import { store } from './store.js';
import { playUrl } from './media.js';
import { h, $, icon, fmtTime } from './util.js';
import { applyTransition, resetLayer } from './transitions.js';

const EPS = 0.004;
const clipEnd = (c) => c.start + c.out - c.in;

// Множитель плавного появления/исчезания клипа в момент t таймлайна (0…1)
export function fadeFactor(c, t) {
  const len = c.out - c.in;
  const local = Math.max(0, Math.min(len, t - c.start));
  let f = 1;
  if (c.fadeIn > 0.001) f = Math.min(f, local / c.fadeIn);
  if (c.fadeOut > 0.001) f = Math.min(f, (len - local) / c.fadeOut);
  return Math.max(0, Math.min(1, f));
}

export class Preview {
  constructor(root) {
    this.root = root;
    this.stage = h('div', { class: 'stage' });
    this.slots = [0, 1].map((i) => {
      const v = h('video', { class: 'slot', preload: 'auto', playsinline: true, disablepictureinpicture: true, crossorigin: 'anonymous' });
      v.dataset.slot = i;
      v.clipId = null;
      v.addEventListener('error', () => { v.failed = true; this.updateMessage(); });
      v.addEventListener('loadeddata', () => { v.failed = false; this.updateMessage(); });
      return v;
    });
    this.overlay = h('div', { class: 'stage-overlay' });
    this.msg = h('div', { class: 'stage-msg' });
    this.stage.append(...this.slots, this.overlay, this.msg);
    this.frame = h('div', { class: 'stage-frame' }, this.stage);
    root.append(this.frame);

    this.ctx = null;
    this.gains = new Map();      // element -> GainNode
    this.audio = new Map();      // clipId -> { el, url }
    this.visible = new Set();    // показанные сейчас <video>
    this.master = null;          // { el, clip } — по нему идут часы воспроизведения
    this.current = null;         // что показано: результат layersAt()
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

  clipGain(clip) {
    const m = store.media(clip.mediaId);
    return clip.muted || !m || !m.hasAudio ? 0 : clip.volume;
  }

  // --- что показывать в момент t ---
  // { A: {clip, mt}, B?: {clip, mt}, trans?: {type, p}, master: 'A'|'B' } или null (пустота)
  layersAt(t) {
    for (const tr of store.transitions()) {
      if (t >= tr.from - EPS && t < tr.to - EPS) {
        return {
          A: { clip: tr.a, mt: tr.a.in + (t - tr.a.start) },
          B: { clip: tr.b, mt: tr.b.in + (t - tr.b.start) },
          trans: { type: tr.type, p: (t - tr.from) / tr.d },
          master: t < tr.seam ? 'A' : 'B',
        };
      }
    }
    const layout = store.videoLayout();
    let s = layout.find((x) => t >= x.start - EPS && t < x.end - EPS);
    if (!s && layout.length) {
      // ровно в конце клипа (например, в конце ролика) — показываем последний кадр
      s = layout.find((x) => Math.abs(t - x.end) < 0.02 && !layout.some((y) => Math.abs(y.start - x.end) < 0.02));
    }
    return s ? { A: { clip: s.clip, mt: s.clip.in + (t - s.start) }, master: 'A' } : null;
  }

  // Следующее, что понадобится показать после t (для предзагрузки)
  nextLayerAfter(t) {
    let best = null;
    for (const s of store.videoLayout()) {
      if (s.start > t + EPS && (!best || s.start < best.at)) best = { at: s.start, clip: s.clip, mt: s.clip.in };
    }
    for (const tr of store.transitions()) {
      if (tr.from > t + EPS && (!best || tr.from < best.at)) best = { at: tr.from, clip: tr.b, mt: tr.b.in - tr.d / 2 };
    }
    return best;
  }

  mediaDur(clip) { const m = store.media(clip.mediaId); return m ? m.duration : clip.out; }
  clampMt(clip, mt) { return Math.max(0, Math.min(this.mediaDur(clip) - 0.001, mt)); }

  // Загружает в <video> нужный файл и позицию
  load(el, url, time) {
    if (el.dataset.url !== url) {
      el.failed = false;
      el.dataset.url = url;
      el.src = url;
    }
    if (Math.abs(el.currentTime - time) > 0.001) el.currentTime = Math.max(0, time);
  }

  // Раздаёт слои по двум <video>: тот же клип → тот же элемент; тот же файл с близким временем
  // (продолжение после разреза) → тот же элемент; иначе — свободный
  assign(layers) {
    const used = new Set();
    const pick = (fn) => this.slots.find((s) => !used.has(s) && fn(s));
    return layers.map((L) => {
      const s = pick((x) => x.clipId === L.clip.id && x.dataset.url === L.url)
        || pick((x) => x.dataset.url === L.url && Math.abs(x.currentTime - L.mt) < 0.35)
        || pick((x) => x.dataset.url === L.url)
        || pick((x) => !this.visible.has(x))
        || pick(() => true);
      used.add(s);
      s.clipId = L.clip.id;
      return s;
    });
  }

  // Показ кадра (и, при воспроизведении, управление элементами) для момента t
  present(t, force = false) {
    const L = this.layersAt(t);
    this.current = L;
    const layers = [];
    if (L) {
      for (const role of ['A', 'B']) {
        const x = L[role];
        if (!x) continue;
        const url = playUrl(x.clip.mediaId);
        if (url) layers.push({ ...x, role, url });
      }
    }
    const els = this.assign(layers);
    this.visible = new Set(els);
    this.master = null;

    layers.forEach((x, i) => {
      const el = els[i];
      const mt = this.clampMt(x.clip, x.mt);
      const before = x.mt < -0.001;                       // клип ещё не начался в файле (переход без «запаса» кадров)
      const after = x.mt > this.mediaDur(x.clip) - 0.01;  // кадры в файле кончились — стоп на последнем
      if (!this.playing || force) {
        this.load(el, x.url, mt);
        if (this.playing && !before && !after) el.play().catch(() => {});
      } else if (el.dataset.url !== x.url) {
        this.load(el, x.url, mt);
        if (!before && !after) el.play().catch(() => {});
      } else {
        const isMaster = x.role === L.master && !L.trans;
        const drift = Math.abs(el.currentTime - mt);
        if (before || after) {
          if (!el.paused) el.pause();
          if (drift > 0.05) el.currentTime = mt;
        } else if (el.paused) {
          if (drift > 0.1) el.currentTime = mt;
          el.play().catch(() => {});
        } else if (!isMaster && drift > 0.2) {
          el.currentTime = mt;
        }
      }
      if (x.role === L.master) this.master = { el, clip: x.clip };
      const fade = fadeFactor(x.clip, t);
      const mix = L.trans ? (x.role === 'A' ? 1 - L.trans.p : L.trans.p) : 1;
      this.setGain(el, this.clipGain(x.clip) * fade * mix);
      x.el = el; x.fade = fade;
    });

    for (const s of this.slots) {
      const on = this.visible.has(s);
      s.classList.toggle('on', on);
      if (!on && !s.paused) s.pause();
    }
    const A = layers.find((x) => x.role === 'A');
    const B = layers.find((x) => x.role === 'B');
    if (L && L.trans) {
      applyTransition(L.trans.type, L.trans.p, A ? A.el : null, B ? B.el : null, this.overlay, A ? A.fade : 1, B ? B.fade : 1);
    } else {
      if (A) resetLayer(A.el, A.fade);
      this.overlay.style.opacity = '0';
    }
    this.preload(t);
    this.updateMessage();
  }

  // Заранее грузим следующий клип в свободный элемент
  preload(t) {
    const n = this.nextLayerAfter(t);
    if (!n || n.at - t > 5) return;
    const url = playUrl(n.clip.mediaId);
    if (!url) return;
    const mt = this.clampMt(n.clip, n.mt);
    // Продолжение того же файла в играющем элементе (после разреза) — грузить нечего
    if (this.slots.some((s) => this.visible.has(s) && s.dataset.url === url && Math.abs(s.currentTime + (n.at - t) - mt) < 0.35)) return;
    // Уже загружено в свободный элемент
    if (this.slots.some((s) => !this.visible.has(s) && s.dataset.url === url && s.clipId === n.clip.id && Math.abs(s.currentTime - mt) < 0.3)) return;
    const free = this.slots.find((s) => !this.visible.has(s));
    if (free) { free.clipId = n.clip.id; this.load(free, url, mt); }
  }

  // --- позиционирование без воспроизведения ---
  seek(t) {
    this.present(t, true);
    this.syncAudio(t, true);
  }

  updateMessage() {
    const L = this.current;
    let text = '';
    if (!store.project.videoClips.length && !store.audioEnd()) {
      text = Object.keys(store.project.media).length
        ? 'Перетащите видео на таймлайн внизу'
        : 'Импортируйте видео, чтобы начать';
    } else if (L) {
      const c = L[L.master].clip;
      const rt = store.runtime[c.mediaId] || {};
      if (rt.missing) text = 'Файл не найден';
      else if (!playUrl(c.mediaId)) text = rt.status === 'rebuild' ? 'Восстановление эффекта…' : `Подготовка файла… ${Math.round((rt.progress || 0) * 100)}%`;
      else if (this.master && this.master.el.failed) text = 'Этот файл не воспроизводится в предпросмотре';
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

  startAt(t) {
    this.clock = { wall: performance.now(), t };
    this.present(t, true);
    this.syncAudio(t, true);
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
    const dur = store.duration();
    const now = performance.now();
    const L = this.current;
    let t = this.clock.t + (now - this.clock.wall) / 1000;  // по умолчанию — часы
    const ms = this.master;
    // Вне переходов время берём с играющего видео: так картинка и звук не расходятся
    if (L && !L.trans && ms && store.findClip(ms.clip.id) && !ms.el.failed && !ms.el.ended && playUrl(ms.clip.mediaId)) {
      const mt = ms.el.currentTime;
      if (ms.el.readyState >= 2 && !ms.el.seeking && !ms.el.paused) {
        t = ms.clip.start + (mt - ms.clip.in);
      } else if (ms.el.seeking || ms.el.readyState < 2) {
        t = this.clock.t; // ждём, пока загрузится кадр
        this.clock.wall = now;
      }
    }
    if (t >= dur) {
      store.setTime(dur, 'preview');
      this.pause();
      return;
    }
    this.clock = { wall: now, t };
    store.time = t;
    store.emit('time', 'preview');
    this.present(t);
    this.syncAudio(t, false);
    this.loop();
  }

  // --- музыка и прочие аудиодорожки ---
  syncAudio(t, force) {
    for (const track of store.project.audioTracks) {
      for (const c of track.clips) {
        const url = playUrl(c.mediaId);
        const active = !track.muted && t >= c.start - EPS && t < clipEnd(c) - 0.02;
        let rec = this.audio.get(c.id);
        if (!active) { if (rec && !rec.el.paused) rec.el.pause(); continue; }
        if (!url) continue;
        if (!rec) {
          const el = new Audio();
          el.crossOrigin = 'anonymous'; // медиа идут с media.localhost — без CORS Web Audio дал бы тишину
          el.preload = 'auto';
          rec = { el, url: null };
          this.audio.set(c.id, rec);
          this.attach(el);
        }
        if (this.ctx && !this.gains.has(rec.el)) this.attach(rec.el);
        if (rec.url !== url) { rec.url = url; rec.el.src = url; }
        const expected = c.in + (t - c.start);
        this.setGain(rec.el, c.muted ? 0 : c.volume * fadeFactor(c, t));
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
    for (const t of store.project.audioTracks) for (const c of t.clips) ids.add(`${c.id}`);
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
      btn('fullscreen', 'Во весь экран (Shift+F)', () => preview.fullscreen())),
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
