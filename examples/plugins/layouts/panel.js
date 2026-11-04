// Панель: плитки раскладок с маленькой схемой кадра
import { LAYOUTS } from './layouts.js';
import { applyLayout } from './apply.js';

const ru = ffm.lang === 'ru';
document.getElementById('hint').textContent = ru
  ? 'Работает с клипами под курсором: нижняя видеодорожка — первый слот, выше — следующие. Отменяется Ctrl+Z.'
  : 'Uses the clips under the playhead: the bottom video track fills the first slot, higher tracks the next ones. Undo with Ctrl+Z.';

const grid = document.getElementById('tiles');
for (const L of LAYOUTS) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.dataset.layout = L.id;
  b.title = ru ? L.ru : L.en;
  const scheme = document.createElement('div');
  scheme.className = 'scheme';
  const slots = L.id.startsWith('pip-') ? [{ x: 0, y: 0, scale: 1 }, L.slots[1]] : L.slots;
  slots.forEach((s, i) => {
    const r = document.createElement('i');
    const w = 100 * s.scale; const h = 100 * s.scale;
    Object.assign(r.style, { width: `${w}%`, height: `${h}%`, left: `${50 + 100 * s.x - w / 2}%`, top: `${50 + 100 * s.y - h / 2}%`, opacity: String(1 - i * 0.12) });
    scheme.append(r);
  });
  b.append(scheme, Object.assign(document.createElement('span'), { textContent: ru ? L.ru : L.en }));
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await applyLayout(L.id); } finally { b.disabled = false; }
  });
  grid.append(b);
}

ffm.ready();
