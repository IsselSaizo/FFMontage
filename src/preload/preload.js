'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, fn) => {
  const h = (_e, p) => fn(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  info: () => invoke('app:info'),
  pickMedia: () => invoke('media:pick'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  probe: (p) => invoke('media:probe', p),
  thumbs: (info) => invoke('media:thumbs', info),
  peaks: (info) => invoke('media:peaks', info),
  proxy: (info) => invoke('media:proxy', info),
  onProxyProgress: (fn) => on('media:proxy-progress', fn),
  encoders: () => invoke('enc:detect'),
  pickExportPath: (suggested) => invoke('export:pick', suggested),
  defaultExportPath: (base) => invoke('export:default-path', base),
  startExport: (project, settings) => invoke('export:start', project, settings),
  cancelExport: () => invoke('export:cancel'),
  onExportProgress: (fn) => on('export:progress', fn),
  saveProject: (args) => invoke('project:save', args),
  openProject: () => invoke('project:open'),
  autosaveWrite: (text) => invoke('autosave:write', text),
  autosaveRead: () => invoke('autosave:read'),
  showInFolder: (p) => invoke('shell:show', p),
  openPath: (p) => invoke('shell:open', p),
  devtools: () => invoke('win:devtools'),
  setTitle: (t) => invoke('win:title', t),
  exists: (p) => invoke('fs:exists', p),
  // окно настроек папок / первого запуска
  setupInfo: () => invoke('setup:info'),
  pickFolder: (current) => invoke('setup:pick-folder', current),
  checkFfmpeg: (dir) => invoke('setup:check-ffmpeg', dir),
  setupEncoders: (dir) => invoke('setup:encoders', dir),
  saveSetup: (cfg) => invoke('setup:save', cfg),
  openSettings: () => invoke('setup:open'),
  cancelSetup: () => invoke('setup:cancel'),
});
