// Вкладки эпизодов над таймлайном: несколько таймлайнов в проекте (как в DaVinci Resolve).
// Монтируйте сцены по отдельности, потом одной кнопкой добавьте эпизод в основной таймлайн.
import { store } from './store.js';
import { h, icon, toast, confirmDialog } from './util.js';
import { openMenu } from './contextMenu.js';
import { fmtTime } from './util.js';

export function initEpisodes(timelineRoot) {
  const bar = h('div', { class: 'tl-episodes', id: 'episodes' });
  timelineRoot.insertBefore(bar, timelineRoot.firstChild);

  const rename = (id, el) => {
    const inp = h('input', { class: 'ep-rename', value: store.episodeName(id), maxlength: '40' });
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      if (ok && inp.value.trim()) store.renameEpisode(id, inp.value); else render();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    el.replaceWith(inp); inp.focus(); inp.select();
  };

  const remove = async (id) => {
    const dur = store.episodeDuration(id);
    if (dur > 0 && !(await confirmDialog('Удалить эпизод?', `«${store.episodeName(id)}» (${fmtTime(dur, { ms: false })}) будет удалён вместе с его клипами. Файлы в «Ваших медиа» останутся. Отменить можно Ctrl+Z.`, 'Удалить', 'Отмена', true))) return;
    store.removeEpisode(id);
  };

  const insertInto = (src, dst, atCursor) => {
    const at = atCursor && dst === store.activeEpisode() ? store.time : null;
    if (!store.insertEpisode(src, dst, at)) { toast('Эпизод пустой — добавлять нечего', 'info', 2200); return; }
    toast(`«${store.episodeName(src)}» добавлен в «${store.episodeName(dst)}»${at === null ? ' (в конец)' : ' (по курсору)'}`, 'success', 2600);
  };

  const tabMenu = (e, id) => {
    e.preventDefault();
    const active = store.activeEpisode();
    const others = store.episodes().filter((x) => x.id !== id);
    openMenu(e.clientX, e.clientY, [
      { label: 'Переименовать', icon: 'rename', onClick: () => rename(id, bar.querySelector(`.ep-tab[data-ep="${id}"] .ep-name`)) },
      id !== 'main' ? { label: 'Добавить в конец «Основного»', icon: 'plus', id: 'ep-to-main', onClick: () => insertInto(id, 'main', false) } : null,
      id !== active ? { label: `Вставить сюда по курсору («${store.episodeName(active)}»)`, icon: 'plus', id: 'ep-here', onClick: () => insertInto(id, active, true) } : null,
      ...(others.length ? ['sep', { header: 'Добавить в конец эпизода' }, ...others.map((o) => ({ label: o.name, onClick: () => insertInto(id, o.id, false) }))] : []),
      id !== 'main' ? 'sep' : null,
      id !== 'main' ? { label: 'Удалить эпизод', icon: 'trash', danger: true, onClick: () => remove(id) } : null,
    ]);
  };

  function render() {
    bar.innerHTML = '';
    const active = store.activeEpisode();
    const list = store.episodes();
    for (const ep of list) {
      const name = h('span', { class: 'ep-name' }, ep.name);
      const tab = h('div', {
        class: `ep-tab${ep.id === active ? ' on' : ''}`, dataset: { ep: ep.id },
        title: `${ep.name}${ep.id === 'main' ? ' — основной таймлайн' : ''}. Двойной щелчок — переименовать, правая кнопка — добавить в другой эпизод`,
      }, name);
      tab.addEventListener('click', () => store.switchEpisode(ep.id));
      name.addEventListener('dblclick', (e) => { e.stopPropagation(); rename(ep.id, name); });
      tab.addEventListener('contextmenu', (e) => tabMenu(e, ep.id));
      if (ep.id !== 'main') {
        const x = h('button', { class: 'ep-x', title: 'Удалить эпизод', html: icon('close', 12) });
        x.addEventListener('click', (e) => { e.stopPropagation(); remove(ep.id); });
        tab.append(x);
      }
      bar.append(tab);
    }
    bar.append(h('button', { class: 'ep-add', id: 'ep-add', title: 'Новый эпизод: отдельный таймлайн, потом его легко добавить в основной', onclick: () => store.addEpisode() },
      h('span', { html: icon('plus', 14) }), list.length > 1 ? '' : 'Эпизод'));
    if (active !== 'main') {
      bar.append(h('div', { class: 'ep-spacer' }),
        h('button', { class: 'btn small ep-join', id: 'ep-join', title: 'Скопировать весь этот эпизод в конец основного таймлайна', onclick: () => insertInto(active, 'main', false) },
          h('span', { html: icon('plus', 14) }), `Добавить в «${store.episodeName('main')}»`));
    }
  }

  let last = '';
  const maybe = () => {
    const k = JSON.stringify([store.activeEpisode(), store.episodes().map((e) => [e.id, e.name])]);
    if (k !== last) { last = k; render(); }
  };
  store.on('project', maybe);
  store.on('episodes', () => { last = ''; maybe(); });
  render();
}
