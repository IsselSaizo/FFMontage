// Геймпад (0.4.2, Steam Deck в игровом режиме и любые XInput/стандартные геймпады): кнопки → действия клавиатуры (keymap.js).
// Раскладка «standard» из Gamepad API:
//   A — пуск/пауза, B — отменить, X — разрезать, Y — повторить,
//   LB / RB — кадр назад / вперёд (держать — повтор), LT / RT — шаттл назад / вперёд (как J / L),
//   крестовина ← / → — 1 с назад / вперёд, ↑ / ↓ — приблизить / отдалить таймлайн,
//   View — метка In, Menu — метка Out, L3 — Extract (убрать In–Out со сдвигом), R3 — удалить и сдвинуть,
//   левый стик по горизонтали — прокрутка курсора (чем сильнее наклон, тем быстрее).
import { runAction } from './keymap.js';
import { store } from './store.js';
import { toast } from './util.js';
import { t } from './i18n.js';

export const BUTTONS = {
  0: 'play.toggle', 1: 'edit.undo', 2: 'clip.split', 3: 'edit.redo',
  4: 'play.frameBack', 5: 'play.frameFwd', 6: 'play.shuttleBack', 7: 'play.shuttleFwd',
  8: 'mark.in', 9: 'mark.out', 10: 'edit.extract', 11: 'clip.rippleDelete',
  12: 'view.zoomIn', 13: 'view.zoomOut', 14: 'play.secBack', 15: 'play.secFwd',
};
// Эти действия повторяются, пока кнопка зажата (как автоповтор клавиатуры)
const REPEAT = new Set(['play.frameBack', 'play.frameFwd', 'play.secBack', 'play.secFwd', 'view.zoomIn', 'view.zoomOut']);
const REPEAT_DELAY = 400; const REPEAT_EVERY = 70;
const TRIGGER_ON = 0.5;   // аналоговые курки: нажато, когда больше половины хода
const DEAD = 0.25;        // мёртвая зона стика
export const SCRUB_SPEED = 4; // секунд таймлайна в секунду при полном наклоне

/**
 * Один шаг опроса (без окна — для тестов): state хранит, что было нажато.
 * → { actions: [{ id, repeat }], scrub: секунды сдвига курсора }
 */
export function stepPad(state, pad, now, dt) {
  const actions = [];
  const held = state.held || (state.held = {});
  (pad.buttons || []).forEach((b, i) => {
    const id = BUTTONS[i];
    if (!id) return;
    const v = typeof b === 'number' ? b : (b.value || (b.pressed ? 1 : 0));
    const down = v > (i === 6 || i === 7 ? TRIGGER_ON : 0.5);
    const h = held[i];
    if (down && !h) { held[i] = { since: now, next: now + REPEAT_DELAY }; actions.push({ id, repeat: false }); }
    else if (down && h && REPEAT.has(id) && now >= h.next) { h.next = now + REPEAT_EVERY; actions.push({ id, repeat: true }); }
    else if (!down && h) delete held[i];
  });
  const ax = (pad.axes && pad.axes[0]) || 0;
  const mag = Math.abs(ax) < DEAD ? 0 : (Math.abs(ax) - DEAD) / (1 - DEAD);
  const scrub = mag ? Math.sign(ax) * mag * mag * SCRUB_SPEED * (dt / 1000) : 0;
  return { actions, scrub };
}

export function initGamepad() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const states = new Map(); // index → state
  let raf = 0; let last = 0;
  const modalOpen = () => !!document.querySelector('.modal-overlay, .settings-overlay');
  const loop = (now) => {
    const dt = last ? Math.min(100, now - last) : 16; last = now;
    const pads = [...navigator.getGamepads()].filter(Boolean);
    if (!pads.length) { raf = 0; last = 0; return; }
    if (document.hasFocus()) {
      for (const pad of pads) {
        if (!states.has(pad.index)) states.set(pad.index, {});
        const r = stepPad(states.get(pad.index), pad, now, dt);
        if (modalOpen()) continue; // в окнах настроек/экспорта геймпад не трогает монтаж
        for (const a of r.actions) runAction(a.id, { repeat: a.repeat, code: `Gamepad${a.id}`, preventDefault() {} });
        if (r.scrub) store.setTime(Math.max(0, Math.min(store.duration(), store.time + r.scrub)));
      }
    }
    raf = requestAnimationFrame(loop);
  };
  const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
  window.addEventListener('gamepadconnected', (e) => {
    toast(t('Геймпад подключён: A — пуск, X — разрезать, B — отменить, LT / RT — шаттл, стик — прокрутка'), 'info', 6000);
    states.delete(e.gamepad.index);
    start();
  });
  window.addEventListener('gamepaddisconnected', (e) => { states.delete(e.gamepad.index); });
  // Геймпад мог быть подключён до запуска (Steam Deck): getGamepads() видит его после первого нажатия
  if ([...navigator.getGamepads()].some(Boolean)) start();
  return { stepPad };
}
