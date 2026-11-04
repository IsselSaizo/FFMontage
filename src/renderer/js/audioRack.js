// Вкладка «Аудио»: стойка эффектов справа.
// Выбран аудиоклип — эффекты клипа; выбрана дорожка (щелчок по её названию) — эффекты всей дорожки.
// Список «Добавить» пополняется аудиоэффектами плагинов (перерисовка по onRegistryChange).
import { store } from './store.js';
import { h, $, icon } from './util.js';
import { AUDIO_FX, fxDef, fxParam } from './audioFx.js';
import { t, getLang } from './i18n.js';
import * as registry from './registry.js';

// Десятичный разделитель языка без лишних нулей: 2,5 / 2.5
const dec = (x) => (getLang() === 'ru' ? String(x).replace('.', ',') : String(x));
const fmt = (v, pd) => `${dec(Math.round(v * 10) / 10)}${pd.unit ? ` ${pd.unit}` : ''}`;

export function rackTarget() {
  const s = store.selection;
  if (!s) return null;
  if (s.kind === 'track') {
    const tk = store.project.audioTracks.find((x) => x.id === s.id);
    return tk ? { kind: 'track', id: tk.id, owner: tk, name: tk.name || t('Аудио {n}', { n: store.project.audioTracks.indexOf(tk) + 1 }) } : null;
  }
  const f = s.kind === 'audio' ? store.findClip(s.id) : null;
  return f ? { kind: 'clip', id: f.clip.id, owner: f.clip, name: store.clipName(f.clip) } : null;
}

export function initAudioRack() {
  const root = $('#audio-rack');
  let before = null; // снимок проекта, пока тянут ползунок

  const slider = (target, i, fx, pd) => {
    const v = fxParam(fx, pd.k);
    const val = h('span', { class: 'vol-val' }, fmt(v, pd));
    const r = h('input', { type: 'range', class: 'slider', min: String(pd.min), max: String(pd.max), step: String(pd.step), value: String(v), dataset: { param: pd.k } });
    r.addEventListener('pointerdown', () => { before = store.snapshot(); });
    r.addEventListener('input', () => {
      const x = Number(r.value);
      val.textContent = fmt(x, pd);
      store.setAudioFx(target, i, { p: { [pd.k]: x } }, { live: !!before });
    });
    const done = () => { if (before) { const b = before; before = null; store.commitFrom(b); render(); } };
    r.addEventListener('pointerup', done);
    r.addEventListener('change', done);
    // Двойной щелчок — значение по умолчанию
    r.addEventListener('dblclick', () => { before = null; store.setAudioFx(target, i, { p: { [pd.k]: pd.def } }); });
    return h('div', { class: 'fx-param' }, h('span', { class: 'fx-pname' }, pd.name), h('div', { class: 'row gap' }, r, val));
  };

  function render() {
    if (before) return;
    root.innerHTML = '';
    const tg = rackTarget();
    root.append(h('div', { class: 'panel-head' }, h('h2', {}, t('Аудиоэффекты'))));
    if (!tg) {
      const s = store.selection;
      const vid = s && s.kind === 'video' ? store.findClip(s.id) : null;
      root.append(h('p', { class: 'muted small' }, vid && vid.clip.noAudio
        ? t('Звук этого видео лежит на аудиодорожке — выберите его там.')
        : t('Выберите звуковой клип на таймлайне — эффекты будут только у него. Щелчок по названию дорожки — эффекты для всей дорожки.')));
      return;
    }
    const target = { kind: tg.kind, id: tg.id };
    root.append(h('div', { class: 'rack-target' },
      h('span', { class: 'th-ic', html: icon(tg.kind === 'track' ? 'menu' : 'music', 16) }),
      h('span', {}, tg.kind === 'track' ? t('Дорожка «{name}»', { name: tg.name }) : t('Клип «{name}»', { name: tg.name }))),
    h('p', { class: 'muted small' }, tg.kind === 'track' ? t('Эффекты действуют на все клипы дорожки вместе.') : t('Эффекты действуют только на этот клип.')));

    const list = Array.isArray(tg.owner.afx) ? tg.owner.afx : [];
    list.forEach((fx, i) => {
      const d = fxDef(fx.type);
      if (!d) {
        // Эффект плагина, которого нет (или он выключен): в проекте остаётся, но не применяется
        if (fx && typeof fx.type === 'string') {
          root.append(h('div', { class: 'fx-card off missing', dataset: { fx: fx.type, index: String(i) } },
            h('div', { class: 'fx-card-head' },
              h('span', { class: 'muted small' }, t('«{id}» — эффект отсутствующего плагина, не применяется', { id: fx.type })),
              h('button', { class: 'icon-btn tiny', title: t('Убрать эффект'), html: icon('trash', 14), dataset: { fxDel: String(i) }, onclick: () => store.removeAudioFx(target, i) }))));
        }
        return;
      }
      const on = h('input', { type: 'checkbox', title: t('Включить / выключить'), dataset: { fxOn: String(i) } });
      on.checked = fx.on !== false;
      on.addEventListener('change', () => store.setAudioFx(target, i, { on: on.checked }));
      const card = h('div', { class: `fx-card${fx.on === false ? ' off' : ''}`, dataset: { fx: fx.type, index: String(i) } },
        h('div', { class: 'fx-card-head' },
          h('label', { class: 'check-row' }, on, h('b', {}, d.name)),
          h('button', { class: 'icon-btn tiny', title: t('Убрать эффект'), html: icon('trash', 14), dataset: { fxDel: String(i) }, onclick: () => store.removeAudioFx(target, i) })),
        ...d.params.map((pd) => slider(target, i, fx, pd)),
        d.previewOnlyExport ? h('p', { class: 'muted small' }, t('В плеере не слышно — только в готовом видео.')) : null);
      root.append(card);
    });

    root.append(h('div', { class: 'rack-add' },
      h('div', { class: 'pop-title' }, t('Добавить')),
      ...AUDIO_FX.map((d) => h('button', { class: 'btn ghost small wide-left', title: d.hint, dataset: { addFx: d.id }, onclick: () => store.addAudioFx(target, d.id) },
        h('span', { html: icon('plus', 14) }), d.name)),
      h('p', { class: 'muted small' }, t('Другие эффекты появятся с плагинами.'))));
  }

  store.on('selection', render);
  store.on('project', render);
  store.on('mode', render);
  // Плагин включили/выключили — список аудиоэффектов изменился
  if (typeof registry.onRegistryChange === 'function') {
    let pending = false;
    registry.onRegistryChange((ev) => {
      if (pending || (ev && ev.kind && ev.kind !== 'audioEffect')) return;
      pending = true;
      queueMicrotask(() => { pending = false; try { render(); } catch (e) { console.warn('audio rack', e); } });
    });
  }
  render();
  return { render };
}
