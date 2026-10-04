// Klingelschild: Klick auf eine Klingel öffnet den Assistenten des jeweiligen Demo-Betriebs.
document.querySelectorAll('.bell').forEach((bell) => {
  bell.addEventListener('click', () => {
    if (!window.EmpfangKI) return;
    document.querySelectorAll('.bell').forEach((b) => b.setAttribute('aria-pressed', String(b === bell)));
    window.EmpfangKI.use(bell.dataset.key, { open: true });
  });
});
