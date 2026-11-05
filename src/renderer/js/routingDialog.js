// Каналы проекта и маршруты дорожек (0.5.1): раскладка (стерео / моно / 5.1 / 7.1 / N моно) и матрица
// «дорожка → каналы». Модель — audioLayout.js, операции — store.setAudioLayout / setTrackRoute.
// Щелчок по ячейке: канал есть в маршруте — убрать (последний не убирается); один канал — добавить второй (пара:
// левый → меньший номер, правый → больший); пара — заменить одним этим каналом (моно, L+R).
import { store } from './store.js';
import { h, icon } from './util.js';
import { t } from './i18n.js';
import { layoutOf, channelLabels, routeOf, MAX_CHANNELS } from './audioLayout.js';

let openOverlay = null;

const LAYOUT_NAMES = () => [
  { id: 'stereo', label: t('Стерео (2 канала)') },
  { id: 'mono', label: t('Моно (1 канал)') },
  { id: '5.1', label: t('5.1 (6 каналов: L R C LFE Ls Rs)') },
  { id: '7.1', label: t('7.1 (8 каналов)') },
  { id: 'multi', label: t('Отдельные моно-каналы (N)') },
];

/** Новый маршрут после щелчка по каналу k */
export function toggleRoute(route, k) {
  if (route.includes(k)) return route.length > 1 ? route.filter((x) => x !== k) : route;
  if (route.length === 1) return [route[0], k].sort((a, b) => a - b);
  return [k];
}

export function openRouting() {
  if (openOverlay) return;
  const body = h('div', { class: 'modal-body' });
  const close = () => { off(); overlay.remove(); openOverlay = null; };
  const render = () => {
    body.innerHTML = '';
    const p = store.project;
    const lay = layoutOf(p);
    const labels = channelLabels(p);
    const n = lay.channels;
    // Раскладка
    const sel = h('select', { class: 'input', id: 'routing-layout' }, ...LAYOUT_NAMES().map((x) => h('option', { value: x.id, selected: x.id === lay.kind }, x.label)));
    sel.addEventListener('change', () => store.setAudioLayout(sel.value === 'multi' ? { kind: 'multi', channels: Math.max(2, n) } : { kind: sel.value }));
    const addCh = h('button', {
      class: 'btn ghost small', id: 'routing-add-channel', disabled: n >= MAX_CHANNELS,
      title: lay.kind === 'multi' ? t('Добавить канал') : t('Добавить канал: раскладка станет «отдельные моно-каналы» (имена L/R/C пропадут, маршруты сохранятся)'),
      onclick: () => store.setAudioLayout({ kind: 'multi', channels: Math.min(MAX_CHANNELS, n + 1) }),
    }, t('+ канал'));
    const delCh = lay.kind === 'multi' && n > 1 ? h('button', {
      class: 'btn ghost small', title: t('Убрать последний канал (маршруты в него сбросятся)'),
      onclick: () => store.setAudioLayout({ kind: 'multi', channels: n - 1 }),
    }, t('− канал')) : null;
    body.append(h('div', { class: 'row gap' }, h('span', { class: 'muted' }, t('Каналы проекта')), sel, addCh, delCh));
    // Матрица
    const rows = [{ id: 'video', name: t('Звук видео'), track: null }, ...p.audioTracks.map((tr, i) => ({ id: tr.id, name: tr.name || t('Аудио {n}', { n: i + 1 }), track: tr }))];
    const grid = h('div', { class: 'route-grid', style: { gridTemplateColumns: `minmax(90px, 160px) repeat(${n}, minmax(30px, 1fr))` } });
    grid.append(h('span', {}), ...labels.map((l) => h('span', { class: 'rg-head' }, l)));
    for (const row of rows) {
      const route = routeOf(p, row.track || 'video');
      grid.append(h('span', { class: 'rg-name', title: row.name }, row.name));
      for (let k = 0; k < n; k++) {
        const at = route.indexOf(k);
        const mark = at < 0 ? '' : route.length === 1 ? 'M' : at === 0 ? 'L' : 'R';
        grid.append(h('button', {
          class: at < 0 ? '' : 'on', dataset: { route: `${row.id}:${k}` },
          title: at < 0 ? t('Направить в канал {ch}', { ch: labels[k] }) : mark === 'M' ? t('Моно (L+R) в канал {ch}', { ch: labels[k] }) : t('{side} → канал {ch}', { side: mark, ch: labels[k] }),
          onclick: () => store.setTrackRoute(row.id, toggleRoute(route, k)),
        }, mark));
      }
    }
    body.append(grid,
      h('p', { class: 'muted small' }, t('L / R — левый и правый канал дорожки, M — дорожка сведена в моно. Щелчок: добавить второй канал, убрать или заменить одним. Плеер слушает даунмикс в стерео; в экспорт уходят все каналы (MOV/MKV/MXF/WAV — PCM, MP4 — AAC до 8 каналов).')));
    if (n !== 2 || lay.kind !== 'stereo') {
      body.append(h('p', { class: 'muted small' }, t('Многоканальный клип можно разложить по каналам: правый щелчок по клипу → «Разложить по каналам».')));
    }
  };
  const off = store.on('project', render);
  const overlay = h('div', { class: 'modal-overlay', id: 'routing-dialog' },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, t('Каналы и маршруты звука')), h('button', { class: 'icon-btn', onclick: close, html: icon('close', 18) })),
      body,
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: close }, t('Готово')))));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  document.body.append(overlay);
  openOverlay = overlay;
  render();
}
