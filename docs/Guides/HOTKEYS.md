# Горячие клавиши FF Montage

<!-- Файл создан tools/hotkeys-doc.mjs из src/renderer/js/keymap.js и keymapPresets.js. Не править вручную: -->
<!-- после изменения клавиш выполните `node tools/hotkeys-doc.mjs` (CI проверяет, что файл свежий). -->

Пресет выбирается в окне настроек: **Настройки → Горячие клавиши** (там же можно назначить свои клавиши,
найти конфликты, экспортировать и импортировать JSON). В таблице — клавиши пресетов без ваших изменений.

- Сочетания привязаны к физическим клавишам, поэтому работают в любой раскладке (S — это клавиша S и в русской раскладке).
- ¹ — действие работает и во время ввода текста.
- «—» — в этом пресете у действия клавиши нет.
- Пресеты Resolve, Premiere Pro и CapCut собраны по памяти и ещё сверяются с самими программами.
- Действия плагинов и пресеты из плагинов здесь не показаны — они видны в настройках, когда плагин включён.

## Файл

| Действие | Родные | DaVinci Resolve | Premiere Pro | CapCut |
|---|---|---|---|---|
| Новый проект ¹ | <kbd>Ctrl+N</kbd> | <kbd>Ctrl+N</kbd> | <kbd>Ctrl+Alt+N</kbd> | <kbd>Ctrl+N</kbd> |
| Открыть проект… ¹ | <kbd>Ctrl+O</kbd> | <kbd>Ctrl+O</kbd> | <kbd>Ctrl+O</kbd> | <kbd>Ctrl+O</kbd> |
| Сохранить ¹ | <kbd>Ctrl+S</kbd> | <kbd>Ctrl+S</kbd> | <kbd>Ctrl+S</kbd> | <kbd>Ctrl+S</kbd> |
| Сохранить как… ¹ | <kbd>Ctrl+Shift+S</kbd> | <kbd>Ctrl+Shift+S</kbd> | <kbd>Ctrl+Shift+S</kbd> | <kbd>Ctrl+Shift+S</kbd> |
| Импорт медиа… ¹ | <kbd>Ctrl+I</kbd> | <kbd>Ctrl+I</kbd> | <kbd>Ctrl+I</kbd> | <kbd>Ctrl+I</kbd> |
| Экспорт ¹ | <kbd>Ctrl+E</kbd> | <kbd>Ctrl+E</kbd> | <kbd>Ctrl+M</kbd> | <kbd>Ctrl+E</kbd> |
| Настройки ¹ | <kbd>Ctrl+,</kbd> | <kbd>Ctrl+,</kbd> | <kbd>Ctrl+,</kbd> | <kbd>Ctrl+,</kbd> |

## Правка

| Действие | Родные | DaVinci Resolve | Premiere Pro | CapCut |
|---|---|---|---|---|
| Отменить | <kbd>Ctrl+Z</kbd> | <kbd>Ctrl+Z</kbd> | <kbd>Ctrl+Z</kbd> | <kbd>Ctrl+Z</kbd> |
| Повторить | <kbd>Ctrl+Y</kbd> <kbd>Ctrl+Shift+Z</kbd> | <kbd>Ctrl+Shift+Z</kbd> | <kbd>Ctrl+Shift+Z</kbd> | <kbd>Ctrl+Shift+Z</kbd> |
| Копировать клип | <kbd>Ctrl+C</kbd> | <kbd>Ctrl+C</kbd> | <kbd>Ctrl+C</kbd> | <kbd>Ctrl+C</kbd> |
| Вставить клип | <kbd>Ctrl+V</kbd> | <kbd>Ctrl+V</kbd> | <kbd>Ctrl+V</kbd> | <kbd>Ctrl+V</kbd> |
| Дублировать клип | <kbd>Ctrl+D</kbd> | — | — | <kbd>Ctrl+D</kbd> |
| Удалить | <kbd>Del</kbd> <kbd>Backspace</kbd> | <kbd>Backspace</kbd> | <kbd>Del</kbd> <kbd>Backspace</kbd> | <kbd>Del</kbd> <kbd>Backspace</kbd> |
| Удалить и сдвинуть | <kbd>Shift+Del</kbd> <kbd>Shift+Backspace</kbd> | <kbd>Del</kbd> <kbd>Shift+Backspace</kbd> | <kbd>Shift+Del</kbd> <kbd>Shift+Backspace</kbd> | — |
| Разрезать по курсору | <kbd>S</kbd> | <kbd>Ctrl+B</kbd> <kbd>Ctrl+&#92;</kbd> | <kbd>Ctrl+K</kbd> | <kbd>Ctrl+B</kbd> |
| Разрезать всё под курсором (видео и звук) | <kbd>Alt+S</kbd> | <kbd>Ctrl+Shift+B</kbd> | <kbd>Ctrl+Shift+K</kbd> | — |
| Стоп-кадр | <kbd>F</kbd> | <kbd>Shift+R</kbd> | — | — |
| Отзеркалить (задом наперёд) | <kbd>R</kbd> | — | — | — |
| Обрезать начало до курсора со сдвигом | <kbd>Q</kbd> | <kbd>Ctrl+Shift+[</kbd> | <kbd>Q</kbd> | <kbd>Q</kbd> |
| Обрезать конец до курсора со сдвигом | <kbd>W</kbd> | <kbd>Ctrl+Shift+]</kbd> | <kbd>W</kbd> | <kbd>W</kbd> |
| Обрезать начало до курсора | <kbd>Shift+Q</kbd> | <kbd>Shift+[</kbd> | <kbd>Shift+Q</kbd> | <kbd>Shift+Q</kbd> |
| Обрезать конец до курсора | <kbd>Shift+W</kbd> | <kbd>Shift+]</kbd> | <kbd>Shift+W</kbd> | <kbd>Shift+W</kbd> |
| Удалить паузы в клипе… | — | — | — | — |
| Метка In | <kbd>I</kbd> | <kbd>I</kbd> | <kbd>I</kbd> | <kbd>I</kbd> |
| Метка Out | <kbd>O</kbd> | <kbd>O</kbd> | <kbd>O</kbd> | <kbd>O</kbd> |
| Метки по клипу под курсором | <kbd>X</kbd> | <kbd>X</kbd> | <kbd>X</kbd> | <kbd>X</kbd> |
| Убрать метки In / Out | <kbd>Alt+X</kbd> | <kbd>Alt+X</kbd> | <kbd>Ctrl+Shift+X</kbd> | <kbd>Alt+X</kbd> |
| Lift: убрать In–Out, оставить пустоту | <kbd>;</kbd> | — | <kbd>;</kbd> | <kbd>;</kbd> |
| Extract: убрать In–Out со сдвигом | <kbd>'</kbd> | — | <kbd>'</kbd> | <kbd>'</kbd> |

## Инструменты

| Действие | Родные | DaVinci Resolve | Premiere Pro | CapCut |
|---|---|---|---|---|
| Выделение | <kbd>A</kbd> | <kbd>A</kbd> | <kbd>V</kbd> | <kbd>A</kbd> |
| Лезвие | <kbd>B</kbd> | <kbd>B</kbd> | <kbd>C</kbd> | <kbd>B</kbd> |
| Обрезка (ripple, roll, slip, slide) | <kbd>T</kbd> | <kbd>T</kbd> | <kbd>B</kbd> | <kbd>T</kbd> |
| Магнит (привязка) | — | <kbd>N</kbd> | <kbd>S</kbd> | <kbd>N</kbd> |

## Воспроизведение

| Действие | Родные | DaVinci Resolve | Premiere Pro | CapCut |
|---|---|---|---|---|
| К метке In | <kbd>Shift+I</kbd> | <kbd>Shift+I</kbd> | <kbd>Shift+I</kbd> | <kbd>Shift+I</kbd> |
| К метке Out | <kbd>Shift+O</kbd> | <kbd>Shift+O</kbd> | <kbd>Shift+O</kbd> | <kbd>Shift+O</kbd> |
| Пуск / пауза | <kbd>Пробел</kbd> | <kbd>Пробел</kbd> | <kbd>Пробел</kbd> | <kbd>Пробел</kbd> |
| Шаттл назад (ещё раз — быстрее) | <kbd>J</kbd> | <kbd>J</kbd> | <kbd>J</kbd> | <kbd>J</kbd> |
| Шаттл: стоп (держать + J / L — по кадру) | <kbd>K</kbd> | <kbd>K</kbd> | <kbd>K</kbd> | <kbd>K</kbd> |
| Шаттл вперёд (ещё раз — быстрее) | <kbd>L</kbd> | <kbd>L</kbd> | <kbd>L</kbd> | <kbd>L</kbd> |
| На кадр назад | <kbd>←</kbd> | <kbd>←</kbd> | <kbd>←</kbd> | <kbd>←</kbd> |
| На кадр вперёд | <kbd>→</kbd> | <kbd>→</kbd> | <kbd>→</kbd> | <kbd>→</kbd> |
| На 1 с назад | <kbd>Shift+←</kbd> | <kbd>Shift+←</kbd> | <kbd>Shift+←</kbd> | <kbd>Shift+←</kbd> |
| На 1 с вперёд | <kbd>Shift+→</kbd> | <kbd>Shift+→</kbd> | <kbd>Shift+→</kbd> | <kbd>Shift+→</kbd> |
| На 5 с назад | <kbd>Ctrl+←</kbd> | <kbd>Ctrl+←</kbd> | <kbd>Ctrl+←</kbd> | — |
| На 5 с вперёд | <kbd>Ctrl+→</kbd> | <kbd>Ctrl+→</kbd> | <kbd>Ctrl+→</kbd> | — |
| В начало | <kbd>Home</kbd> | <kbd>Home</kbd> | <kbd>Home</kbd> | <kbd>Home</kbd> |
| В конец | <kbd>End</kbd> | <kbd>End</kbd> | <kbd>End</kbd> | <kbd>End</kbd> |

## Вид

| Действие | Родные | DaVinci Resolve | Premiere Pro | CapCut |
|---|---|---|---|---|
| Плеер во весь экран | <kbd>Shift+F</kbd> | <kbd>Ctrl+F</kbd> | <kbd>Ctrl+&#96;</kbd> | <kbd>Ctrl+Shift+F</kbd> |
| Приблизить таймлайн | <kbd>Ctrl+=</kbd> <kbd>Ctrl+Num +</kbd> | <kbd>Ctrl+=</kbd> <kbd>Ctrl+Num +</kbd> | <kbd>=</kbd> | <kbd>Ctrl+=</kbd> <kbd>Ctrl+Num +</kbd> |
| Отдалить таймлайн | <kbd>Ctrl+-</kbd> <kbd>Ctrl+Num −</kbd> | <kbd>Ctrl+-</kbd> <kbd>Ctrl+Num −</kbd> | <kbd>-</kbd> | <kbd>Ctrl+-</kbd> <kbd>Ctrl+Num −</kbd> |
| Весь проект на таймлайне | <kbd>Ctrl+0</kbd> <kbd>Ctrl+Num 0</kbd> | <kbd>Shift+Z</kbd> | <kbd>&#92;</kbd> | <kbd>Shift+Z</kbd> |
