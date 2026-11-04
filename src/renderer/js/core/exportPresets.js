// Встроенные пресеты экспорта (плагин core): размер кадра, частота, при желании кодек ('av1' | 'hevc' | 'h264')
// и качество ('high' | 'medium' | 'compact'). Без пресета окно экспорта предлагает размеры от исходника.
import { t } from '../i18n.js';
import { registerExportPreset, CORE } from '../registry.js';

export const CORE_EXPORT_PRESETS = [
  { id: 'hd-1080', name: t('Горизонтальное Full HD (YouTube)'), width: 1920, height: 1080, fps: 30 },
  { id: 'vertical-1080', name: t('Вертикальное Full HD (Shorts, Reels, TikTok)'), width: 1080, height: 1920, fps: 30 },
  { id: 'uhd-2160', name: '4K UHD', width: 3840, height: 2160, fps: 30 },
];

for (const d of CORE_EXPORT_PRESETS) registerExportPreset(d, CORE);
