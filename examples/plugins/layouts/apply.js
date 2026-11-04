// Применение раскладки через инструменты программы (общая часть main.js и panel.js)
import { planLayout, layoutById } from './layouts.js';

const ru = () => ffm.lang === 'ru';
const MSG = {
  'nothing': ['Под курсором нет видеоклипов.', 'There are no video clips under the playhead.'],
  'need-more': ['Нужно два клипа под курсором на разных видеодорожках: добавьте дорожку «+ Видео» и положите на неё второй клип.',
    'Two clips under the playhead on different video tracks are needed: add a track with “+ Video” and put the second clip on it.'],
  'unknown-layout': ['Неизвестная раскладка.', 'Unknown layout.'],
};

export async function applyLayout(id) {
  const project = await ffm.tools.call('get_project');
  const plan = planLayout(project, id);
  const L = layoutById(id);
  if (plan.error) { await ffm.ui.notify(MSG[plan.error][ru() ? 0 : 1], 'error'); return plan; }
  // Каждый клип — отдельный вызов set_transform (у каждого свой слот)
  for (const c of plan.calls) await ffm.tools.call('set_transform', c);
  const name = L ? (ru() ? L.ru : L.en) : id;
  const extra = plan.skipped ? (ru() ? ` (с замком пропущено: ${plan.skipped})` : ` (locked, skipped: ${plan.skipped})`) : '';
  await ffm.ui.notify(`${name}: ${plan.calls.length}${extra}`);
  return plan;
}
