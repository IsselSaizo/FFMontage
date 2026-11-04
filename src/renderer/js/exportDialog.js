// Окно экспорта: настройки → прогресс → результат.
import { store } from './store.js';
import { h, fmtTime, fmtBytes, fmtDur, icon, toast } from './util.js';
import { t, num } from './i18n.js';
import { listExportPresets, onRegistryChange } from './registry.js';
import { buildExport } from './exportPlan.js';
import './core/exportPresets.js';
import { exportableSubs } from './exportAssets.js';

const api = window.api;
let encoders = null;
let open = false;

const CODECS = [
  { id: 'av1', title: 'AV1', desc: t('Самый компактный файл при том же качестве. Рекомендуется.'), gpu: 'av1_nvenc', cpu: 'libsvtav1' },
  { id: 'hevc', title: 'HEVC (H.265)', desc: t('Почти как AV1, лучше поддерживается старыми устройствами.'), gpu: 'hevc_nvenc', cpu: 'libx265' },
  { id: 'h264', title: 'H.264', desc: t('Открывается везде, но файл примерно вдвое больше.'), gpu: 'h264_nvenc', cpu: 'libx264' },
];
const QUALITIES = [
  { id: 'high', title: t('Высокое'), desc: t('Почти без потерь') },
  { id: 'medium', title: t('Среднее'), desc: t('Баланс') },
  { id: 'compact', title: t('Компактное'), desc: t('Меньше размер') },
];

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('ffm.export') || '{}'); } catch { return {}; }
}
function savePrefs(p) { localStorage.setItem('ffm.export', JSON.stringify(p)); }

export async function openExport() {
  if (open) return;
  if (store.duration() <= 0.01) { toast(t('Сначала добавьте клипы на таймлайн'), 'info'); return; }
  open = true;
  if (store.playing) store.emit('request-pause');
  if (!encoders) encoders = await api.encoders();
  const appInfo = await api.info();

  const src = store.sourceFormat();
  const prefs = loadPrefs();
  const aspect = src.width / src.height;
  const resOptions = [{ id: 'source', label: t('Как в исходнике — {w}×{h}', { w: src.width, h: src.height }), w: src.width, h: src.height }];
  // «1080p» — по короткой стороне кадра (для вертикального 9:16 это 1080×1920)
  const short = Math.min(src.width, src.height);
  for (const s of [2160, 1440, 1080, 720]) {
    if (s === short) continue;
    const w = aspect >= 1 ? even(s * aspect) : s;
    const hh = aspect >= 1 ? s : even(s / aspect);
    resOptions.push({ id: String(s), label: `${s}p — ${w}×${hh}${s > short ? ` ${t('(увеличение)')}` : ''}`, w, h: hh });
  }
  const fpsOptions = [{ id: 'source', label: t('Как в исходнике — {fps} fps', { fps: src.fps }), v: src.fps }];
  for (const f of [60, 30]) if (Math.abs(f - src.fps) > 0.01) fpsOptions.push({ id: String(f), label: `${f} fps`, v: f });

  // Пресеты (встроенные и из плагинов): размер, частота, при желании кодек и качество. '' — свои настройки
  const presetById = (id) => (id ? listExportPresets().find((p) => p.id === id) : null);

  const st = {
    preset: presetById(prefs.preset) ? prefs.preset : '',
    name: store.project.name || t('Мой ролик'),
    res: resOptions.find((r) => r.id === prefs.res) ? prefs.res : 'source',
    fps: fpsOptions.find((r) => r.id === prefs.fps) ? prefs.fps : 'source',
    codec: CODECS.find((c) => c.id === prefs.codec) ? prefs.codec : 'av1',
    quality: QUALITIES.find((q) => q.id === prefs.quality) ? prefs.quality : 'high',
    subtitles: ['burn', 'soft', 'none'].includes(prefs.subtitles) ? prefs.subtitles : 'burn',
    output: null,
  };

  const overlay = h('div', { class: 'modal-overlay' });
  const modal = h('div', { class: 'modal export' });
  overlay.append(modal);
  document.body.append(overlay);
  // Список пресетов меняется, пока окно открыто (плагин включили/выключили) — перерисовать форму
  const offRegistry = onRegistryChange((ev) => {
    if (ev.kind !== 'exportPreset' || modal.classList.contains('busy') || !modal.querySelector('#export-go')) return;
    if (st.preset && !presetById(st.preset)) st.preset = '';
    renderForm();
  });
  const close = () => { overlay.remove(); open = false; offRegistry(); document.removeEventListener('keydown', onKey); };
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
    const outText = () => st.output || `${appInfo.outputDir}${appInfo.sep}${(st.name || t('Видео')).replace(/[\\/:*?"<>|]+/g, '_')}.mp4`;
    outLabel.textContent = outText();
    const pickBtn = h('button', { class: 'btn ghost small', onclick: async () => {
      const p = await api.pickExportPath(`${st.name || t('Видео')}.mp4`);
      if (p) { st.output = p; outLabel.textContent = p; }
    } }, h('span', { html: icon('folder', 16) }), t('Изменить…'));

    const select = (opts, key) => {
      const s = h('select', { class: 'input' }, ...opts.map((o) => h('option', { value: o.id, selected: st[key] === o.id }, o.label)));
      s.addEventListener('change', () => { st[key] = s.value; });
      return s;
    };

    const codecCards = h('div', { class: 'codec-cards' }, ...CODECS.map((c) => {
      const e = encoderFor(c.id);
      const card = h('button', { class: `codec-card${st.codec === c.id ? ' on' : ''}`, onclick: () => { st.codec = c.id; renderForm(); } },
        h('div', { class: 'cc-title' }, c.title, h('span', { class: `cc-tag ${e.gpu ? 'gpu' : 'cpu'}` }, e.gpu ? t('Видеокарта') : t('Процессор'))),
        h('div', { class: 'cc-desc' }, c.desc));
      return card;
    }));
    // Пресет: размер и частота берутся из него (кодек и качество — если заданы, их можно поменять)
    const presets = listExportPresets();
    const preset = presetById(st.preset);
    let presetSel = null;
    if (presets.length) {
      presetSel = h('select', { class: 'input', id: 'export-preset' },
        h('option', { value: '', selected: !preset }, t('Свои настройки')),
        ...presets.map((p) => h('option', { value: p.id, selected: !!preset && preset.id === p.id }, `${p.name} — ${p.width}×${p.height}, ${p.fps} fps`)));
      presetSel.addEventListener('change', () => {
        st.preset = presetSel.value;
        const p = presetById(st.preset);
        if (p && p.codec) st.codec = p.codec;
        if (p && p.quality) st.quality = p.quality;
        renderForm();
      });
    }
    const fromPreset = (text) => h('div', { class: 'muted', title: t('Задано пресетом') }, text);
    const hasSubs = exportableSubs(store.project).length > 0;
    const SUB_MODES = [{ id: 'burn', label: t('Вшить в кадр') }, { id: 'soft', label: t('Отдельной дорожкой (можно выключить в плеере)') }, { id: 'none', label: t('Не добавлять') }];

    const qual = h('div', { class: 'segmented' }, ...QUALITIES.map((q) =>
      h('button', { class: st.quality === q.id ? 'on' : '', onclick: () => { st.quality = q.id; renderForm(); } },
        h('b', {}, q.title), h('small', {}, q.desc))));

    modal.append(
      h('div', { class: 'modal-head' }, h('h2', {}, t('Экспорт видео')),
        h('button', { class: 'icon-btn', onclick: close, html: icon('close', 18) })),
      h('div', { class: 'modal-body' },
        h('div', { class: 'form-grid' },
          store.episodes().length > 1 ? h('label', {}, t('Эпизод')) : null,
          store.episodes().length > 1 ? h('div', { class: 'muted', title: t('Экспортируется открытый эпизод. Чтобы выгрузить другой — откройте его вкладку над таймлайном.') }, t('«{name}» (открытый)', { name: store.episodeName(store.activeEpisode()) })) : null,
          h('label', {}, t('Название')), nameInput,
          h('label', {}, t('Сохранить в')), h('div', { class: 'row gap' }, outLabel, pickBtn),
          presetSel ? h('label', {}, t('Пресет')) : null, presetSel,
          h('label', {}, t('Разрешение')), preset ? fromPreset(`${preset.width}×${preset.height}`) : select(resOptions, 'res'),
          h('label', {}, t('Частота кадров')), preset ? fromPreset(`${preset.fps} fps`) : select(fpsOptions, 'fps'),
          h('label', {}, t('Кодек')), codecCards,
          h('label', {}, t('Качество')), qual,
          hasSubs ? h('label', {}, t('Субтитры в видео')) : null,
          hasSubs ? select(SUB_MODES, 'subtitles') : null),
        h('p', { class: 'muted small' },
          encoderFor(st.codec).gpu
            ? t('Длительность ролика: {dur}. Кодирование идёт на видеокарте NVIDIA — быстро. Звук: AAC 192 кбит/с, 48 кГц.', { dur: fmtTime(store.duration()) })
            : t('Длительность ролика: {dur}. Кодирование идёт на процессоре — дольше. Звук: AAC 192 кбит/с, 48 кГц.', { dur: fmtTime(store.duration()) }))),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn ghost', onclick: close }, t('Отмена')),
        h('button', { class: 'btn primary', id: 'export-go', onclick: start }, h('span', { html: icon('export', 18) }), t('Экспортировать'))));
    nameInput.focus();
    nameInput.select();
  }

  // ---------------- Экспорт ----------------
  async function start() {
    savePrefs({ res: st.res, fps: st.fps, codec: st.codec, quality: st.quality, preset: st.preset, subtitles: st.subtitles });
    if (st.name && st.name !== store.project.name) store.mutate((p) => { p.name = st.name; });
    const preset = presetById(st.preset);
    const res = preset ? { w: preset.width, h: preset.height } : resOptions.find((r) => r.id === st.res);
    const fps = preset ? { v: preset.fps } : fpsOptions.find((r) => r.id === st.fps);
    const enc = encoderFor(st.codec);
    const output = st.output || await api.defaultExportPath(st.name || t('Видео'));
    const exists = await api.exists(output);
    const settings = { width: res.w, height: res.h, fps: fps.v, codec: enc.enc, quality: st.quality, output, subtitles: st.subtitles };
    // Что экспорт пропустит (эффекты и переходы пропавших плагинов) — показать до и после
    let warnings = [];
    try { warnings = buildExport(JSON.parse(JSON.stringify(store.project)), settings).warnings || []; } catch { /* ошибку покажет сам экспорт */ }
    const warnNote = () => (warnings.length ? h('p', { class: 'muted small export-warn' }, warnings.join(' ')) : null);
    if (warnings.length) toast(warnings.join(' '), 'info');

    modal.innerHTML = '';
    modal.classList.add('busy');
    const bar = h('div', { class: 'bar' });
    const pct = h('div', { class: 'big-pct' }, '0%');
    const stats = h('div', { class: 'export-stats muted' }, t('Запуск FFmpeg…'));
    const cancel = h('button', { class: 'btn ghost', onclick: () => { cancel.disabled = true; api.cancelExport(); } }, t('Отмена'));
    modal.append(
      h('div', { class: 'modal-head' }, h('h2', {}, t('Экспорт…'))),
      h('div', { class: 'modal-body' },
        h('div', { class: 'export-target' }, output.split(/[\\/]/).pop(),
          h('span', { class: 'muted' }, ` · ${res.w}×${res.h} · ${fps.v} fps · ${CODECS.find((c) => c.id === st.codec).title}`)),
        pct, h('div', { class: 'progress' }, bar), stats,
        exists ? h('p', { class: 'muted small' }, t('Файл с таким именем будет заменён.')) : null, warnNote()),
      h('div', { class: 'modal-foot' }, cancel));

    const off = api.onExportProgress((p) => {
      const v = Math.round(p.fraction * 1000) / 10;
      bar.style.width = `${v}%`;
      pct.textContent = `${Math.floor(v)}%`;
      const parts = [t('{time} из {total}', { time: fmtTime(p.time, { ms: false }), total: fmtTime(p.duration, { ms: false }) })];
      if (p.speed) parts.push(t('скорость {speed}', { speed: p.speed.replace('x', '×') }));
      if (p.size) parts.push(fmtBytes(p.size));
      if (p.eta !== null && p.eta !== undefined) parts.push(t('осталось ≈ {eta}', { eta: fmtDur(Math.max(0, p.eta)) }));
      stats.textContent = parts.join(' · ');
    });
    const r = await api.startExport(JSON.parse(JSON.stringify(store.project)), settings);
    off();

    modal.innerHTML = '';
    modal.classList.remove('busy');
    if (r.ok) {
      const ratio = r.duration > 0 ? (r.size * 8 / r.duration / 1e6) : 0;
      modal.append(
        h('div', { class: 'modal-head' }, h('h2', {}, t('Готово!')), h('button', { class: 'icon-btn', onclick: close, html: icon('close', 18) })),
        h('div', { class: 'modal-body' },
          h('div', { class: 'done-icon', html: icon('check', 40) }),
          h('div', { class: 'export-target center' }, r.output.split(/[\\/]/).pop()),
          h('dl', { class: 'kv center' },
            h('dt', {}, t('Размер')), h('dd', {}, fmtBytes(r.size)),
            h('dt', {}, t('Средний битрейт')), h('dd', {}, t('{n} Мбит/с', { n: num(ratio, 1) })),
            h('dt', {}, t('Длительность')), h('dd', {}, fmtTime(r.duration)),
            h('dt', {}, t('Экспорт занял')), h('dd', {}, fmtDur(r.elapsed))), warnNote()),
        h('div', { class: 'modal-foot' },
          h('button', { class: 'btn ghost', onclick: () => api.showInFolder(r.output) }, h('span', { html: icon('folder', 17) }), t('Показать в папке')),
          h('button', { class: 'btn primary', onclick: () => api.openPath(r.output) }, h('span', { html: icon('play', 17) }), t('Открыть видео'))));
      toast(t('Экспорт завершён'), 'success');
    } else if (r.cancelled) {
      close();
      toast(t('Экспорт отменён'), 'info');
    } else {
      modal.append(
        h('div', { class: 'modal-head' }, h('h2', {}, t('Ошибка экспорта'))),
        h('div', { class: 'modal-body' },
          h('pre', { class: 'error-box' }, r.error || t('Неизвестная ошибка')),
          h('p', { class: 'muted small' }, t('Полный журнал: {path}', { path: `${appInfo.logsDir}${appInfo.sep}last-export.log` }))),
        h('div', { class: 'modal-foot' },
          h('button', { class: 'btn ghost', onclick: close }, t('Закрыть')),
          h('button', { class: 'btn primary', onclick: renderForm }, t('Назад к настройкам'))));
    }
  }

  renderForm();
}
