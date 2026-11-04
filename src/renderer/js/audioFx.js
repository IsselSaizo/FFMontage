// Звуковые эффекты клипа и дорожки: описание, параметры по умолчанию и фильтры FFmpeg.
// В проекте: clip.afx / track.afx = [{ type: 'eq' | 'comp' | 'denoise', on: true, p: { ...параметры } }]
// Модуль без DOM — его используют окно (стойка эффектов, Web Audio в плеере) и сборка экспорта.
// Остальные эффекты появятся плагинами.
import { t } from './i18n.js';

export const AUDIO_FX = [
  {
    id: 'eq', name: t('Эквалайзер'), hint: t('Три полосы: низкие, середина, высокие'),
    params: [
      { k: 'low', name: t('Низкие (120 Гц)'), min: -15, max: 15, step: 0.5, def: 0, unit: t('дБ') },
      { k: 'mid', name: t('Середина'), min: -15, max: 15, step: 0.5, def: 0, unit: t('дБ') },
      { k: 'midF', name: t('Частота середины'), min: 200, max: 5000, step: 10, def: 1000, unit: t('Гц') },
      { k: 'high', name: t('Высокие (8 кГц)'), min: -15, max: 15, step: 0.5, def: 0, unit: t('дБ') },
    ],
  },
  {
    id: 'comp', name: t('Компрессор'), hint: t('Выравнивает громкость: тихое громче, громкое тише'),
    params: [
      { k: 'threshold', name: t('Порог'), min: -60, max: 0, step: 1, def: -18, unit: t('дБ') },
      { k: 'ratio', name: t('Степень'), min: 1, max: 20, step: 0.5, def: 4, unit: ':1' },
      { k: 'attack', name: t('Атака'), min: 1, max: 200, step: 1, def: 20, unit: t('мс') },
      { k: 'release', name: t('Восстановление'), min: 10, max: 1000, step: 10, def: 250, unit: t('мс') },
      { k: 'makeup', name: t('Усиление'), min: 0, max: 24, step: 0.5, def: 0, unit: t('дБ') },
    ],
  },
  {
    id: 'denoise', name: t('Шумоподавление'), hint: t('Убирает ровный фоновый шум (гул, шипение)'), previewOnlyExport: true,
    params: [
      { k: 'strength', name: t('Сила'), min: 3, max: 40, step: 1, def: 12, unit: t('дБ') },
      { k: 'floor', name: t('Уровень шума'), min: -80, max: -20, step: 1, def: -50, unit: t('дБ') },
    ],
  },
];

export const fxDef = (type) => AUDIO_FX.find((x) => x.id === type) || null;

export function newAudioFx(type) {
  const d = fxDef(type);
  if (!d) return null;
  return { type, on: true, p: Object.fromEntries(d.params.map((x) => [x.k, x.def])) };
}

// Значение параметра с проверкой границ (старые/чужие проекты)
export function fxParam(fx, k) {
  const d = fxDef(fx.type);
  const pd = d && d.params.find((x) => x.k === k);
  if (!pd) return 0;
  const v = Number(fx.p && fx.p[k]);
  return Number.isFinite(v) ? Math.min(pd.max, Math.max(pd.min, v)) : pd.def;
}

export const activeFx = (list) => (Array.isArray(list) ? list.filter((x) => x && x.on !== false && fxDef(x.type)) : []);

const dB = (x) => 10 ** (x / 20);
const n = (x, d = 6) => Number(x).toFixed(d);

// Цепочка фильтров FFmpeg: '' или ',фильтр1,фильтр2'
export function ffAudioFx(list) {
  const out = [];
  for (const fx of activeFx(list)) {
    const p = (k) => fxParam(fx, k);
    if (fx.type === 'eq') {
      if (p('low')) out.push(`bass=g=${n(p('low'), 2)}:f=120:t=q:w=0.7`);
      if (p('mid')) out.push(`equalizer=f=${n(p('midF'), 1)}:t=q:w=1:g=${n(p('mid'), 2)}`);
      if (p('high')) out.push(`treble=g=${n(p('high'), 2)}:f=8000:t=q:w=0.7`);
    } else if (fx.type === 'comp') {
      out.push(`acompressor=threshold=${n(Math.max(0.000977, dB(p('threshold'))))}:ratio=${n(p('ratio'), 2)}` +
        `:attack=${n(p('attack'), 1)}:release=${n(p('release'), 1)}:makeup=${n(Math.max(1, dB(p('makeup'))))}:knee=2.8`);
    } else if (fx.type === 'denoise') {
      out.push(`afftdn=nr=${n(p('strength'), 1)}:nf=${n(p('floor'), 1)}`);
    }
  }
  return out.length ? `,${out.join(',')}` : '';
}

// Подпись для списка: «Эквалайзер, Компрессор»
export const fxSummary = (list) => activeFx(list).map((x) => fxDef(x.type).name).join(', ');
