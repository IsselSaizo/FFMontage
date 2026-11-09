// Правая панель: свойства выделенного клипа / перехода или сведения о проекте.
import { store, MAX_FADE } from './store.js';
import { h, $, fmtTime, fmtDur, fmtBytes, icon, iconEl, t } from './util.js';
import { getLang, num as numFixed } from './i18n.js';
import { keyHint } from './keymap.js';
import { transitionById, isKnownTransition, MIN_DURATION } from './transitions.js';
import { maxTransition } from './store.js';
import { changeDuration } from './actions.js';
import { isReversed, isFreeze } from './fx.js';
import { clipEffects, unknownEffects, effectById, effectValues } from './effects.js';
import { onRegistryChange } from './registry.js';
import { speedOf, tlLen, fmtSpeed, SPEED_PRESETS, MIN_SPEED, MAX_SPEED } from './clipTime.js';
import { tfOf, cleanTransform, TF_DEFAULT } from './transform.js';
import { isText } from './textModel.js';
import { renderTextClip, renderShapeClip, renderTimerClip, borderSection, renderCue, renderSubTrack } from './textInspector.js';
import { isShape } from './shapes.js';
import { getPref, setPref } from './prefs.js';

// Число как есть, но с десятичным разделителем языка: 0,8 / 0.8 (без лишних нулей, в отличие от i18n num)
const dec = (x) => (getLang() === 'ru' ? String(x).replace('.', ',') : String(x));
const num = (x, d = 1) => dec(Math.round(x * 10 ** d) / 10 ** d);

export function initInspector() {
  const root = $('#inspector');
  let liveBefore = null; // снимок для слайдеров (одна запись в истории за жест)
  let focusSection = null;

  // Слайдер, который меняет проект «вживую» и пишет в историю один раз за жест
  function liveSlider({ min, max, step, value, onLive, onCommit, format }) {
    const val = h('span', { class: 'vol-val' }, format(value));
    const slider = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'slider' });
    slider.addEventListener('pointerdown', () => { liveBefore = store.snapshot(); });
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      val.textContent = format(v);
      if (liveBefore) store.live(() => onLive(v));
      else onCommit(v);
    });
    const finish = () => { if (liveBefore) { const b = liveBefore; liveBefore = null; store.commitFrom(b); render(); } };
    slider.addEventListener('pointerup', finish);
    slider.addEventListener('change', finish);
    return { slider, val };
  }

  // Числовое поле «0,8 с» рядом со слайдером
  function secInput(value, max, onSet) {
    const inp = h('input', { class: 'input sec', type: 'text', value: num(value), title: t('Секунды') });
    const apply = () => {
      const v = Number(String(inp.value).replace(',', '.'));
      if (isFinite(v)) onSet(Math.max(0, Math.min(max, v))); else inp.value = num(value);
    };
    inp.addEventListener('change', apply);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } e.stopPropagation(); });
    return h('label', { class: 'sec-wrap' }, inp, h('span', {}, t('с')));
  }

  // Скорость ×0.1…×16: кнопки-пресеты, ползунок (логарифмический), поле ввода и «Сдвигать следующие клипы».
  // Ползунок применяет значение, когда его отпустили (иначе каждое движение затирало бы соседей).
  const RIPPLE_KEY = 'ui.speedRipple'; // settings.json (js/prefs.js)
  function speedSection(clip) {
    const cur = speedOf(clip);
    const ripple = getPref(RIPPLE_KEY, false) === true;
    const apply = (v) => {
      const s = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(v * 100) / 100));
      const f = store.findClip(clip.id);
      if (!f || Math.abs(s - speedOf(f.clip)) < 1e-6) { render(); return; }
      store.setSpeed(clip.id, s, { ripple: getPref(RIPPLE_KEY, false) === true });
    };
    const toPos = (s) => Math.log2(s);
    const fromPos = (x) => 2 ** x;
    const val = h('span', { class: 'vol-val' }, fmtSpeed(cur));
    const slider = h('input', { type: 'range', class: 'slider', id: 'speed-slider', min: String(toPos(MIN_SPEED)), max: String(toPos(MAX_SPEED)), step: '0.01', value: String(toPos(cur)) });
    // Около ×1 — «прилипает», чтобы легко вернуть обычную скорость
    const snapped = () => { const s = fromPos(Number(slider.value)); return Math.abs(Math.log2(s)) < 0.06 ? 1 : s; };
    slider.addEventListener('input', () => { val.textContent = fmtSpeed(Math.round(snapped() * 100) / 100); });
    slider.addEventListener('change', () => apply(snapped()));
    const inp = h('input', { class: 'input sec', type: 'text', id: 'speed-input', value: dec(cur), title: t('От {min} до {max}', { min: MIN_SPEED, max: MAX_SPEED }) });
    inp.addEventListener('change', () => {
      const v = Number(String(inp.value).replace(',', '.').replace(/^[x×]/i, ''));
      if (isFinite(v) && v > 0) apply(v); else inp.value = dec(cur);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } e.stopPropagation(); });
    const chk = h('input', { type: 'checkbox', id: 'speed-ripple' });
    chk.checked = ripple;
    chk.addEventListener('change', () => setPref(RIPPLE_KEY, chk.checked));
    const linked = store.linkedOf(clip.id).length;
    return h('div', { class: 'insp-section', dataset: { section: 'speed' } }, h('h3', {}, t('Скорость')),
      h('div', { class: 'presets' }, ...SPEED_PRESETS.map((s) => h('button', {
        class: `chip${Math.abs(cur - s) < 1e-6 ? ' on' : ''}`, dataset: { speed: String(s) }, onclick: () => apply(s),
      }, fmtSpeed(s)))),
      h('div', { class: 'row gap', style: { marginTop: '8px' } }, slider, val, h('label', { class: 'sec-wrap' }, h('span', {}, '×'), inp)),
      h('label', { class: 'check-row', title: t('Выключено: клип меняет длину на месте (ускоренный оставит пустоту, замедленный наедет на следующий). Включено: всё правее сдвигается.') },
        chk, h('span', {}, t('Сдвигать следующие клипы'))),
      h('p', { class: 'muted small' }, (cur !== 1 ? `${t('Длина на таймлайне {len} (из файла {src}).', { len: fmtTime(tlLen(clip)), src: fmtTime(clip.out - clip.in) })} ` : '') + t('Тон звука сохраняется.')
        + (linked ? ` ${t('Звук этого видео меняет скорость вместе с ним.')}` : '')));
  }

  // Ползунок параметра видеоэффекта: значение хранится в clip.fxp[effectId][k]
  function effectParamRow(clipId, effectId, pd, value) {
    const digits = (String(pd.step).split('.')[1] || '').length;
    const format = (v) => `${num(v, digits)}${pd.unit ? ` ${pd.unit}` : ''}`;
    const put = (c, v) => { c.fxp = { ...(c.fxp || {}), [effectId]: { ...((c.fxp && c.fxp[effectId]) || {}), [pd.k]: v } }; };
    const { slider, val } = liveSlider({
      min: pd.min, max: pd.max, step: pd.step, value, format,
      onLive: (v) => { const f = store.findClip(clipId); if (f) put(f.clip, v); },
      onCommit: (v) => store.mutate(() => { const f = store.findClip(clipId); if (f) put(f.clip, v); }),
    });
    slider.dataset.param = pd.k;
    // Двойной щелчок — значение по умолчанию
    slider.addEventListener('dblclick', () => store.mutate(() => { const f = store.findClip(clipId); if (f) put(f.clip, pd.def); }));
    return [h('div', { class: 'row between' }, h('label', {}, pd.name), val), slider];
  }

  const render = () => {
    // Не перерисовываем, пока пользователь тянет слайдер — иначе он «отпустится»
    if (liveBefore) return;
    root.innerHTML = '';
    const s = store.selection;
    if (s && s.kind === 'transition') return renderTransition(s.id);
    // liveStart/liveEnd — правка «вживую» (ввод текста): панель не перерисовывается, в историю — одна запись
    const liveStart = () => { if (!liveBefore) liveBefore = store.snapshot(); };
    const liveEnd = () => { if (liveBefore) { const b = liveBefore; liveBefore = null; store.commitFrom(b); render(); } };
    const ui = { root, liveSlider, secInput, transformSection, num, render, liveStart, liveEnd };
    if (s && s.kind === 'cue' && store.findCue(s.id)) { renderCue(ui, s.id); applyFocus(); return; }
    if (s && s.kind === 'strack' && store.subtitleTrack(s.id)) { renderSubTrack(ui, s.id); applyFocus(); return; }
    const sel = s ? store.findClip(s.id) : null;
    if (!sel) return renderProject();
    if (isText(sel.clip)) { renderTextClip(ui, sel); applyFocus(); return; }
    if (isShape(sel.clip)) { renderShapeClip(ui, sel); applyFocus(); return; }
    if (sel.clip.kind === 'timer') { renderTimerClip(ui, sel); applyFocus(); return; }
    const { kind, clip } = sel;
    const m = store.media(clip.mediaId) || {};
    const srcMedia = m.derived ? store.media(m.derived.from) || m : m;
    const dur = tlLen(clip);

    root.append(h('div', { class: 'panel-head' }, h('h2', {}, kind === 'video' ? t('Видеоклип') : t('Аудиоклип'))));
    root.append(h('div', { class: 'insp-file', title: srcMedia.path },
      iconEl(kind === 'video' ? 'film' : 'music', 18), h('span', {}, store.clipName(clip)),
      isReversed(clip) ? h('span', { class: 'tag', title: t('Играет задом наперёд') }, t('реверс')) : null,
      isFreeze(clip) ? h('span', { class: 'tag' }, t('стоп-кадр')) : null));
    if (store.busy[clip.id]) root.append(h('p', { class: 'muted small' }, t('{label}… подождите', { label: store.busy[clip.id].label })));

    // --- Звук ---
    const sec = h('div', { class: 'insp-section', dataset: { section: 'audio' } }, h('h3', {}, t('Звук')));
    if (!m.hasAudio) {
      sec.append(h('p', { class: 'muted small' }, isFreeze(clip) ? t('У стоп-кадра нет звука.') : t('В этом файле нет звуковой дорожки.')));
    } else if (kind === 'video' && clip.noAudio) {
      const partners = store.linkedOf(clip.id).filter((x) => x.kind === 'audio');
      sec.append(
        h('p', { class: 'muted small' }, partners.length
          ? t('Звук этого клипа — на аудиодорожке ({tracks}): громкость и затухание — у аудиоклипа.', { tracks: partners.map((x) => store.trackName(x.track.id)).join(', ') })
          : t('Звук этого клипа удалён с аудиодорожки.')),
        h('button', { class: 'btn', onclick: () => store.restoreOwnAudio(clip.id) }, h('span', { html: icon('speaker', 17) }), t('Вернуть звук в видеоклип')));
    } else {
      const pct = Math.round(clip.volume * 100);
      const { slider, val } = liveSlider({
        min: 0, max: 200, step: 1, value: pct, format: (v) => `${v}%`,
        onLive: (v) => { store.findClip(clip.id).clip.volume = v / 100; },
        onCommit: (v) => store.setClip(clip.id, { volume: v / 100 }),
      });
      slider.addEventListener('dblclick', () => store.setClip(clip.id, { volume: 1 }));
      const muteBtn = h('button', { class: `btn toggle${clip.muted ? ' on' : ''}`, onclick: () => store.setClip(clip.id, { muted: !clip.muted }) },
        h('span', { html: icon(clip.muted ? 'mute' : 'speaker', 17) }), clip.muted ? t('Звук выключен') : t('Выключить звук'));
      sec.append(
        h('div', { class: 'row between' }, h('label', {}, t('Громкость')), val),
        slider,
        h('div', { class: 'presets' },
          ...[0, 50, 100, 150, 200].map((p) => h('button', { class: `chip${pct === p ? ' on' : ''}`, onclick: () => store.setClip(clip.id, { volume: p / 100 }) }, `${p}%`))),
        muteBtn);
      if (kind === 'video') {
        sec.append(h('button', { class: 'btn', onclick: () => store.detachAudio(clip.id) }, h('span', { html: icon('music', 17) }), t('Вынести звук на аудиодорожку')));
      } else {
        const tr = sel.track;
        sec.append(h('p', { class: 'muted small' }, t('Дорожка «{name}»: громкость {pct}% (умножается на громкость клипа; ползунок — в заголовке дорожки).', { name: store.trackName(tr.id), pct: Math.round((tr.volume ?? 1) * 100) })));
        if (clip.link) sec.append(h('button', { class: 'btn', onclick: () => store.unlink(clip.id) }, h('span', { html: icon('link', 17) }), t('Отвязать от видео')));
      }
    }
    root.append(sec);

    // --- Затухание ---
    const maxFade = Math.min(MAX_FADE, dur);
    const fade = h('div', { class: 'insp-section', dataset: { section: 'fade' } }, h('h3', {}, t('Затухание')));
    const fadeRow = (label, key, other) => {
      const lim = () => Math.max(0, Math.min(maxFade, dur - (clip[other] || 0)));
      const { slider } = liveSlider({
        min: 0, max: Math.round(maxFade * 10) / 10, step: 0.1, value: clip[key] || 0, format: (v) => num(v),
        onLive: (v) => { store.findClip(clip.id).clip[key] = Math.min(v, lim()); },
        onCommit: (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }),
      });
      return [h('div', { class: 'row between' }, h('label', {}, label), secInput(clip[key] || 0, maxFade, (v) => store.setClip(clip.id, { [key]: Math.min(v, lim()) }))), slider];
    };
    fade.append(
      ...fadeRow(t('Постепенное возникновение'), 'fadeIn', 'fadeOut'),
      ...fadeRow(t('Постепенное исчезание'), 'fadeOut', 'fadeIn'),
      h('p', { class: 'muted small' }, kind === 'video'
        ? t('Картинка проявляется из цвета фона (обычно чёрного) и уходит в него, звук клипа — плавно. Можно тянуть кружки в углах выделенного клипа.')
        : t('Звук плавно нарастает и затихает. Можно тянуть кружки в углах выделенного клипа.')));
    root.append(fade);

    // --- Обрезка ---
    const trim = h('div', { class: 'insp-section', dataset: { section: 'trim' } }, h('h3', {}, t('Обрезка')));
    const info = [
      [t('Длительность'), fmtTime(dur)],
      [t('На таймлайне'), `${fmtTime(clip.start)} – ${fmtTime(clip.start + dur)}`],
    ];
    if (!m.derived) info.push([t('Из файла'), `${fmtTime(clip.in)} – ${fmtTime(clip.out)}`]);
    trim.append(h('dl', { class: 'kv' }, ...info.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    trim.append(h('p', { class: 'muted small' }, t('Тяните края клипа на таймлайне, чтобы обрезать. Клавиша {key} разрезает клип по курсору.', { key: keyHint('clip.split') })));
    trim.append(h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn ghost small', onclick: () => changeDuration(clip.id) }, h('span', { html: icon('clock', 15) }), t('Длительность…')),
      h('button', { class: 'btn ghost small', disabled: m.derived || (clip.in === 0 && Math.abs(clip.out - m.duration) < 0.001),
        onclick: () => store.setClip(clip.id, { in: 0, out: m.duration }) }, t('Исходная длина'))));
    root.append(trim);

    // --- Скорость (видео и аудио; у картинки и стоп-кадра скорости нет) ---
    if (!(m.isImage && !m.isAnimation) && !isFreeze(clip)) root.append(speedSection(clip));

    // --- Трансформ (видео): положение, масштаб, поворот, прозрачность; в плеере — рамка с ручками ---
    if (kind === 'video') root.append(transformSection(clip, sel));
    // --- Обводка и скруглённые углы (0.5.0) ---
    if (kind === 'video' && m.hasVideo !== false) root.append(borderSection(ui, clip, !!(sel.lane && sel.lane.locked)));

    // --- Фильтры (видео): список — во вкладке «Фильтры», подгонка и кадрирование — над плеером ---
    if (kind === 'video') {
      const fxOn = clipEffects(clip);
      // Эффекты пропавших плагинов остаются в проекте — показываем их id, в экспорт они не попадают
      const missing = unknownEffects(clip);
      const names = [...fxOn.map((id) => effectById(id).name), ...missing.map((id) => t('{id} (нет плагина)', { id }))];
      const fxSec = h('div', { class: 'insp-section', dataset: { section: 'effects' } }, h('h3', {}, t('Фильтры')),
        h('div', { class: 'row between' },
          h('span', { class: 'muted small' }, names.length ? names.join(', ') : t('Нет')),
          h('button', { class: 'btn ghost small', onclick: () => store.emit('show-tab', 'effects') }, names.length ? t('Изменить') : t('Добавить'))));
      // Параметры эффектов (clip.fxp[effectId][k]; нет значения — по умолчанию)
      for (const id of fxOn) {
        const e = effectById(id);
        if (!e.params || !e.params.length) continue;
        const vals = effectValues(clip, id);
        fxSec.append(h('div', { class: 'fx-params', dataset: { effect: id } }, h('div', { class: 'small' }, h('b', {}, e.name)),
          ...e.params.flatMap((pd) => effectParamRow(clip.id, id, pd, vals[pd.k]))));
      }
      root.append(fxSec);
    }
    // --- Исходный файл ---
    root.append(fileInfo(srcMedia));
    applyFocus();
  };

  // Трансформ: поля ввода и ползунки; ползунок пишет в историю один раз за жест
  function transformSection(clip) {
    const f = store.findClip(clip.id);
    const locked = !!(f && f.lane && f.lane.locked);
    const tf = tfOf(clip);
    const sec = h('div', { class: 'insp-section', dataset: { section: 'transform' } }, h('h3', {}, t('Трансформ')));
    const rows = [
      ['x', t('По горизонтали'), -1, 1, 0.005, (v) => `${num(v * 100, 1)}%`],
      ['y', t('По вертикали'), -1, 1, 0.005, (v) => `${num(v * 100, 1)}%`],
      ['scale', t('Масштаб'), 0.05, 3, 0.01, (v) => `${Math.round(v * 100)}%`],
      ['rotate', t('Поворот'), -180, 180, 1, (v) => `${num(v, 1)}°`],
      ['opacity', t('Непрозрачность'), 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`],
    ];
    for (const [k, label, min, max, step, fmt] of rows) {
      const { slider, val } = liveSlider({
        min, max, step, value: Math.min(max, Math.max(min, tf[k])), format: fmt,
        onLive: (v) => { const c = store.findClip(clip.id).clip; const n = cleanTransform({ [k]: v }, c.transform); if (n) c.transform = n; else delete c.transform; },
        onCommit: (v) => store.setTransform([clip.id], { [k]: v }),
      });
      slider.dataset.tf = k;
      slider.disabled = locked;
      slider.addEventListener('dblclick', () => store.setTransform([clip.id], { [k]: TF_DEFAULT[k] }));
      sec.append(h('div', { class: 'row between' }, h('label', {}, label), val), slider);
    }
    const presets = [
      [t('Сброс'), null],
      [t('По центру ½'), { x: 0, y: 0, scale: 0.5 }],
      [t('Угол ↗ ⅓'), { x: 0.3, y: -0.3, scale: 0.33 }],
      [t('Угол ↘ ⅓'), { x: 0.3, y: 0.3, scale: 0.33 }],
      [t('Левая половина'), { x: -0.25, y: 0, scale: 0.5 }],
      [t('Правая половина'), { x: 0.25, y: 0, scale: 0.5 }],
    ];
    sec.append(h('div', { class: 'presets' }, ...presets.map(([name, p]) => h('button', {
      class: 'chip', disabled: locked, onclick: () => store.setTransform([clip.id], p, { replace: true }),
    }, name))));
    sec.append(h('p', { class: 'muted small' }, locked
      ? t('Дорожка закрыта замком — снимите его в заголовке дорожки.')
      : t('В плеере выделенный клип можно двигать мышью, тянуть за углы (масштаб) и за кружок сверху (поворот; Shift — шагом 15°). Двойной щелчок по ползунку — сброс.')));
    return sec;
  }

  // ---------------- Переход ----------------
  function renderTransition(clipId) {
    const j = store.junctionBefore(clipId);
    if (!j) return renderProject();
    const tr = j.b.transition;
    const mx = maxTransition(j.a, j.b);
    root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Переход'))));
    root.append(h('p', { class: 'muted small' },
      t('Между «{a}» и «{b}» на {time}. Переход идёт поровну до и после стыка — длина ролика не меняется.', { a: store.clipName(j.a), b: store.clipName(j.b), time: fmtTime(j.seam) })));

    if (tr) {
      const d = h('div', { class: 'insp-section', dataset: { section: 'transition' } }, h('h3', {}, t('Длительность')));
      const { slider } = liveSlider({
        min: MIN_DURATION, max: Math.max(MIN_DURATION, Math.floor(mx * 10) / 10), step: 0.1, value: tr.duration, format: (v) => num(v),
        onLive: (v) => { const b = store.findClip(clipId).clip; if (b.transition) b.transition.duration = v; },
        onCommit: (v) => store.setTransition(clipId, tr.type, v),
      });
      d.append(h('div', { class: 'row between' }, h('label', {}, isKnownTransition(tr.type) ? transitionById(tr.type).name : t('{id} (нет плагина)', { id: tr.type })),
        secInput(tr.duration, mx, (v) => store.setTransition(clipId, tr.type, Math.max(MIN_DURATION, v)))), slider,
      h('button', { class: 'btn danger-ghost small', onclick: () => store.setTransition(clipId, null) }, h('span', { html: icon('trash', 15) }), t('Убрать переход')));
      root.append(d);
    } else {
      root.append(h('p', { class: 'muted small' }, t('Выберите переход — он сразу появится на стыке.')));
    }

    root.append(h('div', { class: 'insp-section', dataset: { section: tr ? 'list' : 'transition' } },
      h('button', { class: 'btn ghost small', onclick: () => store.emit('show-tab', 'transitions') }, tr ? t('Сменить переход…') : t('Выбрать переход…'))));
    applyFocus();
  }

  function fileInfo(m) {
    const rows = [];
    if (m.hasVideo) {
      rows.push([t('Разрешение'), `${m.width}×${m.height}`], [t('Частота'), `${Math.round(m.fps * 100) / 100} fps`],
        [t('Видеокодек'), `${(m.vcodec || '').toUpperCase()}${m.pixFmt && /10/.test(m.pixFmt) ? ` ${t('10 бит')}` : ''}`]);
      if (m.vbitrate || m.bitrate) rows.push([t('Битрейт'), t('{n} Мбит/с', { n: numFixed((m.vbitrate || m.bitrate) / 1e6, 1) })]);
    }
    if (m.hasAudio) rows.push([t('Звук'), `${(m.acodec || '').toUpperCase()}, ${t('{n} кГц', { n: Math.round((m.sampleRate || 0) / 1000) })}, ${m.channels === 1 ? t('моно') : m.channels === 2 ? t('стерео') : t('{n} кан.', { n: m.channels })}`]);
    rows.push([t('Длительность'), fmtDur(m.duration)], [t('Размер'), fmtBytes(m.size)]);
    return h('div', { class: 'insp-section' }, h('h3', {}, t('Исходный файл')),
      h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('p', { class: 'muted small path' }, m.path || ''));
  }

  function renderProject() {
    const f = store.sourceFormat();
    const nClips = store.allVideo().length + store.project.audioTracks.reduce((s, tr) => s + tr.clips.length, 0);
    const files = Object.values(store.project.media).filter((m) => !m.hidden).length;
    root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Проект'))));
    root.append(h('div', { class: 'insp-section' },
      h('dl', { class: 'kv' },
        h('dt', {}, t('Формат')), h('dd', {}, f.fromClip ? `${f.width}×${f.height}, ${f.fps} fps` : t('по видео на таймлайне')),
        h('dt', {}, t('Длительность')), h('dd', {}, fmtTime(store.duration())),
        h('dt', {}, t('Клипов')), h('dd', {}, String(nClips)),
        h('dt', {}, t('Переходов')), h('dd', {}, String(store.transitions().length)),
        h('dt', {}, t('Файлов')), h('dd', {}, String(files))),
      h('p', { class: 'muted small' }, t('Размер кадра берётся из самого крупного видео на таймлайне (с учётом формата кадра). При экспорте можно выбрать другой.'))));

    root.append(h('p', { class: 'muted small' }, t('Формат кадра и фон — кнопки над плеером. Горячие клавиши — меню ☰ → «Горячие клавиши».')));
  }

  // Прокрутить к нужному разделу и подсветить его
  function applyFocus() {
    if (!focusSection) return;
    const el = root.querySelector(`[data-section="${focusSection}"]`) || root.querySelector('.insp-section');
    focusSection = null;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 900);
  }

  store.on('selection', render);
  store.on('project', render);
  store.on('busy', render);
  // Плагин включили/выключили — названия и параметры эффектов могли измениться
  onRegistryChange(() => render());
  store.on('media', () => { if (!store.selection) render(); });
  store.on('focus-inspector', (section) => { focusSection = section || 'actions'; render(); });
  render();
}
