// JKL-шаттл (0.4.3), как в Premiere / Resolve:
//   L — вперёд; ещё раз L — быстрее (×1 → ×2 → ×4 → ×8); J — то же назад; K — стоп.
//   K удерживается + J / L — шаг на кадр назад / вперёд.
// Вперёд играет сам плеер (preview.setRate), назад — шаттл двигает курсор по кадрам (видео в WebView назад не играет).
import { store } from './store.js';
import { h } from './util.js';
import { getLang } from './i18n.js';

const RATES = [1, 2, 4, 8];

export function initShuttle(preview) {
  let rate = 0;        // 0 — стоит; > 0 — вперёд; < 0 — назад
  let raf = 0; let last = 0;
  let kHeld = null;    // код клавиши, которой нажали «стоп» (пока держат — J/L шагают по кадрам)
  const badge = h('div', { class: 'shuttle-badge', id: 'shuttle-badge' });
  preview.stage.append(badge);
  const fmt = (r) => { const s = `×${Math.abs(r)}`; return getLang() === 'ru' ? s.replace('.', ',') : s; };
  const show = () => {
    const on = rate !== 0 && rate !== 1; // обычное воспроизведение (×1 вперёд) — без значка
    badge.textContent = rate > 0 ? `▶▶ ${fmt(rate)}` : rate < 0 ? `◀◀ ${fmt(rate)}` : '';
    badge.classList.toggle('on', on);
    store.emit('shuttle', rate);
  };
  const stopReverse = () => { cancelAnimationFrame(raf); raf = 0; };
  const reverseTick = () => {
    const now = performance.now();
    const dt = (now - last) / 1000; last = now;
    const nt = store.time + dt * rate;
    if (nt <= 0) { store.setTime(0); set(0); return; }
    store.setTime(nt);
    raf = requestAnimationFrame(reverseTick);
  };
  function set(r) {
    rate = r;
    if (r > 0) {
      stopReverse();
      preview.setRate(r);
      if (!preview.playing) preview.play();
    } else if (r < 0) {
      if (preview.playing) preview.pause();
      preview.setRate(1);
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(reverseTick); }
    } else {
      stopReverse();
      if (preview.playing) preview.pause();
      preview.setRate(1);
    }
    show();
  }
  const next = (r) => RATES[Math.min(RATES.length - 1, RATES.indexOf(Math.abs(r)) + 1)];
  const step = () => 1 / (store.sourceFormat().fps || 30);

  // Остановка извне (пробел, конец ролика, переключение эпизода) — сбросить шаттл
  store.on('playstate', (playing) => { if (!playing && rate > 0) { rate = 0; preview.setRate(1); show(); } });
  store.on('request-pause', () => { if (rate < 0) set(0); });
  window.addEventListener('keyup', (e) => { if (kHeld && e.code === kHeld) kHeld = null; });
  window.addEventListener('blur', () => { kHeld = null; });

  return {
    get rate() { return rate; },
    // Автоповтор зажатой клавиши не разгоняет шаттл (в режиме «K + J/L» — шагает по кадрам)
    forward(e) {
      if (kHeld) { if (rate) set(0); store.setTime(store.time + step()); return; }
      if (e && e.repeat) return;
      set(rate <= 0 ? 1 : next(rate));
    },
    back(e) {
      if (kHeld) { if (rate) set(0); store.setTime(store.time - step()); return; }
      if (e && e.repeat) return;
      set(rate >= 0 ? -1 : -next(rate));
    },
    stop(e) {
      if (e && e.repeat) return;
      kHeld = e && e.code ? e.code : null;
      set(0);
    },
    /** Для автотестов и MCP: поставить скорость напрямую (−8…8) */
    set: (r) => set(Math.max(-8, Math.min(8, Number(r) || 0))),
  };
}
