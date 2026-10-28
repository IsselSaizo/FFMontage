// Проверка кнопки «Проверить обновления»: только проверка (git fetch), без pull.
(async () => {
  for (let i = 0; i < 50 && !window.__ffm; i++) await new Promise((r) => setTimeout(r, 100));
  try { return { log: [JSON.stringify(await window.api.updateCheck())] }; } catch (e) { return { error: String(e) }; }
})();
