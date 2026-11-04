# Встроенные шрифты (решение D5)

| Шрифт | Файлы | Лицензия | Источник |
|---|---|---|---|
| Inter 4.1 | `Inter/InterVariable.ttf`, `InterVariable-Italic.ttf` | SIL OFL 1.1 (`Inter/LICENSE.txt`) | https://github.com/rsms/inter |
| Open Sans | `OpenSans/OpenSans-Variable.ttf`, `OpenSans-Italic-Variable.ttf` | SIL OFL 1.1 (`OpenSans/OFL.txt`) | https://github.com/googlefonts/opensans |

Оба шрифта вариативные (насыщенность, у Open Sans ещё ширина), с кириллицей.
Пока не встраиваются в программу: подключаются вместе с текстовыми клипами (M5.2) — тогда копируются в
`src/renderer/assets/fonts/` и регистрируются через `@font-face`, а для экспорта титров (решение D2) используются при отрисовке на canvas.