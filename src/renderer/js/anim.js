// Вкладка «Анимации»: пресеты слева, параметры справа, живой предпросмотр в плеере (холст),
// «Сохранить» — запекание в WebM с прозрачностью (кэш) → файл в «Ваши медиа» → клип на дорожке «Наложения».
// Двойной щелчок по клипу на «Наложениях» открывает анимацию снова.
import { store } from './store.js';
import { h, $, toast, errText, icon } from './util.js';
import { importPaths, pickAndImport, playUrl } from './media.js';
import { setMode, currentMode } from './modes.js';
import { RAIN_PARAMS, rainDefaults, rainClean, rainParticles, rainAt, rainBakePlan, rainKey } from './animRain.js';

const api = window.api;
const PRESETS = [{ id: 'rain', name: 'Дождь', hint: 'Картинка падает сверху вниз: купюры, листья, снег, конфетти' }];

export function initAnim(preview) {
  const left = $('#anim-presets');
  const right = $('#anim-params');
  const st = {
    preset: 'rain',
    params: rainDefaults(),
    editing: null,  // id клипа на «Наложениях», который открыт для правки
    busy: false,
  };
  let canvas = null; let raf = 0; let img = null; let imgSrc = ''; let parts = null; let partsSig = '';
  const t0 = performance.now();

  const images = () => Object.values(store.project.media).filter((m) => m.isImage && !m.isAnimation && !m.hidden);
  const imageMedia = () => (st.params.image && store.media(st.params.image)) || null;

  // --- живой предпросмотр поверх плеера ---
  function draw() {
    raf = 0;
    if (currentMode() !== 'anim' || !canvas) return;
    const fmt = store.sourceFormat();
    const W = fmt.width; const H = fmt.height;
    const cw = preview.stage.clientWidth; const ch = preview.stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const m = imageMedia();
    if (m) {
      if (imgSrc !== m.url) { imgSrc = m.url; img = new Image(); img.src = m.url; }
      if (img && img.complete && img.naturalWidth) {
        const p = rainClean(st.params);
        const aspect = m.width && m.height ? m.width / m.height : img.naturalWidth / img.naturalHeight;
        const sig = JSON.stringify([p, W, H, aspect]);
        if (sig !== partsSig) { parts = rainParticles(p, W, H, aspect); partsSig = sig; }
        const t = ((performance.now() - t0) / 1000) % p.duration;
        const k = (cw * dpr) / W;
        for (const pt of parts) {
          const { cx, cy, angle } = rainAt(pt, t, W, H);
          ctx.setTransform(k, 0, 0, k, 0, 0);
          ctx.translate(cx, cy); ctx.rotate(angle);
          ctx.drawImage(img, -pt.sw / 2, -pt.sh / 2, pt.sw, pt.sh);
        }
      }
    }
    raf = requestAnimationFrame(draw);
  }
  function showCanvas(on) {
    if (on && !canvas) { canvas = h('canvas', { class: 'anim-canvas' }); preview.stage.append(canvas); }
    if (!on && canvas) { canvas.remove(); canvas = null; }
    preview.hideOverlay = on;
    preview.seek(store.time);
    if (on && !raf) raf = requestAnimationFrame(draw);
  }

  // --- панели ---
  function renderLeft() {
    left.innerHTML = '';
    left.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Анимации')),
      ...PRESETS.map((pr) => h('button', {
        class: `anim-preset${st.preset === pr.id ? ' on' : ''}`, dataset: { preset: pr.id }, title: pr.hint,
        onclick: () => { st.preset = pr.id; renderLeft(); renderRight(); },
      }, h('span', { class: 'ap-ic', html: icon('media', 22) }), h('span', {}, h('b', {}, pr.name), h('small', {}, pr.hint)))),
      h('p', { class: 'muted small' }, 'Другие пресеты появятся с плагинами.'));
  }

  const fmtVal = (d, v) => (d.pct ? `${Math.round(v * 100)}%` : `${String(Math.round(v * 100) / 100).replace('.', ',')}${d.unit ? ` ${d.unit}` : ''}`);

  function renderRight() {
    right.innerHTML = '';
    const p = st.params;
    right.append(h('div', { class: 'panel-head' }, h('h2', {}, st.editing ? 'Дождь — правка' : 'Дождь')));
    // Картинка
    const imgs = images();
    if (!p.image && imgs.length) p.image = imgs[0].id;
    const pick = h('div', { class: 'anim-images' }, ...imgs.map((m) => h('button', {
      class: `anim-img${p.image === m.id ? ' on' : ''}`, title: m.name, dataset: { image: m.id },
      onclick: () => { p.image = m.id; renderRight(); },
    }, h('img', { src: m.url, alt: '', draggable: 'false' }))),
    h('button', { class: 'anim-img add', title: 'Импорт картинки (PNG с прозрачностью)', html: icon('plus', 18), onclick: async () => {
      const ids = await pickAndImport();
      const im = ids.map((id) => store.media(id)).find((m) => m && m.isImage && !m.isAnimation);
      if (im) { p.image = im.id; renderRight(); } else if (ids.length) toast('Нужна картинка (PNG, JPG, WebP)', 'info', 2500);
    } }));
    right.append(h('div', { class: 'insp-section' }, h('h3', {}, 'Картинка'), pick,
      imgs.length ? null : h('p', { class: 'muted small' }, 'Импортируйте картинку — лучше PNG с прозрачным фоном.')));

    // Параметры
    const sec = h('div', { class: 'insp-section' }, h('h3', {}, 'Параметры'));
    for (const d of RAIN_PARAMS) {
      const val = h('span', { class: 'vol-val' }, fmtVal(d, p[d.k]));
      const r = h('input', { type: 'range', class: 'slider', min: String(d.min), max: String(d.max), step: String(d.step), value: String(p[d.k]), dataset: { param: d.k } });
      r.addEventListener('input', () => { p[d.k] = Number(r.value); val.textContent = fmtVal(d, p[d.k]); });
      r.addEventListener('dblclick', () => { p[d.k] = d.def; renderRight(); });
      sec.append(h('div', { class: 'fx-param' }, h('span', { class: 'fx-pname' }, d.name), h('div', { class: 'row gap' }, r, val)));
    }
    const loop = h('input', { type: 'checkbox', id: 'anim-loop' }); loop.checked = p.loop !== false;
    loop.addEventListener('change', () => { p.loop = loop.checked; });
    const seed = h('input', { class: 'input sec', id: 'anim-seed', type: 'text', value: String(p.seed) });
    seed.addEventListener('change', () => { p.seed = Math.max(0, Math.round(Number(seed.value) || 0)); seed.value = String(p.seed); });
    seed.addEventListener('keydown', (e) => e.stopPropagation());
    sec.append(
      h('label', { class: 'check-row', title: 'Анимация бесшовно повторяется: конец переходит в начало' }, loop, h('span', {}, 'Зациклить')),
      h('div', { class: 'row gap', style: { marginTop: '8px' } }, h('span', { class: 'fx-pname', style: { margin: 0 } }, 'Случайный узор'), seed,
        h('button', { class: 'btn ghost small', id: 'anim-reseed', title: 'Другой узор', onclick: () => { p.seed = Math.floor(Math.random() * 100000); renderRight(); } }, 'Другой')));
    right.append(sec);

    const fmt = store.sourceFormat();
    right.append(h('div', { class: 'anim-actions' },
      h('button', { class: 'btn primary', id: 'anim-save', disabled: st.busy || !imageMedia(), onclick: () => save() }, st.busy ? 'Сохраняю…' : (st.editing ? 'Сохранить изменения' : 'Сохранить')),
      st.editing ? h('button', { class: 'btn ghost small', id: 'anim-new', onclick: () => { st.editing = null; renderRight(); } }, 'Как новую') : null,
      h('p', { class: 'muted small' }, `Видео ${fmt.width}×${fmt.height}, ${fmt.fps} fps с прозрачностью. Появится в «Ваши медиа» и на дорожке «Наложения» с позиции курсора.`)));
  }

  async function save() {
    const m = imageMedia();
    if (!m || st.busy) return;
    const info = await api.info();
    const fmt = store.sourceFormat();
    const params = rainClean({ ...st.params, image: m.id });
    const key = rainKey(params, m, fmt);
    const out = [info.cacheDir, 'anim', `rain-${key}.webm`].join(info.sep);
    st.busy = true; renderRight();
    const off = api.onExportProgress((ev) => { const b = $('#anim-save'); if (b && ev && ev.fraction !== undefined) b.textContent = `Сохраняю… ${Math.round(ev.fraction * 100)}%`; });
    try {
      if (!(await api.exists(out))) {
        const plan = rainBakePlan(params, m, fmt, out, info.ffMajor);
        const r = await api.runPlan(plan);
        if (r && r.ok === false) throw new Error(r.error || 'ошибка FFmpeg');
      }
      const [id] = await importPaths([out]);
      if (!id) throw new Error('файл анимации не открылся');
      store.mutate((p) => { const mm = p.media[id]; if (mm) { mm.anim = { preset: 'rain', params }; mm.name = `Дождь · ${m.name.replace(/\.[^.]+$/, '')}`; } });
      const ed = st.editing && store.findOverlay(st.editing);
      if (ed) {
        store.setOverlay(ed.id, { mediaId: id, in: 0, out: params.duration });
        store.select({ kind: 'overlay', id: ed.id });
      } else {
        const c = store.addOverlayClip(id, store.time);
        if (c) st.editing = c.id;
      }
      toast('Анимация сохранена: она в «Ваши медиа» и на дорожке «Наложения»', 'success', 2600);
    } catch (e) {
      toast(`Анимация не сохранилась: ${errText(e)}`, 'error', 5000);
    } finally {
      off && off();
      st.busy = false; renderRight();
    }
  }

  function edit(clipId) {
    const c = store.findOverlay(clipId);
    const m = c && store.media(c.mediaId);
    if (!m || !m.anim) { toast('Этот клип — не анимация из пресета', 'info', 2000); return; }
    st.preset = m.anim.preset || 'rain';
    st.params = rainClean(m.anim.params);
    st.editing = clipId;
    setMode('anim');
    renderLeft(); renderRight();
  }

  store.on('anim-edit', edit);
  store.on('mode', (id) => { showCanvas(id === 'anim'); if (id === 'anim') { renderLeft(); renderRight(); } });
  store.on('media', () => { if (currentMode() === 'anim' && !st.busy) renderRight(); });
  renderLeft(); renderRight();
  if (currentMode() === 'anim') showCanvas(true);
  return { state: st, edit, save, render: renderRight };
}
