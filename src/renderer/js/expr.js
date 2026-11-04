// Безопасные выражения для описаний эффектов и переходов (без eval / Function).
// Используются в шаблонах строк: 'gblur=sigma={max(1, w*0.006):2}' — в фигурных скобках выражение,
// после двоеточия — число знаков после запятой (по умолчанию toFixed(6)).
//
// Что умеет выражение: числа (1, 0.5, .5, 1e-3), переменные (параметры эффекта, w — ширина кадра,
// p — доля перехода 0…1), + - * / %, скобки, < > <= >= == != && || !, функции
// min max clamp abs round floor ceil pow sqrt db(x) = 10^(x/20).
// Сравнения и логика дают 1 или 0. Больше ничего нет: ни свойств, ни строк, ни вызова чужих функций.
// Модуль без DOM — грузится и в Node (тесты экспорта).
import { t } from './i18n.js';

const MAX_LEN = 500;    // длина выражения
const MAX_DEPTH = 40;   // вложенность скобок и операторов
const MAX_TPL = 2000;   // длина шаблона

// Имена, которые нельзя использовать как переменные (на всякий случай — переменные и так ищутся только среди своих ключей)
const FORBIDDEN_NAMES = new Set(['constructor', '__proto__', 'prototype', 'hasOwnProperty', 'toString', 'valueOf',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']);

// Функции: [наименьшее, наибольшее число аргументов, реализация]
const FUNCS = {
  min: [1, 16, (...a) => Math.min(...a)],
  max: [1, 16, (...a) => Math.max(...a)],
  clamp: [3, 3, (x, a, b) => Math.max(a, Math.min(b, x))],
  abs: [1, 1, Math.abs],
  round: [1, 1, Math.round],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  pow: [2, 2, (a, b) => a ** b],
  sqrt: [1, 1, Math.sqrt],
  db: [1, 1, (x) => 10 ** (x / 20)],
};
const hasFunc = (name) => Object.prototype.hasOwnProperty.call(FUNCS, name);

function exprError(src, reason) {
  return new Error(t('Ошибка в выражении «{src}»: {reason}', { src: String(src).slice(0, 120), reason }));
}

// --- разбор: строка → токены → дерево ---
function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(?:<=|>=|==|!=|&&|\|\||[-+*/%()<>!,])/.exec(src.slice(i));
    if (op) { out.push({ k: 'op', v: op[0] }); i += op[0].length; continue; }
    throw exprError(src, t('неожиданный символ «{c}»', { c }));
  }
  return out;
}

// Узлы дерева: ['n', число] ['v', имя] ['f', имя, [аргументы]] ['u', оп, x] ['b', оп, a, b]
function parse(src) {
  if (typeof src !== 'string') throw exprError(src, t('выражение должно быть строкой'));
  if (src.length > MAX_LEN) throw exprError(src, t('слишком длинное выражение'));
  const tk = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => tk[pos];
  const isOp = (v) => tk[pos] && tk[pos].k === 'op' && tk[pos].v === v;
  const enter = () => { if (++depth > MAX_DEPTH) throw exprError(src, t('слишком сложное выражение')); };
  const binary = (next, ops) => () => {
    enter();
    let a = next();
    while (tk[pos] && tk[pos].k === 'op' && ops.includes(tk[pos].v)) { const op = tk[pos++].v; a = ['b', op, a, next()]; }
    depth--;
    return a;
  };
  const primary = () => {
    const x = peek();
    if (!x) throw exprError(src, t('неожиданный конец выражения'));
    if (x.k === 'num') { pos++; return ['n', x.v]; }
    if (x.k === 'id') {
      pos++;
      if (FORBIDDEN_NAMES.has(x.v)) throw exprError(src, t('запрещённое имя «{name}»', { name: x.v }));
      if (isOp('(')) {
        if (!hasFunc(x.v)) throw exprError(src, t('неизвестная функция «{name}»', { name: x.v }));
        pos++;
        const args = [];
        if (!isOp(')')) {
          for (;;) { args.push(or()); if (isOp(',')) { pos++; continue; } break; }
        }
        if (!isOp(')')) throw exprError(src, t('незакрытая скобка'));
        pos++;
        const [lo, hi] = FUNCS[x.v];
        if (args.length < lo || args.length > hi) throw exprError(src, t('неверное число аргументов у {name}()', { name: x.v }));
        return ['f', x.v, args];
      }
      return ['v', x.v];
    }
    if (isOp('(')) {
      pos++;
      const e = or();
      if (!isOp(')')) throw exprError(src, t('незакрытая скобка'));
      pos++;
      return e;
    }
    throw exprError(src, t('неожиданный символ «{c}»', { c: x.v }));
  };
  const unary = () => {
    if (isOp('-') || isOp('+') || isOp('!')) { enter(); const op = tk[pos++].v; const r = ['u', op, unary()]; depth--; return r; }
    return primary();
  };
  const mul = binary(unary, ['*', '/', '%']);
  const add = binary(mul, ['+', '-']);
  const rel = binary(add, ['<', '>', '<=', '>=']);
  const eq = binary(rel, ['==', '!=']);
  const and = binary(eq, ['&&']);
  const or = binary(and, ['||']);
  if (!tk.length) throw exprError(src, t('пустое выражение'));
  const tree = or();
  if (pos < tk.length) throw exprError(src, t('лишний текст после выражения'));
  return tree;
}

function collectVars(node, set) {
  if (node[0] === 'v') set.add(node[1]);
  else if (node[0] === 'f') node[2].forEach((x) => collectVars(x, set));
  else if (node[0] === 'u') collectVars(node[2], set);
  else if (node[0] === 'b') { collectVars(node[2], set); collectVars(node[3], set); }
  return set;
}

// Дерево → функция от переменных (замыкания, без генерации кода)
function build(node) {
  switch (node[0]) {
    case 'n': { const v = node[1]; return () => v; }
    case 'v': {
      const name = node[1];
      return (vars) => {
        if (!vars || !Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(t('неизвестная переменная «{name}»', { name }));
        const v = Number(vars[name]);
        return v;
      };
    }
    case 'f': {
      const fn = FUNCS[node[1]][2];
      const args = node[2].map(build);
      return (vars) => fn(...args.map((a) => a(vars)));
    }
    case 'u': {
      const x = build(node[2]);
      if (node[1] === '-') return (vars) => -x(vars);
      if (node[1] === '+') return (vars) => +x(vars);
      return (vars) => (x(vars) ? 0 : 1);
    }
    default: {
      const a = build(node[2]); const b = build(node[3]);
      switch (node[1]) {
        case '+': return (v) => a(v) + b(v);
        case '-': return (v) => a(v) - b(v);
        case '*': return (v) => a(v) * b(v);
        case '/': return (v) => a(v) / b(v);
        case '%': return (v) => a(v) % b(v);
        case '<': return (v) => (a(v) < b(v) ? 1 : 0);
        case '>': return (v) => (a(v) > b(v) ? 1 : 0);
        case '<=': return (v) => (a(v) <= b(v) ? 1 : 0);
        case '>=': return (v) => (a(v) >= b(v) ? 1 : 0);
        case '==': return (v) => (a(v) === b(v) ? 1 : 0);
        case '!=': return (v) => (a(v) !== b(v) ? 1 : 0);
        case '&&': return (v) => (a(v) && b(v) ? 1 : 0);
        default: return (v) => (a(v) || b(v) ? 1 : 0); // ||
      }
    }
  }
}

// Кэш разобранного: одинаковые строки описаний разбираются один раз
const exprCache = new Map();
const tplCache = new Map();
const remember = (cache, key, val) => { if (cache.size > 2000) cache.clear(); cache.set(key, val); return val; };

/** Разобрать выражение: { src, vars: Set имён переменных, run(vars) → число }. Ошибка — throw Error */
export function compileExpr(src) {
  const hit = exprCache.get(src);
  if (hit) return hit;
  const tree = parse(src);
  const fn = build(tree);
  return remember(exprCache, src, Object.freeze({ src, vars: collectVars(tree, new Set()), run: (vars) => fn(vars) }));
}

/** Вычислить выражение сразу */
export const evalExpr = (src, vars = {}) => compileExpr(src).run(vars);

/** Число → строка для шаблона; NaN и бесконечность — ошибка (в фильтр FFmpeg такое не пишем) */
export function fmtNum(x, digits = 6) {
  if (!Number.isFinite(x)) throw new Error(t('выражение дало не число'));
  return x.toFixed(digits);
}

/**
 * Разобрать шаблон 'текст {выражение} текст {выражение:2}'.
 * Возвращает { src, vars, single, fill(vars) → строка, num(vars) → число }.
 * single — шаблон целиком одно выражение без знаков: num() отдаёт его значение без округления.
 * Число вместо строки — постоянное значение.
 */
export function compileTemplate(src) {
  if (typeof src === 'number') {
    if (!Number.isFinite(src)) throw exprError(src, t('выражение дало не число'));
    const s = String(src);
    return Object.freeze({ src: s, vars: new Set(), single: false, fill: () => s, num: () => src });
  }
  if (typeof src !== 'string') throw exprError(src, t('шаблон должен быть строкой'));
  const hit = tplCache.get(src);
  if (hit) return hit;
  if (src.length > MAX_TPL) throw exprError(src, t('слишком длинный шаблон'));
  const parts = []; // строка или { e, d }
  const vars = new Set();
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    const close = src.indexOf('}', i);
    if (close >= 0 && (open < 0 || close < open)) throw exprError(src, t('лишняя закрывающая фигурная скобка в шаблоне'));
    if (open < 0) { parts.push(src.slice(i)); break; }
    if (open > i) parts.push(src.slice(i, open));
    const end = src.indexOf('}', open);
    if (end < 0) throw exprError(src, t('незакрытая фигурная скобка в шаблоне'));
    let body = src.slice(open + 1, end);
    if (body.includes('{')) throw exprError(src, t('незакрытая фигурная скобка в шаблоне'));
    let d = null;
    const m = /:\s*(\d{1,2})\s*$/.exec(body);
    if (m) { d = Number(m[1]); body = body.slice(0, m.index); }
    if (d !== null && d > 20) throw exprError(src, t('слишком много знаков после запятой'));
    const e = compileExpr(body.trim());
    e.vars.forEach((v) => vars.add(v));
    parts.push({ e, d });
    i = end + 1;
  }
  const single = parts.length === 1 && typeof parts[0] === 'object' && parts[0].d === null;
  const fill = (v) => parts.map((p) => (typeof p === 'string' ? p : fmtNum(p.e.run(v), p.d ?? 6))).join('');
  const num = single
    ? (v) => { const x = parts[0].e.run(v); if (!Number.isFinite(x)) throw new Error(t('выражение дало не число')); return x; }
    : (v) => { const x = Number(fill(v)); if (!Number.isFinite(x)) throw new Error(t('выражение дало не число')); return x; };
  return remember(tplCache, src, Object.freeze({ src, vars, single, fill, num }));
}

/** Подставить переменные в шаблон сразу */
export const fillTemplate = (src, vars = {}) => compileTemplate(src).fill(vars);
