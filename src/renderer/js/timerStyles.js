// Стили таймера (0.5.0): три рисунка в виде параметрического SVG — «классический» (секундомер), «цифровой»
// (кольцо с цифрами внутри), «ретро» (кухонный таймер). Без DOM: модуль используется окном, экспортом и автотестами.
//
// Рисунок разложен на слои — так его собирает и плеер (timer.js, холст), и экспорт (FFmpeg: статичные PNG, поворот,
// обрезка, цифры из ленты символов, звонок — APNG). Координаты — в единицах viewBox стиля, центр циферблата — pivot.
//   back      статичный: корпус, циферблат, подложка цифр, тень
//   progress  сектор от 12 часов по часовой, θ = 360°·p, только из двух половинок (полукруг или полукольцо):
//               R (θ < 180°)  = левая половинка, повёрнутая на θ, обрезанная по правой половине (x ≥ pivot)
//               R (θ ≥ 180°)  = статичная правая половина с нахлёстом OV за центр (прячет швы на 6 и 12 часах)
//               L (θ > 180°)  = правая половинка, повёрнутая на θ − 180°, обрезанная по левой половине (x ≤ pivot)
//             «остаток» (progress: 'remaining'): под половинками — полная фигура цветом fill, половинки — цветом «пусто»
//   front     статичный: деления, обвод циферблата
//   hand      стрелка (у цифрового — бегунок на дуге), поворот на θ вокруг pivot
//   cap       статичный: втулка поверх стрелки
//   digits    символы в ячейках постоянной ширины (цифра 0.62·fs, двоеточие 0.34·fs); формат — по длительности
//   ring      звонок RING_DUR с: рисунок целиком (поза pose + эффекты fxBack / fxFront)
// Вращающиеся слои (половинки, стрелка) рисуются в квадрате 2·spin × 2·spin с центром в pivot.

export const RING_DUR = 1.6;
export const TIMER_STYLES = Object.freeze(['classic', 'digital', 'retro']);
export const OV = 1.5;   // нахлёст статичной правой половины за центр, единиц

/** Формат цифр — по длительности (не меняется во время клипа) */
export const fmtFor = (duration) => (duration >= 3600 ? 'h:mm:ss' : duration >= 600 ? 'mm:ss' : 'm:ss');
const p2 = (n) => String(n).padStart(2, '0');
/** Время в формате fmt: 75 → «1:15» / «01:15» / «0:01:15» */
export function fmtTime(sec, fmt) {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = s % 60;
  if (fmt === 'h:mm:ss') return `${h}:${p2(m)}:${p2(ss)}`;
  if (fmt === 'mm:ss') return `${p2(Math.floor(s / 60))}:${p2(ss)}`;
  return `${Math.floor(s / 60)}:${p2(ss)}`;
}

/** Ячейки формата: [{ ch, x (центр ячейки от левого края), w }], width — ширина всей строки (в единицах fs) */
export function cells(fmt, fs) {
  const list = []; let x = 0;
  for (const ch of fmt) { const w = (ch === ':' ? 0.34 : 0.62) * fs; list.push({ ch, x: x + w / 2, w }); x += w; }
  return { list, width: x };
}

const f = (n) => (Math.round(n * 100) / 100).toString();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, k) => {
  const pa = parseInt(a.slice(1), 16); const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
};
const pol = (r, deg) => { const a = ((deg - 90) * Math.PI) / 180; return [r * Math.cos(a), r * Math.sin(a)]; };

// Половинки «вверх» (от 12 часов) с центром в 0,0. r = 0 — полукруг, r > 0 — полукольцо.
export const leftHalf = (R, r) => (r > 0
  ? `M0 ${-R}A${R} ${R} 0 0 0 0 ${R}L0 ${r}A${r} ${r} 0 0 1 0 ${-r}Z`
  : `M0 ${-R}A${R} ${R} 0 0 0 0 ${R}Z`);
export const rightHalf = (R, r) => (r > 0
  ? `M0 ${-R}A${R} ${R} 0 0 1 0 ${R}L0 ${r}A${r} ${r} 0 0 0 0 ${-r}Z`
  : `M0 ${-R}A${R} ${R} 0 0 1 0 ${R}Z`);
export const fullShape = (R, r) => (r > 0
  ? `M${-R} 0A${R} ${R} 0 1 0 ${R} 0A${R} ${R} 0 1 0 ${-R} 0ZM${-r} 0A${r} ${r} 0 1 1 ${r} 0A${r} ${r} 0 1 1 ${-r} 0Z`
  : `M${-R} 0A${R} ${R} 0 1 0 ${R} 0A${R} ${R} 0 1 0 ${-R} 0Z`);

const shadowDef = (dy, sd, op) => `<filter id="sh" x="-30%" y="-30%" width="160%" height="160%">`
  + `<feDropShadow dx="0" dy="${dy}" stdDeviation="${sd}" flood-color="#000" flood-opacity="${op}"/></filter>`;

// Каждый стиль: palette — цвета по умолчанию, viewBox, pivot — центр циферблата, spin — полуразмер квадрата
// вращающихся слоёв; parts(c, st, P) → { defs, back, front, hand (на угол 0), cap, digits {cx, cy, fs, color, show},
// progress {R, r, paint, empty}, fxBack, fxFront, pose [операции] }. st = { p, ringing, u }; P = { fmt, progress, digits }.
// Поза: ['t', x, y] | ['r', deg, cx, cy] | ['s', sx, sy] — по порядку, как список transform в SVG.
const STYLES = {
  // Классический секундомер: головка и две кнопки, толстый безель, стрелка-игла, капсула с цифрами под корпусом
  classic: {
    palette: { case: '#2e4066', face: '#f5f2ea', fill: '#ffa23a', ink: '#121722', accent: '#ff5468', digits: '#ffffff' },
    viewBox: [-165, -192, 330, 384],
    pivot: [0, 0],
    spin: 84,
    parts(c, st, P) {
      const R = 100; const RF = 80;
      const ring = st.ringing; const u = st.u;
      const press = ring ? Math.max(0, 1 - ((u % 0.4) / 0.12)) * 7 : 0;   // головку нажимают на каждый удар
      const flash = ring && Math.floor(u * 5) % 2 === 0;
      const fs = 42; const cl = cells(P.fmt, fs); const bw = cl.width + 36; const bh = 58; const by = 134;
      const pusher = (deg) => `<g transform="rotate(${deg})"><rect x="-10" y="-121" width="20" height="24" rx="5" fill="${c.case}" stroke="${c.ink}" stroke-width="6"/></g>`;
      const back = '<g filter="url(#sh)">'
        + pusher(-42) + pusher(42)
        + `<g transform="translate(0 ${f(press)})"><rect x="-10" y="-124" width="20" height="30" fill="${c.ink}"/>`
        + `<rect x="-27" y="-146" width="54" height="26" rx="9" fill="${c.accent}" stroke="${c.ink}" stroke-width="6"/>`
        + `<path d="M-13 -139v12M0 -139v12M13 -139v12" stroke="${c.ink}" stroke-width="3.5" stroke-linecap="round" opacity=".45"/></g>`
        + `<circle r="${R}" fill="${c.case}" stroke="${c.ink}" stroke-width="7"/>`
        + (P.digits ? `<rect x="${f(-bw / 2)}" y="${by - bh / 2}" width="${f(bw)}" height="${bh}" rx="${bh / 2}" fill="${flash ? c.accent : c.ink}" stroke="${c.case}" stroke-width="5"/>` : '')
        + '</g>'
        + `<circle r="${RF}" fill="${c.face}"/>`;
      let ticks = '';
      for (let i = 0; i < 12; i++) {
        const major = i % 3 === 0;
        const [x1, y1] = pol(major ? 60 : 66, i * 30); const [x2, y2] = pol(73, i * 30);
        ticks += `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${c.ink}" stroke-width="${major ? 6.5 : 4}" stroke-linecap="round"/>`;
      }
      const front = `<circle r="${RF}" fill="none" stroke="${c.ink}" stroke-width="5"/>${ticks}`;
      const hand = `<path d="M0 -70L4.2 0 2.6 20h-5.2L-4.2 0Z" fill="${c.ink}" stroke="${c.ink}" stroke-width="2" stroke-linejoin="round"/>`
        + `<circle cy="16" r="6" fill="${c.accent}" stroke="${c.ink}" stroke-width="3"/>`;
      const cap = `<circle r="9.5" fill="${c.ink}"/><circle r="3.6" fill="${c.accent}"/>`;
      // Звонок: секундомер качается, подвешенный за головку; головка щёлкает; два расходящихся импульса
      const pose = []; let fxBack = '';
      if (ring) {
        const env = u < 1.25 ? 1 : Math.max(0, 1 - (u - 1.25) / 0.35);
        pose.push(['r', 10 * Math.sin(u * Math.PI * 2 * 2.5) * env, 0, -146]);
        for (const k of [0, 0.5]) {
          const ph = (u * 1.25 + k) % 1;
          fxBack += `<circle r="${f(106 + 52 * ph)}" fill="none" stroke="${c.accent}" stroke-width="${f(9 * (1 - ph) + 1.5)}" opacity="${f((1 - ph) * 0.95 * env)}"/>`;
        }
      }
      return {
        defs: shadowDef(4, 5, 0.45), back, front, hand, cap, fxBack, fxFront: '', pose,
        digits: { cx: 0, cy: by + 1.5, fs, color: flash ? c.ink : c.digits, show: P.digits },
        progress: { R: RF, r: 0, paint: c.fill, empty: c.face },
      };
    },
  },

  // Цифровой: тёмная полупрозрачная «шайба», дуга прогресса по дорожке, бегунок на дуге, крупные цифры внутри
  digital: {
    // case — дорожка, face — внутренний диск, ink — подложка и обводы
    palette: { case: '#ffffff', face: '#0f1420', fill: '#36d6a3', ink: '#05070c', accent: '#ffffff', digits: '#ffffff' },
    viewBox: [-158, -158, 316, 316],
    pivot: [0, 0],
    spin: 106,
    parts(c, st, P) {
      const RO = 96; const RI = 74; const RM = (RO + RI) / 2;
      const ring = st.ringing; const u = st.u;
      const beat = ring ? Math.floor(u * 6) % 2 === 0 : false;
      const arcColor = ring && beat ? c.accent : c.fill;
      const fs = P.fmt === 'h:mm:ss' ? 29 : P.fmt === 'mm:ss' ? 38 : 42;
      const back = `<g filter="url(#sh)"><circle r="${RO + 8}" fill="${c.ink}" fill-opacity=".62"/></g>`
        + `<path d="${fullShape(RO, RI)}" fill="${c.case}" fill-opacity=".22" fill-rule="evenodd"/>`
        + `<circle r="${RI - 4}" fill="${c.face}" fill-opacity=".88"/>`;
      let ticks = '';
      for (let i = 0; i < 12; i++) {
        const [x, y] = pol(RI - 10, i * 30);
        ticks += `<circle cx="${f(x)}" cy="${f(y)}" r="${i % 3 ? 2.2 : 3.4}" fill="${c.digits}" fill-opacity="${i % 3 ? 0.35 : 0.6}"/>`;
      }
      // Статичное скругление начала дуги на 12 часах (конец дуги закрывает бегунок)
      const [, sy] = pol(RM, 0);
      const hw = (RO - RI) / 2;
      const startCap = P.progress === 'remaining' ? '' : `<path d="M0 ${f(sy - hw)}A${hw} ${hw} 0 0 0 0 ${f(sy + hw)}Z" fill="${arcColor}"/>`;
      const front = `${startCap}${ticks}`;
      const hand = `<circle cy="${-RM}" r="14.5" fill="${c.accent}" stroke="${c.ink}" stroke-width="4"/><circle cy="${-RM}" r="4.5" fill="${c.ink}"/>`;
      const blink = ring && Math.floor(u * 4) % 2 === 1;
      const pose = []; let fxBack = '';
      if (ring) {
        const env = u < 1.2 ? 1 : Math.max(0, 1 - (u - 1.2) / 0.4);
        const s = 1 + 0.075 * Math.abs(Math.sin(u * Math.PI * 2.5)) * env;
        pose.push(['s', s, s]);
        for (const k of [0, 0.33, 0.66]) {
          const ph = (u * 1.5 + k) % 1;
          fxBack += `<circle r="${f(RO + 10 + 44 * ph)}" fill="none" stroke="${c.fill}" stroke-width="${f(6 * (1 - ph) + 1)}" opacity="${f((1 - ph) * 0.9 * env)}"/>`;
        }
      }
      return {
        defs: shadowDef(3, 6, 0.5), back, front, hand, cap: '', fxBack, fxFront: '', pose,
        digits: { cx: 0, cy: 2, fs, color: c.digits, show: P.digits && !blink },
        // «остаток»: пройденная часть — непрозрачная, как дорожка поверх шайбы
        progress: { R: RO, r: RI, paint: arcColor, empty: mix(c.ink, c.case, 0.3) },
      };
    },
  },

  // Ретро: пухлый кухонный таймер на ножках, ручка-вертушка, окошко-циферблат, «наклейка» с цифрами
  retro: {
    palette: { case: '#ffb03b', face: '#fff6e6', fill: '#ff6f61', ink: '#3b2a20', accent: '#4cc3b5', digits: '#fff6e6' },
    viewBox: [-175, -212, 350, 380],
    pivot: [0, -10],
    spin: 72,
    parts(c, st, P) {
      const DY = -10; const RD = 68;
      const ring = st.ringing; const u = st.u;
      const fs = 34; const cl = cells(P.fmt, fs); const bw = cl.width + 26; const bh = 44; const by = 96;
      const flash = ring && Math.floor(u * 5) % 2 === 0;
      // Звонок: два прыжка (сжатие → прыжок с растяжением → приземление), ручка вертится, штрихи звона
      const pose = []; let fxBack = ''; let fxFront = ''; let knob = 0;
      if (ring) {
        const q = (u % 0.8) / 0.8; const env = u < 1.45 ? 1 : 0.4;
        let sx = 1; let sy = 1; let ty = 0;
        if (q < 0.15) { const k = Math.sin((q / 0.15) * Math.PI / 2); sx = 1 + 0.1 * k; sy = 1 - 0.12 * k; }
        else if (q < 0.7) { const k = (q - 0.15) / 0.55; ty = -26 * Math.sin(k * Math.PI) * env; sx = 1 - 0.05 * Math.sin(k * Math.PI); sy = 1 + 0.07 * Math.sin(k * Math.PI); }
        else { const k = Math.sin(((q - 0.7) / 0.3) * Math.PI); sx = 1 + 0.06 * k; sy = 1 - 0.07 * k; }
        knob = 22 * Math.sin(u * Math.PI * 2 * 5);
        pose.push(['t', 0, ty], ['t', 0, 143], ['s', sx, sy], ['t', 0, -143]);
        const lift = clamp(-ty / 26, 0, 1);
        fxBack = `<ellipse cy="148" rx="${f(112 - 40 * lift)}" ry="${f(11 - 4 * lift)}" fill="#000" opacity="${f(0.32 - 0.18 * lift)}"/>`;
        const k = (u % 0.4) / 0.4;
        for (const a of [-62, -38, 38, 62]) {
          const [x1, y1] = pol(150 + 12 * k, a); const [x2, y2] = pol(170 + 14 * k, a);
          fxFront += `<line x1="${f(x1)}" y1="${f(y1 - 12)}" x2="${f(x2)}" y2="${f(y2 - 12)}" stroke="${c.ink}" stroke-width="12" stroke-linecap="round" opacity="${f(1 - k * 0.7)}"/>`
            + `<line x1="${f(x1)}" y1="${f(y1 - 12)}" x2="${f(x2)}" y2="${f(y2 - 12)}" stroke="${c.fill}" stroke-width="6" stroke-linecap="round" opacity="${f(1 - k * 0.7)}"/>`;
        }
      }
      const body = 'M-124 12C-124 -66 -72 -104 0 -104C72 -104 124 -66 124 12C124 94 80 132 0 132C-80 132 -124 94 -124 12Z';
      const back = '<g filter="url(#sh)">'
        + `<ellipse cx="-62" cy="134" rx="27" ry="14" fill="${c.ink}"/><ellipse cx="62" cy="134" rx="27" ry="14" fill="${c.ink}"/>`
        + `<g transform="rotate(${f(knob)} 0 -106)"><rect x="-14" y="-126" width="28" height="26" fill="${c.ink}"/>`
        + `<rect x="-42" y="-152" width="84" height="32" rx="16" fill="${c.accent}" stroke="${c.ink}" stroke-width="7"/>`
        + `<path d="M-18 -144v16M0 -144v16M18 -144v16" stroke="${c.ink}" stroke-width="5" stroke-linecap="round" opacity=".4"/></g>`
        + `<path d="${body}" fill="${c.case}" stroke="${c.ink}" stroke-width="8"/>`
        + '</g>'
        + '<path d="M-100 -22Q-96 -66 -54 -86" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="10" stroke-linecap="round"/>'
        + (P.digits ? `<rect x="${f(-bw / 2)}" y="${by - bh / 2}" width="${f(bw)}" height="${bh}" rx="${bh / 2}" fill="${flash ? c.fill : c.ink}"/>` : '')
        + `<circle cy="${DY}" r="${RD}" fill="${c.face}"/>`;
      let ticks = '';
      for (let i = 0; i < 12; i++) {
        const [x, y] = pol(i % 3 ? 55 : 53, i * 30);
        ticks += `<circle cx="${f(x)}" cy="${f(y + DY)}" r="${i % 3 ? 3.2 : 6}" fill="${c.ink}"/>`;
      }
      const front = `<circle cy="${DY}" r="${RD}" fill="none" stroke="${c.ink}" stroke-width="8"/>${ticks}`;
      // Стрелка — относительно pivot (0, DY)
      const hand = `<rect x="-7.5" y="-50" width="15" height="58" rx="7.5" fill="${c.ink}"/>`;
      const cap = `<circle cy="${DY}" r="14" fill="${c.accent}" stroke="${c.ink}" stroke-width="5.5"/>`;
      return {
        defs: shadowDef(4, 5, 0.4), back, front, hand, cap, fxBack, fxFront, pose,
        digits: { cx: 0, cy: by + 1.5, fs, color: c.digits, show: P.digits },
        progress: { R: RD, r: 0, paint: c.fill, empty: c.face },
      };
    },
  },
};

export const styleOf = (id) => STYLES[id] || STYLES.classic;
export const stylePalette = (id) => ({ ...styleOf(id).palette });

/** Части рисунка стиля для цветов c и состояния st ({ p, ringing, u }); P = { fmt, progress, digits } */
export const styleParts = (id, c, st, P) => styleOf(id).parts(c, st, P);

/** SVG-документ в единицах viewBox стиля (тень — фильтр #sh из defs) */
export function svgDoc(id, defs, body, box = null) {
  const [vx, vy, vw, vh] = box || styleOf(id).viewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}"><defs>${defs}</defs>${body}</svg>`;
}

/** SVG-строка позы (для <g transform>) */
export const poseSvg = (ops) => ops.map((o) => (o[0] === 't' ? `translate(${f(o[1])} ${f(o[2])})`
  : o[0] === 'r' ? `rotate(${f(o[1])} ${f(o[2])} ${f(o[3])})` : `scale(${Math.round(o[1] * 1000) / 1000} ${Math.round(o[2] * 1000) / 1000})`)).join(' ');

/**
 * SVG слоёв для состояния «до звонка» (не зависят от времени) — источник картинок плеера и экспорта:
 *   back, front, cap — во весь viewBox; hand, halfL, halfR, rightOv, base — в квадрате spin вокруг pivot (base — только
 *   при progress 'remaining': полная фигура цветом fill, неподвижная). Пустые слои — null.
 */
export function layerSvgs(id, c, P) {
  const s = styleOf(id);
  const x = s.parts(c, { p: 0, ringing: false, u: 0 }, P);
  const [px, py] = s.pivot; const S = s.spin;
  const sq = [px - S, py - S, 2 * S, 2 * S];
  const doc = (body, box) => (body ? svgDoc(id, x.defs, body, box) : null);
  const { R, r, paint, empty } = x.progress;
  const half = P.progress === 'remaining' ? empty : paint;
  const at = (inner) => `<g transform="translate(${px} ${py})">${inner}</g>`;
  return {
    back: doc(x.back), front: doc(x.front), cap: doc(x.cap),
    hand: doc(at(x.hand), sq),
    halfL: doc(at(`<path d="${leftHalf(R, r)}" fill="${half}"/>`), sq),
    halfR: doc(at(`<path d="${rightHalf(R, r)}" fill="${half}"/>`), sq),
    rightOv: doc(at(`<defs><clipPath id="ov"><rect x="${-OV}" y="${-S}" width="${S + OV}" height="${2 * S}"/></clipPath></defs>`
      + `<g clip-path="url(#ov)"><path d="${fullShape(R, r)}" fill="${half}" fill-rule="evenodd"/></g>`), sq),
    base: P.progress === 'remaining' ? doc(at(`<path d="${fullShape(R, r)}" fill="${paint}" fill-rule="evenodd"/>`), sq) : null,
    digits: x.digits,
  };
}

/** Кадр звонка в момент u: { under — SVG под цифрами (эффекты сзади + рисунок в позе), over — эффекты спереди, pose, digits } */
export function ringSvgs(id, c, P, u) {
  const s = styleOf(id);
  const x = s.parts(c, { p: 1, ringing: true, u }, P);
  const [px, py] = s.pivot;
  // Сектор при звонке — полный (в «остатке» — пустой: всё время прошло)
  const { R, r, paint, empty } = x.progress;
  const prog = `<g transform="translate(${px} ${py})"><path d="${fullShape(R, r)}" fill="${P.progress === 'remaining' ? empty : paint}" fill-rule="evenodd"/></g>`;
  const hand = `<g transform="translate(${px} ${py})">${x.hand}</g>`;
  const pic = `<g transform="${poseSvg(x.pose)}">${x.back}${prog}${x.front}${hand}${x.cap}</g>`;
  return {
    under: svgDoc(id, x.defs, (x.fxBack || '') + pic),
    over: x.fxFront ? svgDoc(id, x.defs, x.fxFront) : null,
    pose: x.pose, digits: x.digits,
  };
}
