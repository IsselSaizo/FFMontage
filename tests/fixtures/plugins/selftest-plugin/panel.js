// Панель тестового плагина: пытается выбраться из песочницы. Всё должно провалиться («blocked»).
// Итог показывается в панели и уходит уведомлением «SANDBOX:{json}» по действию report
// (тест вызывает его сам, когда готов ловить уведомления).
const out = {};
const short = (v) => String(v).slice(0, 30);
const attempt = async (name, fn) => {
  try { const v = await fn(); out[name] = `LEAK ${short(v)}`; } catch (e) { out[name] = 'blocked'; }
};
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

await attempt('parentDocument', () => window.parent.document.title);
await attempt('topLocation', () => window.top.location.href);
await attempt('tauriInternals', async () => {
  const ti = window.__TAURI_INTERNALS__;
  if (!ti || typeof ti.invoke !== 'function') throw new Error('absent');
  return JSON.stringify(await withTimeout(ti.invoke('app_info'), 3000));
});
await attempt('tauriGlobal', () => { if (!window.__TAURI__) throw new Error('absent'); return 'present'; });
await attempt('ipcFetch', async () => (await withTimeout(fetch('http://ipc.localhost/app_info', { method: 'POST', body: '{}' }), 5000)).status);
await attempt('internet', async () => (await withTimeout(fetch('https://example.com/'), 8000)).status);
await attempt('localStorage', () => { localStorage.setItem('ffm-test', '1'); return 'writable'; });
await attempt('popup', () => { const w = window.open('https://example.com/'); if (!w) throw new Error('no popup'); return 'opened'; });

document.getElementById('out').textContent = JSON.stringify(out, null, 1);
await ffm.register.action({ id: 'report', title: 'Report sandbox' }, () => ffm.ui.notify(`SANDBOX:${JSON.stringify(out)}`));
ffm.ready();
