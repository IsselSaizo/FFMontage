// Окно первого запуска (и старое окно «Настройки папок»): язык и папки. Результат пишется в config.json.
import { h, icon, errText } from './util.js';
import { t, LANGS, getLang, rememberLang } from './i18n.js';
import { foldersForm } from './folders.js';

const api = window.api;

async function main() {
  const info = await api.setupInfo();
  // Введённые пути переживают перезагрузку окна при смене языка
  try { const kept = JSON.parse(sessionStorage.getItem('ffm.setupCfg') || 'null'); if (kept) Object.assign(info.config, kept); } catch { /* ignore */ }
  const form = foldersForm(info);
  const root = document.getElementById('setup');
  document.title = info.firstRun ? t('FF Montage — первый запуск') : t('FF Montage — настройки папок');

  const errorBox = h('div', { class: 'setup-error' });

  // Язык: при первом запуске предложен язык системы; смена перезагружает окно
  const langRow = h('div', { class: 'setup-row lang-row' },
    h('div', { class: 'setup-label' }, h('b', {}, 'Язык / Language')), // i18n-ignore — подпись на обоих языках
    h('div', { class: 'row gap' }, ...LANGS.map((l) => h('button', {
      class: `chip${l.id === getLang() ? ' on' : ''}`, dataset: { lang: l.id },
      onclick: () => {
        if (l.id === getLang()) return;
        try { sessionStorage.setItem('ffm.setupCfg', JSON.stringify(form.values())); } catch { /* ignore */ }
        rememberLang(l.id);
        location.reload();
      },
    }, l.name))));

  const save = h('button', { class: 'btn primary', onclick: async () => {
    errorBox.textContent = '';
    save.disabled = true;
    const r = await api.saveSetup({ ...form.values(), lang: getLang() });
    if (!r.ok) { errorBox.textContent = r.error; save.disabled = false; return; }
    try { sessionStorage.removeItem('ffm.setupCfg'); } catch { /* ignore */ }
    save.textContent = t('Перезапуск…');
  } }, info.firstRun ? t('Сохранить и запустить') : t('Сохранить и перезапустить'));

  root.append(
    h('div', { class: 'setup-head' },
      h('div', { class: 'logo', html: icon('logo', 34) }),
      h('div', {},
        h('h1', {}, info.firstRun ? t('Добро пожаловать в FF Montage') : t('Настройки папок')),
        h('p', { class: 'muted' }, info.firstRun
          ? t('Выберите, где программа будет хранить файлы. Это можно поменять позже: меню ☰ → «Настройки» → «Папки».')
          : t('Новые папки начнут использоваться после перезапуска программы. Старые файлы не переносятся.')))),
    h('div', { class: 'setup-body' },
      info.firstRun ? langRow : null,
      form.el,
      errorBox),
    h('div', { class: 'setup-foot' },
      h('span', { class: 'muted small cfg-path', title: info.configFile }, t('Настройки: {path}', { path: info.configFile })),
      h('div', { class: 'row gap' },
        info.firstRun ? null : h('button', { class: 'btn ghost', onclick: () => api.cancelSetup() }, t('Отмена')),
        save)),
  );
  document.addEventListener('keydown', (e) => { if (e.key === 'F12') api.devtools(); });
  window.__setup = { cfg: form.cfg, check: form.check, save };
  await form.check();
}

main().catch((e) => { document.body.textContent = t('Ошибка: {e}', { e: errText(e) }); });
