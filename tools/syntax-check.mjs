// Проверка синтаксиса ES-модулей окна без запуска (у них DOM и window.api на верхнем уровне):
// node tools/syntax-check.mjs [файлы…] — по умолчанию все src/renderer/js/**/*.js. Код выхода 1 — есть ошибки.
import { readdirSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => join(process.cwd(), f)) : walk(join(ROOT, 'src', 'renderer', 'js'));
const tmp = mkdtempSync(join(tmpdir(), 'ffm-syntax-'));
let bad = 0;
for (const f of files) {
  // Копия с расширением .mjs — node --check разбирает её как модуль
  const copy = join(tmp, 'x.mjs');
  writeFileSync(copy, readFileSync(f));
  const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    console.log(`FAIL ${relative(ROOT, f)}\n${(r.stderr || '').split('\n').slice(0, 6).join('\n').replaceAll(copy, relative(ROOT, f))}`);
  }
}
rmSync(tmp, { recursive: true, force: true });
console.log(`syntax: файлов ${files.length}, ошибок ${bad}`);
process.exit(bad ? 1 : 0);
