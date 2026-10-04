// Buttons mit data-open-chat öffnen den Assistenten
document.querySelectorAll('[data-open-chat]').forEach((el) =>
  el.addEventListener('click', (e) => { e.preventDefault(); window.EmpfangKI && window.EmpfangKI.open(); }));
