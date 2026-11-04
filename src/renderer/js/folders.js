// Форма папок (кэш, экспорт, проекты, FFmpeg): окно первого запуска (setup.js) и «Настройки → Папки».
import { h, icon } from './util.js';
import { t } from './i18n.js';

const api = window.api;

const FIELDS = () => [
  { key: 'cacheDir', title: t('Кэш'), desc: t('Миниатюры, волны звука, прокси-файлы, данные окна. Может занимать сотни мегабайт — лучше не на системный диск.') },
  { key: 'outputDir', title: t('Экспорт'), desc: t('Сюда сохраняются готовые видео.') },
  { key: 'projectsDir', title: t('Проекты'), desc: t('Файлы проектов (.ffproj), если сохранять их через Ctrl+S.') },
];

/** Возвращает { el, cfg, check } — el: строки формы; cfg: текущие значения; check(): проверка FFmpeg */
export function foldersForm(info) {
  const cfg = { ...info.config };
  const ffStatus = h('div', { class: 'ff-status muted small' }, t('Проверка…'));
  const ffEnc = h('div', { class: 'ff-status muted small' });

  const row = (f) => {
    const input = h('input', { class: 'input', value: cfg[f.key] || '', spellcheck: 'false', dataset: { field: f.key } });
    input.addEventListener('input', () => { cfg[f.key] = input.value; });
    const browse = h('button', { class: 'btn ghost small', onclick: async () => {
      const p = await api.pickFolder(input.value);
      if (p) { input.value = p; cfg[f.key] = p; }
    } }, h('span', { html: icon('folder', 16) }), t('Обзор…'));
    return h('div', { class: 'setup-row' },
      h('div', { class: 'setup-label' }, h('b', {}, f.title), h('span', { class: 'muted small' }, f.desc)),
      h('div', { class: 'row gap' }, input, browse));
  };

  // FFmpeg: пусто = автопоиск
  const ffInput = h('input', { class: 'input', value: cfg.ffmpegDir || '', placeholder: t('Пусто — найти автоматически'), spellcheck: 'false', dataset: { field: 'ffmpegDir' } });
  let checkSeq = 0;
  const check = async () => {
    const seq = ++checkSeq;
    ffStatus.className = 'ff-status muted small';
    ffStatus.textContent = t('Проверка…');
    ffEnc.textContent = '';
    const r = await api.checkFfmpeg(ffInput.value.trim());
    if (seq !== checkSeq) return;
    if (!r.ok) {
      ffStatus.className = 'ff-status bad small';
      ffStatus.textContent = `✗ ${r.error}. ${info.platform === 'windows'
        ? t('Запустите setup.cmd либо укажите папку вручную.')
        : t('Запустите ./setup.sh или установите ffmpeg из репозитория дистрибутива либо укажите папку вручную.')}`;
      return;
    }
    ffStatus.className = 'ff-status good small';
    ffStatus.textContent = `✓ ${r.version.replace(/ Copyright.*/, '')} — ${r.path}`;
    if (r.major < 6) ffEnc.textContent = t('Версия старая: программа будет работать, но лучше FFmpeg 7 или новее.');
    ffEnc.textContent += ` ${t('Проверяю кодирование на видеокарте…')}`;
    const enc = await api.setupEncoders(ffInput.value.trim());
    if (seq !== checkSeq || !enc) return;
    const gpu = ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc'].filter((e) => enc[e]);
    ffEnc.textContent = gpu.length
      ? t('Видеокарта NVIDIA: {list} — быстрый экспорт.', { list: gpu.map((e) => e.split('_')[0].toUpperCase().replace('H264', 'H.264')).join(', ') })
      : t('Кодирование на видеокарте NVIDIA недоступно — экспорт будет идти на процессоре (медленнее).');
  };
  ffInput.addEventListener('change', () => { cfg.ffmpegDir = ffInput.value.trim(); check(); });
  const ffBrowse = h('button', { class: 'btn ghost small', onclick: async () => {
    const p = await api.pickFolder(ffInput.value);
    if (p) { ffInput.value = p; cfg.ffmpegDir = p; check(); }
  } }, h('span', { html: icon('folder', 16) }), t('Обзор…'));

  const el = h('div', { class: 'folders-form' },
    ...FIELDS().map(row),
    h('div', { class: 'setup-row' },
      h('div', { class: 'setup-label' }, h('b', {}, 'FFmpeg'), h('span', { class: 'muted small' }, t('Папка с ffmpeg и ffprobe.'))),
      h('div', { class: 'row gap' }, ffInput, ffBrowse),
      ffStatus, ffEnc));
  const values = () => ({ ...cfg, ffmpegDir: ffInput.value.trim() });
  return { el, cfg, values, check };
}
