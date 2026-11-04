# Встроенные шрифты (решение D5)

| Шрифт | Файлы | Лицензия | Источник |
|---|---|---|---|
| Inter 4.1 | `Inter/InterVariable.ttf`, `InterVariable-Italic.ttf` | SIL OFL 1.1 (`Inter/LICENSE.txt`) | https://github.com/rsms/inter |
| Open Sans | `OpenSans/OpenSans-Variable.ttf`, `OpenSans-Italic-Variable.ttf` | SIL OFL 1.1 (`OpenSans/OFL.txt`) | https://github.com/googlefonts/opensans |

Оба шрифта вариативные (насыщенность, у Open Sans ещё ширина), с кириллицей.

**Встроены с M5.2.** Копии лежат в `src/renderer/assets/fonts/` (`Inter.ttf`, `Inter-Italic.ttf`, `OpenSans.ttf`,
`OpenSans-Italic.ttf` + лицензии) и попадают в exe вместе с интерфейсом:
- в окне — `@font-face` в `styles.css` (семейства `Inter` и `Open Sans`); текст рисуется на canvas и в плеере, и в PNG для экспорта (D2);
- для субтитров libass (`fonts_export_dir`, `src-tauri/src/fonts.rs`) файлы выкладываются в `<кэш>/fonts`.
  Настоящее имя семейства Inter в файле — «Inter Variable»: его пишем в `Fontname` стиля `.ass` (`js/fonts.js` → `fontFile()`).

Эта папка — исходники (как скачаны). Обновили шрифт — скопируйте файлы в `src/renderer/assets/fonts/` под теми же короткими именами.
