// Эффекты клипа: экспорт — фильтр FFmpeg (до масштабирования, на исходных пикселях),
// предпросмотр — CSS filter на элементе видео. Клип хранит список id: clip.effects = ['bw', 'blur'].
// blur в FFmpeg задаётся долей ширины кадра, чтобы предпросмотр (CSS-пиксели) совпадал при любом размере окна.

export const EFFECTS = [
  { id: 'bw', name: 'Чёрно-белое', ff: () => 'hue=s=0', css: () => 'grayscale(1)' },
  { id: 'sepia', name: 'Сепия', ff: () => 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131', css: () => 'sepia(1)' },
  { id: 'invert', name: 'Негатив', ff: () => 'negate', css: () => 'invert(1)' },
  { id: 'contrast', name: 'Контраст', ff: () => 'eq=contrast=1.35', css: () => 'contrast(1.35)' },
  { id: 'bright', name: 'Ярче', ff: () => 'eq=brightness=0.1', css: () => 'brightness(1.25)' },
  { id: 'saturate', name: 'Сочнее', ff: () => 'eq=saturation=1.7', css: () => 'saturate(1.7)' },
  { id: 'fade', name: 'Блёклый', ff: () => 'eq=saturation=0.45:contrast=0.85', css: () => 'saturate(0.45) contrast(0.85)' },
  // sigma = 0.6% ширины кадра; CSS blur(px) ≈ sigma в пикселях показанного кадра
  { id: 'blur', name: 'Размытие', ff: (w) => `gblur=sigma=${Math.max(1, (w || 1920) * 0.006).toFixed(2)}`, css: (w) => `blur(${Math.max(0.5, (w || 640) * 0.006).toFixed(2)}px)` },
];

export const effectById = (id) => EFFECTS.find((e) => e.id === id);
export const clipEffects = (c) => (Array.isArray(c && c.effects) ? c.effects.filter((id) => effectById(id)) : []);

// Цепочка фильтров FFmpeg ('' — эффектов нет). srcW — ширина исходного кадра
export function ffEffects(c, srcW) {
  const list = clipEffects(c).map((id) => effectById(id).ff(srcW));
  return list.length ? `${list.join(',')},` : '';
}

// CSS filter для предпросмотра. shownW — ширина показанного кадра в CSS-пикселях
export function cssEffects(c, shownW, extra = []) {
  return clipEffects(c).map((id) => effectById(id).css(shownW)).concat(extra).join(' ');
}
