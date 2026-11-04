// Раскладки кадра (M4.6): картинка в картинке и сетки. Чистые функции — без ffm, поэтому их можно
// проверить в Node (tests/layouts-test.js). На входе — результат инструмента get_project.
//
// Трансформ клипа (как в set_transform): x, y — сдвиг центра в долях кадра, scale — доля «вписанного» размера.
// Клип вписывается в кадр с сохранением пропорций, поэтому сетки ровные для клипов с пропорциями проекта.

const M = 0.03;           // поле от края кадра для «картинки в картинке»
const PIP = 0.3;          // размер «картинки в картинке»
const c = (PIP / 2) + M;  // сдвиг центра от края кадра
const e = 0.5 - c;

// slots — снизу вверх: первый слот получает нижний видимый клип
export const LAYOUTS = [
  { id: 'pip-tr', ru: 'Картинка в картинке ↗', en: 'Picture-in-picture ↗', min: 2, slots: [null, { x: e, y: -e, scale: PIP }] },
  { id: 'pip-tl', ru: 'Картинка в картинке ↖', en: 'Picture-in-picture ↖', min: 2, slots: [null, { x: -e, y: -e, scale: PIP }] },
  { id: 'pip-br', ru: 'Картинка в картинке ↘', en: 'Picture-in-picture ↘', min: 2, slots: [null, { x: e, y: e, scale: PIP }] },
  { id: 'pip-bl', ru: 'Картинка в картинке ↙', en: 'Picture-in-picture ↙', min: 2, slots: [null, { x: -e, y: e, scale: PIP }] },
  { id: 'side', ru: 'Два рядом', en: 'Side by side', min: 2, slots: [{ x: -0.25, y: 0, scale: 0.5 }, { x: 0.25, y: 0, scale: 0.5 }] },
  { id: 'grid', ru: 'Сетка 2×2', en: 'Grid 2×2', min: 2,
    slots: [{ x: -0.25, y: -0.25, scale: 0.5 }, { x: 0.25, y: -0.25, scale: 0.5 }, { x: -0.25, y: 0.25, scale: 0.5 }, { x: 0.25, y: 0.25, scale: 0.5 }] },
  { id: 'one-two', ru: 'Один большой и два', en: 'One large and two', min: 2,
    slots: [{ x: -1 / 6, y: 0, scale: 2 / 3 }, { x: 1 / 3, y: -1 / 6, scale: 1 / 3 }, { x: 1 / 3, y: 1 / 6, scale: 1 / 3 }] },
  { id: 'reset', ru: 'Сбросить раскладку', en: 'Reset layout', min: 1, slots: [] },
];

export const layoutById = (id) => LAYOUTS.find((l) => l.id === id) || null;

/** Видеоклипы под курсором на видимых дорожках, снизу вверх */
export function clipsAtPlayhead(project, t = project.playhead) {
  const tracks = [
    { id: 'video', hidden: !!(project.video_track && project.video_track.hidden), locked: !!(project.video_track && project.video_track.locked), clips: (project.video_track && project.video_track.clips) || [] },
    ...(project.upper_video_tracks || []),
  ];
  const out = [];
  for (const tr of tracks) {
    if (tr.hidden) continue;
    const clip = (tr.clips || []).find((x) => t >= x.start - 0.004 && t < x.end - 0.004);
    if (clip) out.push({ clip, track: tr });
  }
  return out;
}

const round = (v) => Math.round(v * 10000) / 10000;

/**
 * План раскладки: { calls: [{ clip_id, reset: true, x?, y?, scale? }], error?, skipped? }
 * Лишние клипы (их больше, чем слотов) не трогаются; клипы на дорожках с замком пропускаются.
 */
export function planLayout(project, id) {
  const L = layoutById(id);
  if (!L) return { calls: [], error: 'unknown-layout' };
  const shown = clipsAtPlayhead(project);
  if (shown.length < L.min) return { calls: [], error: shown.length ? 'need-more' : 'nothing' };
  const calls = []; let skipped = 0;
  const n = L.id === 'reset' ? shown.length : Math.min(shown.length, L.slots.length);
  for (let i = 0; i < n; i++) {
    const { clip, track } = shown[L.id.startsWith('pip-') && i === 1 ? shown.length - 1 : i];
    if (track.locked) { skipped++; continue; }
    const s = L.slots[i];
    calls.push(s ? { clip_id: clip.id, reset: true, x: round(s.x), y: round(s.y), scale: round(s.scale) } : { clip_id: clip.id, reset: true });
  }
  return { calls, skipped };
}
