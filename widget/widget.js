/*!
 * Empfang KI – einbettbares Chat-Widget
 * Einbindung:
 *   <script src="https://IHRE-DOMAIN/widget.js" data-bot-id="pk_..." defer></script>
 * Optionen (data-Attribute): data-open="true" (sofort öffnen), data-mode="page" (Vollbild, für /c/<slug>)
 * JS-API: window.EmpfangKI.open(), .close(), .use("pk_...") – z. B. für Demo-Seiten
 */
(function () {
  'use strict';
  if (window.EmpfangKI && window.EmpfangKI.__loaded) return;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var BASE = script ? new URL(script.src, location.href).origin : location.origin;
  var MODE = (script && script.getAttribute('data-mode')) || 'bubble';

  var state = { key: null, cfg: null, conversationId: null, busy: false, open: false, started: false };

  // ---------- kleine Helfer ----------
  function store(kind) {
    try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { return null; }
  }
  function sget(kind, k) { var s = store(kind); try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function sset(kind, k, v) { var s = store(kind); try { if (s) s.setItem(k, v); } catch (e) { /* privat-Modus */ } }

  // Zufällige Kennung nur für diese Browser-Sitzung (wird beim Schließen des Tabs gelöscht)
  var visitorId = sget('session', 'ek_vid');
  if (!visitorId) { visitorId = Math.random().toString(36).slice(2) + Date.now().toString(36); sset('session', 'ek_vid', visitorId); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  // Minimal-Markdown: **fett**, Links, Telefonnummern, Aufzählungen, Zeilenumbrüche
  function render(text) {
    var html = esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)((?:\+49|0)\d[\d /-]{5,}\d)/g, function (m, pre, num) {
        return pre + '<a href="tel:' + num.replace(/[^\d+]/g, '') + '">' + num + '</a>';
      });
    var lines = html.split('\n');
    var out = [];
    var inList = false;
    lines.forEach(function (l) {
      var m = l.match(/^\s*(?:[-•*]|\d+\.)\s+(.*)/);
      if (m) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + m[1] + '</li>'); return; }
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(l === '' ? '<br>' : l + '<br>');
    });
    if (inList) out.push('</ul>');
    return out.join('').replace(/(<br>)+$/, '').replace(/(<br>){3,}/g, '<br><br>');
  }

  function contrastText(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#14213d' : '#ffffff';
  }

  // ---------- DOM im Shadow Root (keine Konflikte mit dem CSS der Website) ----------
  var host = document.createElement('div');
  host.id = 'empfang-ki';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.ek{--c:#1f4e79;--ct:#fff;--ink:#14213d;--muted:#5b6475;--line:#e3e6ea;--bg:#f6f7f5;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}',
    '.launcher{position:fixed;bottom:20px;right:20px;z-index:2147483000;display:flex;align-items:center;gap:10px;height:56px;padding:0 20px 0 16px;border:0;border-radius:28px;background:var(--c);color:var(--ct);font-weight:600;font-size:15px;line-height:1;font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(20,33,61,.25),0 1px 3px rgba(20,33,61,.2);transition:transform .15s ease}',
    '.launcher:hover{transform:translateY(-2px)}',
    '.launcher:focus-visible,.ek button:focus-visible,.ek a:focus-visible{outline:3px solid #f2b705;outline-offset:2px}',
    '.form:focus-within{box-shadow:inset 0 2px 0 var(--c)}',
    '.launcher .i-x{display:none}.launcher.is-open .i-chat,.launcher.is-open .l-text{display:none}.launcher.is-open .i-x{display:block}.launcher.is-open{width:56px;padding:0;justify-content:center}',
    '.page .close{display:none}',
    '.launcher svg{width:24px;height:24px;flex:none;display:block}',
    '.left .launcher{right:auto;left:20px}',
    '.panel{position:fixed;bottom:88px;right:20px;z-index:2147483001;width:380px;max-width:calc(100vw - 32px);height:min(620px,calc(100vh - 110px));display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(20,33,61,.28),0 2px 6px rgba(20,33,61,.12);transform-origin:bottom right;animation:ek-in .18s ease-out}',
    '.left .panel{right:auto;left:20px;transform-origin:bottom left}',
    '@keyframes ek-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}',
    '.hidden{display:none!important}',
    '.head{display:flex;align-items:center;gap:12px;padding:14px 14px 14px 16px;background:var(--c);color:var(--ct)}',
    '.avatar{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.18);font-weight:700;flex:none}',
    '.title{flex:1;min-width:0}',
    '.title b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.title span{display:flex;align-items:center;gap:6px;font-size:12.5px;opacity:.85}',
    '.title span:before{content:"";width:7px;height:7px;border-radius:50%;background:#4ade80}',
    '.icon-btn{width:36px;height:36px;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer;display:grid;place-items:center}',
    '.icon-btn:hover{background:rgba(255,255,255,.15)}',
    '.icon-btn svg{width:20px;height:20px}',
    '.log{flex:1;overflow-y:auto;padding:16px;background:var(--bg);display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}',
    '.msg{max-width:86%;padding:10px 13px;border-radius:14px;word-wrap:break-word;overflow-wrap:anywhere}',
    '.msg.bot{align-self:flex-start;background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}',
    '.msg.user{align-self:flex-end;background:var(--c);color:var(--ct);border-bottom-right-radius:4px}',
    '.msg.note{align-self:stretch;max-width:none;background:transparent;color:var(--muted);font-size:12.5px;text-align:center;padding:2px 8px}',
    '.msg.emergency{border:2px solid #c62828;background:#fff5f5}',
    '.msg.error{background:#fff7e6;border:1px solid #f0c36d}',
    '.msg ul{margin:4px 0;padding-left:18px}',
    '.msg a{color:inherit;text-decoration:underline}',
    '.lead-ok{align-self:flex-start;display:flex;align-items:center;gap:8px;font-size:13px;color:#1b6e3a;background:#e8f6ee;border-radius:10px;padding:6px 10px}',
    '.typing{display:inline-flex;gap:4px;padding:4px 0}',
    '.typing i{width:7px;height:7px;border-radius:50%;background:#9aa3b2;animation:ek-dot 1.2s infinite}',
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes ek-dot{0%,60%,100%{opacity:.3;transform:none}30%{opacity:1;transform:translateY(-3px)}}',
    '.chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px;background:var(--bg)}',
    '.chip{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:18px;padding:7px 13px;font-weight:500;font-size:13.5px;line-height:1.2;font-family:inherit;cursor:pointer}',
    '.chip:hover{background:var(--c);color:var(--ct)}',
    '.form{display:flex;align-items:flex-end;gap:8px;padding:10px 10px 10px 14px;border-top:1px solid var(--line);background:#fff}',
    'textarea{flex:1;resize:none;border:0;outline:0;font:inherit;color:var(--ink);max-height:120px;padding:9px 0;background:transparent}',
    'textarea::placeholder{color:#8a93a3}',
    '.send{width:42px;height:42px;border:0;border-radius:12px;background:var(--c);color:var(--ct);cursor:pointer;display:grid;place-items:center;flex:none}',
    '.send:disabled{opacity:.45;cursor:default}',
    '.send svg{width:20px;height:20px}',
    '.foot{padding:6px 14px 9px;font-size:11.5px;color:var(--muted);background:#fff;text-align:center}',
    '.foot a{color:inherit}',
    '.ek.page{height:100%}',
    '.page .launcher{display:none}',
    '.page .panel{position:static;width:100%;max-width:720px;height:100%;margin:0 auto;border-radius:0;box-shadow:none;animation:none}',
    '@media (max-width:520px){.panel{inset:0;width:100%;max-width:none;height:100%;border-radius:0}.launcher{bottom:16px;right:16px;width:56px;padding:0;justify-content:center}.launcher .l-text{display:none}.left .launcher{left:16px}}',
    '@media (prefers-reduced-motion:reduce){.panel,.typing i{animation:none}.launcher{transition:none}.log{scroll-behavior:auto}}',
  ].join('');

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  root.innerHTML =
    '<style>' + CSS + '</style>' +
    '<div class="ek">' +
    '<button class="launcher hidden" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Chat öffnen"><span class="i-chat">' + ICON_CHAT + '</span><span class="i-x">' + ICON_X + '</span><span class="l-text">Fragen? Chatten Sie mit uns</span></button>' +
    '<section class="panel hidden" role="dialog" aria-modal="false" aria-label="Chat">' +
    '<header class="head"><div class="avatar" aria-hidden="true"></div><div class="title"><b></b><span>KI-Assistent, antwortet sofort</span></div>' +
    '<button class="icon-btn reset" type="button" aria-label="Neues Gespräch" title="Neues Gespräch">' + ICON_NEW + '</button>' +
    '<button class="icon-btn close" type="button" aria-label="Chat schließen" title="Schließen">' + ICON_X + '</button></header>' +
    '<div class="log" role="log" aria-live="polite"></div>' +
    '<div class="chips"></div>' +
    '<form class="form"><label class="hidden" for="ek-input">Nachricht</label><textarea id="ek-input" rows="1" placeholder="Ihre Nachricht …" maxlength="1200"></textarea>' +
    '<button class="send" type="submit" aria-label="Senden" disabled>' + ICON_SEND + '</button></form>' +
    '<div class="foot"></div>' +
    '</section></div>';

  var $ = function (sel) { return root.querySelector(sel); };
  var wrap = $('.ek'), launcher = $('.launcher'), panel = $('.panel'), log = $('.log'), chips = $('.chips');
  var input = $('textarea'), send = $('.send'), form = $('.form');

  if (MODE === 'page') wrap.classList.add('page');

  function scroll() { log.scrollTop = log.scrollHeight; }

  function addMsg(role, text, extra) {
    var el = document.createElement('div');
    el.className = 'msg ' + role + (extra ? ' ' + extra : '');
    if (role === 'user' || role === 'note') el.textContent = text; else el.innerHTML = render(text);
    log.appendChild(el);
    scroll();
    return el;
  }

  function setChips(list) {
    chips.innerHTML = '';
    (list || []).slice(0, 4).forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = t;
      b.addEventListener('click', function () { submit(t); });
      chips.appendChild(b);
    });
    chips.classList.toggle('hidden', !list || !list.length);
  }

  function applyConfig(cfg) {
    var color = /^#[0-9a-f]{3,6}$/i.test(cfg.color || '') ? cfg.color : '#1f4e79';
    wrap.style.setProperty('--c', color);
    wrap.style.setProperty('--ct', contrastText(color));
    wrap.classList.toggle('left', cfg.position === 'left');
    $('.title b').textContent = cfg.name;
    $('.avatar').textContent = (cfg.name || '?').trim().charAt(0).toUpperCase();
    panel.setAttribute('aria-label', 'Chat mit ' + cfg.name);
    var foot = 'KI-Assistent von ' + esc(cfg.name) + '. Antworten können Fehler enthalten.';
    if (cfg.privacyUrl) foot += ' <a href="' + esc(cfg.privacyUrl) + '" target="_blank" rel="noopener">Datenschutz</a>';
    $('.foot').innerHTML = foot;
  }

  function startConversation() {
    log.innerHTML = '';
    state.conversationId = null;
    addMsg('bot', state.cfg.greeting);
    setChips(state.cfg.quickReplies);
    state.started = true;
  }

  // ---------- Senden & Streaming (Server-Sent Events über fetch) ----------
  function submit(text) {
    text = String(text || '').trim();
    if (!text || state.busy || !state.key) return;
    state.busy = true;
    send.disabled = true;
    setChips(null);
    addMsg('user', text);
    input.value = '';
    autosize();

    var bubble = addMsg('bot', '');
    bubble.innerHTML = '<span class="typing" aria-label="Schreibt"><i></i><i></i><i></i></span>';
    var answer = '';

    fetch(BASE + '/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: state.key, conversationId: state.conversationId, visitorId: visitorId, message: text }),
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.message || 'Der Chat ist gerade nicht erreichbar.');
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buffer += decoder.decode(r.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();
          parts.forEach(function (block) {
            var ev = 'message', data = '';
            block.split('\n').forEach(function (line) {
              if (line.indexOf('event: ') === 0) ev = line.slice(7);
              else if (line.indexOf('data: ') === 0) data += line.slice(6);
            });
            var d = {};
            try { d = JSON.parse(data || '{}'); } catch (e) { /* ignorieren */ }
            if (ev === 'meta') {
              state.conversationId = d.conversationId;
              sset('session', 'ek_cid_' + state.key, d.conversationId);
            } else if (ev === 'delta') {
              answer += d.text;
              bubble.innerHTML = render(answer);
              scroll();
            } else if (ev === 'emergency') {
              bubble.classList.add('emergency');
            } else if (ev === 'lead') {
              var ok = document.createElement('div');
              ok.className = 'lead-ok';
              ok.textContent = '✓ Anfrage an das Team übermittelt';
              log.insertBefore(ok, bubble.nextSibling);
            } else if (ev === 'error') {
              answer = d.message || 'Es ist ein Fehler aufgetreten.';
              bubble.classList.add('error');
              bubble.innerHTML = render(answer);
            }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      bubble.classList.add('error');
      bubble.innerHTML = render(err.message || 'Verbindung fehlgeschlagen. Bitte versuchen Sie es erneut.');
    }).then(function () {
      if (!answer && !bubble.classList.contains('error')) bubble.remove();
      state.busy = false;
      send.disabled = !input.value.trim();
      scroll();
      if (MODE === 'page' || state.open) input.focus();
    });
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); submit(input.value); });
  input.addEventListener('input', function () { autosize(); send.disabled = state.busy || !input.value.trim(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); }
  });

  function open() {
    if (!state.cfg) return;
    if (!state.started) startConversation();
    state.open = true;
    panel.classList.remove('hidden');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.setAttribute('aria-label', 'Chat schließen');
    launcher.classList.add('is-open');
    if (window.innerWidth <= 520) launcher.classList.add('hidden');
    setTimeout(function () { input.focus(); }, 50);
  }
  function close() {
    if (MODE === 'page') return;
    state.open = false;
    panel.classList.add('hidden');
    launcher.classList.remove('hidden');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Chat öffnen');
    launcher.classList.remove('is-open');
    launcher.focus();
  }

  launcher.addEventListener('click', function () { state.open ? close() : open(); });
  $('.close').addEventListener('click', close);
  $('.reset').addEventListener('click', function () { if (!state.busy) { startConversation(); input.focus(); } });
  root.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  /** Lädt die Konfiguration eines Unternehmens (Public Key) und setzt das Widget zurück. */
  function use(key, opts) {
    opts = opts || {};
    return fetch(BASE + '/api/v1/widget/config?key=' + encodeURIComponent(key))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (cfg) {
        state.key = key;
        state.cfg = cfg;
        state.started = false;
        applyConfig(cfg);
        if (MODE === 'page') { panel.classList.remove('hidden'); startConversation(); }
        else launcher.classList.remove('hidden');
        if (opts.open) open();
      })
      .catch(function () {
        if (window.console) console.warn('[Empfang KI] Widget konnte nicht geladen werden (Key oder Domain nicht freigeschaltet).');
      });
  }

  function mount() {
    document.body.appendChild(host);
    var key = script && script.getAttribute('data-bot-id');
    if (key) use(key, { open: script.getAttribute('data-open') === 'true' });
  }

  window.EmpfangKI = { __loaded: true, open: open, close: close, use: use };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
