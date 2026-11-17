// Стабилизация: запросы к программе (src-tauri/src/stab.rs) и подготовка экспорта. Без DOM и без store —
// грузится и в Node (тесты экспорта); живые задания окна, статус и плеер — js/stab.js.
//   analyzeReq — анализ движения vidstab для эффекта с prepare.kind 'vidstab' (Баланс / Максимум);
//   proxyReq   — прокси превью (чекбокс «Показывать превью»): цепочка эффекта на отрезке клипа; для vidstab — ровно на
//                отрезке анализа (fixed): .trf привязан к его кадрам;
//   prepareStabAssets — перед экспортом: дождаться анализа всех клипов (запустить, если не готов) → assets.stab
//                { [clipId]: { trf, start, end } } для exportPlan.js (stabPart).
import { sourceEffect, sourceChain, effectAvailable, setHostCaps } from './effects.js';
import { ffPath } from './core/ffEscape.js';
import { t } from './i18n.js';

/** Запас отрезка анализа по краям клипа, с (stab.rs MARGIN: обрезка клипа в его пределах не требует пересчёта) */
export const STAB_MARGIN = 1;

const fileOk = (m) => !!(m && m.path && m.hasVideo !== false && !m.isImage);

/** Запрос анализа движения клипа (null — эффекту анализ не нужен или клип без видео) */
export function analyzeReq(c, m) {
  const se = sourceEffect(c);
  if (!se || !se.prepare || se.prepare.kind !== 'vidstab' || !fileOk(m)) return null;
  return { file: m.path, in: c.in, out: c.out, margin: STAB_MARGIN, duration: Number(m.duration) || 0, args: se.prepare.args };
}

/**
 * Запрос прокси превью. analysis — готовый анализ { trf, start, end } (для vidstab обязателен).
 * null — превью не нужно (чекбокс выключен) или делать пока не из чего.
 */
export function proxyReq(c, m, analysis = null) {
  const se = sourceEffect(c);
  if (!se || !se.preview || !fileOk(m) || !effectAvailable(se.effect)) return null;
  if (se.prepare && !(analysis && analysis.trf)) return null;
  let chain = '';
  try { chain = sourceChain(c, m.width, se.prepare ? ffPath(analysis.trf) : null); } catch { return null; }
  if (!chain) return null;
  const req = { file: m.path, chain, in: c.in, out: c.out, margin: STAB_MARGIN, duration: Number(m.duration) || 0, audio: !!m.hasAudio };
  if (se.prepare) req.fixed = { start: analysis.start, end: analysis.end };
  return req;
}

/** Все видеоклипы проекта (основная, верхние дорожки, старые overlayClips), кроме скрытых дорожек */
function shownClips(p) {
  const lanes = [{ clips: p.videoClips || [], hidden: !!p.videoHidden },
    ...(p.videoTracks || []).map((tr) => ({ clips: tr.clips || [], hidden: !!tr.hidden })),
    { clips: p.overlayClips || [], hidden: false }];
  return lanes.filter((l) => !l.hidden).flatMap((l) => l.clips).filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cancelError = () => Object.assign(new Error(t('Экспорт отменён')), { cancelled: true });

/**
 * Перед экспортом: анализ движения для клипов с vidstab. Готов — сразу; нет — запускается и экспорт ждёт его
 * (api.emitStabPrepare — прогресс для окна экспорта; api.exportCancelled() — «Отмена»: задание отменяется).
 * Нет vidstab в сборке FFmpeg — клипы пропускаются (exportPlan.js предупредит). Ошибка анализа — ошибка экспорта.
 */
export async function prepareStabAssets(project, api) {
  const out = {};
  const media = project.media || {};
  const todo = [];
  for (const c of shownClips(project)) {
    const req = analyzeReq(c, media[c.mediaId]);
    if (req) todo.push({ c, req });
  }
  if (!todo.length) return out;
  const info = await api.info().catch(() => null);
  if (info && 'vidstab' in info) setHostCaps({ vidstab: !!info.vidstab });
  if (info && info.vidstab === false) return out;
  const cancelled = () => !!(api.exportCancelled && api.exportCancelled());
  let i = 0;
  for (const { c, req } of todo) {
    const name = String(c.name || (media[c.mediaId] && media[c.mediaId].name) || c.id).slice(0, 40);
    let r = null; let retried = false;
    for (;;) {
      if (cancelled()) { if (r && r.state === 'running' && r.id) await api.stabCancel(r.id); throw cancelError(); }
      r = await api.stabAnalyze(r && r.state === 'error' ? { ...req, retry: true } : req);
      if (r.state === 'ready') break;
      if (r.state === 'error') {
        // ошибка прошлого запуска (например, отменили) — один повтор
        if (!retried) { retried = true; continue; }
        throw new Error(t('Анализ движения клипа «{name}» не удался: {e}', { name, e: r.error || '?' }));
      }
      if (api.emitStabPrepare) api.emitStabPrepare({ fraction: (i + (Number(r.progress) || 0)) / todo.length, progress: Number(r.progress) || 0, name, index: i, total: todo.length });
      await sleep(300);
    }
    out[c.id] = { trf: r.trf, start: r.start, end: r.end };
    i++;
  }
  if (api.emitStabPrepare) api.emitStabPrepare({ fraction: 1, progress: 1, done: true, index: todo.length, total: todo.length });
  return out;
}
