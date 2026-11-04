// Права плагинов: проверка (её делает только главное окно, SDK лишь передаёт запросы)
// и описание человеческим языком для настроек и окна установки.
import { t } from '../i18n.js';

export const KNOWN = ['project:read', 'project:write', 'ui:panel', 'storage', 'notify'];
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Права из манифеста → Set (неизвестные отбрасываются; net:<хост> — только имя хоста) */
export function permissionSet(manifest) {
  const out = new Set();
  const list = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const p of list) {
    if (typeof p !== 'string') continue;
    if (KNOWN.includes(p)) out.add(p);
    else if (p.startsWith('net:') && HOST.test(p.slice(4).toLowerCase())) out.add(`net:${p.slice(4).toLowerCase()}`);
  }
  // project:write без project:read бессмыслен — запись подразумевает чтение
  if (out.has('project:write')) out.add('project:read');
  return out;
}

export const netHosts = (perms) => [...perms].filter((p) => p.startsWith('net:')).map((p) => p.slice(4));

/** Ошибка «нет права» — текст уходит в плагин (для разработчика, по-английски) */
export function need(perms, perm) {
  if (!perms.has(perm)) throw new Error(`Permission denied: "${perm}" is not declared in plugin.json`);
}

/** Можно ли плагину ходить по этому адресу (Rust проверяет то же самое ещё раз) */
export function checkNetUrl(perms, url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`Bad URL: ${url}`); }
  if (u.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
  const host = u.hostname.toLowerCase();
  if (!netHosts(perms).includes(host)) throw new Error(`Permission denied: "net:${host}" is not declared in plugin.json`);
  return u.href;
}

/** Строки для показа пользователю: что плагин сможет делать */
export function describePermissions(manifest) {
  const perms = permissionSet(manifest);
  const rows = [];
  if (manifest && typeof manifest.entry === 'string' && manifest.entry) rows.push({ id: 'code', text: t('Выполняет свой код в песочнице (без доступа к файлам и программе)') });
  if (perms.has('project:read')) rows.push({ id: 'project:read', text: t('Читать проект: клипы, эффекты, названия и пути файлов') });
  if (perms.has('project:write')) rows.push({ id: 'project:write', text: t('Изменять проект (изменения отменяются через «Отменить»)'), warn: true });
  if (perms.has('ui:panel')) rows.push({ id: 'ui:panel', text: t('Показывать свою вкладку в правой панели') });
  if (perms.has('storage')) rows.push({ id: 'storage', text: t('Хранить свои настройки и данные (до 1 МБ)') });
  if (perms.has('notify')) rows.push({ id: 'notify', text: t('Показывать уведомления') });
  for (const host of netHosts(perms)) rows.push({ id: `net:${host}`, text: t('Обращаться в интернет к {host}', { host }), warn: true });
  const filters = manifest && manifest.ffmpeg && Array.isArray(manifest.ffmpeg.filters) ? manifest.ffmpeg.filters.filter((x) => typeof x === 'string') : [];
  if (filters.length) rows.push({ id: 'ffmpeg', text: t('Фильтры FFmpeg при экспорте: {list}', { list: filters.join(', ') }) });
  return rows;
}
