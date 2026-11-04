// Встроенные звуковые эффекты (плагин core) в декларативном виде.
// ffmpeg — фильтры экспорта (when — фильтр только при ненулевой полосе), webaudio — узлы Web Audio для плеера.
// Шумоподавления в Web Audio нет — его слышно только в готовом видео (previewOnlyExport).
import { t } from '../i18n.js';
import { registerAudioEffect, CORE } from '../registry.js';

export const CORE_AUDIO_FX = [
  {
    id: 'eq', name: t('Эквалайзер'), hint: t('Три полосы: низкие, середина, высокие'),
    params: [
      { k: 'low', name: t('Низкие (120 Гц)'), min: -15, max: 15, step: 0.5, def: 0, unit: t('дБ') },
      { k: 'mid', name: t('Середина'), min: -15, max: 15, step: 0.5, def: 0, unit: t('дБ') },
      { k: 'midF', name: t('Частота середины'), min: 200, max: 5000, step: 10, def: 1000, unit: t('Гц') },
      { k: 'high', name: t('Высокие (8 кГц)'), min: -15, max: 15, step: 0.5, def: 0, unit: t('дБ') },
    ],
    ffmpeg: [
      { filter: 'bass', when: 'low != 0', args: { g: '{low:2}', f: '120', t: 'q', w: '0.7' } },
      { filter: 'equalizer', when: 'mid != 0', args: { f: '{midF:1}', t: 'q', w: '1', g: '{mid:2}' } },
      { filter: 'treble', when: 'high != 0', args: { g: '{high:2}', f: '8000', t: 'q', w: '0.7' } },
    ],
    webaudio: [
      { node: 'biquad', type: 'lowshelf', frequency: 120, gain: '{low}' },
      { node: 'biquad', type: 'peaking', frequency: '{midF}', gain: '{mid}', Q: 1.4 },
      { node: 'biquad', type: 'highshelf', frequency: 8000, gain: '{high}' },
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
    ffmpeg: [{
      filter: 'acompressor',
      args: {
        threshold: '{max(0.000977, db(threshold))}', ratio: '{ratio:2}', attack: '{attack:1}', release: '{release:1}',
        makeup: '{max(1, db(makeup))}', knee: '2.8',
      },
    }],
    webaudio: [
      { node: 'compressor', threshold: '{threshold}', ratio: '{ratio}', knee: 6, attack: '{attack/1000}', release: '{release/1000}' },
      { node: 'gain', gain: '{db(makeup)}' },
    ],
  },
  {
    id: 'denoise', name: t('Шумоподавление'), hint: t('Убирает ровный фоновый шум (гул, шипение)'), previewOnlyExport: true,
    params: [
      { k: 'strength', name: t('Сила'), min: 3, max: 40, step: 1, def: 12, unit: t('дБ') },
      { k: 'floor', name: t('Уровень шума'), min: -80, max: -20, step: 1, def: -50, unit: t('дБ') },
    ],
    ffmpeg: [{ filter: 'afftdn', args: { nr: '{strength:1}', nf: '{floor:1}' } }],
  },
];

for (const d of CORE_AUDIO_FX) registerAudioEffect(d, CORE);
