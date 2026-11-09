// Встроенные виды графических клипов (реестр — graphics.js): импорт этого модуля регистрирует их модели
// (текст, фигура, таймер). Код, которому нужно isGraphic / graphicOf, импортирует их отсюда — тогда виды уже известны.
import './textModel.js';
import './shapes.js';
import './timer.js';

export * from './graphics.js';
