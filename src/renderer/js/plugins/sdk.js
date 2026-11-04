// SDK плагина. Выполняется ВНУТРИ песочницы плагина (iframe sandbox="allow-scripts", без allow-same-origin):
// протокол plugin:// отдаёт этот файл как /<id>/__sdk.js и вставляет его в каждую HTML-страницу плагина.
// Классический скрипт, не модуль: window.ffm появляется синхронно, раньше модулей плагина.
// Самодостаточен — модулей приложения и t() здесь нет, поэтому строки только английские.
//
// Протокол (см. js/plugins/host.js):
//   окно → фрейм (window.postMessage, один раз после load):
//     { type: 'ffm-init', pluginId, apiVersion: 1, lang, kind: 'main'|'panel', panelId?, permissions } + порт
//   дальше только MessagePort:
//     фрейм → окно  { t: 'req', id, method, args }      окно → фрейм  { t: 'res', id, ok, result | error }
//     окно → фрейм  { t: 'event', name, data }          фрейм → окно  { t: 'ready' }
// Вызовы до прихода порта копятся в очереди. Права проверяет окно, SDK лишь передаёт запросы.
(function () {
  'use strict';
  if (window.ffm && window.ffm.__sdk) return;

  // Тёмная схема, как у окна программы: иначе Chromium подкладывает под фрейм непрозрачный белый фон
  // (схемы цветов окна и фрейма различаются). Страница плагина может переопределить своим <meta>.
  try {
    if (!document.querySelector('meta[name="color-scheme"]')) {
      var cs = document.createElement('meta');
      cs.name = 'color-scheme'; cs.content = 'dark';
      (document.head || document.documentElement).appendChild(cs);
    }
    document.documentElement.style.colorScheme = 'dark';
  } catch (e) { /* ignore */ }

  // Предварительные сведения: окно кладёт их в имя фрейма (iframe.name) — доступны синхронно,
  // чтобы модуль плагина мог сразу прочитать ffm.lang. Точные значения придут в ffm-init.
  var boot = {};
  try { var nm = JSON.parse(window.name || '{}'); if (nm && nm.ffm === 1) boot = nm; } catch (e) { /* ignore */ }
  if (!boot.pluginId) {
    var m = /^\/([a-z0-9][a-z0-9-]{1,40})\//.exec(location.pathname || '');
    if (m) boot.pluginId = m[1];
  }

  var TIMEOUT = 30000;          // обычный запрос
  var LONG = { 'net.fetch': 45000, 'tools.call': 120000, 'commands.execute': 120000 };
  var port = null;
  var queue = [];               // сообщения до прихода порта
  var pending = {};             // id → { resolve, reject, timer }
  var seq = 0;
  var listeners = {};           // событие → [fn]
  var actionHandlers = {};      // id действия → fn (ffm.register.action)
  var projectSubs = 0;          // подписчики 'project'

  function send(msg) {
    if (port) { try { port.postMessage(msg); } catch (e) { fail(msg, e); } } else queue.push(msg);
  }
  function fail(msg, e) {
    if (msg && msg.t === 'req' && pending[msg.id]) {
      var p = pending[msg.id]; delete pending[msg.id]; clearTimeout(p.timer); p.reject(new Error(String(e && e.message || e)));
    }
  }

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var ms = LONG[method] || TIMEOUT;
      var timer = setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        reject(new Error('ffm: ' + method + ' timed out'));
      }, ms + (port ? 0 : 10000));
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var msg = { t: 'req', id: id, method: method, args: args === undefined ? null : args };
      try { send(msg); } catch (e) { fail(msg, e); }
    });
  }

  function emit(name, data) {
    var list = (listeners[name] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { console.error('ffm listener (' + name + ')', e); }
    }
  }

  function on(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('ffm.on: handler must be a function');
    name = String(name);
    (listeners[name] = listeners[name] || []).push(fn);
    if (name === 'project' && ++projectSubs === 1) call('project.subscribe', { on: true }).catch(warn);
    var done = false;
    return function off() {
      if (done) return; done = true;
      var l = listeners[name] || [];
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
      if (name === 'project' && --projectSubs === 0) call('project.subscribe', { on: false }).catch(warn);
    };
  }
  function off(name, fn) {
    var l = listeners[String(name)] || [];
    var i = l.indexOf(fn);
    if (i < 0) return;
    l.splice(i, 1);
    if (String(name) === 'project' && --projectSubs === 0) call('project.subscribe', { on: false }).catch(warn);
  }
  function warn(e) { console.warn('ffm', e && e.message || e); }

  function onPortMessage(ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.t === 'res') {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id]; clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result); else p.reject(new Error(String(d.error || 'error')));
    } else if (d.t === 'event') {
      if (d.name === 'action' && d.data && typeof d.data.id === 'string') {
        var h = actionHandlers[d.data.id];
        if (h) { try { h(d.data); } catch (e) { console.error('ffm action', e); } }
      }
      emit(d.name, d.data);
    }
  }

  // Порт от главного окна — принимаем только первое ffm-init от родителя
  window.addEventListener('message', function (ev) {
    if (port || ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || d.type !== 'ffm-init' || !ev.ports || !ev.ports[0]) return;
    port = ev.ports[0];
    port.onmessage = onPortMessage;
    if (typeof port.start === 'function') port.start();
    ffm.pluginId = String(d.pluginId || ffm.pluginId || '');
    ffm.apiVersion = Number(d.apiVersion) || 1;
    ffm.lang = d.lang === 'en' ? 'en' : 'ru';
    ffm.kind = d.kind || ffm.kind;
    ffm.panelId = d.panelId || null;
    ffm.permissions = Array.isArray(d.permissions) ? d.permissions.slice() : [];
    // запросы, накопленные до прихода порта
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) { try { port.postMessage(q[i]); } catch (e) { fail(q[i], e); } }
    emit('init', { pluginId: ffm.pluginId, lang: ffm.lang, kind: ffm.kind });
  });

  var reg = function (kind) { return function (desc) { return call('register.' + kind, desc); }; };

  var ffm = {
    __sdk: 1,
    apiVersion: 1,
    pluginId: boot.pluginId || '',
    lang: boot.lang === 'en' ? 'en' : 'ru',
    kind: boot.kind || 'main',
    panelId: boot.panelId || null,
    permissions: Array.isArray(boot.permissions) ? boot.permissions.slice() : [],
    on: on,
    off: off,
    /** Сообщить главному окну, что плагин готов (окно ждёт не дольше ~3 с) */
    ready: function () { send({ t: 'ready' }); return Promise.resolve(true); },
    project: {
      get: function () { return call('project.get'); },
      /** fn(project) при каждом изменении (не чаще ~10 раз/с). Возвращает функцию отписки. */
      subscribe: function (fn) { return on('project', fn); },
    },
    commands: {
      execute: function (actionId) { return call('commands.execute', { id: String(actionId) }); },
      list: function () { return call('commands.list'); },
    },
    tools: {
      call: function (name, args) { return call('tools.call', { name: String(name), args: args || {} }); },
    },
    register: {
      effect: reg('effect'),
      transition: reg('transition'),
      audioEffect: reg('audioEffect'),
      exportPreset: reg('exportPreset'),
      textStyle: reg('textStyle'),
      keymap: reg('keymap'),
      /** desc = { id, title, category?, keys? }; handler({ id }) — при нажатии (id без префикса плагина) */
      action: function (desc, handler) {
        if (desc && typeof desc.id === 'string' && typeof handler === 'function') actionHandlers[desc.id] = handler;
        return call('register.action', desc);
      },
    },
    ui: {
      notify: function (text, kind) { return call('ui.notify', { text: String(text), kind: kind || 'info' }); },
    },
    storage: {
      get: function () { return call('storage.get'); },
      set: function (obj) { return call('storage.set', obj); },
    },
    net: {
      fetch: function (url, opts) {
        opts = opts || {};
        return call('net.fetch', { url: String(url), method: opts.method, headers: opts.headers, body: opts.body });
      },
    },
  };

  try {
    Object.defineProperty(window, 'ffm', { value: ffm, writable: false, configurable: false, enumerable: true });
  } catch (e) { window.ffm = ffm; }
})();
