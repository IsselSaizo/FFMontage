// Плагины: хост, раздел настроек «Плагины», предупреждения о пропавших плагинах
export default {
  // keymap.js — категория действий
  'Плагины': 'Plugins',
  // plugins/permissions.js — права человеческим языком
  'Выполняет свой код в песочнице (без доступа к файлам и программе)': 'Runs its own code in a sandbox (no access to files or the app itself)',
  'Читать проект: клипы, эффекты, названия и пути файлов': 'Read the project: clips, effects, file names and paths',
  'Изменять проект (изменения отменяются через «Отменить»)': 'Change the project (changes can be undone with “Undo”)',
  'Показывать свою вкладку в правой панели': 'Show its own tab in the right panel',
  'Хранить свои настройки и данные (до 1 МБ)': 'Keep its own settings and data (up to 1 MB)',
  'Показывать уведомления': 'Show notifications',
  'Обращаться в интернет к {host}': 'Access the internet at {host}',
  'Фильтры FFmpeg при экспорте: {list}': 'FFmpeg filters on export: {list}',
  // plugins/host.js
  'Нет манифеста plugin.json': 'No plugin.json manifest',
  'Недопустимый id плагина': 'Invalid plugin id',
  'Установка не вернула id плагина': 'The installer did not return a plugin id',
  'В проекте есть эффекты плагинов, которых нет или они выключены: {list}. Они не применяются, но остаются в проекте — установите или включите плагин.':
    'The project uses effects from plugins that are missing or disabled: {list}. They are not applied but stay in the project — install or enable the plugin.',
  'Плагин «{name}» не отвечает': 'Plugin “{name}” is not responding',
  // audioRack.js
  '«{id}» — эффект отсутствующего плагина, не применяется': '“{id}” is an effect of a missing plugin and is not applied',
  // settings.js — раздел «Плагины»
  'Плагины добавляют эффекты, переходы, панели и действия с горячими клавишами. Код плагина работает в песочнице: без доступа к файлам и к самой программе — только то, что разрешают его права.':
    'Plugins add effects, transitions, panels and actions with hotkeys. Plugin code runs in a sandbox: no access to files or the app itself — only what its permissions allow.',
  'Из папки…': 'From folder…',
  'Из zip…': 'From zip…',
  'С GitHub…': 'From GitHub…',
  'Открыть папку плагинов': 'Open plugins folder',
  'Обновить список': 'Refresh list',
  'Особых прав не просит: только эффекты, переходы и клавиши из описания.': 'Asks for no special permissions: only the effects, transitions and keys from its description.',
  'Не удалось установить плагин: {e}': 'Could not install the plugin: {e}',
  'Плагин «{name}» установлен, но в его манифесте ошибка: {e}': 'Plugin “{name}” was installed, but its manifest has an error: {e}',
  'Заменена ранее установленная версия.': 'The previously installed version was replaced.',
  'Контрольная сумма архива (sha256) не проверена — в релизе нет файла с ней. Включайте, только если доверяете автору.':
    'The archive checksum (sha256) was not verified — the release has no checksum file. Enable it only if you trust the author.',
  'Файл релиза: {name}': 'Release file: {name}',
  'Плагин «{name}» установлен': 'Plugin “{name}” installed',
  'Включить его? Плагин получит такие права:': 'Enable it? The plugin will get these permissions:',
  'Включить': 'Enable',
  'Оставить выключенным': 'Keep disabled',
  'Плагин «{name}» включён': 'Plugin “{name}” enabled',
  'Установить плагин?': 'Install a plugin?',
  'Устанавливайте плагины только из источников, которым доверяете. Код плагина работает в песочнице, а перед включением программа покажет, какие права он просит.':
    'Install plugins only from sources you trust. Plugin code runs in a sandbox, and before enabling it the app shows which permissions it asks for.',
  'Продолжить': 'Continue',
  'Установка с GitHub': 'Install from GitHub',
  'Репозиторий (owner/repo)': 'Repository (owner/repo)',
  'Установить': 'Install',
  'Будет скачан последний релиз репозитория (первый файл .zip).': 'The latest release of the repository will be downloaded (the first .zip file).',
  'Укажите репозиторий в виде owner/repo': 'Enter the repository as owner/repo',
  'версия {v}': 'version {v}',
  'встроенный': 'built-in',
  'Автор: {name}': 'Author: {name}',
  'Включить плагин «{name}»?': 'Enable plugin “{name}”?',
  'Плагин получит такие права:': 'The plugin will get these permissions:',
  'Выключить': 'Disable',
  'Включён': 'Enabled',
  'Открыть папку': 'Open folder',
  'Удалить плагин «{name}»?': 'Remove plugin “{name}”?',
  'Папка плагина будет удалена. Проекты с его эффектами откроются, но эти эффекты не будут применяться, пока плагин не установят снова.':
    'The plugin folder will be deleted. Projects with its effects will still open, but those effects will not be applied until the plugin is installed again.',
  'Плагин удалён': 'Plugin removed',
  'Не удалось удалить плагин: {e}': 'Could not remove the plugin: {e}',
  'Ошибка в манифесте: {e}': 'Manifest error: {e}',
  'Список плагинов не загрузился: {e}': 'The plugin list did not load: {e}',
  'Установленных плагинов нет.': 'No plugins installed.',
  'Папка плагинов: {path}': 'Plugins folder: {path}',
};
