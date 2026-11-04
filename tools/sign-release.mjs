#!/usr/bin/env node
// Подпись релиза FF Montage (M0.10): SHA256SUMS + подпись ed25519 в формате, похожем на minisign.
//
//   node tools/sign-release.mjs sign <папка>      — SHA256SUMS по всем файлам папки + SHA256SUMS.sig
//                                                   ключ: переменная FFM_SIGNING_KEY (PEM PKCS#8) или FFM_SIGNING_KEY_FILE (путь)
//   node tools/sign-release.mjs verify <папка>    — проверить SHA256SUMS, хэши файлов и подпись открытым ключом из update.rs
//   node tools/sign-release.mjs keygen <папка>    — новая пара ключей: update-signing.key (секрет!) и update-signing.pub
//   node tools/sign-release.mjs pubkey            — открытый ключ из FFM_SIGNING_KEY / FFM_SIGNING_KEY_FILE
//
// Форматы (их же разбирает src-tauri/src/update.rs):
//   открытый ключ — base64("Ed" + keyid[8] + ключ[32]); keyid = первые 8 байт SHA-256 от ключа;
//   SHA256SUMS.sig — строка «untrusted comment: …» и строка base64("Ed" + keyid[8] + подпись[64]);
//   подписываются байты файла SHA256SUMS целиком (чистый Ed25519, без предварительного хэширования).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_RS = path.join(ROOT, 'src-tauri', 'src', 'update.rs');
const SUMS = 'SHA256SUMS';
const SIG = 'SHA256SUMS.sig';

const die = (msg) => { console.error(`sign-release: ${msg}`); process.exit(1); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function rawPublic(keyObject) {
  const pub = keyObject.type === 'public' ? keyObject : crypto.createPublicKey(keyObject);
  const jwk = pub.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519') die('ключ не Ed25519');
  return Buffer.from(jwk.x, 'base64url');
}
const keyId = (pk) => sha256(pk).subarray(0, 8);
const encodePublic = (pk) => Buffer.concat([Buffer.from('Ed'), keyId(pk), pk]).toString('base64');

function decodePublic(text) {
  const b = Buffer.from(text.trim(), 'base64');
  if (b.length !== 42 || b.subarray(0, 2).toString() !== 'Ed') die('открытый ключ: неверный формат');
  const pk = b.subarray(10);
  if (!keyId(pk).equals(b.subarray(2, 10))) die('открытый ключ: keyid не совпадает');
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pk.toString('base64url') }, format: 'jwk' });
  return { pk, key };
}

function loadPrivate() {
  let pem = process.env.FFM_SIGNING_KEY;
  if (!pem && process.env.FFM_SIGNING_KEY_FILE) pem = fs.readFileSync(process.env.FFM_SIGNING_KEY_FILE, 'utf8');
  if (!pem) die('нет ключа: задайте FFM_SIGNING_KEY (текст PEM) или FFM_SIGNING_KEY_FILE');
  // В секретах GitHub переводы строк иногда превращаются в «\n» — вернём их
  pem = pem.replace(/\\n/g, '\n').trim();
  try { return crypto.createPrivateKey(pem); } catch (e) { die(`не удалось прочитать ключ: ${e.message}`); }
}

// Открытый ключ, зашитый в программу (константа UPDATE_PUBKEY в update.rs)
function embeddedPublic() {
  const m = fs.readFileSync(UPDATE_RS, 'utf8').match(/const UPDATE_PUBKEY: &str = "([^"]+)";/);
  if (!m) die('в update.rs не найдена константа UPDATE_PUBKEY');
  return decodePublic(m[1]);
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== SUMS && e.name !== SIG)
    .map((e) => e.name)
    .sort();
}

function sumsText(dir) {
  const names = listFiles(dir);
  if (!names.length) die(`в ${dir} нет файлов`);
  for (const n of names) if (/\s/.test(n)) die(`имя файла с пробелом: «${n}»`);
  return names.map((n) => `${sha256(fs.readFileSync(path.join(dir, n))).toString('hex')}  ${n}\n`).join('');
}

function sigText(data, privateKey) {
  const pk = rawPublic(privateKey);
  const sig = crypto.sign(null, data, privateKey);
  const blob = Buffer.concat([Buffer.from('Ed'), keyId(pk), sig]).toString('base64');
  return `untrusted comment: FF Montage SHA256SUMS signature, key ${keyId(pk).toString('hex').toUpperCase()}\n${blob}\n`;
}

function verifySig(data, text, pub) {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('untrusted comment:'));
  const b = Buffer.from(line || '', 'base64');
  if (b.length !== 74 || b.subarray(0, 2).toString() !== 'Ed') return 'неверный формат подписи';
  if (!b.subarray(2, 10).equals(keyId(pub.pk))) return 'подпись сделана другим ключом';
  return crypto.verify(null, data, pub.key, b.subarray(10)) ? null : 'подпись не сходится';
}

function verifyDir(dir, pub) {
  const sums = fs.readFileSync(path.join(dir, SUMS));
  const err = verifySig(sums, fs.readFileSync(path.join(dir, SIG), 'utf8'), pub);
  if (err) die(`${SIG}: ${err}`);
  let n = 0;
  for (const line of sums.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (!m) die(`${SUMS}: строка не разобрана: ${line}`);
    const got = sha256(fs.readFileSync(path.join(dir, m[2]))).toString('hex');
    if (got !== m[1]) die(`${m[2]}: SHA-256 не совпадает`);
    n++;
  }
  console.log(`OK: подпись верна, файлов проверено: ${n}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'sign') {
  if (!arg) die('укажите папку с файлами релиза');
  const key = loadPrivate();
  const pub = embeddedPublic();
  if (!rawPublic(key).equals(pub.pk)) die('ключ подписи не соответствует UPDATE_PUBKEY в update.rs — программа отвергнет такое обновление');
  const sums = sumsText(arg);
  fs.writeFileSync(path.join(arg, SUMS), sums);
  fs.writeFileSync(path.join(arg, SIG), sigText(Buffer.from(sums), key));
  process.stdout.write(sums);
  verifyDir(arg, pub);
} else if (cmd === 'verify') {
  if (!arg) die('укажите папку');
  verifyDir(arg, embeddedPublic());
} else if (cmd === 'keygen') {
  if (!arg) die('укажите папку для ключей (вне репозитория!)');
  const keyFile = path.join(arg, 'update-signing.key');
  if (fs.existsSync(keyFile)) die(`${keyFile} уже есть — не перезаписываю`);
  fs.mkdirSync(arg, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = encodePublic(rawPublic(publicKey));
  fs.writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  fs.writeFileSync(path.join(arg, 'update-signing.pub'), `${pub}\n`);
  console.log(`Ключ: ${keyFile}\nconst UPDATE_PUBKEY: &str = "${pub}";`);
} else if (cmd === 'pubkey') {
  console.log(encodePublic(rawPublic(loadPrivate())));
} else {
  die('команды: sign <папка> | verify <папка> | keygen <папка> | pubkey');
}
