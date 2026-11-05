// Многоканальный звук (0.5.1) — модель без DOM: её используют плеер (Web Audio), экспорт (exportPlan.js),
// окно маршрутизации, MCP и тесты.
//
// В проекте:
//   project.audioLayout = { kind: 'stereo' | 'mono' | '5.1' | '7.1' | 'multi', channels?: N (только multi, 1…16) }
//                         нет поля — стерео (как во всех проектах до 0.5.1)
//   track.route         = [k] | [k1, k2] — каналы проекта, в которые идёт дорожка: пара — левый → k1, правый → k2;
//                         один канал — моно (L+R)/2. Нет поля — по умолчанию (defaultRoute)
//   project.videoRoute  — то же для звука видеоклипов (если он не вынесен на аудиодорожки)
//   clip.channel        = k — клип берёт только канал k своего звукового потока (моно) — «разложить по каналам»
//
// Внутри дорожка всегда стерео (громкость, эффекты, затухания — как раньше); раскладка проекта появляется только
// на выходе дорожки: матрица «дорожка → каналы» (routeMatrix) и общий микс в N каналов.

export const LAYOUTS = ['stereo', 'mono', '5.1', '7.1', 'multi'];
export const MAX_CHANNELS = 16;
// Каналы раскладок FFmpeg (порядок — как в FFmpeg: 5.1 = FL FR FC LFE BL BR, 7.1 = FL FR FC LFE BL BR SL SR)
const FF_CH = {
  mono: ['FC'],
  stereo: ['FL', 'FR'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
};
// Подписи каналов для людей (короткие — в индикаторах и матрице)
const LABELS = {
  mono: ['M'],
  stereo: ['L', 'R'],
  '5.1': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
  '7.1': ['L', 'R', 'C', 'LFE', 'Lb', 'Rb', 'Ls', 'Rs'],
};

const int = (x, lo, hi, def) => { const v = Math.round(Number(x)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };

/** Раскладка проекта (всегда валидная): { kind, channels } */
export function layoutOf(p) {
  const L = p && p.audioLayout;
  const kind = L && LAYOUTS.includes(L.kind) ? L.kind : 'stereo';
  const channels = kind === 'multi' ? int(L.channels, 1, MAX_CHANNELS, 2) : FF_CH[kind].length;
  return { kind, channels };
}
/** Для проекта: убрать неверное, стерео — без поля */
export function cleanLayout(x) {
  if (!x || typeof x !== 'object' || !LAYOUTS.includes(x.kind) || x.kind === 'stereo') return null;
  return x.kind === 'multi' ? { kind: 'multi', channels: int(x.channels, 1, MAX_CHANNELS, 2) } : { kind: x.kind };
}
export const channelCount = (p) => layoutOf(p).channels;
export const isStereo = (p) => layoutOf(p).kind === 'stereo';
/** Короткие подписи каналов: L R C LFE … или 1 2 3 … для N моно */
export function channelLabels(p) {
  const { kind, channels } = layoutOf(p);
  return kind === 'multi' ? Array.from({ length: channels }, (_, i) => String(i + 1)) : LABELS[kind].slice();
}
/** Раскладка FFmpeg для pan=… / aformat: 'stereo' | '5.1' | '7.1' | 'mono' | '<N>c' (N моно — без имён каналов) */
export function ffLayout(p) {
  const { kind, channels } = layoutOf(p);
  return kind === 'multi' ? `${channels}c` : kind;
}

/** Маршрут по умолчанию: стерео-пара 1–2 (в моно — единственный канал) */
export function defaultRoute(p) {
  return channelCount(p) >= 2 ? [0, 1] : [0];
}
/** Проверенный маршрут: один канал или пара разных каналов в пределах раскладки; иначе — по умолчанию */
export function cleanRoute(r, p) {
  const n = channelCount(p);
  if (!Array.isArray(r) || !r.length || r.length > 2) return defaultRoute(p);
  const out = r.map((x) => Math.round(Number(x)));
  if (!out.every((x) => Number.isInteger(x) && x >= 0 && x < n)) return defaultRoute(p);
  if (out.length === 2 && out[0] === out[1]) return [out[0]];
  return out;
}
/** Маршрут дорожки (null/'video' — звук видео) */
export function routeOf(p, track) {
  const r = track === null || track === 'video' ? p.videoRoute : track && track.route;
  return cleanRoute(r, p);
}
const sameRoute = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Маршрут по умолчанию хранить не нужно */
export const isDefaultRoute = (r, p) => sameRoute(cleanRoute(r, p), defaultRoute(p));

/**
 * Матрица «стерео дорожки → N каналов»: m[k] = [gL, gR] — сколько левого и правого входа идёт в канал k.
 * Пара [a, b]: L → a, R → b. Один канал [a]: (L + R) / 2 → a.
 */
export function routeMatrix(route, n) {
  const m = Array.from({ length: n }, () => [0, 0]);
  if (route.length === 2) { m[route[0]][0] = 1; m[route[1]][1] = 1; } else { m[route[0]][0] = 0.5; m[route[0]][1] = 0.5; }
  return m;
}
/** Звено графа FFmpeg: стерео дорожки → N каналов проекта ('' — стерео в стерео [0,1], ничего делать не нужно) */
export function routePan(route, p) {
  const n = channelCount(p);
  if (n === 2 && sameRoute(route, [0, 1])) return '';
  const m = routeMatrix(route, n);
  const ch = m.map((g, k) => {
    const parts = [];
    if (g[0]) parts.push(g[0] === 1 ? 'c0' : `${g[0]}*c0`);
    if (g[1]) parts.push(g[1] === 1 ? 'c1' : `${g[1]}*c1`);
    return `c${k}=${parts.length ? parts.join('+') : '0*c0'}`;
  });
  return `pan=${ffLayout(p)}|${ch.join('|')}`;
}

/**
 * Даунмикс N каналов в стерео для прослушивания (и экспорта в стерео-формат): d[k] = [gL, gR].
 * Стандартные коэффициенты ITU (центр и тылы −3 дБ, LFE не слушаем); N моно — нечётные каналы влево, чётные вправо,
 * последний нечётный — по центру.
 */
export function downmixMatrix(p) {
  const { kind, channels } = layoutOf(p);
  const c = Math.SQRT1_2;
  if (kind === 'stereo') return [[1, 0], [0, 1]];
  if (kind === 'mono') return [[1, 1]];
  if (kind === '5.1') return [[1, 0], [0, 1], [c, c], [0, 0], [c, 0], [0, c]];
  if (kind === '7.1') return [[1, 0], [0, 1], [c, c], [0, 0], [c, 0], [0, c], [c, 0], [0, c]];
  return Array.from({ length: channels }, (_, k) => (k === channels - 1 && channels % 2 ? [c, c] : k % 2 ? [0, 1] : [1, 0]));
}
/** pan=stereo|… — даунмикс всего микса в стерео ('' — уже стерео) */
export function downmixPan(p) {
  if (isStereo(p)) return '';
  const d = downmixMatrix(p);
  const side = (s) => d.map((g, k) => (g[s] ? `${+g[s].toFixed(4)}*c${k}` : '')).filter(Boolean).join('+') || '0*c0';
  return `pan=stereo|c0=${side(0)}|c1=${side(1)}`;
}

/** Канал источника клипа: целое ≥ 0 в пределах потока (иначе undefined — весь поток) */
export function clipChannel(clip, media) {
  const k = clip && clip.channel;
  if (!Number.isInteger(k) || k < 0) return undefined;
  const n = streamChannels(media, clip.stream || 0);
  return k < n ? k : undefined;
}
/** Сколько каналов в звуковом потоке файла */
export function streamChannels(m, stream = 0) {
  if (!m) return 2;
  const s = Array.isArray(m.audioStreams) ? m.audioStreams[stream] : null;
  const n = Number((s && s.channels) || m.channels || 2);
  return Number.isFinite(n) && n >= 1 ? Math.min(64, Math.round(n)) : 2;
}
/** Звено графа: взять канал k потока и сделать из него двойное моно (стерео дорожки) */
export const channelPick = (k) => `pan=stereo|c0=c${k}|c1=c${k}`;

/**
 * Что делать со звуком в файле. mode: 'mix' — одна дорожка в раскладке проекта; 'mono' — N моно-дорожек;
 * 'stereo' — даунмикс в стерео. Кодек и контейнер ограничивают выбор (MP3 — не больше 2 каналов, AAC/Opus/Vorbis —
 * только именованные раскладки, у N моно имён нет; WAV/MP3/M4A/OGG — один поток).
 * Возвращает { mode, note? } — что получится на самом деле.
 */
export function outputMode(p, { mode = 'mix', codec = 'aac', container = 'mp4' } = {}) {
  const { kind, channels } = layoutOf(p);
  if (kind === 'stereo') return { mode: 'mix' };
  const singleStream = ['wav', 'mp3', 'm4a', 'ogg'].includes(container);
  const maxCh = codec.startsWith('mp3') ? 2 : codec.startsWith('pcm') || codec === 'flac' ? 64 : 8;
  const named = kind !== 'multi';
  const anyLayout = codec.startsWith('pcm') || codec === 'flac';
  if (mode === 'stereo') return { mode: 'stereo' };
  if (mode === 'mono' && !singleStream) return { mode: 'mono' };
  // одна многоканальная дорожка
  if (channels > maxCh) return { mode: 'stereo', note: 'channels' };
  if (!named && !anyLayout) return singleStream ? { mode: 'stereo', note: 'layout' } : { mode: 'mono', note: 'layout' };
  if (kind === 'mono') return { mode: 'mix' };
  return { mode: 'mix' };
}
