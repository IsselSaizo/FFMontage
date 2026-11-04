// Панель плагина: живая статистика проекта и заметка, которая хранится в storage плагина.
import { stats, fmt } from './stats.js';

const ru = ffm.lang === 'ru';
const L = ru
  ? { video: 'Видеоклипов', audio: 'Звуковых клипов', media: 'Файлов в медиатеке', len: 'Длина ролика', note: 'Заметка к проекту…', saved: 'Заметка сохраняется сама.' }
  : { video: 'Video clips', audio: 'Audio clips', media: 'Media files', len: 'Video length', note: 'Project note…', saved: 'The note is saved automatically.' };

const box = document.getElementById('stats');
const note = document.getElementById('note');
note.placeholder = L.note;
document.getElementById('hint').textContent = L.saved;

function draw(project) {
  const s = stats(project);
  box.innerHTML = '';
  for (const [k, v] of [[L.video, s.videoClips], [L.audio, s.audioClips], [L.media, s.media], [L.len, fmt(s.duration)]]) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(Object.assign(document.createElement('span'), { textContent: k }), Object.assign(document.createElement('b'), { textContent: String(v) }));
    box.append(row);
  }
}

draw(await ffm.project.get());
ffm.project.subscribe(draw);

const data = await ffm.storage.get();
note.value = data.note || '';
let timer = 0;
note.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => ffm.storage.set({ ...data, note: note.value }), 500);
});

ffm.ready();
