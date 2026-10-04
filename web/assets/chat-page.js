(async () => {
  const status = document.getElementById('status');
  const slug = location.pathname.split('/').filter(Boolean)[1];
  try {
    const res = await fetch(`/api/v1/hosted/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error();
    const { key, name } = await res.json();
    document.title = `Chat – ${name}`;
    const s = document.createElement('script');
    s.src = '/widget.js';
    s.dataset.botId = key;
    s.dataset.mode = 'page';
    s.onload = () => status.remove();
    document.body.appendChild(s);
  } catch {
    status.textContent = 'Diesen Chat gibt es nicht (mehr). Bitte prüfen Sie den Link.';
  }
})();
