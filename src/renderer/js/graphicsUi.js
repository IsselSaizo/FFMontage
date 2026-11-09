// Интерфейс встроенных видов графических клипов (реестр — graphics.js, поле ui):
//   badge(clip)  → { text | icon, tip } — значок в подписи клипа на таймлайне
//   strip(clip)  → элемент полосы клипа на таймлайне (вместо плёнки)
//   inspector(ui, sel) — панель «Свойства» (ui — помощники inspector.js)
//   edit         → { label(), icon } — пункт контекстного меню «изменить»
// Раздел инспектора для store.emit('focus-inspector', …) — kind вида.
import { h, icon } from './util.js';
import { t } from './i18n.js';
import { registerGraphic, graphicOf } from './graphicKinds.js';
import { fontFamilies } from './textRender.js';
import { cleanShape } from './shapes.js';
import { cleanTimer } from './timer.js';
import { tlLen } from './clipTime.js';
import { renderTextClip, renderShapeClip, renderTimerClip } from './textInspector.js';

registerGraphic('text', {
  ui: {
    badge: () => ({ text: 'T', tip: t('Текст — двойной щелчок, чтобы изменить') }),
    // Образец оформления (цвет, жирность, курсив) вместо плёнки
    strip: (c) => {
      const tx = c.text || {};
      return h('div', { class: 'text-strip', style: { color: tx.color || '#fff', fontWeight: String(tx.weight || 700), fontStyle: tx.italic ? 'italic' : '', fontFamily: fontFamilies(tx.font || 'Inter') } },
        (tx.content || '').replace(/\s*\n\s*/g, ' · '));
    },
    inspector: renderTextClip,
    edit: { label: () => t('Изменить текст'), icon: 'rename' },
  },
});

registerGraphic('shape', {
  ui: {
    badge: () => ({ text: '◆', tip: t('Фигура — двойной щелчок, чтобы изменить') }),
    // Полоса цвета заливки (или контура, если заливки нет)
    strip: (c) => {
      const sh = cleanShape(c.shape);
      const col = sh.fillOpacity > 0 ? sh.fill : sh.stroke;
      return h('div', { class: 'text-strip shape-strip', style: { background: `linear-gradient(90deg, ${col}cc, ${col}55)` } });
    },
    inspector: renderShapeClip,
    edit: { label: () => t('Изменить фигуру'), icon: 'rename' },
  },
});

registerGraphic('timer', {
  ui: {
    badge: () => ({ icon: 'timer', tip: t('Таймер — двойной щелчок, чтобы настроить') }),
    // Полоса отсчёта (цвета корпуса и сектора), после неё — звонок (штриховка цветом акцента) или пусто
    strip: (c) => {
      const tm = cleanTimer(c.timer);
      const rest = Math.max(0, Math.min(1, (tlLen(c) - tm.duration) / Math.max(0.01, tlLen(c))));
      const at = Math.round((1 - rest) * 100);
      const { case: cs, fill, accent } = tm.colors;
      const after = tm.ring === 'none' ? 'transparent' : `${accent}55`;
      const bg = `linear-gradient(90deg, ${cs}cc, ${fill}99 ${at}%, ${after} ${at}%)`
        + (tm.ring === 'none' ? '' : `, repeating-linear-gradient(135deg, transparent 0 6px, ${accent}66 6px 9px)`);
      return h('div', { class: 'text-strip shape-strip timer-strip', style: { background: bg, backgroundBlendMode: 'normal' } });
    },
    inspector: renderTimerClip,
    edit: { label: () => t('Настроить таймер'), icon: 'timer' },
  },
});

/** Значок вида в подписи клипа (или null) */
export function graphicBadge(c) {
  const g = graphicOf(c);
  const b = g && g.ui.badge ? g.ui.badge(c) : null;
  if (!b) return null;
  return b.icon
    ? h('span', { class: 'ci fx', title: b.tip || '', html: icon(b.icon, 13) })
    : h('span', { class: 'ci fxb', title: b.tip || '' }, b.text || '•');
}
