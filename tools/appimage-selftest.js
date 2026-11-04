// Автотест окна AppImage (tools/appimage-window.sh → FFM_SELFTEST): играет ли <video> в WebKitGTK через GStreamer
// из образа и верно ли решение «нужен прокси» (ff.rs probe): если needsProxy=false, файл обязан играть напрямую,
// если true — должен играть прокси. Тестовые файлы кладёт appimage-window.sh в <кэш>/tmp/appimage-test.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const errors = [];
  window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
  for (let i = 0; i < 100 && !(window.api && window.__ffm); i++) await sleep(100);
  if (!window.api) return { log, errors: ['window.api не появился'] };
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'appimage-test', ''].join(info.sep);
  log.push(`WebKit: ${navigator.userAgent}`);
  const types = {
    h264: 'video/mp4; codecs="avc1.42E01E"',
    hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
    av1: 'video/mp4; codecs="av01.0.05M.08"',
    vp9: 'video/webm; codecs="vp9"',
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: 'audio/mpeg',
    opus: 'audio/ogg; codecs="opus"',
  };
  const probe = document.createElement('video');
  log.push('canPlayType: ' + Object.entries(types).map(([k, t]) => `${k}=${probe.canPlayType(t) || 'no'}`).join(' '));

  // Первый кадр и 1,5 с воспроизведения (без звука: на раннере нет звуковой карты)
  // cors — как в плеере (preview.js: crossOrigin='anonymous' ради Web Audio)
  const play = (url, ms = 20000, cors = true) => new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    if (cors) v.crossOrigin = 'anonymous';
    v.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:120px;z-index:99999';
    document.body.appendChild(v);
    let done = false;
    const fin = (r) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => fin({ ok: false, why: `timeout readyState=${v.readyState} network=${v.networkState} t=${v.currentTime.toFixed(2)}` }), ms);
    v.addEventListener('error', () => fin({ ok: false, why: `error code=${v.error && v.error.code} network=${v.networkState} ${(v.error && v.error.message) || ''}` }));
    v.addEventListener('loadeddata', async () => {
      const w = v.videoWidth; const h = v.videoHeight;
      try { await v.play(); } catch (e) { fin({ ok: false, why: `play(): ${e}` }); return; }
      const t0 = v.currentTime;
      await sleep(1500);
      fin({ ok: w > 0 && v.currentTime > t0, why: `${w}x${h}, t ${t0.toFixed(2)}→${v.currentTime.toFixed(2)}` });
    }, { once: true });
    v.src = url;
  });

  // Диагностика на H.264: без crossOrigin, через blob: (без своей схемы media://), запрос fetch с Range
  try {
    const m = await window.api.probe(dir + 'h264.mp4');
    const r1 = await play(m.url, 15000, false);
    log.push(`диагностика h264 media:// без crossOrigin: ${r1.ok ? 'играет' : 'нет'} (${r1.why})`);
    let blobUrl = null;
    try {
      const resp = await fetch(m.url);
      const buf = await resp.blob();
      log.push(`диагностика fetch media://: status=${resp.status} type=${resp.headers.get('content-type')} size=${buf.size}`);
      blobUrl = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
      const r2 = await play(blobUrl, 15000, false);
      log.push(`диагностика h264 через blob: ${r2.ok ? 'играет' : 'нет'} (${r2.why})`);
    } catch (e) { log.push(`диагностика fetch media://: ошибка ${e}`); }
    try {
      const resp = await fetch(m.url, { headers: { Range: 'bytes=0-99' } });
      log.push(`диагностика Range 0-99: status=${resp.status} range=${resp.headers.get('content-range')} len=${(await resp.arrayBuffer()).byteLength}`);
    } catch (e) { log.push(`диагностика Range: ошибка ${e}`); }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  } catch (e) { log.push(`диагностика: ${e}`); }

  // [файл, должен играть напрямую на Linux]
  for (const [name, direct] of [['h264.mp4', true], ['h264_aac.mp4', true], ['vp9.webm', null], ['hevc.mp4', false]]) {
    let m;
    try { m = await window.api.probe(dir + name); } catch (e) { errors.push(`probe ${name}: ${e}`); continue; }
    const r = await play(m.url);
    log.push(`${name} (${m.vcodec}/${m.acodec || '-'}): needsProxy=${m.needsProxy}, напрямую: ${r.ok ? 'играет' : 'нет'} (${r.why})`);
    if (direct === true && !r.ok) errors.push(`${name} не играет в <video>: ${r.why} — нет декодера GStreamer в образе?`);
    if (direct === false && !m.needsProxy) errors.push(`${name}: на Linux ожидался needsProxy=true`);
    if (!m.needsProxy && !r.ok) errors.push(`${name}: needsProxy=false, но <video> его не играет — решение о прокси неверно`);
    if (m.needsProxy) {
      try {
        const url = await window.api.proxy(m);
        const p = await play(url);
        log.push(`${name}: прокси ${p.ok ? 'играет' : 'НЕ играет'} (${p.why})`);
        if (!p.ok) errors.push(`прокси ${name} не играет: ${p.why}`);
      } catch (e) { errors.push(`прокси ${name}: ${e}`); }
    }
  }
  return { log, errors };
})();
