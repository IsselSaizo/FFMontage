// Окно экспорта: настройки → прогресс → результат.
import { store } from './store.js';
import { h, fmtTime, fmtBytes, fmtDur, icon, toast } from './util.js';
import { t, num } from './i18n.js';
import { listExportPresets, onRegistryChange } from './registry.js';
import { buildExport, gpuFamily, CONTAINERS, VIDEO_CONTAINERS, AUDIO_CONTAINERS, AUDIO_CODECS, audioCodecFor, stemsAllowed, isAudioOnly, GIF_FPS, GIF_MAX_SEC } from './exportPlan.js';
import { invoke } from './tauri.js';
import './core/exportPresets.js';
import { exportableSubs } from './exportAssets.js';
import { getPref, setPref } from './prefs.js';

const api = window.api;
let encoders = null;
let open = false;

// gpu — кодировщики видеокарты в порядке выбора: NVIDIA (nvenc) → Intel (qsv) → AMD (amf) → VAAPI (Linux);
// берётся первый, который прошёл пробное кодирование (ff.rs detect_encoders), иначе — процессор (cpu)
const CODECS = [
  { id: 'av1', title: 'AV1', desc: t('Самый компактный файл при том же качестве. Рекомендуется.'), gpu: ['av1_nvenc', 'av1_qsv', 'av1_amf'], cpu: 'libsvtav1' },
  { id: 'hevc', title: 'HEVC (H.265)', desc: t('Почти как AV1, лучше поддерживается старыми устройствами.'), gpu: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_vaapi'], cpu: 'libx265' },
  { id: 'h264', title: 'H.264', desc: t('Открывается везде, но файл примерно вдвое больше.'), gpu: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi'], cpu: 'libx264' },
];
// Подпись видеокарты по семейству кодировщика
const GPU_VENDOR = { nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD', vaapi: 'VAAPI' };
const QUALITIES = [
  { id: 'high', title: t('Высокое'), desc: t('Почти без потерь') },
  { id: 'medium', title: t('Среднее'), desc: t('Баланс') },
  { id: 'compact', title: t('Компактное'), desc: t('Меньше размер') },
];

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

// Контейнер и звук (0.4.1)
const CONTAINER_INFO = {
  mp4: { label: 'MP4', desc: t('Открывается везде: телефоны, браузеры, соцсети.') },
  mkv: { label: 'MKV', desc: t('Любой звук (FLAC, Opus, PCM), субтитры SRT, несколько звуковых дорожек.') },
  mov: { label: 'MOV', desc: t('Для монтажных программ (Premiere, Resolve, Final Cut): звук PCM, несколько дорожек.') },
  gif: { label: 'GIF', desc: t('Анимация без звука, повторяется по кругу. Для коротких роликов (до {n} с) и небольшого размера — 480p и меньше.', { n: GIF_MAX_SEC }) },
  mp3: { label: 'MP3', desc: t('Только звук. Открывается везде.') },
  m4a: { label: 'M4A', desc: t('Только звук, AAC: телефоны, iTunes, браузеры.') },
  wav: { label: 'WAV', desc: t('Только звук без сжатия — для звукорежиссёра и других программ.') },
  ogg: { label: 'OGG', desc: t('Только звук, Vorbis: свободный формат, игры и Linux.') },
};
const AUDIO_INFO = {
  aac: { label: t('AAC 192 кбит/с') },
  aac256: { label: t('AAC 256 кбит/с') },
  aac128: { label: t('AAC 128 кбит/с') },
  opus: { label: t('Opus 160 кбит/с') },
  flac: { label: t('FLAC — без потерь') },
  pcm: { label: t('PCM 24 бит — без сжатия') },
  pcm16: { label: t('PCM 16 бит — без сжатия') },
  mp3: { label: t('MP3 320 кбит/с') },
  mp3_192: { label: t('MP3 192 кбит/с') },
  mp3_128: { label: t('MP3 128 кбит/с') },
  vorbis: { label: t('Vorbis 256 кбит/с') },
  vorbis_160: { label: t('Vorbis 160 кбит/с') },
};

// Последние настройки экспорта — settings.json → export (js/prefs.js)
function loadPrefs() {
  const p = getPref('export', {});
  return p && typeof p === 'object' ? { ...p } : {};
}
function savePrefs(p) { setPref('export', JSON.parse(JSON.stringify(p))); }

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
  for (const s of [2160, 1440, 1080, 720, 480]) {
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
    container: CONTAINERS.includes(prefs.container) ? prefs.container : 'mp4',
    audioCodec: AUDIO_CODECS.some((a) => a.id === prefs.audioCodec) ? prefs.audioCodec : 'aac',
    stems: !!prefs.stems,
    gifFps: GIF_FPS.includes(Number(prefs.gifFps)) ? Number(prefs.gifFps) : 15,
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
    const c = CODECS.find((x) => x.id === cid) || CODECS[0];
    const gpu = c.gpu.find((e) => encoders && encoders[e]);
    return gpu ? { enc: gpu, gpu: true, vendor: GPU_VENDOR[gpuFamily(gpu)] || '' } : { enc: c.cpu, gpu: false, vendor: '' };
  };
  // Проверить кодировщики заново (сменили видеокарту или драйвер): кэш encoders.json забывается (ff.rs enc_reset)
  const recheckBtn = () => h('button', {
    class: 'btn ghost small', id: 'export-recheck',
    title: t('Заново проверить, какие кодировщики работают (после смены видеокарты или драйвера)'),
    onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      try { encoders = await invoke('enc_reset'); } catch (e) { toast(String((e && e.message) || e), 'error'); }
      renderForm();
    },
  }, t('Проверить заново'));

  // ---------------- Форма ----------------
  function renderForm() {
    modal.innerHTML = '';
    modal.classList.remove('busy');
    const nameInput = h('input', { type: 'text', class: 'input', value: st.name, spellcheck: 'false' });
    nameInput.addEventListener('input', () => { st.name = nameInput.value; st.output = null; outLabel.textContent = outText(); });
    const outLabel = h('span', { class: 'out-path' });
    const outText = () => st.output || `${appInfo.outputDir}${appInfo.sep}${(st.name || t('Видео')).replace(/[\\/:*?"<>|]+/g, '_')}.${st.container}`;
    outLabel.textContent = outText();
    const pickBtn = h('button', { class: 'btn ghost small', onclick: async () => {
      const p = await api.pickExportPath(`${st.name || t('Видео')}.${st.container}`, st.container);
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
        h('div', { class: 'cc-title' }, c.title, h('span', { class: `cc-tag ${e.gpu ? 'gpu' : 'cpu'}`, title: e.enc }, e.gpu ? t('Видеокарта {vendor}', { vendor: e.vendor }) : t('Процессор'))),
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

    // Контейнер: смена сбрасывает выбранный путь (у него другое расширение)
    const contBtn = (c) => h('button', { class: st.container === c ? 'on' : '', dataset: { container: c }, title: CONTAINER_INFO[c].desc,
      onclick: () => {
        if (st.container === c) return;
        st.container = c; st.output = null;
        // GIF во весь кадр 1080p весит десятки мегабайт — по умолчанию 480p
        if (c === 'gif' && st.res === 'source' && short > 480 && resOptions.some((r) => r.id === '480')) st.res = '480';
        renderForm();
      } }, h('b', {}, CONTAINER_INFO[c].label));
    const contSeg = h('div', { id: 'export-container', class: 'export-formats' },
      h('div', { class: 'row gap' }, h('span', { class: 'muted small fmt-group' }, t('Видео')), h('div', { class: 'segmented' }, ...VIDEO_CONTAINERS.map(contBtn))),
      h('div', { class: 'row gap' }, h('span', { class: 'muted small fmt-group' }, t('Только звук')), h('div', { class: 'segmented' }, ...AUDIO_CONTAINERS.map(contBtn))));
    const audioOnly = isAudioOnly(st.container);
    const gif = st.container === 'gif';
    const gifSel = h('select', { class: 'input', id: 'export-gif-fps' }, ...GIF_FPS.map((v) => h('option', { value: String(v), selected: st.gifFps === v }, `${v} fps`)));
    gifSel.addEventListener('change', () => { st.gifFps = Number(gifSel.value); });
    const tooLong = gif && store.duration() > GIF_MAX_SEC;
    const acodecNow = audioCodecFor(st.container, st.audioCodec).id;
    const audioSel = h('select', { class: 'input', id: 'export-audio-codec' }, ...AUDIO_CODECS.filter((a) => a.in.includes(st.container))
      .map((a) => h('option', { value: a.id, selected: a.id === acodecNow }, AUDIO_INFO[a.id].label)));
    audioSel.addEventListener('change', () => { st.audioCodec = audioSel.value; renderForm(); });
    const trackCount = (store.project.audioTracks || []).filter((tr) => !tr.muted && (tr.clips || []).length).length;
    const stemsBox = stemsAllowed(st.container) && trackCount > 0
      ? h('label', { class: 'check', title: t('Поток 1 — общий микс, дальше — звук видео и каждая аудиодорожка отдельно (с названиями дорожек)') },
        (() => { const cb = h('input', { type: 'checkbox', id: 'export-stems', checked: st.stems }); cb.addEventListener('change', () => { st.stems = cb.checked; }); return cb; })(),
        ' ', t('Аудиодорожки отдельными потоками'))
      : null;
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
          h('label', {}, t('Формат файла')), h('div', {}, contSeg, h('div', { class: 'muted small' }, CONTAINER_INFO[st.container].desc),
            tooLong ? h('div', { class: 'setup-error small' }, t('Ролик длиннее {n} с — для GIF слишком длинный. Обрежьте его или выберите видео.', { n: GIF_MAX_SEC })) : null),
          presetSel && !audioOnly && !gif ? h('label', {}, t('Пресет')) : null, !audioOnly && !gif ? presetSel : null,
          !audioOnly ? h('label', {}, t('Разрешение')) : null, audioOnly ? null : preset && !gif ? fromPreset(`${preset.width}×${preset.height}`) : select(resOptions, 'res'),
          !audioOnly ? h('label', {}, t('Частота кадров')) : null, audioOnly ? null : gif ? gifSel : preset ? fromPreset(`${preset.fps} fps`) : select(fpsOptions, 'fps'),
          !audioOnly && !gif ? h('label', {}, t('Кодек')) : null, !audioOnly && !gif ? codecCards : null,
          !audioOnly && !gif ? h('label', {}, t('Качество')) : null, !audioOnly && !gif ? qual : null,
          !gif ? h('label', {}, t('Звук')) : null, !gif ? h('div', { class: 'row gap' }, audioSel, stemsBox) : null,
          hasSubs && !audioOnly ? h('label', {}, t('Субтитры в видео')) : null,
          hasSubs && !audioOnly ? select(gif ? SUB_MODES.filter((m) => m.id !== 'soft') : SUB_MODES, 'subtitles') : null),
        audioOnly || gif ? h('p', { class: 'muted small' }, t('Длительность ролика: {dur}.', { dur: fmtTime(store.duration()) }),
          audioOnly ? ` ${t('Звук: {a}, 48 кГц.', { a: AUDIO_INFO[acodecNow].label })}` : '') : h('p', { class: 'muted small' },
          encoderFor(st.codec).gpu
            ? t('Длительность ролика: {dur}. Кодирование идёт на видеокарте ({gpu}) — быстро.', { dur: fmtTime(store.duration()), gpu: encoderFor(st.codec).vendor })
            : t('Длительность ролика: {dur}. Кодирование идёт на процессоре — дольше.', { dur: fmtTime(store.duration()) }),
          ' ', t('Звук: {a}, 48 кГц.', { a: AUDIO_INFO[acodecNow].label }),
          ' ', recheckBtn())),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn ghost', onclick: close }, t('Отмена')),
        h('button', { class: 'btn primary', id: 'export-go', onclick: start, disabled: tooLong }, h('span', { html: icon('export', 18) }), t('Экспортировать'))));
    nameInput.focus();
    nameInput.select();
  }

  // ---------------- Экспорт ----------------
  async function start() {
    savePrefs({ res: st.res, fps: st.fps, codec: st.codec, quality: st.quality, preset: st.preset, subtitles: st.subtitles, container: st.container, audioCodec: st.audioCodec, stems: st.stems, gifFps: st.gifFps });
    const audioOnly = isAudioOnly(st.container); const gif = st.container === 'gif';
    if (st.name && st.name !== store.project.name) store.mutate((p) => { p.name = st.name; });
    const preset = audioOnly || gif ? null : presetById(st.preset);
    const res = preset ? { w: preset.width, h: preset.height } : resOptions.find((r) => r.id === st.res);
    const fps = preset ? { v: preset.fps } : gif ? { v: st.gifFps } : fpsOptions.find((r) => r.id === st.fps);
    const enc = encoderFor(st.codec);
    const output = st.output || await api.defaultExportPath(st.name || t('Видео'), st.container);
    const exists = await api.exists(output);
    const subtitles = audioOnly ? 'none' : gif && st.subtitles === 'soft' ? 'burn' : st.subtitles;
    const settings = { width: res.w, height: res.h, fps: fps.v, codec: enc.enc, quality: st.quality, output, subtitles,
      container: st.container, audioCodec: audioCodecFor(st.container, st.audioCodec).id, stems: st.stems && stemsAllowed(st.container) };
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
          h('span', { class: 'muted' }, audioOnly ? ` · ${AUDIO_INFO[audioCodecFor(st.container, st.audioCodec).id].label}` : gif ? ` · ${res.w}×${res.h} · ${fps.v} fps · GIF` : ` · ${res.w}×${res.h} · ${fps.v} fps · ${CODECS.find((c) => c.id === st.codec).title}`)),
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
    // Пока готовится звук с аудиоплагинами (VST3 / CLAP) — его прогресс; потом его сменит прогресс FFmpeg
    let ffStarted = false;
    const offExp = off;
    const offVst = typeof api.onVstRender === 'function' ? api.onVstRender((p) => {
      if (ffStarted || !p || !Number.isFinite(p.fraction)) return;
      stats.textContent = t('Обработка звука аудиоплагинами… {p}%', { p: Math.round(p.fraction * 100) });
    }) : () => {};
    const offFf = api.onExportProgress(() => { ffStarted = true; });
    const r = await api.startExport(JSON.parse(JSON.stringify(store.project)), settings);
    offExp(); offVst(); offFf();

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
          h('button', { class: 'btn primary', onclick: () => api.openPath(r.output) }, h('span', { html: icon('play', 17) }), audioOnly ? t('Открыть файл') : t('Открыть видео'))));
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
