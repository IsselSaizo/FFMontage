// Действия «Раскладка: …» (палитра команд и клавиши) — в скрытой песочнице плагина
import { applyLayout } from './apply.js';
import { layoutById } from './layouts.js';

ffm.on('action', async ({ id }) => {
  if (layoutById(id)) await applyLayout(id);
});

ffm.ready();
