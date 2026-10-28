'use strict';
// Пути программы. Задаются в config.json рядом с программой (как config-файл у старых игр).
// Если config.json нет — программа запускается в режиме первой настройки и показывает окно выбора папок.
const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '..', '..');
// FFM_CONFIG — другой файл настроек (автотесты запускают программу с отдельным кэшем, не трогая ваш проект)
const CONFIG_FILE = process.env.FFM_CONFIG ? path.resolve(process.env.FFM_CONFIG) : path.join(APP_DIR, 'config.json');

// Объект общий для всех модулей: поля заполняются applyConfig() / applyFirstRun()
const PATHS = {
  APP_DIR,
  CONFIG_FILE,
  VENDOR_DIR: path.join(APP_DIR, 'vendor'),
  FIRSTRUN_DIR: path.join(APP_DIR, '.firstrun'),
  CACHE_DIR: null,
  OUTPUT_DIR: null,
  PROJECTS_DIR: null,
  FFMPEG_DIR: '',   // пусто — искать автоматически
};

function deriveCachePaths() {
  const APP_CACHE = path.join(PATHS.CACHE_DIR, 'app');
  Object.assign(PATHS, {
    APP_CACHE,
    USER_DATA: path.join(APP_CACHE, 'user'),
    SESSION_DATA: path.join(APP_CACHE, 'session'),
    LOGS: path.join(APP_CACHE, 'logs'),
    CRASH: path.join(APP_CACHE, 'crash'),
    TEMP: path.join(PATHS.CACHE_DIR, 'tmp'),
    MEDIA_CACHE: path.join(APP_CACHE, 'media'),
    AUTOSAVE: path.join(APP_CACHE, 'autosave.ffproj'),
  });
}

function applyConfig(cfg) {
  PATHS.CACHE_DIR = path.resolve(APP_DIR, cfg.cacheDir);
  PATHS.OUTPUT_DIR = path.resolve(APP_DIR, cfg.outputDir);
  PATHS.PROJECTS_DIR = path.resolve(APP_DIR, cfg.projectsDir || path.join(cfg.outputDir, '..', 'Projects'));
  PATHS.FFMPEG_DIR = cfg.ffmpegDir ? path.resolve(APP_DIR, cfg.ffmpegDir) : '';
  deriveCachePaths();
}

// Режим первой настройки: временные данные окна — в скрытой папке программы (потом удаляется)
function applyFirstRun() {
  PATHS.CACHE_DIR = PATHS.FIRSTRUN_DIR;
  PATHS.OUTPUT_DIR = PATHS.FIRSTRUN_DIR;
  PATHS.PROJECTS_DIR = PATHS.FIRSTRUN_DIR;
  deriveCachePaths();
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof cfg.cacheDir === 'string' && cfg.cacheDir && typeof cfg.outputDir === 'string' && cfg.outputDir) return cfg;
  } catch { /* нет файла или он испорчен */ }
  return null;
}

function saveConfig(cfg) {
  const data = {
    _comment: 'Настройки FF Montage. Можно править вручную или через меню → «Настройки папок». Удалите файл, чтобы снова увидеть окно первого запуска.',
    version: 1,
    cacheDir: cfg.cacheDir,
    outputDir: cfg.outputDir,
    projectsDir: cfg.projectsDir,
    ffmpegDir: cfg.ffmpegDir || '',
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Предложения для окна первого запуска.
// Если рядом с программой уже есть папки Cache / Output / Projects — берём их.
function suggestDefaults({ videosDir, documentsDir }) {
  const parent = path.dirname(APP_DIR);
  const near = (name) => {
    const p = path.join(parent, name);
    return fs.existsSync(p) ? p : null;
  };
  return {
    cacheDir: near('Cache') || path.join(APP_DIR, 'Cache'),
    outputDir: near('Output') || path.join(videosDir, 'FF Montage'),
    projectsDir: near('Projects') || (near('Cache') ? path.join(parent, 'Projects') : path.join(documentsDir, 'FF Montage')),
    ffmpegDir: '',
  };
}

function ensureDirs() {
  for (const p of [PATHS.CACHE_DIR, PATHS.APP_CACHE, PATHS.USER_DATA, PATHS.SESSION_DATA,
    PATHS.LOGS, PATHS.CRASH, PATHS.TEMP, PATHS.MEDIA_CACHE]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

module.exports = { PATHS, applyConfig, applyFirstRun, loadConfig, saveConfig, suggestDefaults, ensureDirs };
