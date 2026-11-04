// Тонкая замена window.__TAURI__ (withGlobalTauri выключен — M0.1): только то, что нужно окну.
// Всё идёт через window.__TAURI_INTERNALS__, который Tauri ставит в окно всегда.
// Повторяет официальный API (tauri-2.x scripts/bundle.global.js): те же команды плагинов
// `plugin:event|listen|unlisten`, `plugin:window|…` и та же форма аргументов.

const I = () => {
  const x = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : null;
  if (!x) throw new Error('Tauri IPC is not available');
  return x;
};

/** Вызов команды Rust: invoke('app_info') → Promise */
export function invoke(cmd, args = {}, options) {
  try { return I().invoke(cmd, args, options); } catch (e) { return Promise.reject(e); }
}

/** Функция → номер обратного вызова для IPC (как transformCallback в @tauri-apps/api/core) */
export const transformCallback = (fn, once = false) => I().transformCallback(fn, once);

// Метки текущего окна и webview (у нас они совпадают: одно окно — один webview)
export const windowLabel = () => { try { return I().metadata.currentWindow.label; } catch { return 'main'; } };
export const webviewLabel = () => { try { return I().metadata.currentWebview.label; } catch { return windowLabel(); } };

// target: строка — метка (AnyLabel), объект { kind: 'Window'|'Webview'|…, label }, ничего — все (Any)
const normTarget = (target) => (typeof target === 'string' ? { kind: 'AnyLabel', label: target } : target || { kind: 'Any' });

/** Отписка по номеру слушателя */
export async function unlisten(event, eventId) {
  try { window.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener(event, eventId); } catch { /* ignore */ }
  await invoke('plugin:event|unlisten', { event, eventId });
}

/** Подписка на событие: fn({ event, id, payload }). Возвращает Promise<функция отписки> */
export async function listen(event, fn, target) {
  const eventId = await invoke('plugin:event|listen', { event, target: normTarget(target), handler: transformCallback(fn) });
  return () => unlisten(event, eventId);
}

/** Отправить событие в Rust/другие окна */
export const emit = (event, payload) => invoke('plugin:event|emit', { event, payload });

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------
const win = (cmd, extra) => invoke(`plugin:window|${cmd}`, { label: windowLabel(), ...extra });
export const appWindow = {
  minimize: () => win('minimize'),
  toggleMaximize: () => win('toggle_maximize'),
  close: () => win('close'),
  isMaximized: () => win('is_maximized'),
  setFullscreen: (value) => win('set_fullscreen', { value: !!value }),
  isFullscreen: () => win('is_fullscreen'),
  setTitle: (value) => win('set_title', { value: String(value) }),
  startDragging: () => win('start_dragging'),
  /** Изменение размера окна: fn({ width, height }) в физических пикселях */
  onResized: (fn) => listen('tauri://resize', (e) => fn(e.payload), { kind: 'Window', label: windowLabel() }),
};

// ---------------------------------------------------------------------------
// Webview: файлы, брошенные из Проводника
// ---------------------------------------------------------------------------
export const webview = {
  /**
   * fn({ type: 'enter'|'over'|'drop'|'leave', paths, position }) — position в физических пикселях.
   * Возвращает Promise<функция отписки>.
   */
  async onDragDropEvent(fn) {
    const target = { kind: 'Webview', label: webviewLabel() };
    const wrap = (type) => (e) => {
      const p = e.payload || {};
      fn({ type, paths: Array.isArray(p.paths) ? p.paths : [], position: p.position || null });
    };
    const offs = await Promise.all([
      listen('tauri://drag-enter', wrap('enter'), target),
      listen('tauri://drag-over', wrap('over'), target),
      listen('tauri://drag-drop', wrap('drop'), target),
      listen('tauri://drag-leave', wrap('leave'), target),
    ]);
    return () => Promise.all(offs.map((off) => off()));
  },
};
