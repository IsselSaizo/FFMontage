// Предпросмотр: воспроизводит таймлайн без перекодирования.
// Два <video>: обычно один играет, а во второй заранее грузится следующий клип;
// на переходе играют оба, а картинку смешивает CSS (см. transitions.js).
// Музыка — отдельные <audio>, громкость (можно > 100%) и затухания — через Web Audio.
import { store, MAIN_LANE } from './store.js';
import { cssTransform } from './transform.js';
import { playUrl, audioUrl, playbackFailed } from './media.js';
import { h, $, icon, fmtTime } from './util.js';
import { applyTransition, resetLayer } from './transitions.js';
import { cssEffects } from './effects.js';
import { speedOf, tlLen, clipEnd, srcAt, tlAt } from './clipTime.js';
import { activeFx, webAudioChain } from './audioFx.js';
import { onRegistryChange } from './registry.js';
import { t } from './i18n.js';
import { isText } from './textModel.js';
import { drawText } from './textRender.js';
import { fontsVersion, onFontsChange } from './fonts.js';

const EPS = 0.004;
// crop { l, t, r, b } — доли кадра, срезанные с каждой стороны
export const cropViewBox = (cr) => (cr && (cr.l || cr.t || cr.r || cr.b)
  ? `inset(${+(cr.t * 100).toFixed(3)}% ${+(cr.r * 100).toFixed(3)}% ${+(cr.b * 100).toFixed(3)}% ${+(cr.l * 100).toFixed(3)}%)` : '');
const isStill = (clip) => { const m = store.media(clip.mediaId); return !!(m && m.isImage && !m.isAnimation); };

// Множитель плавного появления/исчезания клипа в момент t таймлайна (0…1)
export function fadeFactor(c, t) {
  const len = tlLen(c);
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
    this.msg = h('div', { class: 'stage-msg' });
    // Слои видеодорожек (M4.3): у каждой дорожки свой «вид» — 2 <video> + 2 <img> + заливка перехода;
    // порядок в .stage = порядок дорожек (основная снизу), пустоты верхних дорожек прозрачные
    this.views = new Map();      // laneId -> LaneView
    this.stage.append(this.msg);
    store.on('preview-transition', (info) => this.hoverTransition(info));
    store.on('preview-effect', (info) => this.hoverEffect(info));
    this.frame = h('div', { class: 'stage-frame' }, this.stage);
    root.append(this.frame);

    this.ctx = null;
    this.gains = new Map();      // element -> GainNode
    this.routes = new Map();     // element -> { g, nodes, sig, dest } — цепочка эффектов клипа
    this.buses = new Map();      // trackId -> { input, nodes, sig } — эффекты дорожки
    this.audio = new Map();      // clipId -> { el, url }
    this.master = null;          // { el, clip } — по нему идут часы воспроизведения
    this.masterTrans = false;    // часы-мастер сейчас на переходе (время берём с часов, а не с видео)
    this.current = null;         // что показано на основной дорожке: результат layersAt()
    this.playing = false;
    this.clock = { wall: 0, t: 0 };
    this.view(MAIN_LANE);

    store.on('time', (src) => { if (src !== 'preview') this.onExternalSeek(); });
    store.on('project', () => { this.layoutStage(); if (!this.playing) this.seek(store.time); else this.syncAudio(store.time, true); this.cleanupAudio(); });
    store.on('media', () => { if (!this.playing) this.seek(store.time); });
    // Загрузились/добавились шрифты — перерисовать тексты
    onFontsChange(() => { if (!this.playing) this.present(store.time, true); });
    // Плагин добавил/убрал эффект или переход — пересобрать цепочки Web Audio и перерисовать кадр
    onRegistryChange(() => {
      for (const r of this.routes.values()) r.sig = '';
      for (const b of this.buses.values()) b.sig = null;
      if (!this.playing) this.seek(store.time); else this.syncAudio(store.time, true);
    });
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
    Object.assign(this.stage.style, { width: `${Math.floor(w)}px`, height: `${Math.floor(hh)}px`, background: store.background() });
  }

  // --- звук ---
  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      // Общая громкость предпросмотра: только для прослушивания, на экспорт не влияет
      this.out = this.ctx.createGain();
      this.out.gain.value = this.monitor();
      this.out.connect(this.ctx.destination);
      for (const v of this.allSlots()) this.attach(v);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  monitor() {
    const v = Number(localStorage.getItem('ffm.monitorVol'));
    return localStorage.getItem('ffm.monitorMute') === '1' ? 0 : (isFinite(v) && localStorage.getItem('ffm.monitorVol') !== null ? v : 1);
  }
  setMonitor(v, mute = localStorage.getItem('ffm.monitorMute') === '1') {
    localStorage.setItem('ffm.monitorVol', String(v));
    localStorage.setItem('ffm.monitorMute', mute ? '1' : '0');
    if (this.out) this.out.gain.value = this.monitor();
    else this.syncAudio(store.time, false);
    store.emit('monitor');
  }
  attach(el) {
    if (!this.ctx || this.gains.has(el)) return;
    const src = this.ctx.createMediaElementSource(el);
    const g = this.ctx.createGain();
    src.connect(g).connect(this.out);
    this.gains.set(el, g);
    this.routes.set(el, { g, nodes: [], sig: '' });
  }

  // Эффекты в предпросмотре: элемент → громкость → эффекты клипа → шина дорожки (эффекты дорожки) → общий выход.
  // Узлы — по полю webaudio описаний (audioFx.js webAudioChain); у шумоподавления его нет — слышно только в готовом видео.
  fxNodes(list) {
    const nodes = [];
    for (const d of webAudioChain(list)) {
      let n;
      if (d.node === 'biquad') { n = this.ctx.createBiquadFilter(); n.type = d.type; }
      else if (d.node === 'compressor') n = this.ctx.createDynamicsCompressor();
      else if (d.node === 'gain') n = this.ctx.createGain();
      else continue;
      // Числовые поля описания — AudioParam узла с тем же именем (frequency, gain, Q, threshold, attack…)
      for (const [k, v] of Object.entries(d)) {
        if (k !== 'node' && k !== 'type' && n[k] instanceof AudioParam && Number.isFinite(v)) n[k].value = v;
      }
      nodes.push(n);
    }
    return nodes;
  }
  // Цепочка from → nodes → to; старые узлы отключаются
  rewire(from, oldNodes, nodes, to) {
    from.disconnect();
    for (const n of oldNodes) n.disconnect();
    let cur = from;
    for (const n of nodes) { cur.connect(n); cur = n; }
    cur.connect(to);
  }
  trackBus(track) {
    if (!this.ctx || !track) return this.out;
    let b = this.buses.get(track.id);
    if (!b) { b = { input: this.ctx.createGain(), nodes: [], sig: null }; this.buses.set(track.id, b); }
    const sig = JSON.stringify(activeFx(track.afx));
    if (b.sig !== sig) {
      const nodes = this.fxNodes(track.afx);
      this.rewire(b.input, b.nodes, nodes, this.out);
      b.nodes = nodes; b.sig = sig;
    }
    return b.input;
  }
  route(el, clip, track) {
    const r = this.routes.get(el);
    if (!r) return;
    const dest = this.trackBus(track);
    const sig = `${JSON.stringify(activeFx(clip && clip.afx))}|${track ? track.id : ''}`;
    if (r.sig === sig && r.dest === dest) return;
    const nodes = this.fxNodes(clip && clip.afx);
    this.rewire(r.g, r.nodes, nodes, dest);
    r.nodes = nodes; r.sig = sig; r.dest = dest;
  }
  setGain(el, v) {
    const g = this.gains.get(el);
    if (g) { g.gain.value = v; el.volume = 1; } else el.volume = Math.min(1, Math.max(0, v * this.monitor()));
  }

  // Громкость звука самого видеоклипа (если он не вынесен на аудиодорожку)
  clipGain(clip) {
    const m = store.media(clip.mediaId);
    if (clip.noAudio || clip.muted || !m || !m.hasAudio || store.anySolo()) return 0;
    return clip.volume;
  }

  // Множитель дорожки: выключена, «соло» у других, громкость дорожки
  trackGain(track) {
    if (track.muted) return 0;
    if (store.anySolo() && !track.solo) return 0;
    return track.volume ?? 1;
  }

  // --- слои видеодорожек ---
  // Вид дорожки: { id, root, slots (2 <video>), imgSlots (2 <img>), overlay, visible, current, master }
  view(id) {
    let v = this.views.get(id);
    if (v) return v;
    const root = h('div', { class: 'lane-view', dataset: { lane: id } });
    const slots = [0, 1].map((i) => {
      const el = h('video', { class: 'slot', preload: 'auto', playsinline: true, disablepictureinpicture: true, crossorigin: 'anonymous' });
      el.dataset.slot = i;
      el.clipId = null;
      el.addEventListener('error', () => {
        el.failed = true; this.updateMessage();
        // Файл не декодируется (нет кодека в системе) — переключить этот файл на прокси
        const f = el.clipId && store.findClip(el.clipId);
        if (f && el.error && el.error.code >= 3) playbackFailed(f.clip.mediaId);
      });
      el.addEventListener('loadeddata', () => { el.failed = false; this.updateMessage(); });
      return el;
    });
    const imgSlots = [0, 1].map(() => h('img', { class: 'slot img', draggable: 'false', alt: '' }));
    // Текстовые клипы (M5.1): холст во весь «экран», текст рисует textRender.js (трансформ — внутри рисунка)
    const textSlots = [0, 1].map(() => h('canvas', { class: 'slot txt' }));
    const overlay = h('div', { class: 'stage-overlay' });
    root.append(...slots, ...imgSlots, ...textSlots, overlay);
    v = { id, root, slots, imgSlots, textSlots, overlay, visible: new Set(), current: null, master: null };
    this.views.set(id, v);
    if (this.ctx) for (const el of slots) this.attach(el);
    return v;
  }
  // Виды — по дорожкам проекта: новые создаются, лишние убираются, порядок в .stage — как у дорожек
  syncViews(lanes) {
    const ids = new Set(lanes.map((l) => l.id));
    for (const [id, v] of this.views) {
      if (ids.has(id)) continue;
      for (const el of v.slots) { el.pause(); el.removeAttribute('src'); el.load(); const g = this.gains.get(el); if (g) { g.disconnect(); this.gains.delete(el); this.routes.delete(el); } }
      v.root.remove();
      this.views.delete(id);
    }
    lanes.forEach((l, i) => { this.view(l.id).root.style.zIndex = String(i + 1); });
    // Порядок в DOM: снизу вверх, перед сообщением
    let ref = this.msg;
    for (let i = lanes.length - 1; i >= 0; i--) { const r = this.view(lanes[i].id).root; if (r.nextSibling !== ref) this.stage.insertBefore(r, ref); ref = r; }
  }
  get mainView() { return this.view(MAIN_LANE); }
  // Совместимость (тесты, кадрирование): элементы основной дорожки
  get slots() { return this.mainView.slots; }
  get imgSlots() { return this.mainView.imgSlots; }
  get overlay() { return this.mainView.overlay; }
  get visible() { return this.mainView.visible; }
  // Все <video> всех дорожек
  allSlots() { return [...this.views.values()].flatMap((v) => v.slots); }

  // --- что показывать в момент t на дорожке lane ---
  // { A: {clip, mt}, B?: {clip, mt}, trans?: {type, p}, master: 'A'|'B' } или null (пустота)
  layersAt(t, lane = store.vlane(MAIN_LANE)) {
    const o = this.override;
    if (o && (o.laneId || MAIN_LANE) === lane.id) {
      return {
        A: { clip: o.a, mt: o.a.out - 0.05 },
        B: { clip: o.b, mt: o.b.in },
        trans: { type: o.type, p: o.p },
        master: o.p < 0.5 ? 'A' : 'B',
      };
    }
    for (const tr of store.transitions(lane.id)) {
      if (t >= tr.from - EPS && t < tr.to - EPS) {
        return {
          A: { clip: tr.a, mt: srcAt(tr.a, t) },
          B: { clip: tr.b, mt: srcAt(tr.b, t) },
          trans: { type: tr.type, p: (t - tr.from) / tr.d },
          master: t < tr.seam ? 'A' : 'B',
        };
      }
    }
    const layout = store.videoLayout(lane.id);
    let s = layout.find((x) => t >= x.start - EPS && t < x.end - EPS);
    if (!s && layout.length && lane.main) {
      // ровно в конце клипа (например, в конце ролика) — показываем последний кадр
      s = layout.find((x) => Math.abs(t - x.end) < 0.02 && !layout.some((y) => Math.abs(y.start - x.end) < 0.02));
    }
    return s ? { A: { clip: s.clip, mt: srcAt(s.clip, t) }, master: 'A' } : null;
  }

  // Следующее, что понадобится показать на дорожке после t (для предзагрузки)
  nextLayerAfter(t, lane = store.vlane(MAIN_LANE)) {
    let best = null;
    for (const s of store.videoLayout(lane.id)) {
      if (s.start > t + EPS && (!best || s.start < best.at)) best = { at: s.start, clip: s.clip, mt: s.clip.in };
    }
    for (const tr of store.transitions(lane.id)) {
      if (tr.from > t + EPS && (!best || tr.from < best.at)) best = { at: tr.from, clip: tr.b, mt: tr.b.in - (tr.d / 2) * speedOf(tr.b) };
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

  // Раздаёт слои по двум <video> вида: тот же клип → тот же элемент; тот же файл с близким временем
  // (продолжение после разреза) → тот же элемент; иначе — свободный
  assign(v, layers) {
    const used = new Set();
    const pick = (fn) => v.slots.find((s) => !used.has(s) && fn(s));
    return layers.map((L) => {
      const s = pick((x) => x.clipId === L.clip.id && x.dataset.url === L.url)
        || pick((x) => x.dataset.url === L.url && Math.abs(x.currentTime - L.mt) < 0.35)
        || pick((x) => x.dataset.url === L.url)
        || pick((x) => !v.visible.has(x))
        || pick(() => true);
      used.add(s);
      s.clipId = L.clip.id;
      return s;
    });
  }

  // Показ кадра всех видеодорожек (и, при воспроизведении, управление элементами) для момента t
  present(t, force = false) {
    const lanes = store.vlanes();
    this.syncViews(lanes);
    let master = null; let masterTrans = false;
    for (const lane of lanes) {
      const v = this.view(lane.id);
      // Скрытая дорожка не видна, но её видео продолжают играть — звук клипов остаётся (как в экспорте).
      // hideOverlay — редактор анимаций рисует свой холст и прячет верхние дорожки
      v.root.classList.toggle('lane-hidden', lane.hidden || (!lane.main && !!this.hideOverlay));
      const L = this.layersAt(t, lane);
      this.presentLane(v, L, t, force, lane);
      if (lane.main) this.current = L;
      if (!master && v.master) { master = v.master; masterTrans = !!(L && L.trans); }
    }
    this.master = master; this.masterTrans = masterTrans;
    this.updateMessage();
  }

  presentLane(v, L, t, force, lane) {
    v.current = L;
    const layers = [];
    if (L) {
      for (const role of ['A', 'B']) {
        const x = L[role];
        if (!x) continue;
        const url = isText(x.clip) ? 'text:' : playUrl(x.clip.mediaId);
        if (url) layers.push({ ...x, role, url });
      }
    }
    // Тексты — на холсте, картинки — в <img>, видео — в <video>
    const tLayers = layers.filter((x) => isText(x.clip));
    const vLayers = layers.filter((x) => !isStill(x.clip) && !isText(x.clip));
    const iLayers = layers.filter((x) => isStill(x.clip));
    tLayers.forEach((x, i) => {
      const el = v.textSlots[i];
      this.drawTextSlot(el, x.clip, t);
      x.el = el; x.fade = fadeFactor(x.clip, t); x.text = true;
    });
    for (const s of v.textSlots) s.classList.toggle('on', tLayers.some((x) => x.el === s));
    const els = this.assign(v, vLayers);
    v.visible = new Set(els);
    v.master = null;
    iLayers.forEach((x, i) => {
      const el = v.imgSlots[i];
      if (el.dataset.url !== x.url) { el.dataset.url = x.url; el.src = x.url; }
      x.el = el; x.fade = fadeFactor(x.clip, t);
    });
    for (const s of v.imgSlots) s.classList.toggle('on', iLayers.some((x) => x.el === s));

    vLayers.forEach((x, i) => {
      const el = els[i];
      const mt = this.clampMt(x.clip, x.mt);
      // Скорость клипа: playbackRate (тон звука сохраняется). После смены файла WebView сбрасывает её к default.
      const sp = isStill(x.clip) ? 1 : speedOf(x.clip);
      if (el.defaultPlaybackRate !== sp) el.defaultPlaybackRate = sp;
      if (el.playbackRate !== sp) el.playbackRate = sp;
      const before = x.mt < -0.001;                       // клип ещё не начался в файле (переход без «запаса» кадров)
      const after = x.mt > this.mediaDur(x.clip) - 0.01;  // кадры в файле кончились — стоп на последнем
      if (!this.playing || force) {
        this.load(el, x.url, mt);
        if (this.playing && !before && !after) el.play().catch(() => {});
      } else if (el.dataset.url !== x.url) {
        this.load(el, x.url, mt);
        if (!before && !after) el.play().catch(() => {});
      } else {
        const isMaster = x.role === L.master && !L.trans && this.master && this.master.el === el;
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
      if (x.role === L.master) v.master = { el, clip: x.clip };
      const fade = fadeFactor(x.clip, t);
      const mix = L.trans ? (x.role === 'A' ? 1 - L.trans.p : L.trans.p) : 1;
      this.setGain(el, this.clipGain(x.clip) * fade * mix);
      x.el = el; x.fade = fade;
    });

    for (const s of v.slots) {
      const on = v.visible.has(s);
      s.classList.toggle('on', on);
      if (!on && !s.paused) s.pause();
    }
    const A = layers.find((x) => x.role === 'A');
    const B = layers.find((x) => x.role === 'B');
    for (const x of layers) if (x.el) x.el.style.filter = '';
    if (L && L.trans) {
      applyTransition(L.trans.type, L.trans.p, A ? A.el : null, B ? B.el : null, v.overlay, A ? A.fade : 1, B ? B.fade : 1);
    } else {
      if (A) resetLayer(A.el, A.fade);
      v.overlay.style.opacity = '0';
    }
    // «Заполнить/вписать», трансформ и эффекты клипа (поверх стилей перехода, например размытия или сдвига)
    const shownW = this.stage.clientWidth;
    for (const x of layers) {
      if (!x.el || x.text) continue;
      // В режиме кадрирования клип показывается целиком (вписан, без трансформа), рамку рисует cropMode.js
      const editing = this.cropEdit === x.clip.id;
      x.el.classList.toggle('cover', !editing && x.clip.fit === 'cover');
      x.el.classList.toggle('stretch', !editing && x.clip.fit === 'stretch');
      // Кадрирование: object-view-box вырезает часть кадра, а object-fit подгоняет уже её (как crop→scale в экспорте)
      const vb = editing ? '' : cropViewBox(x.clip.crop);
      if (x.el.style.objectViewBox !== vb) x.el.style.objectViewBox = vb;
      // Трансформ клипа — внутри стиля перехода (как в экспорте: сначала слой собирается, потом переход)
      const ct = editing ? null : cssTransform(x.clip);
      if (ct && ct.transform) x.el.style.transform = `${x.el.style.transform || ''} ${ct.transform}`.trim();
      if (ct && ct.opacity) x.el.style.opacity = String((Number(x.el.style.opacity) || (x.el.style.opacity === '' ? 1 : 0)) * Number(ct.opacity));
      const ov = this.effectOverride && this.effectOverride.clipId === x.clip.id ? { ...x.clip, effects: this.effectOverride.effects } : x.clip;
      const tf = x.el.style.filter;
      x.el.style.filter = cssEffects(ov, shownW, tf ? [tf] : []);
    }
    if (!this.override) this.preload(v, lane, t);
  }

  // Текст на холсте слоя: размер холста = «экран» × devicePixelRatio; перерисовка — только если что-то изменилось
  drawTextSlot(el, clip, t) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(2, Math.round(this.stage.clientWidth * dpr));
    const H = Math.max(2, Math.round(this.stage.clientHeight * dpr));
    const roll = clip.text && clip.text.motion === 'roll';
    const local = roll ? Math.round((t - clip.start) * 120) / 120 : 0;
    const sig = `${W}x${H}|${local}|${fontsVersion()}|${clip.out}|${JSON.stringify(clip.text)}|${JSON.stringify(clip.transform || null)}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    if (el.width !== W) el.width = W;
    if (el.height !== H) el.height = H;
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawText(ctx, clip, W, H, { local });
  }

  // --- показ перехода/эффекта при наведении (проект не меняется) ---
  // Переход: кадры по обе стороны стыка стоят, анимируется сам переход
  hoverTransition(info) {
    cancelAnimationFrame(this.hoverRaf);
    if (!info || this.playing) {
      if (this.override) { this.override = null; this.seek(store.time); }
      return;
    }
    let bId = info.bId;
    if (!bId) {
      // Стык: выделенный переход, иначе ближайший к курсору
      const s = store.selection;
      if (s && s.kind === 'transition') bId = s.id;
      else {
        let best = null;
        for (const v of store.allVideo()) {
          const j = store.junctionBefore(v.id);
          if (j && (!best || Math.abs(j.seam - store.time) < Math.abs(best.seam - store.time))) best = { id: v.id, seam: j.seam };
        }
        bId = best && best.id;
      }
    }
    const j = bId && store.junctionBefore(bId);
    if (!j) return;
    const d = Math.max(0.4, info.duration || (j.b.transition && j.b.transition.duration) || 0.8);
    this.override = { a: j.a, b: j.b, type: info.type, p: 0, seam: j.seam, laneId: j.laneId };
    const t0 = performance.now();
    const loop = (now) => {
      // Элемент, на который навели, исчез или мышь ушла (mouseleave мог не прийти) — показ закончен
      if (info.el && (!info.el.isConnected || !info.el.matches(':hover')) && now - t0 > 150) { this.hoverTransition(null); return; }
      const cyc = d * 1000 + 700;
      this.override.p = Math.min(1, ((now - t0) % cyc) / (d * 1000));
      this.present(j.seam, true);
      this.hoverRaf = requestAnimationFrame(loop);
    };
    this.hoverRaf = requestAnimationFrame(loop);
  }

  // Эффект: показываем кадр клипа с эффектом (курсор внутри клипа — там, иначе середина клипа)
  hoverEffect(info) {
    if (!info) {
      if (this.effectOverride) { this.effectOverride = null; this.seek(store.time); }
      return;
    }
    const f = store.findClip(info.clipId);
    if (!f || f.kind !== 'video' || this.playing) return;
    this.effectOverride = info;
    const c = f.clip; const e = clipEnd(c);
    const t = store.time >= c.start && store.time < e ? store.time : (c.start + e) / 2;
    this.present(t, true);
  }

  // Заранее грузим следующий клип дорожки в свободный элемент её вида
  preload(v, lane, t) {
    const n = this.nextLayerAfter(t, lane);
    if (!n || n.at - t > 5) return;
    const url = playUrl(n.clip.mediaId);
    if (!url) return;
    const mt = this.clampMt(n.clip, n.mt);
    // Продолжение того же файла в играющем элементе (после разреза) — грузить нечего
    if (v.slots.some((s) => v.visible.has(s) && s.dataset.url === url && Math.abs(s.currentTime + (n.at - t) * speedOf(n.clip) - mt) < 0.35)) return;
    // Уже загружено в свободный элемент
    if (v.slots.some((s) => !v.visible.has(s) && s.dataset.url === url && s.clipId === n.clip.id && Math.abs(s.currentTime - mt) < 0.3)) return;
    const free = v.slots.find((s) => !v.visible.has(s));
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
    if (!store.allVideo().length && !store.audioEnd()) {
      text = Object.keys(store.project.media).length
        ? t('Перетащите видео на таймлайн внизу')
        : t('Импортируйте видео, чтобы начать');
    } else if (L || this.master) {
      const c = L ? L[L.master].clip : this.master.clip;
      const rt = store.runtime[c.mediaId] || {};
      if (isText(c)) text = '';
      else if (rt.missing) text = t('Файл не найден');
      else if (!playUrl(c.mediaId)) text = rt.status === 'rebuild' ? t('Восстановление эффекта…') : t('Подготовка файла… {p}%', { p: Math.round((rt.progress || 0) * 100) });
      else if (this.master && this.master.el.failed) text = t('Этот файл не воспроизводится в предпросмотре');
    }
    this.msg.textContent = text;
    this.msg.classList.toggle('on', !!text);
  }

  // --- воспроизведение ---
  toggle() { if (this.playing) this.pause(); else this.play(); }

  play() {
    const dur = store.duration();
    if (dur <= 0) return;
    cancelAnimationFrame(this.hoverRaf);
    this.override = null; this.effectOverride = null;
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
    for (const s of this.allSlots()) s.pause();
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
    let t = this.clock.t + (now - this.clock.wall) / 1000;  // по умолчанию — часы
    const ms = this.master;
    // Вне переходов время берём с играющего видео (основная дорожка, иначе нижняя из верхних): картинка и звук не расходятся
    if (ms && !this.masterTrans && store.findClip(ms.clip.id) && !ms.el.failed && !ms.el.ended && playUrl(ms.clip.mediaId)) {
      const mt = ms.el.currentTime;
      if (ms.el.readyState >= 2 && !ms.el.seeking && !ms.el.paused) {
        t = tlAt(ms.clip, mt);
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
      const tg = this.trackGain(track);
      for (const c of track.clips) {
        const url = audioUrl(c.mediaId, c.stream || 0);
        const active = tg > 0 && t >= c.start - EPS && t < clipEnd(c) - 0.02;
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
        if (this.ctx) this.route(rec.el, c, track);
        if (rec.url !== url) { rec.url = url; rec.el.src = url; }
        const expected = srcAt(c, t);
        const sp = speedOf(c);
        if (rec.el.defaultPlaybackRate !== sp) rec.el.defaultPlaybackRate = sp;
        if (rec.el.playbackRate !== sp) rec.el.playbackRate = sp;
        this.setGain(rec.el, c.muted ? 0 : c.volume * tg * fadeFactor(c, t));
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

// Громкость предпросмотра (только то, что вы слышите; громкость в готовом видео — у клипов и дорожек)
function monitorControl(preview) {
  const vol = () => { const v = Number(localStorage.getItem('ffm.monitorVol')); return localStorage.getItem('ffm.monitorVol') !== null && isFinite(v) ? v : 1; };
  const muted = () => localStorage.getItem('ffm.monitorMute') === '1';
  const b = h('button', { class: 'icon-btn', id: 'monitor-mute' });
  const slider = h('input', { type: 'range', min: '0', max: '100', class: 'monitor-slider', id: 'monitor-vol' });
  const upd = () => {
    b.innerHTML = icon(muted() || vol() === 0 ? 'mute' : 'speaker', 20);
    b.title = muted() ? t('Включить звук предпросмотра') : t('Выключить звук предпросмотра (на экспорт не влияет)');
    slider.value = String(Math.round(vol() * 100));
    slider.title = t('Громкость предпросмотра {v}% — только для прослушивания, на готовое видео не влияет', { v: slider.value });
  };
  b.addEventListener('click', () => preview.setMonitor(vol(), !muted()));
  slider.addEventListener('input', () => preview.setMonitor(Number(slider.value) / 100, false));
  store.on('monitor', upd);
  upd();
  return h('div', { class: 'monitor' }, b, slider);
}

// Панель управления под плеером
export function initTransport(preview) {
  const bar = $('#transport');
  const btn = (name, tip, fn, cls = '') => {
    const b = h('button', { class: `icon-btn ${cls}`, tip, onclick: fn });
    b.innerHTML = icon(name, cls.includes('big') ? 26 : 20);
    return b;
  };
  const fpsStep = () => 1 / (store.sourceFormat().fps || 30);
  const playBtn = btn('play', [t('Воспроизвести / пауза'), 'play.toggle'], () => preview.toggle(), 'big play');
  const cur = h('span', { class: 'tc cur' }, '0:00.00');
  const tot = h('span', { class: 'tc tot' }, '/ 0:00.00');
  bar.append(
    h('div', { class: 'tr-left' }, cur, tot),
    h('div', { class: 'tr-center' },
      btn('start', [t('В начало'), 'play.start'], () => store.setTime(0)),
      btn('back5', [t('Назад на 5 с'), 'play.back5'], () => store.setTime(store.time - 5)),
      playBtn,
      btn('fwd5', [t('Вперёд на 5 с'), 'play.fwd5'], () => store.setTime(store.time + 5)),
      btn('end', [t('В конец'), 'play.end'], () => store.setTime(store.duration()))),
    h('div', { class: 'tr-right' },
      monitorControl(preview),
      btn('fullscreen', [t('Во весь экран'), 'view.fullscreen'], () => preview.fullscreen())),
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
