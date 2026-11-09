#!/usr/bin/env node
// Тег релиза = версия программы (M0.12, R-4).
//   node tools/check-version.mjs v0.4.0   — тег должен быть vX.Y.Z и совпадать с версией во всех файлах
//   node tools/check-version.mjs v0.4.1-hotfix.1 — хотфикс (пре-релиз следующей версии, release.yml)
//   node tools/check-version.mjs          — только сверить файлы между собой
// Версия — X.Y.Z или X.Y.Z-hotfix.N (N ≥ 1, без ведущих нулей); другие суффиксы (rc, beta…) update.rs не понимает.
// Файлы: src-tauri/Cargo.toml ([package] version), src-tauri/tauri.conf.json, package.json, src-tauri/Cargo.lock (ff-montage).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const die = (msg) => { console.error(`check-version: ${msg}`); process.exit(1); };

const cargo = read('src-tauri/Cargo.toml').match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
const lock = read('src-tauri/Cargo.lock').match(/name = "ff-montage"\r?\nversion = "([^"]+)"/);
const found = {
  'src-tauri/Cargo.toml': cargo && cargo[1],
  'src-tauri/Cargo.lock': lock && lock[1],
  'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  'package.json': JSON.parse(read('package.json')).version,
};
for (const [f, v] of Object.entries(found)) if (!v) die(`${f}: версия не найдена`);
const version = found['src-tauri/Cargo.toml'];
// Как parse_version в update.rs: числа до 9 цифр, хотфикс — «-hotfix.N»
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-hotfix\.[1-9]\d{0,8})?$/;
if (!VERSION.test(version)) die(`версия ${version} не вида X.Y.Z или X.Y.Z-hotfix.N — программа не сможет сравнить её с тегом`);
for (const [f, v] of Object.entries(found)) if (v !== version) die(`${f}: ${v}, а в Cargo.toml ${version}`);

const tag = process.argv[2];
if (tag !== undefined) {
  if (!(tag.startsWith('v') && VERSION.test(tag.slice(1)))) die(`тег «${tag}» не вида vX.Y.Z или vX.Y.Z-hotfix.N — программа не предложит такое обновление`);
  if (tag.slice(1) !== version) die(`тег ${tag}, а версия программы ${version}`);
}
console.log(`OK: версия ${version}${tag ? `, тег ${tag}` : ''}`);
