// Встроенные видеоэффекты (плагин core) в декларативном виде — так же их описывает и плагин.
// Экспорт — фильтр FFmpeg до масштабирования (на исходных пикселях), предпросмотр — CSS filter.
// blur в FFmpeg задаётся долей ширины кадра w, чтобы предпросмотр (CSS-пиксели) совпадал при любом размере окна.
import { t } from '../i18n.js';
import { registerEffect, CORE } from '../registry.js';

export const CORE_EFFECTS = [
  { id: 'bw', name: t('Чёрно-белое'), ffmpeg: [{ filter: 'hue', args: { s: '0' } }], css: 'grayscale(1)' },
  {
    id: 'sepia', name: t('Сепия'),
    ffmpeg: [{ filter: 'colorchannelmixer', args: ['.393', '.769', '.189', '0', '.349', '.686', '.168', '0', '.272', '.534', '.131'] }],
    css: 'sepia(1)',
  },
  { id: 'invert', name: t('Негатив'), ffmpeg: [{ filter: 'negate' }], css: 'invert(1)' },
  { id: 'contrast', name: t('Контраст'), ffmpeg: [{ filter: 'eq', args: { contrast: '1.35' } }], css: 'contrast(1.35)' },
  { id: 'bright', name: t('Ярче'), ffmpeg: [{ filter: 'eq', args: { brightness: '0.1' } }], css: 'brightness(1.25)' },
  { id: 'saturate', name: t('Сочнее'), ffmpeg: [{ filter: 'eq', args: { saturation: '1.7' } }], css: 'saturate(1.7)' },
  { id: 'fade', name: t('Блёклый'), ffmpeg: [{ filter: 'eq', args: { saturation: '0.45', contrast: '0.85' } }], css: 'saturate(0.45) contrast(0.85)' },
  // sigma = 0.6% ширины кадра; CSS blur(px) ≈ sigma в пикселях показанного кадра
  { id: 'blur', name: t('Размытие'), ffmpeg: [{ filter: 'gblur', args: { sigma: '{max(1, w*0.006):2}' } }], css: 'blur({max(0.5, w*0.006):2}px)' },
];

for (const d of CORE_EFFECTS) registerEffect(d, CORE);
