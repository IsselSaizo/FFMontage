// Вкладка «Аудио»: стойка эффектов справа.
// Выбран аудиоклип — эффекты клипа; выбрана дорожка (щелчок по её названию) — эффекты всей дорожки.
// Список «Добавить» пополняется аудиоэффектами плагинов (перерисовка по onRegistryChange).
// Аудиоплагины VST3 / CLAP (js/vst.js): кнопка «VST3 / CLAP…» — список найденных (поиск, по производителям),
// запись в стойке — «Окно плагина», состояние обработки звука; у плагина без окна — общие ползунки (vst_info.params).
import { store } from './store.js';
import { h, $, icon, toast, errText } from './util.js';
import { AUDIO_FX, fxDef, fxParam, isVst, vstKnown, vstName, newPluginFx } from './audioFx.js';
import { t, getLang } from './i18n.js';
import * as registry from './registry.js';
import * as vst from './vst.js';
import { attachPopover } from './popover.js';
import { openSettings } from './settings.js';

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
    statusEls = [];
    list.forEach((fx, i) => {
      if (isVst(fx)) { root.append(vstCard(target, i, fx, tg)); return; }
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
      vstAddButton(target),
      h('p', { class: 'muted small' }, t('Другие эффекты появятся с плагинами.'))));
  }

  // ---------------- VST3 / CLAP ----------------
  let statusEls = []; // { el, target, i } — строки состояния обработки (обновляются без перерисовки стойки)
  const fmtOf = (fx) => (fx.type === 'clap' ? 'CLAP' : 'VST3');

  const fillStatus = ({ el, target, i }) => {
    el.innerHTML = '';
    const o = store.fxOwner(target);
    const fx = o && o.afx && o.afx[i];
    if (!fx || fx.on === false || !vstKnown(fx)) { el.hidden = true; return; }
    const r = vst.ownerRender(target);
    el.hidden = !r;
    if (!r) return;
    el.dataset.state = r.status;
    if (r.status === 'live') {
      el.append(vst.sessionOf(target, i) ? t('Открыто окно плагина — звук идёт через него') : t('Открыто окно другого плагина этой цепочки'));
    } else if (r.status === 'ready') {
      el.append(t('Звук обработан'));
    } else if (r.status === 'error') {
      el.append(h('span', {}, t('Ошибка обработки: {e}', { e: r.error || '' })),
        r.key ? h('button', { class: 'btn ghost tiny', onclick: () => vst.retry(r) }, t('Повторить')) : null);
    } else {
      el.append(r.status === 'run' && r.fraction > 0
        ? t('Обработка звука… {p}%', { p: Math.round(r.fraction * 100) })
        : t('Обработка звука…'));
    }
  };

  const setVstParam = (target, i, id, x, live) => {
    const fn = (p) => {
      const o = store.fxOwner(target, p);
      const fx = o && o.afx && o.afx[i];
      if (isVst(fx)) fx.vst = { ...fx.vst, params: { ...(fx.vst.params || {}), [id]: x } };
    };
    if (live) store.live(fn); else store.mutate(fn);
  };
  // Общий ползунок параметра плагина без окна: значение 0..1 (нормированное, как в VST3/CLAP)
  const vstSlider = (target, i, fx, pd) => {
    const id = String(pd.id);
    const steps = Number(pd.steps) > 0 ? Number(pd.steps) : 0;
    const cur = fx.vst.params && Number.isFinite(Number(fx.vst.params[id])) ? Number(fx.vst.params[id]) : Number(pd.value ?? pd.def ?? 0);
    const show = (v) => (steps ? String(Math.round(v * steps)) : `${Math.round(v * 100)}%`);
    const val = h('span', { class: 'vol-val' }, show(cur));
    const r = h('input', { type: 'range', class: 'slider', min: '0', max: '1', step: String(steps ? 1 / steps : 0.001), value: String(cur), dataset: { vstParam: id } });
    r.addEventListener('pointerdown', () => { before = store.snapshot(); });
    r.addEventListener('input', () => {
      const x = Number(r.value);
      val.textContent = show(x);
      setVstParam(target, i, id, x, !!before);
      vst.sendParams(target, i, { [id]: x }); // открыто прослушивание — слышно сразу
    });
    const done = () => { if (before) { const b = before; before = null; store.commitFrom(b); render(); } };
    r.addEventListener('pointerup', done);
    r.addEventListener('change', done);
    r.addEventListener('dblclick', () => { before = null; setVstParam(target, i, id, Number(pd.def ?? 0), false); });
    const title = `${pd.title || id}${pd.units ? `, ${pd.units}` : ''}`;
    return h('div', { class: 'fx-param' }, h('span', { class: 'fx-pname' }, title), h('div', { class: 'row gap' }, r, val));
  };

  function vstCard(target, i, fx, tg) {
    const known = vstKnown(fx);
    const name = vstName(fx);
    const del = h('button', { class: 'icon-btn tiny', title: t('Убрать эффект'), html: icon('trash', 14), dataset: { fxDel: String(i) }, onclick: () => store.removeAudioFx(target, i) });
    const vendor = fx.vst && fx.vst.vendor ? h('span', { class: 'muted small' }, String(fx.vst.vendor)) : null;
    if (!known) {
      return h('div', { class: 'fx-card vst off missing', dataset: { fx: fx.type, index: String(i) } },
        h('div', { class: 'fx-card-head' },
          h('span', { class: 'row gap' }, h('b', {}, name), h('span', { class: 'fmt-tag' }, fmtOf(fx))), del),
        h('p', { class: 'muted small' }, t('Плагин не найден на этом компьютере — запись остаётся в проекте, но не применяется.')));
    }
    const on = h('input', { type: 'checkbox', title: t('Включить / выключить'), dataset: { fxOn: String(i) } });
    on.checked = fx.on !== false;
    on.addEventListener('change', () => store.setAudioFx(target, i, { on: on.checked }));
    const sess = vst.sessionOf(target, i);
    const info = vst.infoCached(fx.vst.uid, fx.vst.state, fx.vst.ctrl);
    const noEditor = !!((info && info.hasEditor === false) || (sess && sess.hasEditor === false));
    // Плагин без своего окна: «Слушать» — живая сессия без окна (ползунки ниже слышны сразу)
    const label = sess ? (noEditor ? t('Остановить') : t('Закрыть окно')) : (noEditor ? t('Слушать') : t('Окно плагина'));
    const winBtn = h('button', {
      class: `btn ghost tiny${sess ? ' on' : ''}`, dataset: { vstEditor: String(i) },
      title: sess ? (noEditor ? t('Закончить прослушивание через плагин') : t('Закрыть окно плагина'))
        : (noEditor ? t('Слушать через плагин — правки ползунков слышны сразу') : t('Открыть окно плагина — правки слышны сразу')),
      onclick: async () => {
        if (sess) { vst.closeEditor(sess.id); return; }
        try {
          const r = await vst.openEditor(target, i, `${name} — ${tg.name}`);
          if (r && r.hasEditor === false) toast(t('У плагина нет своего окна — настройте его ползунками в стойке.'), 'info', 4000);
        } catch (e) { toast(t('Окно плагина не открылось: {e}', { e: errText(e) }), 'error', 6000); }
        render();
      },
    }, h('span', { html: icon(sess ? 'close' : noEditor ? 'speaker' : 'gear', 13) }), label);
    const status = h('div', { class: 'vst-status small' });
    const se = { el: status, target, i };
    statusEls.push(se);
    fillStatus(se);
    const params = noEditor && info && Array.isArray(info.params) ? info.params.filter((pd) => pd && !pd.readOnly) : [];
    return h('div', { class: `fx-card vst${fx.on === false ? ' off' : ''}`, dataset: { fx: fx.type, index: String(i), uid: String(fx.vst.uid) } },
      h('div', { class: 'fx-card-head' },
        h('label', { class: 'check-row' }, on, h('b', {}, name), h('span', { class: 'fmt-tag' }, fmtOf(fx))),
        h('span', { class: 'row gap' }, winBtn, del)),
      vendor,
      status,
      vst.infoError(fx.vst.uid) ? h('p', { class: 'setup-error small' }, t('Плагин не загрузился: {e}', { e: vst.infoError(fx.vst.uid) })) : null,
      ...params.map((pd) => vstSlider(target, i, fx, pd)));
  }

  async function addPlugin(target, p) {
    let info;
    try { info = await vst.pluginInfo(p.uid); } catch (e) {
      toast(t('Плагин «{name}» не загрузился: {e}', { name: p.name, e: errText(e) }), 'error', 7000);
      return;
    }
    const fx = newPluginFx(p, info);
    store.mutate((proj) => { const o = store.fxOwner(target, proj); if (o) o.afx = [...(o.afx || []), fx]; });
  }

  function vstAddButton(target) {
    const s = vst.vstStatus();
    const btn = h('button', { class: 'btn ghost small wide-left', id: 'rack-add-vst', dataset: { addFx: 'vst' } },
      h('span', { html: icon('plus', 14) }), t('VST3 / CLAP…'));
    if (s.supported === false) {
      btn.disabled = true;
      btn.title = t('Аудиоплагины VST3 / CLAP работают только в Windows (x64).');
      return btn;
    }
    btn.title = t('Добавить аудиоплагин VST3 или CLAP');
    const pop = attachPopover(btn, () => {
      const search = h('input', { class: 'input', type: 'search', placeholder: t('Поиск плагина'), spellcheck: 'false' });
      const list = h('div', { class: 'vst-pop-list' });
      const draw = () => {
        list.innerHTML = '';
        const q = search.value.trim().toLowerCase();
        const all = vst.vstPlugins().filter((p) => !p.instrument);
        const found = all.filter((p) => !q || `${p.name} ${p.vendor} ${p.category || ''} ${p.sub || ''}`.toLowerCase().includes(q));
        if (!all.length) { list.append(h('p', { class: 'muted small' }, s.loaded ? t('Плагины не найдены. Укажите папки и запустите сканирование в настройках.') : t('Список плагинов загружается…'))); return; }
        if (!found.length) { list.append(h('p', { class: 'muted small' }, t('Ничего не найдено'))); return; }
        const groups = new Map();
        for (const p of found) { const v = String(p.vendor || '') || t('Без производителя'); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(p); }
        for (const v of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
          list.append(h('div', { class: 'vst-pop-vendor' }, v));
          for (const p of groups.get(v).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
            list.append(h('button', {
              class: 'vst-pop-item', title: p.path || '', dataset: { vstUid: String(p.uid) },
              onclick: () => { pop.close(); addPlugin(target, p); },
            }, h('span', { class: 'grow' }, String(p.name || p.uid)), h('span', { class: 'fmt-tag' }, vst.formatLabel(vst.pluginFormat(p)))));
          }
        }
      };
      search.addEventListener('input', draw);
      search.addEventListener('keydown', (e) => e.stopPropagation());
      draw();
      setTimeout(() => search.focus(), 0);
      return h('div', { class: 'vst-pop-body' }, search, list,
        h('button', { class: 'btn ghost tiny', onclick: () => { pop.close(); openSettings('vst'); } }, h('span', { html: icon('gear', 13) }), t('Настройки аудиоплагинов…')));
    }, { hover: false, align: 'left', className: 'vst-pop' });
    return btn;
  }

  vst.initVst();
  vst.onVstChange((kind) => {
    if (before) return;
    if (kind === 'render') { for (const se of statusEls) if (se.el.isConnected) fillStatus(se); return; }
    if (kind === 'scan') return;
    render();
  });

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
