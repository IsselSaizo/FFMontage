// Время клипа: таймлайн ↔ файл с учётом скорости.
//   in/out  — фрагмент ФАЙЛА (секунды исходника)
//   start   — где клип стоит на ТАЙМЛАЙНЕ
//   speed   — скорость (0.1…16, нет поля — 1): клип на таймлайне длится (out − in) / speed
// Модуль без зависимостей — его используют и окно, и сборка экспорта в автотестах.
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4, 8, 16];

export const speedOf = (c) => {
  const s = Number(c && c.speed);
  return s > 0 && Number.isFinite(s) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, s)) : 1;
};
export const srcLen = (c) => c.out - c.in;
export const tlLen = (c) => (c.out - c.in) / speedOf(c);
export const clipEnd = (c) => c.start + (c.out - c.in) / speedOf(c);
// Момент файла, который виден в момент t таймлайна
export const srcAt = (c, t) => c.in + (t - c.start) * speedOf(c);
// Момент таймлайна, на котором показывается момент файла src
export const tlAt = (c, src) => c.start + (src - c.in) / speedOf(c);

// Цепочка atempo для FFmpeg: один фильтр принимает 0.5…100, ниже 0.5 — несколько подряд
export function atempoChain(s) {
  if (Math.abs(s - 1) < 1e-6) return '';
  const parts = [];
  let r = s;
  while (r < 0.5 - 1e-9) { parts.push(0.5); r /= 0.5; }
  while (r > 100 + 1e-9) { parts.push(100); r /= 100; }
  parts.push(r);
  return parts.map((x) => `atempo=${Number(x).toFixed(6)}`).join(',');
}

// «×1,5» — для подписей
export const fmtSpeed = (s) => `×${String(Math.round(s * 100) / 100).replace('.', ',')}`;
