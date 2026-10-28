'use strict';
// Движок программы для автотестов: вызывает «ff-montage --engine <команда>» (src-tauri/src/cli.rs)
// и даёт те же функции, что были у src/main/ffmpeg.js в Electron-версии.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_DIR = path.resolve(__dirname, '..');
const EXE_NAME = process.platform === 'win32' ? 'ff-montage.exe' : 'ff-montage';

function findExe() {
  const c = [process.env.FFM_EXE,
    path.join(APP_DIR, 'src-tauri', 'target', 'release', EXE_NAME),
    path.join(APP_DIR, 'src-tauri', 'target', 'debug', EXE_NAME),
    path.join(APP_DIR, process.platform === 'win32' ? 'FF Montage.exe' : 'ff-montage')].filter(Boolean);
  const exe = c.find((p) => fs.existsSync(p));
  if (!exe) throw new Error(`Программа не собрана: нет ${c.join(' / ')}. Соберите: cd src-tauri && cargo build --release`);
  return exe;
}
const EXE = findExe();

// Программа ещё не настроена (CI) — отдельный config.json во временной папке проекта
function ensureConfig() {
  if (process.env.FFM_CONFIG) return;
  if (fs.existsSync(path.join(APP_DIR, 'config.json'))) return;
  const base = path.join(APP_DIR, '.test-cache');
  fs.mkdirSync(base, { recursive: true });
  const cfg = path.join(base, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, cacheDir: base, outputDir: path.join(base, 'out'), projectsDir: path.join(base, 'projects'), ffmpegDir: '' }, null, 2));
  process.env.FFM_CONFIG = cfg;
}
ensureConfig();

function engine(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(EXE, ['--engine', cmd], { windowsHide: true, env: process.env });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', () => {
      let j;
      try { j = JSON.parse(out.trim().split('\n').pop()); } catch { reject(new Error(`engine ${cmd}: ${err || out}`)); return; }
      if (j.ok) resolve(j.result); else reject(new Error(j.error));
    });
    p.stdin.end(JSON.stringify(args));
  });
}

let BIN = null;
let PATHS = null;
const ready = (async () => {
  PATHS = await engine('paths');
  const v = await engine('version');
  BIN = { ffmpeg: v.ffmpeg, missing: v.missing, version: v.version };
})();

function run(cmd, args, { binaryStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    p.on('error', reject);
    p.on('close', (code) => {
      const stdout = binaryStdout ? Buffer.concat(out) : Buffer.concat(out).toString();
      if (code === 0) resolve({ stdout, stderr: err });
      else reject(Object.assign(new Error(`${path.basename(cmd)} код ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`), { stderr: err }));
    });
  });
}

let planMod = null;
async function startExport(project, settings, { onProgress } = {}) {
  if (!planMod) planMod = await import(pathToFileURL(path.join(APP_DIR, 'src', 'renderer', 'js', 'exportPlan.js')).href);
  const plan = planMod.exportCommand(project, settings, BIN.version ? BIN.version[1] : 99);
  const r = await engine('export', { plan });
  if (onProgress) onProgress({ fraction: r.lastProgress });
  return r;
}

module.exports = {
  EXE, ready, engine, run, startExport,
  paths: () => PATHS,
  findBinaries: () => BIN,
  version: async () => (BIN.version ? BIN.version[0] : null),
  detectEncoders: () => engine('encoders'),
  probe: (file) => engine('probe', { file }),
  thumbs: (info) => engine('thumbs', { info }),
  peaks: (info) => engine('peaks', { info }),
  proxy: (info) => engine('proxy', { info }),
  reverse: (info, a, b) => engine('reverse', { info, a, b }),
  freeze: (info, at) => engine('freeze', { info, at }),
  silence: (file, threshold, min) => engine('silence', { file, threshold, min }),
  frameJpeg: (file, t, width) => engine('frame', { file, t, width }).then((b) => Buffer.from(b, 'base64')),
  FREEZE_FILE_SEC: 20,
};
