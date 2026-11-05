// Встроенные цели нормализации громкости (плагин core, 0.5.0): loudnorm в 2 прохода при экспорте.
// i — интегральная громкость (LUFS), tp — максимальный истинный пик (dBTP), lra — диапазон громкости (LU).
// Плагины добавляют свои цели так же (contributes.loudnessTargets / ffm.register.loudnessTarget).
import { t } from '../i18n.js';
import { registerLoudnessTarget, CORE } from '../registry.js';

export const CORE_LOUDNESS_TARGETS = [
  { id: 'web', name: t('Интернет: −14 LUFS (YouTube, Spotify)'), hint: t('Стриминговые площадки сами приводят звук к −14 LUFS — так ролик не станет тише или громче чужих.'), i: -14, tp: -1, lra: 11 },
  { id: 'podcast', name: t('Подкаст, голос: −16 LUFS'), hint: t('Рекомендация Apple Podcasts и большинства площадок для речи.'), i: -16, tp: -1.5, lra: 11 },
  { id: 'broadcast', name: t('Эфир: −23 LUFS (EBU R128)'), hint: t('Телевидение и радио в Европе и России; пик не выше −1 dBTP.'), i: -23, tp: -1, lra: 15 },
];

for (const d of CORE_LOUDNESS_TARGETS) registerLoudnessTarget(d, CORE);
