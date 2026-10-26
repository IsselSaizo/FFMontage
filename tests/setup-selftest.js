// Тест окна первого запуска: что предложено, найден ли FFmpeg; при FFM_SAVE=1 — нажать «Сохранить».
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50 && !window.__setup; i++) await sleep(100);
  for (let i = 0; i < 150; i++) {
    const t = [...document.querySelectorAll('.ff-status')].map((e) => e.textContent).join(' ');
    if (/NVIDIA|процессоре|✗/.test(t)) break;
    await sleep(100);
  }
  const values = [...document.querySelectorAll('.setup-row .input')].map((i) => i.value);
  const status = [...document.querySelectorAll('.ff-status')].map((e) => e.textContent);
  let saved = null;
  if (window.__ffmSave) {
    window.__setup.save.click();
    await sleep(800);
    saved = document.querySelector('.setup-error').textContent || 'ok';
  }
  return { title: document.querySelector('h1').textContent, values, status, saved };
})();
