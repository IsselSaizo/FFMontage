// Логика тестового плагина (скрытая песочница): проверяет API v1 и права, итог кладёт в storage (ключ entry),
// на действие «ping» (Ctrl+Alt+P) увеличивает storage.pings и показывает уведомление «SELFTEST:pong N».
const res = { pluginId: ffm.pluginId, lang: ffm.lang, apiVersion: ffm.apiVersion, checks: {} };
const ok = async (name, p) => {
  try { const v = await p; res.checks[name] = 'ok'; return v; } catch (e) { res.checks[name] = `FAIL: ${e && e.message}`; return null; }
};
const denied = async (name, p) => {
  try { await p; res.checks[name] = 'LEAK'; } catch (e) { res.checks[name] = `denied: ${e && e.message}`; }
};

const project = await ok('project.get', ffm.project.get());
res.projectShape = !!(project && Array.isArray(project.videoClips) && Array.isArray(project.audioTracks));
// project:write не объявлено — запись должна быть отклонена
await denied('commands.execute', ffm.commands.execute('edit.undo'));
await denied('tools.split_clip', ffm.tools.call('split_clip', { time: 1 }));
// файлы и экспорт плагинам недоступны вообще
await denied('tools.export_video', ffm.tools.call('export_video', {}));
await denied('tools.import_media', ffm.tools.call('import_media', { paths: ['C:\\x.mp4'] }));
await ok('tools.get_project', ffm.tools.call('get_project', {}));
// net: не объявлено
await denied('net.fetch', ffm.net.fetch('https://example.com/'));
// регистрация из кода: разрешённый фильтр — можно, чужой — нельзя
await ok('register.effect', ffm.register.effect({ id: 'dyn', name: 'Dyn', ffmpeg: [{ filter: 'vignette' }], css: 'brightness(0.9)' }));
await denied('register.effect.badFilter', ffm.register.effect({ id: 'bad', name: 'Bad', ffmpeg: [{ filter: 'movie', args: { filename: 'C:/x.mp4' } }] }));
const list = await ok('commands.list', ffm.commands.list());
res.commandsCount = Array.isArray(list) ? list.length : -1;
res.listHasFileActions = Array.isArray(list) && list.some((a) => a.id === 'project.save' || a.id === 'export.open');

const st = (await ok('storage.get', ffm.storage.get())) || {};
await ok('storage.set', ffm.storage.set({ ...st, runs: (st.runs || 0) + 1, entry: res }));

let pings = 0;
ffm.on('action', async ({ id }) => {
  if (id !== 'ping') return;
  pings++;
  const cur = await ffm.storage.get();
  await ffm.storage.set({ ...cur, pings: (cur.pings || 0) + 1 });
  await ffm.ui.notify(`SELFTEST:pong ${pings}`);
});

ffm.ready();
