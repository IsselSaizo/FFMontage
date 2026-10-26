// Окно выбора папок (первый запуск и меню «Настройки папок»). Результат пишется в config.json.
import { h, icon } from './util.js';

const api = window.api;

const FIELDS = [
  { key: 'cacheDir', title: 'Кэш', desc: 'Миниатюры, волны звука, прокси-файлы, данные окна. Может занимать сотни мегабайт — лучше не на системный диск.' },
  { key: 'outputDir', title: 'Экспорт', desc: 'Сюда сохраняются готовые видео.' },
  { key: 'projectsDir', title: 'Проекты', desc: 'Файлы проектов (.ffproj), если сохранять их через Ctrl+S.' },
];

async function main() {
  const info = await api.setupInfo();
  const cfg = { ...info.config };
  const root = document.getElementById('setup');

  const errorBox = h('div', { class: 'setup-error' });
  const ffStatus = h('div', { class: 'ff-status muted small' }, 'Проверка…');
  const ffEnc = h('div', { class: 'ff-status muted small' });

  const row = (f) => {
    const input = h('input', { class: 'input', value: cfg[f.key] || '', spellcheck: 'false' });
    input.addEventListener('input', () => { cfg[f.key] = input.value; });
    const browse = h('button', { class: 'btn ghost small', onclick: async () => {
      const p = await api.pickFolder(input.value);
      if (p) { input.value = p; cfg[f.key] = p; }
    } }, h('span', { html: icon('folder', 16) }), 'Обзор…');
    return h('div', { class: 'setup-row' },
      h('div', { class: 'setup-label' }, h('b', {}, f.title), h('span', { class: 'muted small' }, f.desc)),
      h('div', { class: 'row gap' }, input, browse));
  };

  // FFmpeg: пусто = автопоиск
  const ffInput = h('input', { class: 'input', value: cfg.ffmpegDir || '', placeholder: 'Пусто — найти автоматически', spellcheck: 'false' });
  let checkSeq = 0;
  const check = async () => {
    const seq = ++checkSeq;
    ffStatus.className = 'ff-status muted small';
    ffStatus.textContent = 'Проверка…';
    ffEnc.textContent = '';
    const r = await api.checkFfmpeg(ffInput.value.trim());
    if (seq !== checkSeq) return;
    if (!r.ok) {
      ffStatus.className = 'ff-status bad small';
      ffStatus.textContent = `✗ ${r.error}. ${info.platform === 'win32' ? 'Запустите setup.cmd' : 'Запустите ./setup.sh или установите ffmpeg из репозитория дистрибутива'} либо укажите папку вручную.`;
      return;
    }
    ffStatus.className = 'ff-status good small';
    ffStatus.textContent = `✓ ${r.version.replace(/ Copyright.*/, '')} — ${r.path}`;
    if (r.major < 6) ffEnc.textContent = 'Версия старая: программа будет работать, но лучше FFmpeg 7 или новее.';
    ffEnc.textContent += ' Проверяю кодирование на видеокарте…';
    const enc = await api.setupEncoders(ffInput.value.trim());
    if (seq !== checkSeq || !enc) return;
    const gpu = ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc'].filter((e) => enc[e]);
    ffEnc.textContent = gpu.length
      ? `Видеокарта NVIDIA: ${gpu.map((e) => e.split('_')[0].toUpperCase().replace('H264', 'H.264')).join(', ')} — быстрый экспорт.`
      : 'Кодирование на видеокарте NVIDIA недоступно — экспорт будет идти на процессоре (медленнее).';
  };
  ffInput.addEventListener('change', () => { cfg.ffmpegDir = ffInput.value.trim(); check(); });
  const ffBrowse = h('button', { class: 'btn ghost small', onclick: async () => {
    const p = await api.pickFolder(ffInput.value);
    if (p) { ffInput.value = p; cfg.ffmpegDir = p; check(); }
  } }, h('span', { html: icon('folder', 16) }), 'Обзор…');

  const save = h('button', { class: 'btn primary', onclick: async () => {
    errorBox.textContent = '';
    save.disabled = true;
    cfg.ffmpegDir = ffInput.value.trim();
    const r = await api.saveSetup(cfg);
    if (!r.ok) { errorBox.textContent = r.error; save.disabled = false; return; }
    save.textContent = 'Перезапуск…';
  } }, info.firstRun ? 'Сохранить и запустить' : 'Сохранить и перезапустить');

  root.append(
    h('div', { class: 'setup-head' },
      h('div', { class: 'logo', html: icon('logo', 34) }),
      h('div', {},
        h('h1', {}, info.firstRun ? 'Добро пожаловать в FF Montage' : 'Настройки папок'),
        h('p', { class: 'muted' }, info.firstRun
          ? 'Выберите, где программа будет хранить файлы. Это можно поменять позже: меню ☰ → «Настройки папок».'
          : 'Новые папки начнут использоваться после перезапуска программы. Старые файлы не переносятся.'))),
    h('div', { class: 'setup-body' },
      ...FIELDS.map(row),
      h('div', { class: 'setup-row' },
        h('div', { class: 'setup-label' }, h('b', {}, 'FFmpeg'), h('span', { class: 'muted small' }, 'Папка с ffmpeg и ffprobe.')),
        h('div', { class: 'row gap' }, ffInput, ffBrowse),
        ffStatus, ffEnc),
      errorBox),
    h('div', { class: 'setup-foot' },
      h('span', { class: 'muted small cfg-path', title: info.configFile }, `Настройки: ${info.configFile}`),
      h('div', { class: 'row gap' },
        info.firstRun ? null : h('button', { class: 'btn ghost', onclick: () => api.cancelSetup() }, 'Отмена'),
        save)),
  );
  document.addEventListener('keydown', (e) => { if (e.key === 'F12') api.devtools(); });
  window.__setup = { cfg, check, save };
  await check();
}

main().catch((e) => { document.body.textContent = `Ошибка: ${e.message}`; });
