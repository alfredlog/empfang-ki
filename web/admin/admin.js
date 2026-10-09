// Admin-Oberfläche: Kunden anlegen, Wissen importieren, Anfragen bearbeiten, Bot testen.
(() => {
  'use strict';

  // ------------------------------------------------------------ Helfer
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtDate = (d) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));
  const fmtNum = (n) => new Intl.NumberFormat('de-DE').format(n || 0);

  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* privat-Modus */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* privat-Modus */ } },
  };

  // Gleiche Oberfläche für zwei Rollen: "admin" (/admin, alle Kunden) und "portal" (/app, eigener Betrieb)
  const MODE = document.body.dataset.mode === 'portal' ? 'portal' : 'admin';
  const IS_ADMIN = MODE === 'admin';
  const API_BASE = IS_ADMIN ? '/api/admin' : '/api/portal';
  let token = IS_ADMIN ? store.get('ek_admin_token') : null;
  const state = { tenants: [], industries: [], plans: {}, current: null, tab: 'uebersicht', me: null };
  /** Pfad zu einem Kunden: Admin über die ID, Kunde immer nur der eigene Betrieb. */
  const T = (t) => (IS_ADMIN ? `/tenants/${typeof t === 'string' ? t : t.id}` : '/tenant');

  class ApiError extends Error {}

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(IS_ADMIN ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { showLogin(); throw new ApiError('Bitte erneut anmelden.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const issue = data.issues?.[0];
      throw new ApiError(data.message || (issue ? `Eingabe prüfen: ${issue.path?.join('.')} – ${issue.message}` : `Fehler ${res.status}`));
    }
    return data;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 2600);
  }

  async function copy(text, label = 'Kopiert') {
    try { await navigator.clipboard.writeText(text); toast(`${label} ✓`); } catch { toast('Kopieren nicht möglich – bitte manuell markieren.', true); }
  }

  /** Führt eine Aktion aus, sperrt dabei den Button und zeigt Fehler als Toast. */
  async function busy(btn, fn) {
    const old = btn?.textContent;
    if (btn) { btn.disabled = true; }
    try { return await fn(); } catch (err) { toast(err.message, true); return undefined; } finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
  }

  const KIND = {
    angebot: 'Angebot', rueckruf: 'Rückruf', termin: 'Termin', schaden: 'Schaden', miete: 'Miete', rezept: 'Rezept',
    erstanfrage: 'Erstanfrage', anfrage: 'Anfrage', offene_frage: 'Offene Frage', sonstiges: 'Sonstiges',
  };
  // Reine Datumswerte ('2027-01-04') ohne Zeitzonen-Verschiebung anzeigen
  const fmtDay = (d) => (d ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? 'UTC' : undefined }).format(new Date(d)) : '');
  /** Abrechnungsstatus → kurzer Text + Farbe */
  function billingBadge(b) {
    if (!b) return { text: '', cls: '' };
    if (b.status === 'trial') return { text: `Testphase bis ${fmtDay(b.trialEndsAt)}`, cls: 'warn' };
    if (b.status === 'active' && b.method === 'manual') return b.overdue ? { text: `Überfällig seit ${fmtDay(b.paidUntil)}`, cls: 'bad' } : { text: `Bezahlt bis ${fmtDay(b.paidUntil)}`, cls: 'ok' };
    if (b.status === 'active' && b.method === 'stripe') return { text: 'Stripe-Abo aktiv', cls: 'ok' };
    if (b.status === 'active') return { text: b.active ? 'Aktiv' : 'Ausgeschaltet', cls: b.active ? 'ok' : 'bad' };
    return {
      past_due: { text: 'Zahlung offen', cls: 'warn' },
      canceled: { text: 'Gekündigt / aus', cls: 'bad' },
      expired: { text: 'Testphase abgelaufen', cls: 'bad' },
      unpaid: { text: 'Unbezahlt', cls: 'bad' },
    }[b.status] || { text: b.status, cls: '' };
  }
  const listBilling = (t) => billingBadge({ status: t.billing_status, method: t.billing_method, trialEndsAt: t.trial_ends_at, paidUntil: t.paid_until, active: t.active,
    overdue: t.billing_method === 'manual' && t.paid_until && String(t.paid_until).slice(0, 10) < new Date().toISOString().slice(0, 10) });
  const sourceLabel = (s) => (s === 'manual' ? 'Eigener Text' : s === 'website' ? 'Website' : s === 'faq' ? 'Ergänzte Antworten' : s.startsWith('pdf:') ? `PDF: ${s.slice(4)}` : s);
  const industryLabel = (k) => state.industries.find((i) => i.key === k)?.label || k;
  const planLabel = (k) => { const p = state.plans[k]; return p ? `${p.label}${p.priceEur ? ` (${p.priceEur} €)` : ''}` : k; };

  // ------------------------------------------------------------ Anmeldung
  function showLogin(msg) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    const err = $('#login-error');
    err.textContent = msg || '';
    err.classList.toggle('hidden', !msg);
    $(IS_ADMIN ? '#token' : '#email').focus();
  }

  async function logout() {
    if (IS_ADMIN) { token = null; store.del('ek_admin_token'); }
    else { try { await fetch('/api/portal/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* offline */ } }
    showLogin();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (IS_ADMIN) {
      token = $('#token').value.trim();
      try {
        await api('/me');
        store.set('ek_admin_token', token);
        start();
      } catch {
        showLogin('Das Passwort stimmt nicht.');
      }
      return;
    }
    // Kunde: Magic Link anfordern
    const btn = $('#login-form button');
    btn.disabled = true;
    try {
      const res = await fetch('/api/portal/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('#email').value.trim(), next: `/app/${location.hash}` }),
      });
      if (!res.ok && res.status !== 429) throw new Error();
      $('#login-form').classList.add('hidden');
      $('#login-sent').classList.remove('hidden');
      $('#login-sent-mail').textContent = $('#email').value.trim();
    } catch {
      showLogin('Das hat nicht geklappt. Bitte prüfen Sie die E-Mail-Adresse und versuchen Sie es erneut.');
    } finally {
      btn.disabled = false;
    }
  });
  $('#logout').addEventListener('click', logout);
  $('#login-again')?.addEventListener('click', () => {
    $('#login-sent').classList.add('hidden');
    $('#login-form').classList.remove('hidden');
    showLogin();
  });

  // ------------------------------------------------------------ Start & Kundenliste
  async function start() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    try {
      const [me, industries, plans] = await Promise.all([api('/me'), api('/industries'), api('/plans')]);
      Object.assign(state, { me, industries, plans });
      const badge = $('#llm-badge');
      if (IS_ADMIN) {
        badge.textContent = me.llm === 'anthropic' ? 'Claude aktiv' : 'Demo-Modus (kein API-Key)';
        badge.classList.toggle('warn', me.llm !== 'anthropic');
      } else {
        badge.textContent = me.email;
        badge.classList.add('neutral');
        const tab = (location.hash.match(/^#(\w+)/) || [])[1];
        return openTenant(me.tenantId, tab);
      }
      await loadTenants();
      const fromHash = location.hash.match(/^#kunde\/([0-9a-f-]{36})(?:\/(\w+))?/);
      if (fromHash) openTenant(fromHash[1], fromHash[2]);
      else renderWelcome();
    } catch (err) {
      if (!(err instanceof ApiError)) showLogin('Server nicht erreichbar.');
    }
  }

  async function loadTenants() {
    if (!IS_ADMIN) return;
    state.tenants = await api('/tenants');
    renderTenantList();
  }

  // Gründerpreis: Ablauf = Start + 12 Monate
  function founderEnd(since) {
    const d = new Date(`${String(since).slice(0, 10)}T00:00:00Z`);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 12, d.getUTCDate()));
  }
  function founderDaysLeft(since) {
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    return Math.round((founderEnd(since) - today) / 864e5);
  }

  function renderTenantList() {
    if (!IS_ADMIN) return;
    const q = $('#tenant-filter').value.trim().toLowerCase();
    const list = state.tenants.filter((t) => !q || `${t.name} ${t.city || ''}`.toLowerCase().includes(q));
    const customers = list.filter((t) => t.plan !== 'demo');
    const demos = list.filter((t) => t.plan === 'demo');
    const item = (t) => `<li><button type="button" data-id="${t.id}" aria-current="${state.current?.id === t.id}">
        <span class="t-name">${esc(t.name)}${t.active ? '' : ' <span class="muted">(aus)</span>'}</span>
        <span class="t-meta">${t.plan === 'demo' ? `${esc(industryLabel(t.industry))}${t.city ? `, ${esc(t.city)}` : ''}` : `<span class="dot ${listBilling(t).cls}"></span>${esc(listBilling(t).text)}`}</span>
        ${t.founder_since && founderDaysLeft(t.founder_since) <= 45 ? `<span class="t-meta"><span class="dot ${founderDaysLeft(t.founder_since) <= 0 ? 'bad' : 'warn'}"></span>${founderDaysLeft(t.founder_since) <= 0 ? 'Gründerpreis abgelaufen' : `Gründerpreis endet in ${founderDaysLeft(t.founder_since)} T.`}</span>` : ''}
        ${t.new_leads ? `<span class="t-count" title="Neue Anfragen">${t.new_leads}</span>` : ''}
      </button></li>`;
    $('#tenant-list').innerHTML =
      (customers.length ? customers.map(item).join('') : '<li class="group">Noch keine Kunden</li>') +
      (demos.length ? `<li class="group">Demos</li>${demos.map(item).join('')}` : '');
  }

  $('#tenant-filter')?.addEventListener('input', renderTenantList);
  $('#tenant-list')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) openTenant(b.dataset.id);
  });
  $('#new-tenant-btn')?.addEventListener('click', renderNewTenant);

  function renderWelcome() {
    state.current = null;
    renderTenantList();
    const customers = state.tenants.filter((t) => t.plan !== 'demo');
    const newLeads = state.tenants.reduce((s, t) => s + (t.new_leads || 0), 0);
    const convs = state.tenants.reduce((s, t) => s + Number(t.conversations_month || 0), 0);
    const mrr = customers.filter((t) => t.active).reduce((s, t) => s + (state.plans[t.plan]?.priceEur || 0), 0);
    $('#main').innerHTML = `
      <div class="welcome">
        <h1>Übersicht</h1>
        <p>Lege einen neuen Kunden an: Name, Branche und Website reichen. Den Rest liest der Import automatisch ein. Danach bekommst du die Code-Zeile zum Kopieren.</p>
      </div>
      <div class="panel"><div class="stats">
        <div class="stat"><b>${customers.length}</b><span>Kunden</span></div>
        <div class="stat"><b>${fmtNum(mrr)} €</b><span>Monatsumsatz (aktive Abos)</span></div>
        <div class="stat"><b>${fmtNum(convs)}</b><span>Gespräche diesen Monat</span></div>
        <div class="stat"><b>${newLeads}</b><span>Neue Anfragen</span></div>
      </div></div>
      <div id="founder-panel"></div>
      <button class="btn btn-primary" type="button" id="welcome-new">Neuen Kunden anlegen</button>`;
    $('#welcome-new').addEventListener('click', renderNewTenant);
    api('/founders').then((list) => {
      if (!list.length || !$('#founder-panel')) return;
      $('#founder-panel').innerHTML = `<div class="panel"><div class="panel-head"><h2>Gründerpreis</h2><span class="row-meta">${list.length} von 10 Plätzen vergeben</span></div>
        <p class="hint">Einen Monat vor Ablauf geht automatisch eine Info-Mail an den Kunden (Kopie an dich). Am Ablauftag bekommst du eine Erinnerung, den Preis umzustellen.</p>
        <div class="rows">${list.map((f) => `
          <div class="row source-row"><div><div class="row-title">${esc(f.name)}</div>
            <div class="row-meta"><span class="dot ${f.expired ? 'bad' : f.daysLeft <= 45 ? 'warn' : 'ok'}"></span>
              ${f.expired ? `abgelaufen am ${esc(fmtDay(f.endsOn))} · jetzt ${f.regularEur} €` : `endet am ${esc(fmtDay(f.endsOn))} (in ${f.daysLeft} Tagen) · danach ${f.regularEur} €`}
              · Info-Mail ${f.noticeSentAt ? `gesendet ${esc(fmtDay(f.noticeSentAt))}` : f.noticeDue ? 'fällig, geht in der nächsten Stunde raus' : `automatisch am ${esc(fmtDay(f.noticeOn))}`}</div></div>
            <button class="btn btn-secondary" type="button" data-founder-open="${f.id}">Öffnen</button></div>`).join('')}</div></div>`;
      $('#founder-panel').querySelectorAll('[data-founder-open]').forEach((b) => b.addEventListener('click', () => openTenant(b.dataset.founderOpen, 'abrechnung')));
    }).catch(() => {});
  }

  // ------------------------------------------------------------ Neuer Kunde
  function planOptions(selected = 'starter') {
    return Object.entries(state.plans)
      .map(([k]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${esc(planLabel(k))}</option>`).join('');
  }
  function industryOptions(selected) {
    return state.industries.map((i) => `<option value="${i.key}" ${i.key === selected ? 'selected' : ''}>${esc(i.label)}</option>`).join('');
  }

  function renderNewTenant() {
    state.current = null;
    renderTenantList();
    history.replaceState(null, '', '#neu');
    $('#main').innerHTML = `
      <div class="page-head"><div><h1>Neuer Kunde</h1><div class="sub">In 2 Minuten startklar: anlegen, Website einlesen, Code-Zeile kopieren.</div></div></div>
      <form id="new-form" class="panel">
        <div class="grid-2">
          <div class="field"><label for="n-name">Name des Betriebs *</label><input id="n-name" type="text" required minlength="2" placeholder="z. B. Malerei Müller"></div>
          <div class="field"><label for="n-industry">Branche *</label><select id="n-industry">${industryOptions('handwerk')}</select></div>
          <div class="field"><label for="n-website">Website</label><input id="n-website" type="text" placeholder="malerei-mueller.de">
            <p class="hint">Die Domain wird automatisch für das Widget freigeschaltet.</p></div>
          <div class="field"><label for="n-city">Stadt</label><input id="n-city" type="text" placeholder="Darmstadt"></div>
          <div class="field"><label for="n-email">E-Mail für Anfragen</label><input id="n-email" type="email" placeholder="info@malerei-mueller.de">
            <p class="hint">Hierhin schickt der Assistent neue Anfragen und offene Fragen.</p></div>
          <div class="field"><label for="n-phone">Telefon</label><input id="n-phone" type="tel" placeholder="06151 …"></div>
          <div class="field"><label for="n-plan">Paket</label><select id="n-plan">${planOptions('starter')}</select></div>
          <div class="field"><label for="n-color">Farbe des Chats</label><input id="n-color" type="color" value="#1f4e79"></div>
        </div>
        <div class="field"><label class="check"><input id="n-import" type="checkbox" checked> Website direkt einlesen (Leistungen, Preise, Öffnungszeiten …)</label></div>
        <button class="btn btn-primary" type="submit" id="n-submit">Kunde anlegen</button>
        <div id="n-progress" class="progress hidden"><span class="spinner"></span><span></span></div>
      </form>`;
    $('#n-name').focus();
    $('#new-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#n-submit');
      const website = $('#n-website').value.trim();
      const progress = $('#n-progress');
      const say = (t) => { progress.classList.remove('hidden'); progress.lastElementChild.textContent = t; };
      await busy(btn, async () => {
        say('Kunde wird angelegt …');
        const t = await api('/tenants', {
          method: 'POST',
          body: {
            name: $('#n-name').value.trim(),
            industry: $('#n-industry').value,
            website,
            city: $('#n-city').value.trim(),
            contactEmail: $('#n-email').value.trim(),
            phone: $('#n-phone').value.trim(),
            plan: $('#n-plan').value,
            settings: { color: $('#n-color').value },
          },
        });
        if (website && $('#n-import').checked) {
          say('Website wird eingelesen … (kann 30–60 Sekunden dauern)');
          try {
            const r = await api(T(t) + `/import/website`, { method: 'POST', body: { url: website } });
            toast(`${r.pages.length} Seiten eingelesen ✓`);
          } catch (err) {
            toast(`Kunde angelegt, aber Website-Import fehlgeschlagen: ${err.message}`, true);
          }
        }
        await loadTenants();
        openTenant(t.id, 'einbau');
      });
      progress.classList.add('hidden');
    });
  }

  // ------------------------------------------------------------ Kundenansicht
  const TABS = [
    ['uebersicht', 'Übersicht'], ['einbau', 'Einbau'], ['wissen', 'Wissen'], ['anfragen', 'Anfragen'], ['fragen', 'Offene Fragen'],
    ['termine', 'Termine'], ['gespraeche', 'Gespräche'], ['einstellungen', 'Einstellungen'], ['abrechnung', 'Abrechnung'],
    ...(IS_ADMIN ? [['zugaenge', 'Zugänge']] : []),
  ];

  async function openTenant(id, tab) {
    try {
      state.current = await api(T(id));
    } catch (err) { toast(err.message, true); return; }
    state.tab = tab || (state.current?.id === id ? state.tab : 'uebersicht');
    if (!TABS.some(([k]) => k === state.tab)) state.tab = 'uebersicht';
    renderTenantList();
    renderTenant();
  }

  async function refreshCurrent() {
    state.current = await api(T(state.current));
    loadTenants();
  }

  function renderTenant() {
    const t = state.current;
    const listEntry = state.tenants.find((x) => x.id === t.id);
    const newLeads = listEntry?.new_leads ?? t.newLeads;
    history.replaceState(null, '', IS_ADMIN ? `#kunde/${t.id}/${state.tab}` : `#${state.tab}`);
    $('#main').innerHTML = `
      <div class="page-head">
        <div><h1>${esc(t.name)}</h1>
          <div class="sub">${esc(industryLabel(t.industry))}${t.city ? `, ${esc(t.city)}` : ''} · ${esc(IS_ADMIN ? planLabel(t.plan) : `Paket ${state.plans[t.plan]?.label || t.plan}`)}${t.active ? '' : ' · <strong>pausiert</strong>'}</div></div>
        <div class="copy-row">
          <button class="btn btn-secondary" type="button" id="test-chat">Chat testen</button>
          ${t.website ? `<a class="btn btn-secondary" href="${esc(t.website.startsWith('http') ? t.website : `https://${t.website}`)}" target="_blank" rel="noopener">Website öffnen</a>` : ''}
        </div>
      </div>
      ${(() => {
        const bb = billingBadge(t.billing);
        if (!t.active) return `<div class="banner bad"><strong>Ihr Assistent ist ausgeschaltet</strong> (${esc(bb.text)}). ${IS_ADMIN ? 'Unter „Abrechnung“ einschalten oder als bezahlt markieren.' : 'Er erscheint gerade nicht auf Ihrer Website.'} <button class="link-btn" type="button" data-goto="abrechnung">${IS_ADMIN ? 'Zur Abrechnung' : 'Jetzt aktivieren'}</button></div>`;
        if (t.billing?.status === 'trial' && !IS_ADMIN) return `<div class="banner warn">Testphase bis <strong>${esc(fmtDay(t.billing.trialEndsAt))}</strong>. Danach wird der Assistent ohne Abo ausgeschaltet. <button class="link-btn" type="button" data-goto="abrechnung">Abo abschließen</button></div>`;
        if (t.billing?.status === 'past_due') return `<div class="banner warn"><strong>Zahlung offen:</strong> ${IS_ADMIN ? 'Stripe konnte zuletzt nicht abbuchen.' : 'Bitte prüfen Sie Ihre Zahlungsmethode.'} <button class="link-btn" type="button" data-goto="abrechnung">Zur Abrechnung</button></div>`;
        return '';
      })()}
      <div class="tabs" role="tablist">${TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${label}${k === 'anfragen' && newLeads ? `<span class="count">${newLeads}</span>` : ''}</button>`).join('')}</div>
      <div id="tab-body"></div>`;
    $('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      state.tab = b.dataset.tab;
      renderTenant();
    });
    $('#main').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.goto; renderTenant(); }));
    $('#test-chat').addEventListener('click', () => {
      if (!window.EmpfangKI) return toast('Widget nicht geladen.', true);
      window.EmpfangKI.use(t.public_key, { open: true });
    });
    const body = $('#tab-body');
    ({ einbau: tabEinbau, wissen: tabWissen, anfragen: tabAnfragen, fragen: tabFragen, termine: tabTermine, gespraeche: tabGespraeche, einstellungen: tabEinstellungen, abrechnung: tabAbrechnung, zugaenge: tabZugaenge, uebersicht: tabUebersicht })[state.tab](body, t);
  }

  // --- Übersicht: Zahlen des Monats, Anfragen, häufigste Fragen (+ Monatsbericht im Admin)
  function monthOptions() {
    const out = [];
    const d = new Date();
    for (let i = 0; i < 6; i++) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
      out.push([key, new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(x)]);
    }
    return out;
  }

  async function tabUebersicht(body, t, month) {
    body.innerHTML = '<div class="progress"><span class="spinner"></span>Lade Übersicht …</div>';
    let s;
    try { s = await api(T(t) + `/insights${month ? `?month=${month}` : ''}`); } catch (err) { body.innerHTML = `<div class="error">${esc(err.message)}</div>`; return; }
    const pct = s.limit ? Math.min(100, Math.round((s.conversations / s.limit) * 100)) : 0;
    body.innerHTML = `
      <div class="panel-head" style="margin-bottom:14px">
        <h2 style="margin:0;font-size:20px">${esc(s.label)}</h2>
        <select id="o-month" style="width:auto" aria-label="Monat wählen">${monthOptions().map(([k, l]) => `<option value="${k}" ${k === s.month ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="tiles">
        <div class="tile"><b>${fmtNum(s.conversations)}</b><span>Gespräche${s.limit ? ` von ${fmtNum(s.limit)}` : ''}</span>${s.limit ? `<div class="meter"><i style="width:${pct}%"></i></div>` : ''}</div>
        <div class="tile"><b>${fmtNum(s.answers)}</b><span>Antworten gegeben</span></div>
        <div class="tile"><b>${fmtNum(s.leads.total)}</b><span>Anfragen weitergeleitet</span></div>
        <div class="tile ${s.openQuestions.pending ? 'tile-warn' : ''}"><b>${fmtNum(s.openQuestions.pending)}</b><span>offene Fragen</span>${s.openQuestions.pending ? '<button class="link-btn" type="button" data-goto="fragen">Jetzt beantworten</button>' : ''}</div>
      </div>
      <div class="grid-2" style="gap:18px;margin-top:18px;align-items:start">
        <div class="panel" style="margin:0">
          <h2>Häufigste Fragen</h2>
          <p class="hint">Womit Gespräche begonnen haben. Gespräche werden nach 30 Tagen gelöscht, ältere Monate sind daher unvollständig.</p>
          ${s.topQuestions.length ? `<ol class="top-list">${s.topQuestions.map((q) => `<li><span>${esc(q.question)}</span><b>${q.count}×</b></li>`).join('')}</ol>` : '<p class="hint">Noch keine Gespräche in diesem Monat.</p>'}
        </div>
        <div class="panel" style="margin:0">
          <h2>Anfragen nach Art</h2>
          ${s.leads.byKind.length ? `<ul class="top-list plain">${s.leads.byKind.map((k) => `<li><span>${esc(k.label)}</span><b>${k.count}</b></li>`).join('')}</ul>
            <button class="link-btn" type="button" data-goto="anfragen" style="margin-top:8px">Alle Anfragen ansehen</button>` : '<p class="hint">Noch keine Anfragen in diesem Monat.</p>'}
        </div>
      </div>
      ${IS_ADMIN ? `
      <div class="panel" style="margin-top:18px">
        <div class="panel-head"><h2>Monatsbericht</h2><span class="hint">Wird automatisch am 1. jedes Monats um 8 Uhr an den Kunden geschickt.</span></div>
        <div class="copy-row">
          <button class="btn btn-secondary" type="button" id="r-preview">Vorschau ${esc(s.label)}</button>
          <button class="btn btn-secondary" type="button" id="r-send">Jetzt an den Kunden senden</button>
        </div>
        <div id="r-out"></div>
      </div>` : ''}`;
    $('#o-month').addEventListener('change', (e) => tabUebersicht(body, t, e.target.value));
    body.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.goto; renderTenant(); }));
    $('#r-preview')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const r = await api(T(t) + `/report/preview?month=${s.month}`);
      $('#r-out').innerHTML = `<p class="hint" style="margin-top:12px">Betreff: <strong>${esc(r.subject)}</strong></p><iframe class="report-frame" title="Vorschau Monatsbericht"></iframe>`;
      $('#r-out iframe').srcdoc = r.html;
    }));
    $('#r-send')?.addEventListener('click', (e) => {
      if (!confirm(`Monatsbericht für ${s.label} jetzt an den Kunden senden?`)) return;
      busy(e.currentTarget, async () => {
        const r = await api(T(t) + '/report/send', { method: 'POST', body: { month: s.month } });
        toast(r.sent ? `Bericht gesendet an ${r.to.join(', ')} ✓` : r.skipped === 'no_recipients' ? 'Keine Empfänger: E-Mail für Anfragen oder Zugang fehlt.' : 'E-Mail konnte nicht gesendet werden (SMTP prüfen).', !r.sent);
      });
    });
  }

  // --- Einbau
  function tabEinbau(body, t) {
    const limit = t.planInfo?.monthlyConversations || 0;
    const used = Number(t.usage?.conversations || 0);
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const noKnowledge = !t.knowledge?.chunks;
    body.innerHTML = `
      ${noKnowledge ? `<div class="panel" style="border-color:var(--messing);background:var(--warn-soft)"><strong>Noch kein Wissen hinterlegt.</strong> Der Assistent kann noch nichts beantworten. <button class="link-btn" type="button" id="go-wissen">Jetzt Website oder PDF einlesen</button></div>` : ''}
      <div class="panel">
        <h2>Code-Zeile für die Website</h2>
        <p class="hint">Diese Zeile kommt vor das Ende von &lt;/body&gt; auf ${IS_ADMIN ? 'der Website des Kunden' : 'Ihrer Website'}. Sie funktioniert nur auf den freigeschalteten Domains (siehe Einstellungen) und kann auf mehreren Websites eingebaut werden.</p>
        <div class="code" id="snippet">${esc(t.snippet)}</div>
        <div class="copy-row"><button class="btn btn-primary" type="button" id="copy-snippet">Code kopieren</button>
          <span class="hint">Freigeschaltet: ${t.allowed_origins.length ? t.allowed_origins.map(esc).join(', ') : '<strong>keine Domain</strong>, bitte unter Einstellungen eintragen'}</span></div>
        <h2 style="margin-top:22px">So wird der Code eingebaut</h2>
        <ul class="steps-list">
          <li><strong>WordPress:</strong> Plugin „WPCode“ installieren → Code-Snippets → Kopf- und Fußzeile → Code in „Fußzeile“ einfügen → Speichern.</li>
          <li><strong>Jimdo:</strong> Einstellungen → Header bearbeiten → Code einfügen → Speichern.</li>
          <li><strong>Wix:</strong> Einstellungen → Benutzerdefinierter Code → Code hinzufügen → „Body – Ende“, alle Seiten (bezahlter Wix-Tarif nötig).</li>
          <li><strong>Eigene Website:</strong> Zeile vor &lt;/body&gt; in jede Seite oder ins Template einfügen.</li>
        </ul>
      </div>
      <div class="panel">
        <h2>Eigene Chat-Seite</h2>
        <p class="hint">Für Betriebe ohne Website: als Link für Google Maps, Instagram, E-Mail-Signatur oder als QR-Code.</p>
        <div class="qr-row">
          <img class="qr" src="/api/v1/hosted/${esc(t.slug)}/qr.svg" alt="QR-Code zur Chat-Seite" width="132" height="132">
          <div>
            <div class="copy-row"><a href="${esc(t.hostedUrl)}" target="_blank" rel="noopener">${esc(t.hostedUrl)}</a>
              <button class="btn btn-secondary" type="button" id="copy-hosted">Link kopieren</button></div>
            <p class="hint" style="margin-top:10px">QR-Code für Visitenkarte, Flyer, Schaufenster oder Rechnung. Wer ihn scannt, landet direkt im Chat.</p>
            <a class="btn btn-secondary" href="/api/v1/hosted/${esc(t.slug)}/qr.svg?download=1">QR-Code herunterladen</a>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Diesen Monat</h2>
        <div class="stats" style="margin-top:12px">
          <div class="stat"><b>${fmtNum(used)}</b><span>von ${fmtNum(limit)} Gesprächen</span><div class="meter"><i style="width:${pct}%"></i></div></div>
          <div class="stat"><b>${fmtNum(t.usage?.messages)}</b><span>Antworten</span></div>
          <div class="stat"><b>${fmtNum(t.knowledge?.chunks)}</b><span>Wissensabschnitte</span></div>
          ${IS_ADMIN ? `<div class="stat"><b>${(((Number(t.usage?.input_tokens) || 0) * 1 + (Number(t.usage?.output_tokens) || 0) * 5 + (Number(t.usage?.cache_read_tokens) || 0) * 0.1) / 1e6).toFixed(2).replace('.', ',')} $</b><span>KI-Kosten (geschätzt)</span></div>` : ''}
        </div>
      </div>`;
    $('#copy-snippet').addEventListener('click', () => copy(t.snippet, 'Code kopiert'));
    $('#copy-hosted').addEventListener('click', () => copy(t.hostedUrl, 'Link kopiert'));
    $('#go-wissen')?.addEventListener('click', () => { state.tab = 'wissen'; renderTenant(); });
  }

  // --- Wissen
  async function tabWissen(body, t) {
    body.innerHTML = `
      <div class="panel">
        <h2>Website einlesen</h2>
        <p class="hint">Liest bis zu 12 Seiten (Leistungen, Preise, Kontakt …) und fasst sie mit KI zu einer sauberen Wissensbasis zusammen. Ersetzt den vorherigen Website-Import.</p>
        <form id="w-form" class="copy-row">
          <input id="w-url" type="text" value="${esc(t.website || '')}" placeholder="www.beispiel.de" style="flex:1;min-width:220px" required>
          <button class="btn btn-primary" type="submit" id="w-btn">Website einlesen</button>
        </form>
        <div id="w-progress" class="progress hidden"><span class="spinner"></span><span>Website wird gelesen und zusammengefasst … (30–60 Sekunden)</span></div>
        <div id="w-result"></div>
      </div>
      <div class="panel">
        <h2>PDF hochladen</h2>
        <p class="hint">Preisliste, Flyer, Speisekarte, Leistungsbeschreibung … (Text-PDFs, max. 20 MB). Jede Datei wird eine eigene Quelle.</p>
        <div class="copy-row"><input id="p-file" type="file" accept="application/pdf,.pdf" multiple>
          <button class="btn btn-primary" type="button" id="p-btn">Hochladen</button></div>
        <div id="p-progress" class="progress hidden"><span class="spinner"></span><span></span></div>
      </div>
      <div class="panel">
        <h2>Eigener Text</h2>
        <p class="hint">Alles, was sonst nirgends steht: Öffnungszeiten an Feiertagen, Notdienst, Besonderheiten. Überschriften mit „# “ beginnen.</p>
        <textarea id="m-text" rows="8" placeholder="# Öffnungszeiten&#10;Mo–Fr 8–17 Uhr&#10;&#10;# Notdienst&#10;Am Wochenende unter 0151 …"></textarea>
        <div class="copy-row" style="margin-top:10px"><button class="btn btn-primary" type="button" id="m-btn">Text speichern</button>
          <span class="hint">Ersetzt den bisherigen eigenen Text.</span></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Gespeichertes Wissen</h2><span class="hint">${fmtNum(t.knowledge?.chunks)} Abschnitte, ca. ${fmtNum(t.knowledge?.tokens)} Tokens</span></div>
        <div id="sources" class="rows"></div>
        <details style="margin-top:14px" id="chunks-details"><summary>Alle Abschnitte ansehen und einzeln löschen</summary><div id="chunks" style="margin-top:8px"></div></details>
      </div>`;

    // Quellen
    const sources = $('#sources');
    sources.innerHTML = t.sources.length
      ? t.sources.map((s) => `<div class="row source-row"><div><div class="row-title">${esc(sourceLabel(s.source))}</div><div class="row-meta">${s.chunks} Abschnitte · aktualisiert ${fmtDate(s.updated_at)}</div></div>
          <span class="row-meta">${fmtNum(s.tokens)} Tokens</span>
          <button class="btn btn-danger" type="button" data-del-source="${esc(s.source)}">Löschen</button></div>`).join('')
      : '<div class="empty">Noch kein Wissen. Lesen Sie die Website ein oder laden Sie ein PDF hoch.</div>';
    sources.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del-source]');
      if (!b || !confirm(`„${sourceLabel(b.dataset.delSource)}“ wirklich löschen?`)) return;
      await busy(b, async () => {
        await api(T(t) + `/knowledge/source/${encodeURIComponent(b.dataset.delSource)}`, { method: 'DELETE' });
        toast('Gelöscht');
        await refreshCurrent();
        renderTenant();
      });
    });

    // Eigener Text vorbefüllen + alle Abschnitte
    const chunks = await api(T(t) + `/knowledge`).catch(() => []);
    const manual = chunks.filter((c) => c.source === 'manual');
    if (manual.length) $('#m-text').value = manual.map((c) => `# ${c.title}\n${c.content}`).join('\n\n');
    $('#chunks').innerHTML = chunks.map((c) => `<div class="chunk"><div><strong>${esc(c.title)}</strong> <span class="row-meta">· ${esc(sourceLabel(c.source))}</span><pre>${esc(c.content)}</pre></div>
      <button class="btn btn-danger" type="button" data-del-chunk="${c.id}">Löschen</button></div>`).join('') || '<p class="hint">Keine Abschnitte.</p>';
    $('#chunks').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del-chunk]');
      if (!b) return;
      await busy(b, async () => {
        await api(T(t) + `/knowledge/${b.dataset.delChunk}`, { method: 'DELETE' });
        b.closest('.chunk').remove();
        toast('Abschnitt gelöscht');
        refreshCurrent();
      });
    });

    // Website-Import
    $('#w-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#w-progress').classList.remove('hidden');
      $('#w-result').innerHTML = '';
      await busy($('#w-btn'), async () => {
        const r = await api(T(t) + `/import/website`, { method: 'POST', body: { url: $('#w-url').value.trim() } });
        toast(`${r.pages.length} Seiten eingelesen ✓`);
        await refreshCurrent();
        renderTenant();
        $('#w-result').innerHTML = `<p class="hint">${r.pages.length} Seiten gelesen${r.condensed ? ', mit KI zusammengefasst' : ' (Rohtext, ohne KI-Zusammenfassung)'}: ${r.pages.map((p) => esc(new URL(p.url).pathname)).join(', ')}</p>
          <details><summary>Vorschau</summary><div class="preview">${esc(r.preview)}</div></details>`;
      });
      $('#w-progress')?.classList.add('hidden');
    });

    // PDF-Upload
    $('#p-btn').addEventListener('click', async () => {
      const files = [...$('#p-file').files];
      if (!files.length) return toast('Bitte zuerst eine PDF-Datei auswählen.', true);
      const progress = $('#p-progress');
      await busy($('#p-btn'), async () => {
        for (const file of files) {
          if (file.size > 20 * 1024 * 1024) { toast(`${file.name} ist größer als 20 MB.`, true); continue; }
          progress.classList.remove('hidden');
          progress.lastElementChild.textContent = `${file.name} wird gelesen …`;
          const dataBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
            reader.readAsDataURL(file);
          });
          try {
            const r = await api(T(t) + `/import/pdf`, { method: 'POST', body: { filename: file.name, dataBase64 } });
            toast(`${file.name}: ${r.pages} Seiten eingelesen ✓`);
          } catch (err) { toast(`${file.name}: ${err.message}`, true); }
        }
        progress.classList.add('hidden');
        await refreshCurrent();
        renderTenant();
      });
    });

    // Eigener Text
    $('#m-btn').addEventListener('click', async () => {
      const text = $('#m-text').value.trim();
      await busy($('#m-btn'), async () => {
        if (!text) {
          await api(T(t) + `/knowledge/source/manual`, { method: 'DELETE' });
        } else {
          await api(T(t) + `/knowledge`, { method: 'PUT', body: { source: 'manual', title: 'Allgemein', text } });
        }
        toast('Gespeichert ✓');
        await refreshCurrent();
        renderTenant();
      });
    });
  }

  // --- Anfragen
  async function tabAnfragen(body, t) {
    body.innerHTML = '<div class="progress"><span class="spinner"></span>Lade Anfragen …</div>';
    const leads = await api(T(t) + `/leads`).catch((e) => { toast(e.message, true); return []; });
    if (!leads.length) { body.innerHTML = '<div class="empty">Noch keine Anfragen. Sobald jemand im Chat eine Anfrage hinterlässt, erscheint sie hier und wird per E-Mail geschickt.</div>'; return; }
    body.innerHTML = `<div class="rows">${leads.map((l) => `
      <div class="row">
        <div class="row-head">
          <div><span class="kind ${l.kind === 'offene_frage' ? 'open' : ''}">${esc(KIND[l.kind] || l.kind)}</span><span class="row-title">${esc(l.name)}</span></div>
          <div class="copy-row"><span class="row-meta">${fmtDate(l.created_at)}${l.notified_at ? ' · E-Mail gesendet' : ''}</span>
            <select class="status-select" data-lead="${l.id}" aria-label="Status">
              ${['neu', 'in_bearbeitung', 'erledigt'].map((s) => `<option value="${s}" ${l.status === s ? 'selected' : ''}>${{ neu: 'Neu', in_bearbeitung: 'In Bearbeitung', erledigt: 'Erledigt' }[s]}</option>`).join('')}
            </select></div>
        </div>
        <p class="contact">${l.phone ? `<a href="tel:${esc(l.phone.replace(/[^\d+]/g, ''))}">${esc(l.phone)}</a>` : ''}${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''}</p>
        ${l.open_question ? `<p><strong>Frage:</strong> ${esc(l.open_question)}</p>` : ''}
        <p>${esc(l.summary)}</p>
        ${Object.keys(l.details || {}).length ? `<p class="row-meta">${Object.entries(l.details).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</p>` : ''}
      </div>`).join('')}</div>`;
    body.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-lead]');
      if (!sel) return;
      try { await api(T(t) + `/leads/${sel.dataset.lead}`, { method: 'PATCH', body: { status: sel.value } }); toast('Status gespeichert'); loadTenants(); } catch (err) { toast(err.message, true); }
    });
  }

  // --- Offene Fragen (Wissenslücken)
  async function tabTermine(body, t) {
    body.innerHTML = '<div class="progress"><span class="spinner"></span>Lade Termine …</div>';
    const slots = await api(T(t) + '/slots').catch((e) => { toast(e.message, true); return []; });
    const now = Date.now();
    const upcoming = slots.filter((s) => new Date(s.starts_at).getTime() > now);
    const dayKey = (d) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
    const time = (d) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
    const groups = [];
    for (const s of upcoming) {
      const k = dayKey(s.starts_at);
      if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, items: [] });
      groups[groups.length - 1].items.push(s);
    }
    const free = upcoming.filter((s) => !s.booked_at).length;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
    body.innerHTML = `
      <p class="hint" style="margin:0 0 14px">Tragen Sie hier freie Termine ein. Der Assistent bietet sie Kunden im Chat an und bucht sie direkt. Gebuchte Termine erscheinen hier mit Namen und kommen zusätzlich als Anfrage per E-Mail. Vergangene Termine werden automatisch nicht mehr angeboten.</p>
      <div class="panel">
        <h2>Freie Termine eintragen</h2>
        <form id="sl-form" class="grid-form">
          <div class="field"><label for="sl-date">Datum</label><input id="sl-date" type="date" min="${today}" value="${today}" required></div>
          <div class="field"><label for="sl-times">Uhrzeiten</label><input id="sl-times" type="text" placeholder="z. B. 09:00, 10:30, 14:00" required></div>
          <div class="field"><label for="sl-dur">Dauer (Minuten)</label><input id="sl-dur" type="number" min="5" max="480" step="5" value="30"></div>
          <div class="field"><label for="sl-rep">Wöchentlich wiederholen</label><select id="sl-rep">${[1, 2, 3, 4, 6, 8, 12].map((n) => `<option value="${n}">${n === 1 ? 'nur dieser Tag' : `${n} Wochen`}</option>`).join('')}</select></div>
          <div class="field" style="grid-column:1/-1"><label for="sl-note">Hinweis (optional)</label><input id="sl-note" type="text" maxlength="120" placeholder="z. B. Besichtigung, nur Erstgespräch"></div>
          <div><button class="btn btn-primary" id="sl-btn" type="submit">Termine speichern</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>Kommende Termine <span class="row-meta">${free} frei · ${upcoming.length - free} gebucht</span></h2>
        ${groups.length ? groups.map((g) => `
          <h3 style="margin:16px 0 8px;font-size:15px">${esc(g.k)}</h3>
          <div class="rows">${g.items.map((s) => `
            <div class="row source-row">
              <div><div class="row-title">${time(s.starts_at)} Uhr · ${s.duration_min} Min.${s.note ? ` · ${esc(s.note)}` : ''}</div>
                <div class="row-meta">${s.booked_at
                  ? `<strong>Gebucht</strong> von ${esc(s.lead_name || 'Kunde')}${s.lead_phone ? ` · <a href="tel:${esc(s.lead_phone.replace(/[^\d+]/g, ''))}">${esc(s.lead_phone)}</a>` : ''}${s.lead_email ? ` · <a href="mailto:${esc(s.lead_email)}">${esc(s.lead_email)}</a>` : ''}`
                  : 'frei'}</div></div>
              ${s.booked_at ? `<button class="btn btn-secondary" type="button" data-release="${s.id}">Wieder freigeben</button>` : ''}
              <button class="btn btn-danger" type="button" data-del-slot="${s.id}">Löschen</button>
            </div>`).join('')}</div>`).join('') : '<div class="empty">Noch keine kommenden Termine. Tragen Sie oben freie Zeiten ein.</div>'}
      </div>`;

    $('#sl-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const times = $('#sl-times').value.split(/[,;\s]+/).map((x) => x.trim().replace('.', ':')).filter(Boolean)
        .map((x) => (/^\d{1,2}$/.test(x) ? `${x}:00` : x)).map((x) => x.padStart(5, '0'));
      if (!times.length || times.some((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))) return toast('Bitte Uhrzeiten wie 09:00, 14:30 eingeben.', true);
      busy($('#sl-btn'), async () => {
        const r = await api(T(t) + '/slots', { method: 'POST', body: {
          date: $('#sl-date').value, times, durationMin: Number($('#sl-dur').value) || 30,
          repeatWeeks: Number($('#sl-rep').value) || 1, note: $('#sl-note').value.trim(),
        } });
        toast(r.created ? `${r.created} Termin${r.created === 1 ? '' : 'e'} gespeichert ✓` : 'Keine neuen Termine (schon vorhanden oder in der Vergangenheit)');
        tabTermine(body, t);
      });
    });
    body.onclick = (e) => {
      const del = e.target.closest('[data-del-slot]');
      const rel = e.target.closest('[data-release]');
      if (del) {
        const s = upcoming.find((x) => x.id === del.dataset.delSlot);
        if (s?.booked_at && !confirm('Dieser Termin ist gebucht. Trotzdem löschen? Bitte informieren Sie den Kunden selbst.')) return;
        busy(del, async () => { await api(T(t) + `/slots/${del.dataset.delSlot}`, { method: 'DELETE' }); toast('Termin gelöscht'); tabTermine(body, t); });
      } else if (rel) {
        if (!confirm('Buchung aufheben und den Termin wieder als frei anbieten?')) return;
        busy(rel, async () => { await api(T(t) + `/slots/${rel.dataset.release}/release`, { method: 'POST' }); toast('Termin wieder frei'); tabTermine(body, t); });
      }
    };
  }

  async function tabFragen(body, t) {
    body.innerHTML = '<div class="progress"><span class="spinner"></span>Lade offene Fragen …</div>';
    const items = await api(T(t) + `/open-questions`).catch((e) => { toast(e.message, true); return []; });
    const open = items.filter((q) => q.status !== 'erledigt');
    const done = items.filter((q) => q.status === 'erledigt');
    body.innerHTML = `
      <p class="hint" style="margin:0 0 14px">Diese Fragen konnte der Assistent nicht beantworten. Tragen Sie die Antwort ein: Ab dann weiß er es. Die Person hat ihre Kontaktdaten hinterlassen und wartet auf eine Rückmeldung.</p>
      ${open.length ? `<div class="rows">${open.map((q) => `
        <div class="row" data-q="${q.id}">
          <div class="row-head"><span class="row-title">${esc(q.open_question)}</span><span class="row-meta">${fmtDate(q.created_at)}</span></div>
          <p class="contact row-meta">${esc(q.name)} ${q.phone ? `· <a href="tel:${esc(q.phone.replace(/[^\d+]/g, ''))}">${esc(q.phone)}</a>` : ''} ${q.email ? `· <a href="mailto:${esc(q.email)}">${esc(q.email)}</a>` : ''}</p>
          <div class="answer-box">
            <label for="a-${q.id}" class="hidden">Antwort</label>
            <textarea id="a-${q.id}" rows="3" placeholder="Antwort, die der Assistent künftig geben soll …"></textarea>
            <div class="copy-row"><button class="btn btn-primary" type="button" data-answer="${q.id}">Antwort hinzufügen</button>
              <button class="btn btn-secondary" type="button" data-skip="${q.id}">Ohne Antwort erledigt</button></div>
          </div>
        </div>`).join('')}</div>` : '<div class="empty">Keine offenen Fragen. Der Assistent konnte bisher alles beantworten.</div>'}
      ${done.length ? `<details style="margin-top:18px"><summary>Erledigt (${done.length})</summary><div class="rows" style="margin-top:10px">${done.map((q) => `<div class="row"><div class="row-head"><span>${esc(q.open_question)}</span><span class="row-meta">${fmtDate(q.created_at)}</span></div></div>`).join('')}</div></details>` : ''}`;
    body.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-answer]');
      const s = e.target.closest('[data-skip]');
      if (a) {
        const q = open.find((x) => x.id === a.dataset.answer);
        const answer = $(`#a-${q.id}`).value.trim();
        if (!answer) return toast('Bitte zuerst eine Antwort eintragen.', true);
        await busy(a, async () => {
          await api(T(t) + `/faq`, { method: 'POST', body: { question: q.open_question, answer, leadId: q.id } });
          toast('Antwort gespeichert. Der Assistent weiß es ab jetzt ✓');
          await refreshCurrent();
          renderTenant();
        });
      } else if (s) {
        await busy(s, async () => {
          await api(T(t) + `/leads/${s.dataset.skip}`, { method: 'PATCH', body: { status: 'erledigt' } });
          renderTenant();
        });
      }
    });
  }

  // --- Gespräche
  async function tabGespraeche(body, t) {
    body.innerHTML = '<div class="progress"><span class="spinner"></span>Lade Gespräche …</div>';
    const convs = await api(T(t) + `/conversations`).catch((e) => { toast(e.message, true); return []; });
    body.innerHTML = `<p class="hint" style="margin:0 0 14px">Die letzten 50 Gespräche. Gespräche werden nach der eingestellten Frist automatisch gelöscht.</p>` + (convs.length
      ? `<div class="rows">${convs.map((c) => {
          const first = c.messages?.find((m) => m.role === 'user')?.content || '';
          return `<details class="row"><summary><span>${esc(first.slice(0, 90))}${first.length > 90 ? ' …' : ''}</span> <span class="row-meta">· ${fmtDate(c.last_at)} · ${c.message_count} Nachrichten</span></summary>
            <div class="msgs">${(c.messages || []).map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('')}</div></details>`;
        }).join('')}</div>`
      : '<div class="empty">Noch keine Gespräche.</div>');
  }

  // --- Einstellungen
  function tabEinstellungen(body, t) {
    const s = t.settings || {};
    body.innerHTML = `
      <form id="s-form">
        <div class="panel">
          <h2>Betrieb</h2>
          <div class="grid-2" style="margin-top:14px">
            <div class="field"><label for="s-name">Name</label><input id="s-name" type="text" value="${esc(t.name)}" required></div>
            ${IS_ADMIN ? `<div class="field"><label for="s-industry">Branche</label><select id="s-industry">${industryOptions(t.industry)}</select></div>` : ''}
            <div class="field"><label for="s-website">Website</label><input id="s-website" type="text" value="${esc(t.website || '')}"></div>
            <div class="field"><label for="s-city">Stadt</label><input id="s-city" type="text" value="${esc(t.city || '')}"></div>
            <div class="field"><label for="s-email">E-Mail für Anfragen</label><input id="s-email" type="email" value="${esc(t.contact_email || '')}"></div>
            <div class="field"><label for="s-phone">Telefon</label><input id="s-phone" type="tel" value="${esc(t.phone || '')}"></div>
            ${IS_ADMIN ? `<div class="field"><label for="s-plan">Paket</label><select id="s-plan">${planOptions(t.plan)}</select></div>` : `<div class="field"><label>Paket</label><p style="margin:6px 0 0">${esc(planLabel(t.plan))}</p><p class="hint">Paket ändern oder kündigen: <a href="mailto:support@empfang-ki.de">support@empfang-ki.de</a></p></div>`}
            <div class="field"><label for="s-origins">Freigeschaltete Domains</label><input id="s-origins" type="text" value="${esc(t.allowed_origins.map((o) => o.replace(/^https?:\/\//, '')).filter((o, i, a) => !(o.startsWith('www.') && a.includes(o.slice(4)))).join(', '))}" placeholder="beispiel.de, shop.beispiel.de">
              <p class="hint">Auf diesen Websites darf der Chat laufen. Mehrere durch Komma trennen, „www.“ wird automatisch ergänzt.</p></div>
          </div>
        </div>
        <div class="panel">
          <h2>Chat</h2>
          <div class="grid-2" style="margin-top:14px">
            <div class="field"><label for="s-color">Farbe</label><input id="s-color" type="color" value="${esc(s.color || '#1f4e79')}"></div>
            <div class="field"><label for="s-position">Position</label><select id="s-position"><option value="right" ${s.position !== 'left' ? 'selected' : ''}>Unten rechts</option><option value="left" ${s.position === 'left' ? 'selected' : ''}>Unten links</option></select></div>
          </div>
          <div class="field"><label for="s-greeting">Begrüßung</label><textarea id="s-greeting" rows="2" placeholder="Leer lassen für die Standard-Begrüßung der Branche">${esc(s.greeting || '')}</textarea></div>
          <div class="field"><label for="s-quick">Schnellantworten (eine pro Zeile, max. 4)</label><textarea id="s-quick" rows="3" placeholder="Leer lassen für die Standard-Vorschläge der Branche">${esc((s.quickReplies || []).join('\n'))}</textarea></div>
          <div class="grid-2">
            <div class="field"><label for="s-booking">Online-Buchungslink</label><input id="s-booking" type="url" value="${esc(s.bookingUrl || '')}" placeholder="https://…"></div>
            <div class="field"><label for="s-privacy">Link zu ${IS_ADMIN ? 'seiner' : 'Ihrer'} Datenschutzerklärung</label><input id="s-privacy" type="url" value="${esc(s.privacyUrl || '')}" placeholder="https://…/datenschutz"></div>
          </div>
          <div class="field"><label for="s-extra">Zusätzliche Anweisungen an den Assistenten</label><textarea id="s-extra" rows="3" placeholder="z. B. „Wir nehmen keine Aufträge unter 500 € an.“ oder „Immer auf den Notdienst hinweisen.“">${esc(s.extraInstructions || '')}</textarea></div>
        </div>

        <button class="btn btn-primary" type="submit" id="s-btn">Einstellungen speichern</button>
      </form>`;
    $('#s-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const quick = $('#s-quick').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4);
      const settings = {
        ...s,
        color: $('#s-color').value,
        position: $('#s-position').value,
        greeting: $('#s-greeting').value.trim() || undefined,
        quickReplies: quick.length ? quick : undefined,
        bookingUrl: $('#s-booking').value.trim() || undefined,
        privacyUrl: $('#s-privacy').value.trim() || undefined,
        extraInstructions: $('#s-extra').value.trim() || undefined,
      };
      Object.keys(settings).forEach((k) => settings[k] === undefined && delete settings[k]);
      await busy($('#s-btn'), async () => {
        await api(T(t), {
          method: 'PATCH',
          body: {
            name: $('#s-name').value.trim(),
            website: $('#s-website').value.trim(),
            city: $('#s-city').value.trim(),
            contactEmail: $('#s-email').value.trim(),
            phone: $('#s-phone').value.trim(),
            allowedOrigins: $('#s-origins').value.split(',').map((x) => x.trim()).filter(Boolean),
            settings,
            ...(IS_ADMIN ? { industry: $('#s-industry').value, plan: $('#s-plan').value } : {}),
          },
        });
        toast('Gespeichert ✓');
        await refreshCurrent();
        renderTenant();
      });
    });
  }

  // --- Abrechnung: manuell (Admin), Stripe (Admin-Link oder Kunde selbst), Testphase, Verlauf
  const EVENT_LABEL = {
    gruenderpreis: 'Gründerpreis vergeben (12 Monate garantiert)', testphase: 'Testphase gestartet', testphase_abgelaufen: 'Testphase abgelaufen', bezahlt: 'Als bezahlt markiert',
    eingeschaltet: 'Eingeschaltet', ausgeschaltet: 'Ausgeschaltet', stripe_bezahlt: 'Abo über Stripe abgeschlossen',
    stripe_rechnung_bezahlt: 'Stripe-Rechnung bezahlt', stripe_zahlung_fehlgeschlagen: 'Stripe-Zahlung fehlgeschlagen',
    stripe_gekuendigt: 'Stripe-Abo beendet', stripe_abo_active: 'Stripe-Abo aktiv', stripe_abo_past_due: 'Stripe: Zahlung offen',
    stripe_abo_unpaid: 'Stripe: unbezahlt', stripe_abo_canceled: 'Stripe-Abo gekündigt',
  };

  async function tabAbrechnung(body, t) {
    body.innerHTML = '<div class="progress"><span class="spinner"></span>Lade Abrechnung …</div>';
    let b;
    try { b = await api(T(t) + '/billing'); } catch (err) { body.innerHTML = `<div class="error">${esc(err.message)}</div>`; return; }
    const badge = billingBadge(b);
    const paidPlans = ['starter', 'business', 'pro'];
    const planChoice = (sel) => paidPlans.map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(planLabel(k))} / Monat</option>`).join('');

    const statusPanel = `
      <div class="panel">
        <div class="panel-head"><h2>Status</h2><span class="badge ${badge.cls === 'ok' ? '' : badge.cls === 'bad' ? 'bad' : 'warn'}">${esc(badge.text)}</span></div>
        <div class="stats">
          <div class="stat"><b>${b.active ? 'An' : 'Aus'}</b><span>Assistent auf der Website</span></div>
          <div class="stat"><b>${esc(state.plans[b.plan]?.label || b.plan)}</b><span>${b.priceEur ? `${b.priceEur} € pro Monat` : 'ohne Kosten'}</span></div>
          <div class="stat"><b>${b.method === 'stripe' ? 'Stripe' : b.method === 'manual' ? 'Überweisung/bar' : '–'}</b><span>Zahlungsweg</span></div>
        </div>
      </div>`;

    let html = statusPanel;
    if (!IS_ADMIN && b.founder?.isFounder) {
      html += `<div class="panel"><h2>Ihr Gründerpreis</h2><p>${b.founder.expired
        ? `Ihr Gründerpreis ist am ${esc(fmtDay(b.founder.endsOn))} ausgelaufen. Es gilt der reguläre Preis von ${b.founder.regularEur} € im Monat.`
        : `Sie zahlen <strong>${b.founder.priceEur} € im Monat</strong>, garantiert bis ${esc(fmtDay(new Date(Date.parse(b.founder.endsOn) - 864e5).toISOString().slice(0, 10)))}. Danach gilt der reguläre Preis von ${b.founder.regularEur} € im Monat.`}</p>
        <p class="hint">Keine Mindestlaufzeit: jederzeit zum Monatsende kündbar.</p></div>`;
    }
    if (IS_ADMIN) {
      html += `
      <div class="panel">
        <h2>Bezahlt bei mir (Überweisung oder bar)</h2>
        <p class="hint">Schaltet den Assistenten sofort ein und verlängert „bezahlt bis“. ${b.paidUntil ? `Aktuell bezahlt bis <strong>${esc(fmtDay(b.paidUntil))}</strong>.` : ''}</p>
        <div class="copy-row">
          <select id="m-months" style="width:auto"><option value="1">1 Monat</option><option value="3">3 Monate</option><option value="6">6 Monate</option><option value="12">12 Monate</option></select>
          <input id="m-note" type="text" placeholder="Notiz, z. B. Rechnung 2026-004" style="flex:1;min-width:200px">
          <button class="btn btn-primary" type="button" id="m-paid">Als bezahlt markieren</button>
        </div>
      </div>
      <div class="panel">
        <h2>Über Stripe bezahlen lassen</h2>
        ${b.stripeEnabled ? `
          <p class="hint">Erstellt eine Stripe-Zahlungsseite für ein Monatsabo. Schicken Sie den Link an den Kunden. Nach der Zahlung schaltet sich der Assistent automatisch ein, bei Kündigung oder offener Zahlung automatisch aus.</p>
          <div class="copy-row"><select id="s-plan-pay" style="width:auto">${planChoice(paidPlans.includes(b.plan) ? b.plan : 'starter')}</select>
            <button class="btn btn-primary" type="button" id="s-link">Zahlungslink erstellen</button>
            ${b.stripeCustomer ? '<button class="btn btn-secondary" type="button" id="s-portal">Stripe-Kundenportal öffnen</button>' : ''}</div>
          <div id="s-link-out"></div>`
        : '<p class="hint">Stripe ist noch nicht eingerichtet. Tragen Sie <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code> und die Preis-IDs in die <code>.env</code> ein (Anleitung in der README).</p>'}
      </div>
      <div class="panel" id="founder-box"><h2>Gründerpreis</h2><p class="hint">Lade …</p></div>
      <div class="panel">
        <h2>Testphase und Ein/Aus</h2>
        <div class="copy-row" style="margin-top:10px">
          <select id="t-days" style="width:auto"><option value="7">7 Tage</option><option value="14" selected>14 Tage</option><option value="30">30 Tage</option></select>
          <button class="btn btn-secondary" type="button" id="t-trial">${b.status === 'trial' ? 'Testphase verlängern' : 'Testphase starten'}</button>
          <span style="flex:1"></span>
          ${b.active ? '<button class="btn btn-danger" type="button" id="t-off">Assistent ausschalten</button>' : '<button class="btn btn-secondary" type="button" id="t-on">Ohne Zahlung einschalten</button>'}
        </div>
        <p class="hint">Eine abgelaufene Testphase schaltet den Assistenten automatisch aus. „Ohne Zahlung einschalten“ eignet sich z. B. für Pilotkunden.</p>
      </div>`;
    } else {
      // Kunde
      if (b.method === 'stripe' && b.stripeCustomer && ['active', 'past_due'].includes(b.status)) {
        html += `<div class="panel"><h2>Ihr Abo</h2><p class="hint">Rechnungen herunterladen, Zahlungsart ändern, Paket wechseln oder kündigen. Das geht alles im sicheren Stripe-Kundenportal.</p>
          <button class="btn btn-primary" type="button" id="s-portal">Abo verwalten</button></div>`;
      } else if (b.method === 'manual' && b.status === 'active') {
        html += `<div class="panel"><h2>Zahlung per Rechnung</h2><p>Sie zahlen per Rechnung. Ihr Assistent ist bezahlt bis <strong>${esc(fmtDay(b.paidUntil))}</strong>.</p>
          <p class="hint">Fragen zur Rechnung: <a href="mailto:support@empfang-ki.de">support@empfang-ki.de</a></p></div>`;
      } else if (b.stripeEnabled) {
        html += `<div class="panel"><h2>Abo abschließen</h2><p class="hint">Monatlich kündbar. Die Zahlung läuft sicher über Stripe (Karte, SEPA-Lastschrift u. a.). Ihr Assistent wird direkt nach der Zahlung eingeschaltet.</p>
          <div class="plans-pick">${paidPlans.map((k) => `
            <label class="plan-pick"><input type="radio" name="plan-pick" value="${k}" ${k === (paidPlans.includes(b.plan) ? b.plan : 'starter') ? 'checked' : ''}>
              <span><strong>${esc(state.plans[k].label)}</strong><span class="price-sm">${b.regularPrice ? state.plans[k].regularEur : state.plans[k].priceEur} € / Monat</span><span class="hint">bis ${fmtNum(state.plans[k].monthlyConversations)} Gespräche</span></span></label>`).join('')}</div>
          <button class="btn btn-primary" type="button" id="s-subscribe" style="margin-top:14px">Weiter zur Zahlung</button></div>`;
      } else {
        html += `<div class="panel"><h2>Abo abschließen</h2><p>Für ein Abo schreiben Sie uns bitte an <a href="mailto:support@empfang-ki.de">support@empfang-ki.de</a>.</p></div>`;
      }
    }

    html += `<div class="panel"><h2>Verlauf</h2><div class="rows" style="margin-top:10px">${b.events.length ? b.events.map((e) => `
      <div class="row"><div class="row-head"><span>${esc(EVENT_LABEL[e.type] || e.type)}${e.detail?.months ? ` (${e.detail.months} Monat${e.detail.months > 1 ? 'e' : ''})` : ''}${e.detail?.amountEur ? `, ${String(e.detail.amountEur).replace('.', ',')} €` : ''}${IS_ADMIN && e.detail?.note ? `, ${esc(e.detail.note)}` : ''}</span>
      <span class="row-meta">${e.source === 'stripe' ? 'Stripe · ' : e.source === 'system' ? 'automatisch · ' : ''}${fmtDate(e.created_at)}</span></div></div>`).join('') : '<p class="hint">Noch keine Einträge.</p>'}</div></div>`;
    body.innerHTML = html;

    const after = async (promise, msg) => { await promise; toast(msg); await refreshCurrent(); renderTenant(); };
    if (IS_ADMIN) renderFounderBox(t, after);
    $('#m-paid')?.addEventListener('click', (e) => busy(e.currentTarget, () => after(
      api(T(t) + '/billing/manual', { method: 'POST', body: { months: Number($('#m-months').value), note: $('#m-note').value.trim() || undefined } }), 'Als bezahlt markiert, Assistent ist an ✓')));
    $('#t-trial')?.addEventListener('click', (e) => busy(e.currentTarget, () => after(
      api(T(t) + '/billing/trial', { method: 'POST', body: { days: Number($('#t-days').value) } }), 'Testphase gesetzt ✓')));
    $('#t-off')?.addEventListener('click', (e) => { if (confirm('Assistent ausschalten? Er erscheint dann nicht mehr auf der Website.')) busy(e.currentTarget, () => after(api(T(t) + '/billing/active', { method: 'POST', body: { active: false } }), 'Ausgeschaltet')); });
    $('#t-on')?.addEventListener('click', (e) => busy(e.currentTarget, () => after(api(T(t) + '/billing/active', { method: 'POST', body: { active: true } }), 'Eingeschaltet ✓')));
    $('#s-link')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const r = await api(T(t) + '/billing/checkout', { method: 'POST', body: { plan: $('#s-plan-pay').value } });
      $('#s-link-out').innerHTML = `<p class="hint" style="margin-top:12px">Zahlungslink für ${esc(planLabel(r.plan))}, gültig 24 Stunden:</p><div class="code">${esc(r.url)}</div><button class="btn btn-secondary" type="button" id="s-copy">Link kopieren</button>`;
      $('#s-copy').addEventListener('click', () => copy(r.url, 'Zahlungslink kopiert'));
    }));
    $('#s-portal')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const r = await api(T(t) + '/billing/portal', { method: 'POST' });
      if (IS_ADMIN) window.open(r.url, '_blank', 'noopener'); else location.href = r.url;
    }));
    $('#s-subscribe')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const plan = body.querySelector('input[name="plan-pick"]:checked')?.value;
      const r = await api(T(t) + '/billing/checkout', { method: 'POST', body: { plan } });
      location.href = r.url;
    }));
  }

  async function renderFounderBox(t, after) {
    const box = $('#founder-box');
    let f;
    try { f = await api(T(t) + '/founder'); } catch (err) { box.innerHTML = `<h2>Gründerpreis</h2><div class="error">${esc(err.message)}</div>`; return; }
    const today = new Date().toISOString().slice(0, 10);
    if (!f.isFounder) {
      box.innerHTML = `<h2>Gründerpreis</h2>
        <p class="hint">Die ersten ${f.limit} zahlenden Kunden werden beim ersten Bezahlen automatisch markiert. Vergeben: <strong>${f.used} von ${f.limit}</strong>.</p>
        ${f.used < f.limit ? `<div class="copy-row"><label for="f-since" class="hint" style="margin:0">Start</label><input id="f-since" type="date" value="${today}" style="width:auto">
          <button class="btn btn-secondary" type="button" id="f-set">Als Gründerkunde markieren</button></div>` : '<p class="hint">Alle Plätze sind vergeben.</p>'}`;
      $('#f-set')?.addEventListener('click', (e) => busy(e.currentTarget, () => after(api(T(t) + '/founder', { method: 'POST', body: { since: $('#f-since').value } }), 'Gründerpreis gesetzt ✓')));
      return;
    }
    box.innerHTML = `<div class="panel-head"><h2>Gründerpreis</h2><span class="badge ${f.expired ? 'bad' : f.daysLeft <= 45 ? 'warn' : ''}">${f.expired ? 'abgelaufen' : `noch ${f.daysLeft} Tage`}</span></div>
      <div class="stats">
        <div class="stat"><b>${esc(fmtDay(f.since))}</b><span>Start</span></div>
        <div class="stat"><b>${esc(fmtDay(f.endsOn))}</b><span>Ende (ab hier ${f.regularEur} €)</span></div>
        <div class="stat"><b>${f.noticeSentAt ? esc(fmtDay(f.noticeSentAt)) : f.noticeDue ? 'fällig' : esc(fmtDay(f.noticeOn))}</b><span>${f.noticeSentAt ? 'Info-Mail gesendet' : f.noticeDue ? 'Info-Mail geht in der nächsten Stunde raus' : 'Info-Mail geht automatisch raus'}</span></div>
      </div>
      <p class="hint">Am Ablauftag bekommst du eine Erinnerung per Mail, den Preis umzustellen${t.billing_method === 'stripe' ? ' (bei Stripe: Preis im Abo ändern)' : ''}.</p>
      <details style="margin:8px 0 12px"><summary>Info-Mail an den Kunden ansehen</summary>
        <div class="mail-preview"><p class="row-meta">Betreff: <strong>${esc(f.preview.subject)}</strong></p>${f.preview.html}</div></details>
      <div class="copy-row">
        <button class="btn btn-secondary" type="button" id="f-send">${f.noticeSentAt ? 'Info-Mail erneut senden' : 'Info-Mail jetzt senden'}</button>
        <input id="f-since" type="date" value="${esc(f.since)}" style="width:auto"><button class="btn btn-secondary" type="button" id="f-set">Startdatum ändern</button>
        <span style="flex:1"></span><button class="btn btn-danger" type="button" id="f-del">Gründerpreis entfernen</button>
      </div>`;
    $('#f-send').addEventListener('click', (e) => { if (confirm('Info-Mail jetzt an den Kunden senden?')) busy(e.currentTarget, () => after(api(T(t) + '/founder/notice', { method: 'POST' }), 'Info-Mail gesendet ✓')); });
    $('#f-set').addEventListener('click', (e) => busy(e.currentTarget, () => after(api(T(t) + '/founder', { method: 'POST', body: { since: $('#f-since').value } }), 'Startdatum geändert ✓')));
    $('#f-del').addEventListener('click', (e) => { if (confirm('Gründerpreis für diesen Kunden entfernen? Der Platz wird frei.')) busy(e.currentTarget, () => after(api(T(t) + '/founder', { method: 'POST', body: { since: null } }), 'Gründerpreis entfernt')); });
  }

  // --- Zugänge (nur Admin): wer darf sich ins Kunden-Dashboard einloggen?
  async function tabZugaenge(body, t) {
    body.innerHTML = '<div class="progress"><span class="spinner"></span>Lade Zugänge …</div>';
    const users = await api(T(t) + '/users').catch((e) => { toast(e.message, true); return []; });
    const loginUrl = `${state.me.publicUrl}/app/`;
    body.innerHTML = `
      <div class="panel">
        <h2>Kunden-Dashboard</h2>
        <p class="hint">Der Kunde meldet sich unter <a href="${esc(loginUrl)}" target="_blank" rel="noopener">${esc(loginUrl)}</a> mit seiner E-Mail-Adresse an und bekommt einen Anmeldelink per Mail, ganz ohne Passwort. Dort kann er Wissen pflegen, Anfragen und offene Fragen bearbeiten, Gespräche sehen und Einstellungen ändern.</p>
        <form id="u-form" class="copy-row" style="margin-top:12px">
          <input id="u-email" type="email" required placeholder="E-Mail-Adresse des Kunden" value="${users.length ? '' : esc(t.contact_email || '')}" style="flex:1;min-width:220px">
          <input id="u-name" type="text" placeholder="Name (optional)" style="width:200px">
          <button class="btn btn-primary" type="submit" id="u-btn">Zugang anlegen und Link senden</button>
        </form>
        <div id="u-link"></div>
      </div>
      <div class="panel">
        <h2>Zugänge</h2>
        <div class="rows" style="margin-top:10px">${users.length ? users.map((u) => `
          <div class="row source-row">
            <div><div class="row-title">${esc(u.email)}</div><div class="row-meta">${u.name ? `${esc(u.name)} · ` : ''}${u.last_login_at ? `zuletzt angemeldet ${fmtDate(u.last_login_at)}` : 'noch nie angemeldet'}</div></div>
            <button class="btn btn-secondary" type="button" data-link="${u.id}">Login-Link senden</button>
            <button class="btn btn-danger" type="button" data-del-user="${u.id}">Entfernen</button>
          </div>`).join('') : '<div class="empty">Noch kein Zugang. Legen Sie oben einen an, z. B. mit der E-Mail des Inhabers.</div>'}</div>
      </div>`;

    const showLink = (r) => {
      $('#u-link').innerHTML = `<p class="hint" style="margin-top:12px">${r.mailSent ? 'Login-Mail wurde an den Mailserver übergeben ✓. Kommt sie nicht an, bitte im Spam-Ordner nachsehen.' : '<strong>E-Mail konnte nicht verschickt werden</strong> (SMTP nicht eingerichtet?).'} Sie können den Link auch direkt weitergeben, z. B. per WhatsApp. Er ist 30 Minuten gültig und funktioniert einmal:</p>
        <div class="code">${esc(r.loginUrl)}</div><button class="btn btn-secondary" type="button" id="u-copy">Link kopieren</button>`;
      $('#u-copy').addEventListener('click', () => copy(r.loginUrl, 'Login-Link kopiert'));
    };

    $('#u-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await busy($('#u-btn'), async () => {
        const r = await api(T(t) + '/users', { method: 'POST', body: { email: $('#u-email').value.trim(), name: $('#u-name').value.trim() } });
        toast('Zugang angelegt ✓');
        await tabZugaenge(body, t);
        showLink(r);
      });
    });
    body.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const r = await api(T(t) + `/users/${b.dataset.link}/login-link`, { method: 'POST' });
      showLink(r);
      toast(r.mailSent ? 'Login-Mail verschickt ✓' : 'Link erstellt');
    })));
    body.querySelectorAll('[data-del-user]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm('Diesen Zugang entfernen? Die Person kann sich danach nicht mehr anmelden.')) return;
      busy(b, async () => {
        await api(T(t) + `/users/${b.dataset.delUser}`, { method: 'DELETE' });
        toast('Zugang entfernt');
        tabZugaenge(body, t);
      });
    }));
  }

  // ------------------------------------------------------------ Los geht's
  if (IS_ADMIN) {
    if (token) start(); else showLogin();
  } else {
    if (new URLSearchParams(location.search).get('login') === 'abgelaufen') {
      history.replaceState(null, '', location.pathname);
      showLogin('Dieser Anmeldelink ist abgelaufen oder wurde schon benutzt. Fordern Sie einfach einen neuen an.');
    } else {
      if (new URLSearchParams(location.search).get('bezahlt') === '1') {
        history.replaceState(null, '', location.pathname + location.hash);
        setTimeout(() => toast('Vielen Dank! Die Zahlung ist eingegangen. Ihr Assistent wird in wenigen Sekunden aktiviert ✓'), 600);
      }
      start();
    }
  }
})();
