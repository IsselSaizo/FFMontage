// Английский словарь: русская строка → перевод. Разбит по частям интерфейса, чтобы правки не мешали друг другу.
import core from './en/core.js';
import timeline from './en/timeline.js';
import clip from './en/clip.js';
import panels from './en/panels.js';
import mcp from './en/mcp.js';
import plugins from './en/plugins.js';
import fxcore from './en/fxcore.js';
import text from './en/text.js';
import vst from './en/vst.js';

export const EN = Object.assign({}, core, timeline, clip, panels, mcp, plugins, fxcore, text, vst);
