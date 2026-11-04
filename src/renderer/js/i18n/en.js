// Английский словарь: русская строка → перевод. Разбит по частям интерфейса, чтобы правки не мешали друг другу.
import core from './en/core.js';
import timeline from './en/timeline.js';
import clip from './en/clip.js';
import panels from './en/panels.js';
import mcp from './en/mcp.js';

export const EN = Object.assign({}, core, timeline, clip, panels, mcp);
