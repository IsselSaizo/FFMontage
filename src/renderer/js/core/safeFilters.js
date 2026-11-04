// Фильтры FFmpeg, которые можно использовать в графе экспорта (ядро и плагины).
// Один список на JS и Rust: src-tauri/src/plugins.rs читает его через include_str! — между маркерами
// BEGIN-FILTERS / END-FILTERS, по одному имени в одинарных кавычках. Не меняйте формат.
// Здесь нет фильтров, которые читают или пишут файлы, ходят в сеть или грузят библиотеки
// (movie, amovie, subtitles, ass, lut3d, sendcmd, zmq, ladspa, lv2, frei0r, arnndn, sofalizer, drawtext …).
// BEGIN-FILTERS
export const SAFE_FILTERS = [
  // ядро: сборка таймлайна
  'setpts', 'asetpts', 'fps', 'scale', 'crop', 'pad', 'setsar', 'format', 'tpad', 'trim', 'atrim', 'fade', 'afade',
  'xfade', 'color', 'concat', 'overlay', 'aresample', 'aformat', 'atempo', 'volume', 'apad', 'adelay', 'amix',
  'alimiter', 'anullsrc', 'split', 'asplit', 'null', 'anull', 'loop', 'rotate', 'hflip', 'vflip', 'transpose',
  // видеоэффекты
  'hue', 'colorchannelmixer', 'negate', 'eq', 'gblur', 'boxblur', 'avgblur', 'smartblur', 'dblur', 'unsharp',
  'vignette', 'colorbalance', 'colorlevels', 'colorcontrast', 'colorcorrect', 'colortemperature', 'colorize',
  'exposure', 'monochrome', 'vibrance', 'curves', 'selectivecolor', 'lut', 'lutrgb', 'lutyuv', 'geq', 'noise',
  'chromakey', 'colorkey', 'hsvkey', 'edgedetect', 'sobel', 'kirsch', 'convolution', 'rgbashift', 'chromashift',
  'deband', 'deflicker', 'hqdn3d', 'nlmeans', 'atadenoise', 'gradfun', 'pixelize', 'tmix', 'lagfun', 'swaprect',
  'fillborders', 'drawbox', 'drawgrid', 'lenscorrection', 'perspective', 'zoompan', 'vaguedenoiser', 'grayworld',
  'huesaturation', 'tblend', 'blend', 'alphamerge', 'premultiply', 'unpremultiply', 'setparams',
  // аудиоэффекты
  'bass', 'treble', 'equalizer', 'acompressor', 'afftdn', 'highpass', 'lowpass', 'bandpass', 'bandreject',
  'allpass', 'lowshelf', 'highshelf', 'aecho', 'chorus', 'flanger', 'aphaser', 'tremolo', 'vibrato', 'compand',
  'dynaudnorm', 'loudnorm', 'speechnorm', 'asubboost', 'crystalizer', 'extrastereo', 'stereotools', 'stereowiden',
  'pan', 'channelmap', 'earwax', 'afreqshift', 'aphaseshift', 'rubberband', 'superequalizer', 'anequalizer',
  'firequalizer', 'agate', 'adeclick', 'adeclip', 'anlmdn', 'deesser', 'acrusher', 'asoftclip', 'aexciter',
  'apulsator', 'haas', 'bs2b', 'dialoguenhance', 'virtualbass', 'adynamicequalizer', 'acontrast', 'aemphasis',
  'silenceremove', 'areverse', 'reverse',
];
// END-FILTERS

/** Имена параметров фильтров, которые никогда не пропускаются (файлы, модели, команды) */
export const FORBIDDEN_OPTION = /file|^filename$|^model$|^sofa$|^url$|^commands?$/i;

export const isSafeFilter = (name) => SAFE_FILTERS.includes(name);
