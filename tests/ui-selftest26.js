// Тест 26 (0.6.1): кадрирование в плеере обрезает саму картинку, а не только подгоняет её («половина на половину»).
// WebView2 рисует <video> с object-view-box и за пределами view box (до краёв элемента) — со сдвигом трансформа
// срезанная часть «выезжала из рамки». Основная дорожка — зелёное видео, верхняя — «красное | синее» (cr_halves.mp4)
// с кадрированием правой половины. Пиксели проверяются по снимкам окна (testShot → импорт PNG → canvas).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = []; const errors = [];
  const ok = (cond, msg) => { log.push(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) errors.push(msg); };
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
  for (let i = 0; i < 50 && !window.__ffm; i++) await sleep(100);
  const { store, importPaths, preview } = window.__ffm;
  const info = await window.api.info();
  const dir = [info.cacheDir, 'tmp', 'engine-test', ''].join(info.sep);
  // Цвет точки снимка: r | g | b | ? (по преобладающему каналу)
  const colorAt = (ctx, x, y) => {
    const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const m = Math.max(r, g, b);
    if (m < 120) return '?';
    return m === r && r > g + 80 && r > b + 80 ? 'r' : m === g && g > r + 80 && g > b + 80 ? 'g' : m === b && b > r + 80 && b > g + 80 ? 'b' : '?';
  };
  try {
    const [g, hv] = await importPaths([dir + 'cr_green.mp4', dir + 'cr_halves.mp4']);
    ok(!!g && !!hv, 'файлы импортированы');
    const p = JSON.parse(store.serialize()).project;
    p.aspect = '16:9';
    p.videoClips = [{ id: 'cg', mediaId: g, in: 0, out: 4, start: 0, volume: 1, muted: true }];
    p.videoTracks = [{ id: 'vtk_top', clips: [{ id: 'ch', mediaId: hv, in: 0, out: 4, start: 0, volume: 1, muted: true }] }];
    delete p.episodes; delete p.activeEpisode;
    store.load(p); await sleep(300);
    // [имя, crop, transform, fit, ожидаемые цвета в точках по ширине кадра (доли)]
    const R = { l: 0, t: 0, r: 0.5, b: 0 };
    const variants = [
      ['plain', null, null, null, { 0.1: 'r', 0.4: 'r', 0.6: 'b', 0.9: 'b' }],
      ['crop', R, null, null, { 0.1: 'g', 0.3: 'r', 0.7: 'r', 0.85: 'g' }],
      ['crop-shift', R, { x: -0.25 }, null, { 0.05: 'r', 0.45: 'r', 0.6: 'g', 0.7: 'g', 0.9: 'g' }],
      ['crop-shift-down', R, { x: -0.25, y: 0.1 }, null, { 0.45: 'r', 0.6: 'g', 0.7: 'g' }],
      ['crop-left', { l: 0.5, t: 0, r: 0, b: 0 }, { x: 0.25 }, null, { 0.1: 'g', 0.4: 'g', 0.55: 'b', 0.95: 'b' }],
      ['crop-cover', R, { x: -0.25 }, 'cover', { 0.1: 'r', 0.6: 'r', 0.9: 'g' }],
      ['crop-blur', R, { x: -0.25 }, 'blur', { 0.3: 'r', 0.7: '!b' }],
    ];
    const shots = [];
    for (const [name, crop, tf, fit, expect] of variants) {
      const c = store.findClip('ch').clip;
      if (crop) c.crop = crop; else delete c.crop;
      if (tf) c.transform = tf; else delete c.transform;
      if (fit) c.fit = fit; else delete c.fit;
      store.select(null);
      store.setTime(1 + shots.length * 0.2); await sleep(700);
      const top = preview.views.get('vtk_top');
      const el = top && top.slots.find((s) => s.classList.contains('on'));
      const st = preview.stage.getBoundingClientRect();
      const file = await window.api.testShot(`ui26-${name}`);
      shots.push({ name, file, expect, st, dpr: window.devicePixelRatio || 1, cp: el ? el.style.clipPath : '' });
    }
    // Снимки → картинки окна (импорт разрешает media://)
    const ids = await importPaths(shots.map((s) => s.file));
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const m = store.media(ids[i]);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`снимок ${s.name} не открылся`)); img.src = m.url; });
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const y = (s.st.y + s.st.height * 0.55) * s.dpr;
      const got = Object.entries(s.expect).map(([fx, want]) => {
        const col = colorAt(ctx, (s.st.x + s.st.width * Number(fx)) * s.dpr, y);
        return { fx, want, col, pass: want.startsWith('!') ? col !== want.slice(1) : col === want };
      });
      ok(got.every((x) => x.pass), `${s.name}: ${got.map((x) => `${x.fx}=${x.col}${x.pass ? '' : `(ждали ${x.want})`}`).join(' ')}${s.cp ? ` · ${s.cp}` : ''}`);
    }
    // Режим кадрирования показывает клип целиком: без clip-path
    store.findClip('ch').clip.crop = R; delete store.findClip('ch').clip.transform; delete store.findClip('ch').clip.fit;
    store.select({ kind: 'video', id: 'ch' }); await sleep(100);
    document.querySelector('#viewbar .vb-crop').click(); await sleep(300);
    const el = preview.views.get('vtk_top').slots.find((s) => s.classList.contains('on'));
    ok(preview.cropEdit === 'ch' && el && !el.style.clipPath, `режим кадрирования: клип целиком (clip-path «${el && el.style.clipPath}»)`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); await sleep(200);
    ok(!preview.cropEdit && /inset/.test(el.style.clipPath), `после выхода — снова обрезка: ${el.style.clipPath}`);
  } catch (e) {
    errors.push(String(e && e.stack || e));
  }
  return { log, errors };
})();
