// Окно экспорта: настройки → прогресс → результат.
import { store } from './store.js';
import { h, fmtTime, fmtBytes, fmtDur, icon, toast } from './util.js';

const api = window.api;
let encoders = null;
let open = false;

const CODECS = [
  { id: 'av1', title: 'AV1', desc: 'Самый компактный файл при том же качестве. Рекомендуется.', gpu: 'av1_nvenc', cpu: 'libsvtav1' },
  { id: 'hevc', title: 'HEVC (H.265)', desc: 'Почти как AV1, лучше поддерживается старыми устройствами.', gpu: 'hevc_nvenc', cpu: 'libx265' },
  { id: 'h264', title: 'H.264', desc: 'Открывается везде, но файл примерно вдвое больше.', gpu: 'h264_nvenc', cpu: 'libx264' },
];
const QUALITIES = [
  { id: 'high', title: 'Высокое', desc: 'Почти без потерь' },
  { id: 'medium', title: 'Среднее', desc: 'Баланс' },
  { id: 'compact', title: 'Компактное', desc: 'Меньше размер' },
];

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('ffm.export') || '{}'); } catch { return {}; }
}
function savePrefs(p) { localStorage.setItem('ffm.export', JSON.stringify(p)); }

export async function openExport() {
  if (open) return;
  if (store.duration() <= 0.01) { toast('Сначала добавьте клипы на таймлайн', 'info'); return; }
  open = true;
  if (store.playing) store.emit('request-pause');
  if (!encoders) encoders = await api.encoders();
  const appInfo = await api.info();

  const src = store.sourceFormat();
  const prefs = loadPrefs();
  const aspect = src.width / src.height;
  const resOptions = [{ id: 'source', label: `Как в исходнике — ${src.width}×${src.height}`, w: src.width, h: src.height }];
  // «1080p» — по короткой стороне кадра (для вертикального 9:16 это 1080×1920)
  const short = Math.min(src.width, src.height);
  for (const s of [2160, 1440, 1080, 720]) {
    if (s === short) continue;
    const w = aspect >= 1 ? even(s * aspect) : s;
    const hh = aspect >= 1 ? s : even(s / aspect);
    resOptions.push({ id: String(s), label: `${s}p — ${w}×${hh}${s > short ? ' (увеличение)' : ''}`, w, h: hh });
  }
  const fpsOptions = [{ id: 'source', label: `Как в исходнике — ${src.fps} fps`, v: src.fps }];
  for (const f of [60, 30]) if (Math.abs(f - src.fps) > 0.01) fpsOptions.push({ id: String(f), label: `${f} fps`, v: f });

  const st = {
    name: store.project.name || 'Мой ролик',
    res: resOptions.find((r) => r.id === prefs.res) ? prefs.res : 'source',
    fps: fpsOptions.find((r) => r.id === prefs.fps) ? prefs.fps : 'source',
    codec: CODECS.find((c) => c.id === prefs.codec) ? prefs.codec : 'av1',
    quality: QUALITIES.find((q) => q.id === prefs.quality) ? prefs.quality : 'high',
    output: null,
  };

  const overlay = h('div', { class: 'modal-overlay' });
  const modal = h('div', { class: 'modal export' });
  overlay.append(modal);
  document.body.append(overlay);
  const close = () => { overlay.remove(); open = false; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !modal.classList.contains('busy')) close(); };
  document.addEventListener('keydown', onKey);

  const encoderFor = (cid) => {
    const c = CODECS.find((x) => x.id === cid);
    return encoders[c.gpu] ? { enc: c.gpu, gpu: true } : { enc: c.cpu, gpu: false };
  };

  // ---------------- Форма ----------------
  function renderForm() {
    modal.innerHTML = '';
    modal.classList.remove('busy');
    const nameInput = h('input', { type: 'text', class: 'input', value: st.name, spellcheck: 'false' });
    nameInput.addEventListener('input', () => { st.name = nameInput.value; st.output = null; outLabel.textContent = outText(); });
    const outLabel = h('span', { class: 'out-path' });
    const outText = () => st.output || `${appInfo.outputDir}${appInfo.sep}${(st.name || 'Видео').replace(/[\\/:*?"<>|]+/g, '_')}.mp4`;
    outLabel.textContent = outText();
    const pickBtn = h('button', { class: 'btn ghost small', onclick: async () => {
      const p = await api.pickExportPath(`${st.name || 'Видео'}.mp4`);
      if (p) { st.output = p; outLabel.textContent = p; }
    } }, h('span', { html: icon('folder', 16) }), 'Изменить…');

    const select = (opts, key) => {
      const s = h('select', { class: 'input' }, ...opts.map((o) => h('option', { value: o.id, selected: st[key] === o.id }, o.label)));
      s.addEventListener('change', () => { st[key] = s.value; });
      return s;
    };

    const codecCards = h('div', { class: 'codec-cards' }, ...CODECS.map((c) => {
      const e = encoderFor(c.id);
      const card = h('button', { class: `codec-card${st.codec === c.id ? ' on' : ''}`, onclick: () => { st.codec = c.id; renderForm(); } },
        h('div', { class: 'cc-title' }, c.title, h('span', { class: `cc-tag ${e.gpu ? 'gpu' : 'cpu'}` }, e.gpu ? 'Видеокарта' : 'Процессор')),
        h('div', { class: 'cc-desc' }, c.desc));
      return card;
    }));
    const qual = h('div', { class: 'segmented' }, ...QUALITIES.map((q) =>
      h('button', { class: st.quality === q.id ? 'on' : '', onclick: () => { st.quality = q.id; renderForm(); } },
        h('b', {}, q.title), h('small', {}, q.desc))));

    modal.append(
      h('div', { class: 'modal-head' }, h('h2', {}, 'Экспорт видео'),
        h('button', { class: 'icon-btn', onclick: close, html: icon('close', 18) })),
      h('div', { class: 'modal-body' },
        h('div', { class: 'form-grid' },
          h('label', {}, 'Название'), nameInput,
          h('label', {}, 'Сохранить в'), h('div', { class: 'row gap' }, outLabel, pickBtn),
          h('label', {}, 'Разрешение'), select(resOptions, 'res'),
          h('label', {}, 'Частота кадров'), select(fpsOptions, 'fps'),
          h('label', {}, 'Кодек'), codecCards,
          h('label', {}, 'Качество'), qual),
        h('p', { class: 'muted small' },
          `Длительность ролика: ${fmtTime(store.duration())}. Кодирование идёт ${encoderFor(st.codec).gpu ? 'на видеокарте NVIDIA — быстро' : 'на процессоре — дольше'}. `
          + 'Звук: AAC 192 кбит/с, 48 кГц.')),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn ghost', onclick: close }, 'Отмена'),
        h('button', { class: 'btn primary', id: 'export-go', onclick: start }, h('span', { html: icon('export', 18) }), 'Экспортировать')));
    nameInput.focus();
    nameInput.select();
  }

  // ---------------- Экспорт ----------------
  async function start() {
    savePrefs({ res: st.res, fps: st.fps, codec: st.codec, quality: st.quality });
    if (st.name && st.name !== store.project.name) store.mutate((p) => { p.name = st.name; });
    const res = resOptions.find((r) => r.id === st.res);
    const fps = fpsOptions.find((r) => r.id === st.fps);
    const enc = encoderFor(st.codec);
    const output = st.output || await api.defaultExportPath(st.name || 'Видео');
    const exists = await api.exists(output);
    const settings = { width: res.w, height: res.h, fps: fps.v, codec: enc.enc, quality: st.quality, output };

    modal.innerHTML = '';
    modal.classList.add('busy');
    const bar = h('div', { class: 'bar' });
    const pct = h('div', { class: 'big-pct' }, '0%');
    const stats = h('div', { class: 'export-stats muted' }, 'Запуск FFmpeg…');
    const cancel = h('button', { class: 'btn ghost', onclick: () => { cancel.disabled = true; api.cancelExport(); } }, 'Отмена');
    modal.append(
      h('div', { class: 'modal-head' }, h('h2', {}, 'Экспорт…')),
      h('div', { class: 'modal-body' },
        h('div', { class: 'export-target' }, output.split(/[\\/]/).pop(),
          h('span', { class: 'muted' }, ` · ${res.w}×${res.h} · ${fps.v} fps · ${CODECS.find((c) => c.id === st.codec).title}`)),
        pct, h('div', { class: 'progress' }, bar), stats,
        exists ? h('p', { class: 'muted small' }, 'Файл с таким именем будет заменён.') : null),
      h('div', { class: 'modal-foot' }, cancel));

    const off = api.onExportProgress((p) => {
      const v = Math.round(p.fraction * 1000) / 10;
      bar.style.width = `${v}%`;
      pct.textContent = `${Math.floor(v)}%`;
      const parts = [`${fmtTime(p.time, { ms: false })} из ${fmtTime(p.duration, { ms: false })}`];
      if (p.speed) parts.push(`скорость ${p.speed.replace('x', '×')}`);
      if (p.size) parts.push(fmtBytes(p.size));
      if (p.eta !== null && p.eta !== undefined) parts.push(`осталось ≈ ${fmtDur(Math.max(0, p.eta))}`);
      stats.textContent = parts.join(' · ');
    });
    const r = await api.startExport(JSON.parse(JSON.stringify(store.project)), settings);
    off();

    modal.innerHTML = '';
    modal.classList.remove('busy');
    if (r.ok) {
      const ratio = r.duration > 0 ? (r.size * 8 / r.duration / 1e6) : 0;
      modal.append(
        h('div', { class: 'modal-head' }, h('h2', {}, 'Готово!'), h('button', { class: 'icon-btn', onclick: close, html: icon('close', 18) })),
        h('div', { class: 'modal-body' },
          h('div', { class: 'done-icon', html: icon('check', 40) }),
          h('div', { class: 'export-target center' }, r.output.split(/[\\/]/).pop()),
          h('dl', { class: 'kv center' },
            h('dt', {}, 'Размер'), h('dd', {}, fmtBytes(r.size)),
            h('dt', {}, 'Средний битрейт'), h('dd', {}, `${ratio.toFixed(1).replace('.', ',')} Мбит/с`),
            h('dt', {}, 'Длительность'), h('dd', {}, fmtTime(r.duration)),
            h('dt', {}, 'Экспорт занял'), h('dd', {}, fmtDur(r.elapsed)))),
        h('div', { class: 'modal-foot' },
          h('button', { class: 'btn ghost', onclick: () => api.showInFolder(r.output) }, h('span', { html: icon('folder', 17) }), 'Показать в папке'),
          h('button', { class: 'btn primary', onclick: () => api.openPath(r.output) }, h('span', { html: icon('play', 17) }), 'Открыть видео')));
      toast('Экспорт завершён', 'success');
    } else if (r.cancelled) {
      close();
      toast('Экспорт отменён', 'info');
    } else {
      modal.append(
        h('div', { class: 'modal-head' }, h('h2', {}, 'Ошибка экспорта')),
        h('div', { class: 'modal-body' },
          h('pre', { class: 'error-box' }, r.error || 'Неизвестная ошибка'),
          h('p', { class: 'muted small' }, `Полный журнал: ${appInfo.logsDir}${appInfo.sep}last-export.log`)),
        h('div', { class: 'modal-foot' },
          h('button', { class: 'btn ghost', onclick: close }, 'Закрыть'),
          h('button', { class: 'btn primary', onclick: renderForm }, 'Назад к настройкам')));
    }
  }

  renderForm();
}
