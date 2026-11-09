// Предпросмотр: воспроизводит таймлайн без перекодирования.
// Два <video>: обычно один играет, а во второй заранее грузится следующий клип;
// на переходе играют оба, а картинку смешивает CSS (см. transitions.js).
// Музыка — отдельные <audio>, громкость (можно > 100%) и затухания — через Web Audio.
import { store, MAIN_LANE } from './store.js';
import { cssTransform, contentAspect, tfOf } from './transform.js';
import { borderOf, borderPx } from './border.js';
import { playUrl, audioUrl, channelUrl, channelState, playbackFailed } from './media.js';
import { layoutOf, routeOf, routeMatrix, downmixMatrix, channelLabels, clipChannel } from './audioLayout.js';
import { updateMeters, resetMeters, masterMeterEl } from './meters.js';
import { h, $, icon, fmtTime } from './util.js';
import { applyTransition, resetLayer } from './transitions.js';
import { cssEffects } from './effects.js';
import { speedOf, tlLen, clipEnd, srcAt, tlAt } from './clipTime.js';
import { activeFx, webAudioChain } from './audioFx.js';
import { onRegistryChange } from './registry.js';
import { t } from './i18n.js';
import { isGraphic, graphicOf, graphicsVersion, onGraphicsChange } from './graphicKinds.js';
import './textRender.js';   // рисунок текста (graphics.js)
import { fontsVersion, onFontsChange } from './fonts.js';
import { getPref, setPref } from './prefs.js';
import * as vst from './vst.js';

const monitorVol = () => { const v = Number(getPref('ui.monitorVol', 1)); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1; };

const EPS = 0.004;
// Окно индикаторов уровня: 2048 отсчётов (~43 мс при 48 кГц) — больше кадра, пики между кадрами не теряются
const METER_FFT = 2048;
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
    this.buses = new Map();      // trackId | '__video' -> шина дорожки (bus): эффекты, индикатор, маршрут по каналам
    this.mix = null;             // общий микс в N каналов проекта → индикаторы каналов → даунмикс в стерео (buildMix)
    this.audio = new Map();      // clipId -> { el, url }
    // Аудиоплагины VST3 / CLAP (js/vst.js): цепочка с плагином играет WAV офлайн-рендера (эффекты уже в нём)
    this.trackAudio = new Map(); // trackId -> { el, url } — рендер всей дорожки (плагины в эффектах дорожки)
    this.vstVideo = new Map();   // clipId -> { el, url } — рендер звука видеоклипа (сам <video> тогда молчит)
    this.vMix = new Map();       // clipId -> доля видеоклипа на переходе (для громкости его рендера)
    this.vstBadge = h('div', { class: 'vst-badge' });
    this.stage.append(this.vstBadge);
    vst.initVst();
    // Рендер готов / окно плагина открыто или закрыто — пересобрать звук (без перемотки играющего)
    vst.onVstChange((kind) => { if (kind === 'render' || kind === 'session' || kind === 'list') this.syncAudio(store.time, false); });
    this.master = null;          // { el, clip } — по нему идут часы воспроизведения
    this.masterTrans = false;    // часы-мастер сейчас на переходе (время берём с часов, а не с видео)
    this.current = null;         // что показано на основной дорожке: результат layersAt()
    this.playing = false;
    this.clock = { wall: 0, t: 0 };
    this.rate = 1;               // JKL-шаттл (js/shuttle.js): ×1…×8 вперёд; назад шаттл двигает курсор сам
    this.view(MAIN_LANE);

    store.on('time', (src) => { if (src !== 'preview') this.onExternalSeek(); });
    store.on('project', () => { this.layoutStage(); if (this.ctx) { this.buildMix(); this.rerouteBuses(); } if (!this.playing) this.seek(store.time); else this.syncAudio(store.time, true); this.cleanupAudio(); });
    store.on('media', () => { if (!this.playing) this.seek(store.time); });
    // Загрузились/добавились шрифты — перерисовать тексты
    onFontsChange(() => { if (!this.playing) this.present(store.time, true); });
    // Картинки графических клипов догрузились (слои таймера) — перерисовать кадр
    onGraphicsChange(() => { if (!this.playing) this.present(store.time, true); });
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
      this.buildMix();
      for (const v of this.allSlots()) this.attach(v);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  // Громкость предпросмотра — settings.json → ui.monitorVol / ui.monitorMute (js/prefs.js)
  monitor() {
    return getPref('ui.monitorMute', false) === true ? 0 : monitorVol();
  }
  setMonitor(v, mute = getPref('ui.monitorMute', false) === true) {
    setPref('ui.monitorVol', v);
    setPref('ui.monitorMute', !!mute);
    if (this.out) this.out.gain.value = this.monitor();
    else this.syncAudio(store.time, false);
    store.emit('monitor');
  }
  attach(el) {
    if (!this.ctx || this.gains.has(el)) return;
    const src = this.ctx.createMediaElementSource(el);
    const g = this.ctx.createGain();
    // По умолчанию — шина звука видео (у <video> основной и верхних дорожек route() не вызывается)
    const dest = this.trackBus(null);
    src.connect(g).connect(dest);
    this.gains.set(el, g);
    this.routes.set(el, { g, nodes: [], sig: '', dest });
  }

  // --- Многоканальный микс (0.5.1) ---
  // Шина дорожки: input → эффекты дорожки → post (стерео) → индикатор L/R и матрица маршрута → общий микс N каналов
  // (ChannelMerger) → индикаторы каналов → даунмикс в стерео (audioLayout.downmixMatrix) → громкость предпросмотра.
  // Стерео-проект — тот же граф с N = 2 и маршрутом L→1, R→2.
  buildMix() {
    const lay = layoutOf(store.project);
    const sig = `${lay.kind}:${lay.channels}`;
    if (this.mix && this.mix.sig === sig) return;
    const ctx = this.ctx;
    if (this.mix) for (const n of [this.mix.merger, this.mix.split, this.mix.dmMerger, ...this.mix.dm]) n.disconnect();
    const n = lay.channels;
    const merger = ctx.createChannelMerger(n);
    const split = ctx.createChannelSplitter(n);
    merger.connect(split);
    const analysers = [];
    for (let k = 0; k < n; k++) { const an = ctx.createAnalyser(); an.fftSize = METER_FFT; split.connect(an, k); analysers.push(an); }
    const dmMerger = ctx.createChannelMerger(2);
    const dm = [];
    downmixMatrix(store.project).forEach((gs, k) => gs.forEach((v, side) => {
      if (!v) return;
      const g = ctx.createGain(); g.gain.value = v;
      split.connect(g, k); g.connect(dmMerger, 0, side); dm.push(g);
    }));
    dmMerger.connect(this.out);
    this.mix = { sig, n, merger, split, analysers, dm, dmMerger, labels: channelLabels(store.project) };
    for (const b of this.buses.values()) b.routeSig = null;
  }
  rerouteBuses() {
    for (const [id, b] of [...this.buses]) {
      const tr = id === '__video' ? null : store.project.audioTracks.find((x) => x.id === id);
      if (tr || id === '__video') this.routeBus(b, tr);
      else { this.disposeBus(b); this.buses.delete(id); }  // дорожку удалили (или другой эпизод / проект)
    }
  }
  disposeBus(b) {
    for (const n of [b.input, ...b.nodes, b.post, b.split, ...b.an, ...b.rg]) n.disconnect();
  }
  routeBus(b, track) {
    const r = routeOf(store.project, track || 'video');
    const sig = `${this.mix.sig}|${r.join(',')}`;
    if (b.routeSig === sig) return;
    // split.disconnect(g) — иначе связь «разделитель → старый узел» держит его живым
    for (const g of b.rg) { b.split.disconnect(g); g.disconnect(); }
    b.rg = [];
    routeMatrix(r, this.mix.n).forEach((gs, k) => gs.forEach((v, side) => {
      if (!v) return;
      const g = this.ctx.createGain(); g.gain.value = v;
      b.split.connect(g, side); g.connect(this.mix.merger, 0, k); b.rg.push(g);
    }));
    b.routeSig = sig;
  }
  /** Уровни для индикаторов: { tracks: { id: [L, R] }, master: [по каналам], labels } — пики, доли полной шкалы */
  readMeters() {
    // Контекст на паузе (системой или до первого звука) — анализаторы отдают старый буфер: индикаторы не трогаем
    if (!this.ctx || !this.mix || this.ctx.state !== 'running') return null;
    const buf = this.meterBuf || (this.meterBuf = new Float32Array(METER_FFT));
    const peak = (an) => {
      an.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
      return p;
    };
    const tracks = {};
    for (const [id, b] of this.buses) tracks[id] = b.an.map(peak);
    return { tracks, master: this.mix.analysers.map(peak), labels: this.mix.labels };
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
  // Шина дорожки (track = null — звук видеоклипов); post — вход после эффектов дорожки (для её готового рендера)
  bus(track) {
    const id = track ? track.id : '__video';
    let b = this.buses.get(id);
    if (!b) {
      const ctx = this.ctx;
      const post = ctx.createGain();
      // Моно-источник раскладывается в L = R (speakers), а не в «левый + тишина»
      post.channelCount = 2; post.channelCountMode = 'explicit'; post.channelInterpretation = 'speakers';
      const split = ctx.createChannelSplitter(2);
      post.connect(split);
      const an = [0, 1].map((k) => { const a = ctx.createAnalyser(); a.fftSize = METER_FFT; split.connect(a, k); return a; });
      b = { input: ctx.createGain(), nodes: [], sig: null, post, split, an, rg: [], routeSig: null };
      this.buses.set(id, b);
    }
    const sig = track ? JSON.stringify(activeFx(track.afx)) : '';
    if (b.sig !== sig) {
      const nodes = track ? this.fxNodes(track.afx) : [];
      this.rewire(b.input, b.nodes, nodes, b.post);
      b.nodes = nodes; b.sig = sig;
    }
    this.routeBus(b, track);
    return b;
  }
  trackBus(track) {
    return this.ctx ? this.bus(track).input : null;
  }
  // bare — без узлов эффектов клипа (играет WAV рендера с плагинами: эффекты клипа уже в нём);
  // post — мимо эффектов дорожки (рендер всей дорожки: они уже в нём)
  route(el, clip, track, bare = false, post = false) {
    const r = this.routes.get(el);
    if (!r) return;
    const b = this.bus(track);
    const dest = post ? b.post : b.input;
    const sig = `${bare ? 'bare' : JSON.stringify(activeFx(clip && clip.afx))}|${track ? track.id : ''}|${post ? 'post' : ''}`;
    if (r.sig === sig && r.dest === dest) return;
    const nodes = bare ? [] : this.fxNodes(clip && clip.afx);
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
      el.addEventListener('error', () => this.slotError(el));
      el.addEventListener('loadeddata', () => { el.failed = false; el.okUrl = el.dataset.url; this.updateMessage(); });
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

  // Ошибка <video>. После неё элемент «мёртв» (play() и перемотка не работают), пока его не перезагрузить.
  // Декодер WebView изредка сбоит посреди файла, который до этого играл (сброс или занятость видеодекодера —
  // например, во время экспорта на той же видеокарте, нехватка памяти, обрыв чтения): такой элемент
  // перезапускаем с того же места. Файл, который в элементе ещё не открывался, сначала проверяем отдельным
  // <video> (playbackFailed): не играет — уходит на прокси, играет — тоже перезапуск. Не больше 3 попыток за 30 с,
  // дальше — сообщение «не воспроизводится».
  slotError(el) {
    const url = el.dataset.url;
    const code = el.error ? el.error.code : 0;
    if (!url || code === 1) return; // MEDIA_ERR_ABORTED — загрузку сменили мы сами
    const now = performance.now();
    const r = el.retry && el.retry.url === url && now - el.retry.at < 30000 ? el.retry : { url, n: 0, at: now };
    el.retry = r;
    el.failed = true; this.updateMessage();
    if (r.n >= 3) { console.warn('preview: файл не играет после перезапусков', code, el.error && el.error.message); return; }
    r.n++;
    const f = el.clipId && store.findClip(el.clipId);
    const mediaId = f && f.clip.mediaId;
    const retry = () => setTimeout(() => this.reloadSlot(el, url), 200 * r.n);
    console.warn('preview: ошибка плеера', code, el.error && el.error.message, el.okUrl === url ? '— перезапуск' : '— проверка файла');
    if (el.okUrl === url || !mediaId) { retry(); return; }
    playbackFailed(mediaId).then((playable) => { if (playable) retry(); });
  }

  // Перезагрузка элемента после ошибки; позицию и воспроизведение восстанавливает present()
  reloadSlot(el, url) {
    if (el.dataset.url !== url || !el.error) return; // элемент уже занят другим файлом или ожил сам
    el.failed = false;
    el.src = url; // присваивание адреса заново запускает загрузку (как load(), но и после подмены src)
    if (this.playing) this.startAt(store.time); else this.seek(store.time);
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
        const url = isGraphic(x.clip) ? 'text:' : playUrl(x.clip.mediaId);
        if (url) layers.push({ ...x, role, url });
      }
    }
    // Тексты и фигуры — на холсте, картинки — в <img>, видео — в <video>
    const tLayers = layers.filter((x) => isGraphic(x.clip));
    const vLayers = layers.filter((x) => !isStill(x.clip) && !isGraphic(x.clip));
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
      const sp = isStill(x.clip) ? 1 : Math.min(16, speedOf(x.clip) * this.rate);
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
      // Звук клипа с аудиоплагином: играет рендер (syncVideoWav) или окно плагина — сам <video> молчит
      const vr = vst.clipRender(x.clip, false);
      const viaVst = !!vr && (vr.status === 'ready' || vr.status === 'live');
      this.vMix.set(x.clip.id, mix);
      this.setGain(el, viaVst ? 0 : this.clipGain(x.clip) * fade * mix);
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
      this.applyBorder(x.el, editing ? null : x.clip, true);
    }
    // Рамки обводки у элементов, которые сейчас ничего не показывают
    const shown = new Set(layers.map((x) => x.el));
    for (const el of [...v.slots, ...v.imgSlots]) if (!shown.has(el)) this.applyBorder(el, null, false);
    if (!this.override) this.preload(v, lane, t);
  }

  // Графический клип (текст, фигура, таймер — graphics.js) на холсте слоя: размер холста = «экран» × devicePixelRatio;
  // перерисовка — только если что-то изменилось (у анимированных видов — и время, до 1/120 с)
  drawTextSlot(el, clip, t) {
    const g = graphicOf(clip);
    if (!g || !g.draw) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(2, Math.round(this.stage.clientWidth * dpr));
    const H = Math.max(2, Math.round(this.stage.clientHeight * dpr));
    const local = g.animated && g.animated(clip) ? Math.round((t - clip.start) * 120) / 120 : 0;
    const sig = `${W}x${H}|${clip.kind}|${local}|${fontsVersion()}|${graphicsVersion()}|${clip.out}|${JSON.stringify(clip[g.field])}|${JSON.stringify(clip.transform || null)}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    if (el.width !== W) el.width = W;
    if (el.height !== H) el.height = H;
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // false — картинки вида ещё грузятся: нарисовать заново, когда будут готовы
    if (g.draw(ctx, clip, W, H, local) === false) delete el.dataset.sig;
  }

  // Обводка и скругление углов клипа (border.js): скругление — clip-path самого слоя, обводка — рамка-div
  // во весь «экран» рядом со слоем, с тем же трансформом (рамка внутри — по картинке после подгонки, до масштаба).
  // Во время перехода с собственной маской (clip-path шторок) скругление не рисуется — его делает экспорт.
  applyBorder(el, clip, on) {
    let ring = el.ring;
    const b = on && clip ? borderOf(clip) : null;
    if (!b) {
      if (ring) ring.style.display = 'none';
      if (el.dataset.bclip) { el.style.clipPath = ''; delete el.dataset.bclip; }
      return;
    }
    if (!ring) {
      ring = h('div', { class: 'slot-ring' }, h('div', { class: 'slot-ring-box' }));
      el.ring = ring;
      el.after(ring);
    }
    const Sw = this.stage.clientWidth; const Sh = this.stage.clientHeight;
    const s = tfOf(clip).scale || 1;
    // Картинка в «экране» до трансформа: «вписать» — по пропорциям файла (с кадрированием), иначе — весь экран
    let w = Sw; let hh = Sh;
    if (!clip.fit || clip.fit === 'contain') {
      const ar = contentAspect(clip, store.media(clip.mediaId));
      if (Sw / Sh > ar) { hh = Sh; w = Sh * ar; } else { w = Sw; hh = Sw / ar; }
    }
    // Толщина и радиус — в пикселях кадра (не зависят от масштаба клипа): делим на масштаб слоя
    const px = borderPx(b, w * s, hh * s, Sh);
    const bw = px.bw / s; const r = px.r / s;
    const own = !el.style.clipPath || el.dataset.bclip === el.style.clipPath;
    if (own) {
      const cp = r > 0.01 ? `inset(${((Sh - hh) / 2).toFixed(2)}px ${((Sw - w) / 2).toFixed(2)}px round ${r.toFixed(2)}px)` : '';
      el.style.clipPath = cp;
      if (cp) el.dataset.bclip = el.style.clipPath; else delete el.dataset.bclip;
    }
    Object.assign(ring.style, {
      display: bw > 0 ? 'block' : 'none',
      transform: el.style.transform, opacity: el.style.opacity, zIndex: el.style.zIndex,
      clipPath: own ? '' : el.style.clipPath, maskImage: el.style.maskImage,
    });
    Object.assign(ring.firstChild.style, {
      left: `${(Sw - w) / 2}px`, top: `${(Sh - hh) / 2}px`, width: `${w}px`, height: `${hh}px`,
      borderWidth: `${bw.toFixed(2)}px`, borderColor: b.color, borderRadius: `${r.toFixed(2)}px`,
    });
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
      if (isGraphic(c)) text = '';
      else if (rt.missing) text = t('Файл не найден');
      else if (!playUrl(c.mediaId)) text = rt.status === 'rebuild' ? t('Восстановление эффекта…') : t('Подготовка файла… {p}%', { p: Math.round((rt.progress || 0) * 100) });
      else if (this.master && this.master.el.failed) text = t('Этот файл не воспроизводится в предпросмотре');
    }
    this.msg.textContent = text;
    this.msg.classList.toggle('on', !!text);
  }

  // --- воспроизведение ---
  toggle() { if (this.playing) this.pause(); else { this.rate = 1; this.play(); } }

  /** Скорость воспроизведения (шаттл L): 1…8; во время игры часы и элементы перестраиваются сразу */
  setRate(r) {
    const v = Math.max(0.25, Math.min(8, Number(r) || 1));
    if (v === this.rate) return;
    this.rate = v;
    if (this.playing) this.startAt(store.time);
  }

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
    for (const { el } of this.trackAudio.values()) el.pause();
    for (const { el } of this.vstVideo.values()) el.pause();
    resetMeters();
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
    let t = this.clock.t + ((now - this.clock.wall) / 1000) * this.rate;  // по умолчанию — часы
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
    updateMeters(this.readMeters());
    this.loop();
  }

  // --- музыка и прочие аудиодорожки ---
  newAudio() {
    const el = new Audio();
    el.crossOrigin = 'anonymous'; // медиа идут с media.localhost — без CORS Web Audio дал бы тишину
    el.preload = 'auto';
    this.attach(el);
    return el;
  }

  // Элемент звука: позиция expected (с), скорость sp, громкость gain
  playEl(el, expected, sp, gain, force) {
    sp = Math.min(16, sp * this.rate);
    if (el.defaultPlaybackRate !== sp) el.defaultPlaybackRate = sp;
    if (el.playbackRate !== sp) el.playbackRate = sp;
    this.setGain(el, gain);
    if (this.playing) {
      if (el.paused) { el.currentTime = expected; el.play().catch(() => {}); }
      else if (force || Math.abs(el.currentTime - expected) > 0.25) el.currentTime = expected;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - expected) > 0.05) el.currentTime = expected;
    }
  }

  syncAudio(t, force) {
    // Аудиоплагины: что показать в значке — идёт обработка, ошибка, звук идёт через окно плагина
    const badge = { pending: 0, error: 0, live: 0 };
    const note = (r) => {
      if (!r) return;
      if (r.status === 'live') badge.live++;
      else if (r.status === 'error') badge.error++;
      else if (r.status !== 'ready') badge.pending++;
    };
    // Ключи элементов, которые играют в этом кадре; остальные — на паузу после всех дорожек (клип мог переехать
    // на другую дорожку — ставить на паузу по «старой» дорожке нельзя)
    const used = new Set();
    for (const track of store.project.audioTracks) {
      const tg = this.trackGain(track);
      const at = (c) => t >= c.start - EPS && t < clipEnd(c) - 0.02;
      // Плагины в эффектах дорожки: один элемент с рендером всей дорожки, клипы сами не играют
      const tr = tg > 0 ? vst.trackRender(track) : null;
      if (tr && track.clips.some(at)) note(tr);
      const trWav = tr && tr.status === 'ready' ? tr : null;
      const trLive = !!tr && tr.status === 'live';
      this.syncTrackWav(track, trWav, tg, t, force);
      // Общий источник на поток (0.5.0): клипы дорожки из одного файла (поток, канал) играют через один элемент
      // и один узел Web Audio — после разрезов звук идёт без пересоздания и подгрузки, а на стыке «встык по файлу»
      // элемент просто продолжает играть. Свой элемент — только у WAV рендера (он у каждого клипа свой).
      const on = tg > 0 && !trWav && !trLive;
      const c = on ? track.clips.find(at) : null;
      if (!c && on && this.playing) {
        // Зазор у стыка (клип кончается за 20 мс до конца, следующий начинается встык): общий элемент
        // следующего клипа не останавливаем — на стыке «по файлу» звук идёт без паузы и перемотки
        const next = track.clips.find((x) => x.start >= t - EPS && x.start - t < 0.05);
        const key = next ? this.streamKey(track, next) : null;
        if (key) used.add(key);
      }
      if (c) {
        // Плагины и шумоподавление в эффектах клипа: WAV рендера (позиция — от начала клипа, скорость уже в нём);
        // пока его нет — сухой звук (встроенные эффекты — Web Audio), открыто окно плагина — молчим
        const cr = vst.clipRender(c, true);
        note(cr);
        const wav = cr && cr.status === 'ready' ? cr.url : null;
        const ch = wav ? undefined : clipChannel(c, store.media(c.mediaId));
        const url = cr && cr.status === 'live' ? null
          : wav || (ch === undefined ? audioUrl(c.mediaId, c.stream || 0) : channelUrl(c.mediaId, c.stream || 0, ch));
        // Файл канала («Разложить по каналам») ещё готовится или не получился — в тот же значок обработки
        if (!url && ch !== undefined) { const s = channelState(c.mediaId, c.stream || 0, ch); if (s) note({ status: s === 'error' ? 'error' : 'run' }); }
        if (url) {
          const key = wav ? `w:${c.id}` : `s:${track.id}|${url}`;
          used.add(key);
          let rec = this.audio.get(key);
          if (!rec) { rec = { el: this.newAudio(), url: null }; this.audio.set(key, rec); }
          rec.track = track.id;
          // Общий элемент перешёл на другой клип: если место в файле не совпадает (разрез с вырезанным
          // куском, повтор фразы) — перемотать сразу, а не ждать расхождения 0,25 с
          const expected = wav ? Math.max(0, t - c.start) : srcAt(c, t);
          const jump = rec.clip !== undefined && rec.clip !== c.id && Math.abs(rec.el.currentTime - expected) > 0.03;
          rec.clip = c.id;
          rec.seq = (this.audioSeq = (this.audioSeq || 0) + 1);
          if (this.ctx && !this.gains.has(rec.el)) this.attach(rec.el);
          if (this.ctx) this.route(rec.el, c, track, !!wav);
          if (rec.url !== url) { rec.url = url; rec.el.src = url; }
          this.playEl(rec.el, expected, wav ? 1 : speedOf(c), c.muted ? 0 : c.volume * tg * fadeFactor(c, t), force || jump);
        }
      }
    }
    for (const [key, rec] of this.audio) if (!used.has(key) && !rec.el.paused) rec.el.pause();
    this.syncVideoWav(t, force, note);
    // Открытое окно плагина: транспорт плеера → хост (он сам играет звук через плагин)
    vst.syncLive(t, this.playing, force);
    this.showVstBadge(badge);
  }

  showVstBadge(badge) {
    const b = this.vstBadge;
    const text = badge.live ? t('Звук идёт через окно плагина')
      : badge.error ? t('Обработка звука (плагины, шумоподавление): ошибка — слышно без неё')
        : badge.pending ? t('Обработка звука (плагины, шумоподавление)… пока слышно без неё') : '';
    if (b.textContent !== text) b.textContent = text;
    b.classList.toggle('on', !!text);
    b.classList.toggle('live', !!badge.live);
    b.classList.toggle('error', !badge.live && !!badge.error);
  }

  /** Ключ элемента звука клипа аудиодорожки (как в syncAudio): WAV рендера клипа или общий элемент потока дорожки */
  streamKey(track, c) {
    const cr = vst.clipRender(c, true);
    if (cr && cr.status === 'ready') return `w:${c.id}`;
    if (cr && cr.status === 'live') return null;
    const ch = clipChannel(c, store.media(c.mediaId));
    const url = ch === undefined ? audioUrl(c.mediaId, c.stream || 0) : channelUrl(c.mediaId, c.stream || 0, ch);
    return url ? `s:${track.id}|${url}` : null;
  }

  /** Элемент звука, который последним играл клип clipId (общий на поток дорожки или WAV рендера клипа) — для тестов */
  clipRec(clipId) {
    let best = null;
    for (const r of this.audio.values()) if (r.clip === clipId && (!best || r.seq > best.seq)) best = r;
    return best;
  }

  // Рендер всей дорожки (граф её клипов + эффекты дорожки): время WAV = время таймлайна, громкость дорожки — здесь
  syncTrackWav(track, r, tg, t, force) {
    let a = this.trackAudio.get(track.id);
    const dur = r && r.job && Number.isFinite(r.job.dur) ? r.job.dur : Infinity;
    if (!r || t >= dur - 0.02) { if (a && !a.el.paused) a.el.pause(); return; }
    if (!a) { a = { el: this.newAudio(), url: null }; this.trackAudio.set(track.id, a); }
    if (this.ctx && !this.gains.has(a.el)) this.attach(a.el);
    if (this.ctx) this.route(a.el, null, track, true, true);
    if (a.url !== r.url) { a.url = r.url; a.el.src = r.url; }
    this.playEl(a.el, Math.max(0, t), 1, tg, force);
  }

  // Звук видеоклипов с аудиоплагинами: отдельный элемент с рендером, <video> этого клипа молчит (presentLane)
  syncVideoWav(t, force, note) {
    for (const lane of store.vlanes()) {
      for (const c of lane.clips) {
        if (!Array.isArray(c.afx) || !c.afx.length) continue;
        const r = vst.clipRender(c, false);
        if (!r) continue;
        const active = t >= c.start - EPS && t < clipEnd(c) - 0.02;
        if (active) note(r);
        let a = this.vstVideo.get(c.id);
        if (!active || r.status !== 'ready') { if (a && !a.el.paused) a.el.pause(); continue; }
        if (!a) { a = { el: this.newAudio(), url: null }; this.vstVideo.set(c.id, a); }
        if (this.ctx && !this.gains.has(a.el)) this.attach(a.el);
        if (this.ctx) this.route(a.el, null, null, true);
        if (a.url !== r.url) { a.url = r.url; a.el.src = r.url; }
        const mix = this.vMix.has(c.id) ? this.vMix.get(c.id) : 1;
        this.playEl(a.el, Math.max(0, t - c.start), 1, this.clipGain(c) * fadeFactor(c, t) * mix, force);
      }
    }
  }

  cleanupAudio() {
    const drop = (map, ids) => {
      for (const [id, rec] of map) {
        if (ids.has(id)) continue;
        rec.el.pause();
        rec.el.removeAttribute('src');
        rec.el.load();
        const g = this.gains.get(rec.el);
        if (g) {
          g.disconnect();
          // и узлы эффектов клипа — иначе они остаются подключены ко входу шины
          for (const n of (this.routes.get(rec.el) || {}).nodes || []) n.disconnect();
          this.gains.delete(rec.el); this.routes.delete(rec.el);
        }
        map.delete(id);
      }
    };
    // Элементы звука клипов: ключ — поток дорожки или WAV клипа; лишние — дорожки нет или её клипы не из этого файла
    const ids = new Set();
    for (const tr of store.project.audioTracks) {
      for (const c of tr.clips) {
        ids.add(`w:${c.id}`);
        const ch = clipChannel(c, store.media(c.mediaId));
        const url = ch === undefined ? audioUrl(c.mediaId, c.stream || 0) : (((store.runtime[c.mediaId] || {}).channelUrl || {})[`${c.stream || 0}:${ch}`] || null);
        if (url) ids.add(`s:${tr.id}|${url}`);
      }
    }
    drop(this.audio, ids);
    drop(this.trackAudio, new Set(store.project.audioTracks.map((x) => x.id)));
    drop(this.vstVideo, new Set(store.allVideo().map((c) => c.id)));
    for (const id of [...this.vMix.keys()]) if (!this.vstVideo.has(id) && !store.findClip(id)) this.vMix.delete(id);
  }

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.frame.requestFullscreen().catch(() => {});
  }
}

// Громкость предпросмотра (только то, что вы слышите; громкость в готовом видео — у клипов и дорожек)
function monitorControl(preview) {
  const vol = monitorVol;
  const muted = () => getPref('ui.monitorMute', false) === true;
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
  return h('div', { class: 'monitor' }, masterMeterEl(), b, slider);
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
