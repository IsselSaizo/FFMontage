# Плагины FF Montage (API v1)

Плагин — папка с файлом `plugin.json` и, по желанию, скриптами и страницами. Через плагины в программу
добавляются эффекты, переходы, звуковые эффекты, пресеты экспорта и горячих клавиш, действия и панели.
Встроенные эффекты и переходы устроены так же: это плагин `core`, он пользуется тем же API.

Готовые примеры: [`examples/plugins/vignette`](../examples/plugins/vignette) (эффект без единой строки кода) и
[`examples/plugins/project-stats`](../examples/plugins/project-stats) (панель, действие с клавишей, хранилище),
[`examples/plugins/layouts`](../examples/plugins/layouts) (раскладки кадра: картинка в картинке и сетки через `set_transform`).

## Установка

**☰ → Настройки → Плагины**: «Из папки…», «Из zip…» или «С GitHub…» (`владелец/репозиторий` — берётся
`.zip` из последнего релиза; если рядом лежит `<имя>.zip.sha256` или `SHA256SUMS`, контрольная сумма проверяется).
Перед установкой программа показывает, какие права просит плагин. Там же плагин выключают, обновляют (повторная
установка заменяет старую версию) и удаляют.

Плагины лежат в папке `plugins/<id>/` рядом с программой (её открывает кнопка «Открыть папку»).
Если плагин пропал, проект всё равно открывается: программа предупреждает, какие эффекты не найдены, а сами
настройки клипов сохраняются — после установки плагина всё вернётся.

## Безопасность

- Код плагина работает в песочнице: `<iframe sandbox="allow-scripts">` без общего происхождения с программой.
  У него нет доступа к окну программы, к файлам, к FFmpeg и к командам программы — только к `window.ffm`.
- Сеть закрыта (CSP `connect-src` — только файлы самого плагина). Запросы в интернет — через `ffm.net.fetch`
  и только к хостам, перечисленным в правах `net:<хост>` (только https).
- FFmpeg плагин не запускает. Эффект описывает фрагмент графа фильтров декларативно; программа подставляет
  числа, проверяет имена фильтров и опций, а Rust перед запуском ещё раз проверяет весь граф и аргументы.
  Разрешены только фильтры из [`safeFilters.js`](../src/renderer/js/core/safeFilters.js), которые плагин
  перечислил в `ffmpeg.filters`. Фильтры, читающие файлы или сеть (`movie`, `subtitles`, `lut3d`, `sendcmd` …),
  и опции вроде `file`/`filename` запрещены.

## plugin.json

```json
{
  "id": "my-plugin",
  "name": { "ru": "Мой плагин", "en": "My plugin" },
  "version": "1.0.0",
  "apiVersion": 1,
  "description": { "ru": "…", "en": "…" },
  "author": "Имя",
  "homepage": "https://github.com/…",
  "entry": "main.js",
  "contributes": {
    "effects": [], "transitions": [], "audioEffects": [], "exportPresets": [],
    "keymaps": [], "actions": [], "panels": []
  },
  "permissions": ["project:read", "storage"],
  "ffmpeg": { "filters": ["vignette"] }
}
```

| Поле | |
|---|---|
| `id` | латиница в нижнем регистре, цифры и `-`, 2–41 символ; не `core`. Эффекты плагина получают id `<id плагина>.<id эффекта>` |
| `name`, `description` | строка или `{ "ru": …, "en": … }` (так же — все подписи ниже) |
| `apiVersion` | `1` |
| `entry` | необязательный ES-модуль логики; выполняется в скрытой песочнице всё время, пока плагин включён |
| `contributes` | что плагин добавляет (см. ниже). Всё из `contributes` регистрируется само, без кода |
| `permissions` | права (см. таблицу) |
| `ffmpeg.filters` | фильтры FFmpeg, которые используют эффекты плагина |

### Права

| Право | Что даёт |
|---|---|
| `project:read` | `ffm.project.get/subscribe`, `ffm.tools.call('get_project')` |
| `project:write` | (включает `project:read`) `ffm.commands.execute`, изменяющие инструменты `ffm.tools.call` — с отменой Ctrl+Z |
| `ui:panel` | панели в правой части окна (без этого права `contributes.panels` не показываются) |
| `storage` | `ffm.storage` — свой JSON до 1 МБ |
| `notify` | не обязательно: `ffm.ui.notify` доступен всем (не больше 5 сообщений за 10 с) |
| `net:<хост>` | `ffm.net.fetch` к `https://<хост>/…` |

Инструменты для `ffm.tools.call`: `get_project`, `add_clip`, `update_clip`, `split_clip`, `delete_clip`,
`reverse_clip`, `freeze_frame`, `set_transition`, `close_gaps`, `add_video_track`, `update_video_track`, `set_transform`,
`undo`, `redo`, `set_playhead` (аргументы — как
у ИИ-ассистента, см. описание MCP). Файловые инструменты и экспорт плагинам недоступны. `ffm.commands.execute`
не выполняет действия меню «Файл» и действия других плагинов.

Только что установленный плагин выключен: программа показывает его права и включает его по вашему согласию.

## Выражения в описаниях

В строках описаний можно писать выражения в фигурных скобках: `{strength * 0.75}` или `{strength * 0.75:3}`
(после двоеточия — число знаков после запятой; по умолчанию 6). Доступны параметры эффекта, `w` (ширина кадра:
исходного — для FFmpeg, показанного в плеере — для CSS), `p` (доля перехода 0…1), операции `+ - * / %`,
сравнения `< > <= >= == != && || !` и функции `min max clamp abs round floor ceil pow sqrt db` (`db(x)` = 10^(x/20)).

## Эффект (видео)

```json
{
  "id": "vignette",
  "name": { "ru": "Виньетка", "en": "Vignette" },
  "params": [ { "k": "strength", "name": "Сила", "min": 0, "max": 1, "step": 0.05, "def": 0.5 } ],
  "ffmpeg": [ { "filter": "vignette", "args": { "angle": "{0.15 + strength * 0.75:4}" }, "when": "strength > 0" } ],
  "css": "brightness({1 - strength * 0.12:3})"
}
```
- `ffmpeg` — цепочка фильтров, которая ставится на клип до масштабирования. `args` — объект `{опция: значение}`
  или массив позиционных значений. `when` — фильтр ставится, только если выражение истинно.
- `css` — CSS `filter` для предпросмотра в плеере (приближение; что не выразить CSS — просто не показывается).
- Значения после подстановки не могут содержать `' " \ ; [ ] ,` и перевод строки.

## Переход

```json
{
  "id": "split",
  "name": "Раскрытие",
  "xfade": "vertopen",
  "preview": { "b": { "clipPath": "inset(0 {(1 - p) * 50}% 0 {(1 - p) * 50}%)" } }
}
```
- `xfade` — имя встроенного перехода фильтра `xfade` или `{ "expr": "…" }` — своё выражение xfade
  (переменные `A`, `B`, `X`, `Y`, `W`, `H`, `P`; `P` идёт от 1 к 0). Пример — встроенные «Жалюзи».
- `preview` — стили двух слоёв в плеере: `a` — уходящий клип, `b` — следующий; поля `opacity`, `transform`,
  `clipPath`, `mask`, `filter`; `top: "a"` — уходящий слой сверху; `overlay: { color, opacity }` — заливка поверх.

## Звуковой эффект

```json
{
  "id": "telephone",
  "name": "Телефон",
  "params": [ { "k": "tone", "name": "Тон", "min": 500, "max": 3000, "step": 50, "def": 1500, "unit": "Гц" } ],
  "ffmpeg": [ { "filter": "bandpass", "args": { "f": "{tone:0}", "width_type": "q", "w": "1.2" } } ],
  "webaudio": [ { "node": "biquad", "type": "bandpass", "frequency": "{tone}", "Q": "1.2" } ]
}
```
- `webaudio` — как эффект звучит в предпросмотре: узлы `biquad` (`type`, `frequency`, `gain`, `Q`),
  `compressor` (`threshold`, `ratio`, `attack`, `release`, `knee`), `gain` (`gain`). Без `webaudio`
  эффект слышно только в готовом файле (как шумоподавление).

## Пресет экспорта, пресет клавиш, действие, панель

```json
"exportPresets": [ { "id": "shorts", "name": "Shorts 1080×1920", "width": 1080, "height": 1920, "fps": 30, "codec": "h264", "quality": "high" } ],
"keymaps": [ { "id": "my", "name": "Мои клавиши", "keys": { "clip.split": ["KeyC"], "tool.blade": ["KeyX"] } } ],
"actions": [ { "id": "show", "title": "Статистика проекта", "keys": ["Ctrl+Shift+KeyI"] } ],
"panels":  [ { "id": "stats", "title": "Статистика", "entry": "panel.html" } ]
```
У пресета экспорта `codec` — `h264`, `hevc` или `av1` (программа сама выберет кодировщик: видеокарта или процессор),
`quality` — `high`, `medium` или `compact`; размеры чётные, от 16 до 8192, `fps` — от 1 до 240.

Клавиши записываются по `KeyboardEvent.code` (`Ctrl+Shift+KeyI`, `Alt+Digit1`) — так они работают в любой
раскладке. Действия видны в «Настройки → Горячие клавиши» (категория «Плагины»), нажатие приходит в `entry`
событием `action`. Панель — страница плагина во вкладке правой панели; SDK в неё подключается сам.

## window.ffm (SDK)

SDK программа вставляет в каждую страницу плагина сама. Все методы возвращают Promise.

```js
ffm.pluginId, ffm.lang ('ru' | 'en'), ffm.apiVersion        // 1
ffm.ready()                                                 // логика/панель готова
ffm.on('action', ({ id }) => {})                            // нажато действие плагина
ffm.project.get()                                           // снимок проекта (JSON)
ffm.project.subscribe((project) => {})                      // изменения проекта
ffm.commands.list() / ffm.commands.execute('clip.split')    // действия программы (как горячие клавиши)
ffm.tools.call('update_clip', { clip_id, volume: 0.5 })     // инструменты ИИ-ассистента (кроме файловых и экспорта)
ffm.register.effect(desc) / .transition / .audioEffect / .exportPreset / .keymap
ffm.register.action({ id, title, keys }, handler)
ffm.ui.notify('Готово', 'success')                          // 'info' | 'success' | 'error'
ffm.storage.get() / ffm.storage.set({ … })
ffm.net.fetch('https://api.example.com/x', { method: 'GET', headers: {} })   // → { status, headers, body }
```

Модель проекта (`project.get()`) — та же, что в файле `.ffproj`: `media`, `videoClips`, `audioTracks`,
`overlayClips`, `episodes`, … В 0.4 она переходит на версию 3 (несколько видеодорожек) — API v1 будет отдавать
и старые поля, пока `apiVersion 1` поддерживается.

## Отладка

- Ошибки плагина пишутся в журнал окна (`<кэш>/app/logs/renderer.log`, ☰ → Настройки → О программе → «Папка журналов»).
- После правки файлов плагина установите папку заново (или выключите и включите плагин).
- Своё выражение FFmpeg удобнее сначала проверить в консоли:
  `ffmpeg -i in.mp4 -vf "vignette=angle=0.5" out.mp4`.
