// Встроенные стили текстовых блоков (плагин core, M5.3): заголовок, нижняя плашка, подпись, титры, простой текст.
// Остальное — плагинами (contributes.textStyles / ffm.register.textStyle). Поля оформления — js/textModel.js.
import { t } from '../i18n.js';
import { registerTextStyle, CORE } from '../registry.js';

export const CORE_TEXT_STYLES = [
  {
    id: 'title', kind: 'title', name: t('Заголовок'), duration: 4,
    text: { content: t('Заголовок'), size: 0.11, weight: 800, shadowOpacity: 0.45, shadowBlur: 0.2, shadowX: 0, shadowY: 0.05 },
  },
  {
    id: 'lower-third', kind: 'lower', name: t('Нижняя плашка'), duration: 5,
    text: {
      content: [t('Имя Фамилия'), t('должность')].join('\n'), size: 0.045, weight: 600, align: 'left', lineHeight: 1.3, wrap: 0.6,
      box: true, boxColor: '#14202c', boxOpacity: 0.8, boxPad: 0.55, boxRadius: 0.15,
    },
    transform: { x: -0.24, y: 0.3 },
  },
  {
    id: 'caption', kind: 'caption', name: t('Подпись'), duration: 3,
    text: { content: t('Подпись к кадру'), size: 0.055, weight: 600, strokeWidth: 0.1, strokeColor: '#000000' },
    transform: { y: 0.36 },
  },
  {
    id: 'credits', kind: 'credits', name: t('Титры'), duration: 12,
    text: {
      content: [t('Режиссёр'), t('Имя Фамилия'), '', t('Оператор'), t('Имя Фамилия'), '', t('Монтаж'), 'FF Montage'].join('\n'),
      size: 0.045, weight: 500, lineHeight: 1.45, motion: 'roll', wrap: 0.8,
    },
  },
  {
    id: 'plain', kind: 'other', name: t('Простой текст'), duration: 5,
    text: { content: t('Текст'), size: 0.07, weight: 500 },
  },
];

for (const d of CORE_TEXT_STYLES) registerTextStyle(d, CORE);
