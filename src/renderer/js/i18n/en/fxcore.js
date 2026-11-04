// Реестр эффектов/переходов/аудиоэффектов и встроенный плагин core:
// expr.js, registry.js, core/*.js, а также новые строки effects/exportPlan/exportDialog/inspector
export default {
  // --- expr.js — ошибки выражений ---
  'Ошибка в выражении «{src}»: {reason}': 'Error in expression “{src}”: {reason}',
  'неожиданный символ «{c}»': 'unexpected character “{c}”',
  'выражение должно быть строкой': 'the expression must be a string',
  'слишком длинное выражение': 'the expression is too long',
  'слишком сложное выражение': 'the expression is too complex',
  'неожиданный конец выражения': 'unexpected end of expression',
  'запрещённое имя «{name}»': 'forbidden name “{name}”',
  'неизвестная функция «{name}»': 'unknown function “{name}”',
  'незакрытая скобка': 'unclosed parenthesis',
  'неверное число аргументов у {name}()': 'wrong number of arguments for {name}()',
  'пустое выражение': 'empty expression',
  'лишний текст после выражения': 'extra text after the expression',
  'неизвестная переменная «{name}»': 'unknown variable “{name}”',
  'выражение дало не число': 'the expression did not produce a number',
  'шаблон должен быть строкой': 'the template must be a string',
  'слишком длинный шаблон': 'the template is too long',
  'лишняя закрывающая фигурная скобка в шаблоне': 'unexpected closing brace in the template',
  'незакрытая фигурная скобка в шаблоне': 'unclosed brace in the template',
  'слишком много знаков после запятой': 'too many decimal places',

  // --- registry.js — проверка описаний ---
  'Неверный владелец описания (id плагина)': 'Invalid owner of the description (plugin id)',
  'нет названия': 'no name',
  'неверное название': 'invalid name',
  'неверный список параметров': 'invalid parameter list',
  'неверный параметр «{k}»': 'invalid parameter “{k}”',
  'нужен список фильтров FFmpeg (от 1 до 16)': 'a list of FFmpeg filters is required (1 to 16)',
  'неверное имя фильтра': 'invalid filter name',
  'фильтр «{f}» запрещён': 'filter “{f}” is not allowed',
  'фильтр «{f}» не объявлен в манифесте (ffmpeg.filters)': 'filter “{f}” is not declared in the manifest (ffmpeg.filters)',
  'слишком много параметров у фильтра «{f}»': 'too many options for filter “{f}”',
  'недопустимый параметр фильтра «{k}»': 'filter option “{k}” is not allowed',
  'неверные параметры фильтра «{f}»': 'invalid options for filter “{f}”',
  'недопустимое значение «{v}» у фильтра «{f}»': 'value “{v}” is not allowed for filter “{f}”',
  'недопустимое значение CSS «{v}»': 'CSS value “{v}” is not allowed',
  'неверный стиль предпросмотра': 'invalid preview style',
  'недопустимое значение стиля «{k}»': 'style value “{k}” is not allowed',
  'неверный переход xfade «{x}»': 'invalid xfade transition “{x}”',
  'недопустимое выражение xfade': 'xfade expression is not allowed',
  'неверный узел Web Audio «{n}»': 'invalid Web Audio node “{n}”',
  'неверные размеры или частота кадров': 'invalid frame size or frame rate',
  'неверный кодек или качество': 'invalid codec or quality',
  'Эффект «{id}»: {reason}': 'Effect “{id}”: {reason}',
  'Переход «{id}»: {reason}': 'Transition “{id}”: {reason}',
  'Аудиоэффект «{id}»: {reason}': 'Audio effect “{id}”: {reason}',
  'Пресет экспорта «{id}»: {reason}': 'Export preset “{id}”: {reason}',
  'описание должно быть объектом': 'the description must be an object',
  'нет id или неверный id (латиница, цифры, «-», «_»)': 'missing or invalid id (Latin letters, digits, “-”, “_”)',
  'id уже занят другим плагином': 'the id is already taken by another plugin',

  // --- core/exportPresets.js ---
  'Горизонтальное Full HD (YouTube)': 'Landscape Full HD (YouTube)',
  'Вертикальное Full HD (Shorts, Reels, TikTok)': 'Vertical Full HD (Shorts, Reels, TikTok)',

  // --- exportPlan.js — предупреждения экспорта ---
  'Аудиоэффект «{id}» не найден (нет плагина) — пропущен': 'Audio effect “{id}” not found (plugin missing) — skipped',
  'Эффект «{id}» не найден (нет плагина) — пропущен': 'Effect “{id}” not found (plugin missing) — skipped',
  'Переход «{id}» не найден (нет плагина) — заменён растворением': 'Transition “{id}” not found (plugin missing) — replaced with a dissolve',

  // --- inspector.js, exportDialog.js ---
  '{id} (нет плагина)': '{id} (plugin missing)',
  'Свои настройки': 'Custom settings',
  'Задано пресетом': 'Set by the preset',
};
