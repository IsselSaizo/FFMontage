// Панель над плеером: только иконки, настройки — во всплывающих панельках.
//   Клип:   кадрирование (режим в плеере) · подгонка (вписать / заполнить / растянуть)
//   Проект: формат кадра · фон
import { store, ASPECTS } from './store.js';
import { h, $, icon, toast } from './util.js';
import { attachPopover } from './popover.js';

const ASPECT_LIST = [
  ['auto', 'Как у видео'], ['16:9', '16:9 — горизонтальное'], ['9:16', '9:16 — вертикальное'],
  ['1:1', '1:1 — квадрат'], ['4:3', '4:3'], ['3:4', '3:4'],
];
const FITS = [
  ['contain', 'Вписать', 'Весь кадр виден, по краям — поля цвета фона'],
  ['cover', 'Заполнить', 'Без полей, лишнее по краям обрезается'],
  ['stretch', 'Растянуть', 'На весь кадр без сохранения пропорций'],
];
const BG_SWATCHES = [['#000000', 'Чёрный'], ['#ffffff', 'Белый'], ['#1f1f24', 'Тёмно-серый'], ['#808080', 'Серый'], ['#00b140', 'Зелёный (хромакей)'], ['#0047bb', 'Синий (хромакей)']];

// Маленькая картинка пропорций для кнопки формата
function aspectShape(id) {
  const ar = ASPECTS[id] || 16 / 9;
  const w = ar >= 1 ? 22 : Math.round(22 * ar);
  const hh = ar >= 1 ? Math.round(22 / ar) : 22;
  return h('span', { class: 'asp-shape', style: { width: `${w}px`, height: `${hh}px` } }, id === 'auto' ? h('span', { class: 'asp-auto' }, 'A') : null);
}

// Выделенный видеоклип (или null)
function selectedVideo() {
  const s = store.selection;
  if (!s || s.kind === 'transition') return null;
  const f = store.findClip(s.id);
  return f && f.kind === 'video' ? f.clip : null;
}

export function initViewbar() {
  const root = $('#viewbar');
  const ib = (name, title, cls = '') => h('button', { class: `vb-btn ${cls}`.trim(), title, 'aria-label': title, html: icon(name, 18) });

  // --- Клип ---
  const cropBtn = ib('crop', 'Кадрирование: обрезать края клипа (щелчок — режим в плеере)', 'vb-crop');
  cropBtn.addEventListener('click', () => {
    const c = selectedVideo();
    if (!c) return;
    store.emit('crop-mode', c.id);
  });

  const fitBtn = ib('fitframe', 'Подгонка клипа под формат кадра', 'vb-fit');
  const fitPop = attachPopover(fitBtn, () => {
    const c = selectedVideo();
    if (!c) return h('p', { class: 'muted small' }, 'Выберите видеоклип на таймлайне.');
    const cur = c.fit || 'contain';
    return h('div', { class: 'pop-body' },
      h('div', { class: 'pop-title' }, 'Подгонка клипа'),
      ...FITS.map(([id, name, hint]) => h('button', {
        class: `pop-option${cur === id ? ' on' : ''}`, dataset: { fit: id },
        onclick: () => store.setFit([c.id], id),
      }, h('span', { class: `fit-demo fit-${id}` }, h('span')), h('span', { class: 'po-text' }, h('b', {}, name), h('span', { class: 'muted small' }, hint)))),
      h('div', { class: 'pop-sep' }),
      h('button', {
        class: 'btn ghost small wide-left', dataset: { act: 'fit-all' },
        onclick: () => {
          store.setFit(store.project.videoClips.map((x) => x.id), cur);
          toast(`Подгонка «${FITS.find((f) => f[0] === cur)[1]}» — для всех видеоклипов`, 'success', 2200);
        },
      }, 'Применить ко всем видеоклипам'));
  }, { align: 'left' });

  // --- Проект ---
  const aspectBtn = ib('aspect', 'Формат кадра проекта', 'vb-aspect');
  const aspectPop = attachPopover(aspectBtn, () => {
    const asp = store.project.aspect || 'auto';
    const f = store.sourceFormat();
    return h('div', { class: 'pop-body' },
      h('div', { class: 'pop-title' }, 'Формат кадра'),
      h('div', { class: 'asp-grid' }, ...ASPECT_LIST.map(([id, name]) => h('button', {
        class: `asp-tile${asp === id ? ' on' : ''}`, dataset: { aspect: id }, title: name,
        onclick: () => store.setProjectProps({ aspect: id }),
      }, aspectShape(id), h('span', {}, id === 'auto' ? 'Как у видео' : id)))),
      h('p', { class: 'muted small' }, f.fromClip ? `Сейчас: ${f.width}×${f.height}, ${f.fps} fps` : 'Размер возьмётся из видео на таймлайне.'));
  });

  const bgDot = h('span', { class: 'vb-dot' });
  const bgBtn = ib('palette', 'Фон кадра: поля, пустоты, затухания', 'vb-bg');
  bgBtn.append(bgDot);
  const bgPop = attachPopover(bgBtn, () => {
    const bgc = store.background();
    const color = h('input', { type: 'color', value: bgc, class: 'color-input', id: 'bg-color', title: 'Свой цвет' });
    color.addEventListener('change', () => store.setProjectProps({ background: color.value === '#000000' ? null : color.value }));
    return h('div', { class: 'pop-body' },
      h('div', { class: 'pop-title' }, 'Фон'),
      h('div', { class: 'row gap' }, color,
        h('div', { class: 'presets' }, ...BG_SWATCHES.map(([c, n]) => h('button', {
          class: `swatch${bgc === c ? ' on' : ''}`, title: n, style: { background: c }, dataset: { bg: c },
          onclick: () => store.setProjectProps({ background: c === '#000000' ? null : c }),
        })))),
      h('p', { class: 'muted small' }, 'Виден по краям вписанных клипов, в пустотах между клипами и при затухании.'));
  }, { align: 'right' });

  const info = h('span', { class: 'vb-info' });
  root.append(
    h('div', { class: 'vb-side' }, h('span', { class: 'vb-title' }, 'Предпросмотр')),
    h('div', { class: 'vb-tools' },
      h('div', { class: 'vb-group', title: '' }, cropBtn, fitBtn),
      h('div', { class: 'vb-sep' }),
      h('div', { class: 'vb-group' }, aspectBtn, bgBtn)),
    h('div', { class: 'vb-side right' }, info));

  const update = () => {
    const c = selectedVideo();
    for (const b of [cropBtn, fitBtn]) {
      b.disabled = !c;
      b.classList.toggle('needs-clip', !c);
    }
    cropBtn.title = c ? 'Кадрирование: обрезать края клипа' : 'Кадрирование — выберите видеоклип';
    fitBtn.title = c ? 'Подгонка клипа под формат кадра' : 'Подгонка — выберите видеоклип';
    fitBtn.classList.toggle('active', !!c && !!c.fit);
    cropBtn.classList.toggle('active', !!c && !!c.crop);
    bgDot.style.background = store.background();
    const f = store.sourceFormat();
    info.textContent = `${f.width} × ${f.height} · ${f.fps} fps`;
    aspectBtn.classList.toggle('active', !!store.project.aspect);
    for (const p of [fitPop, aspectPop, bgPop]) if (p.isOpen) p.refresh();
    if (!c && fitPop.isOpen) fitPop.close();
  };
  store.on('project', update);
  store.on('selection', update);
  store.on('media', update);
  update();
  return { update };
}
