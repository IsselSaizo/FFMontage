// Логика плагина: выполняется в скрытой песочнице. Здесь — обработчик действия «Статистика проекта».
// window.ffm даёт SDK (его подключает сама программа).
import { stats, fmt } from './stats.js';

const ru = ffm.lang === 'ru';

ffm.on('action', async ({ id }) => {
  if (id !== 'show') return;
  const s = stats(await ffm.project.get());
  await ffm.ui.notify(ru
    ? `Клипов: ${s.videoClips} видео, ${s.audioClips} звук · длина ${fmt(s.duration)}`
    : `Clips: ${s.videoClips} video, ${s.audioClips} audio · length ${fmt(s.duration)}`);
});

ffm.ready();
