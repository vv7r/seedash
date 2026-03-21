// === RÈGLES, CLEANER, HISTORIQUE, SECRETS ===

// État local règles et historique
let histData    = [];
let histSortKey = localStorage.getItem('hist-sort-key') || 'date';
let histSortDir = parseInt(localStorage.getItem('hist-sort-dir')) || -1;
let autoSaveTimer    = null;

// État timer
let timerNextAt    = null;
let timerCountdown = null;
let lastSavedTimer = { interval_hours: null, enabled: null };

// === RÈGLES DÉFINITIONS ===

/** Liste fixe ordonnée des règles auto-grab et auto-clean */
const RULE_DEFS = [
  { group: 'cond',  key: 'ratio_min',           name: 'Ratio minimum',              desc: 'Supprimer si ratio ≥ seuil',                                               unit: '',      step: 0.1, min: 0, defVal: 1.0,  defOn: true  },
  { group: 'cond',  key: 'ratio_max',           name: 'Ratio maximum',              desc: 'Force la suppression malgré les autres règles si le ratio dépasse N',      unit: '',      step: 0.1, min: 0, defVal: 5.0,  defOn: false },
  { group: 'cond',  key: 'age_min_hours',       name: 'Âge minimum',                desc: 'Supprimer si le torrent a été ajouté il y a plus de N jours',              unit: 'j',     step: 1,   min: 0, defVal: 2,    defOn: true,  displayScale: 24 },
  { group: 'cond',  key: 'age_max_hours',       name: 'Âge maximum',                desc: 'Force la suppression malgré les autres règles si l\'âge dépasse N jours',  unit: 'j',     step: 1,   min: 0, defVal: 14,   defOn: false, displayScale: 24 },
  { group: 'cond',  key: 'upload_min_mb',       name: 'Upload minimum',             desc: 'Supprimer si upload < N MB dans la fenêtre de temps ci-dessous',           unit: 'MB',    step: 100, min: 0, defVal: 500,  defOn: false },
  { group: 'cond',  key: 'upload_window_hours', name: 'Fenêtre upload',             desc: 'Fenêtre de vérification de l\'upload minimum',                             unit: 'h',     step: 1,   min: 1, defVal: 48,   defOn: false, noToggle: true, linkedTo: 'upload_min_mb' },
  { group: 'limit', key: 'grab_limit_per_day',  name: 'Grab automatique par jour',  desc: 'Nombre max de torrents grabbés par jour',                                  unit: '/jour', step: 1,   min: 1, defVal: 20,   defOn: true  },
  { group: 'limit', key: 'size_max_gb',         name: 'Taille max par torrent',     desc: 'Ignorer les torrents plus lourds',                                         unit: 'GB',    step: 1,   min: 1, defVal: 100,  defOn: true  },
  { group: 'limit', key: 'active_max',          name: 'Max torrents simultanés',    desc: 'Stoppe le grab si limite atteinte',                                       unit: '',      step: 1,   min: 1, defVal: 15,   defOn: false },
  { group: 'limit', key: 'min_leechers',        name: 'Leechers minimum',           desc: 'Ignorer les torrents avec moins de N leechers',                            unit: '',      step: 1,   min: 0, defVal: 5,    defOn: false },
  { group: 'limit', key: 'min_seeders',         name: 'Seeders minimum',            desc: 'Ignorer les torrents avec moins de N seeders',                             unit: '',      step: 1,   min: 0, defVal: 3,    defOn: false },
  { group: 'limit', key: 'network_max_pct',     name: 'Trafic réseau maximum',      desc: 'Stoppe le grab si le trafic mensuel Ultra.cc dépasse N%',                  unit: '%',     step: 1,   min: 1, defVal: 90,   defOn: false },
];

// === RÈGLES CHARGEMENT / RENDU ===

/** Charge la configuration des règles depuis /api/rules, fusionne avec RULE_DEFS. */
async function loadRules() {
  try {
    const d = await fetch(BASE + '/api/rules', { credentials: 'include' }).then(r => r.json());
    const on = d._on || {};
    rules = RULE_DEFS.map((def, i) => ({
      id: i,
      ...def,
      val: (d[def.key] ?? (def.defVal * (def.displayScale || 1))) / (def.displayScale || 1),
      on: on[def.key] !== undefined ? on[def.key] : def.defOn,
    }));
    rulesOrig = JSON.parse(JSON.stringify(rules));
    renderRules();
  } catch (e) { console.error(e); }
}

/** Génère le HTML des deux groupes de règles ('cond' et 'limit') dans leurs conteneurs. */
function renderRules() {
  ['cond', 'limit'].forEach(group => {
    const el = document.getElementById('rules-' + group);
    el.innerHTML = rules.filter(r => r.group === group).map(r => {
      const isDisabled = r.noToggle
        ? !rules.find(x => x.key === r.linkedTo)?.on
        : !r.on;
      const toggleHtml = r.noToggle
        ? '<div class="rule-actions"></div>'
        : `<div class="rule-actions"><input type="checkbox" class="toggle" ${r.on ? 'checked' : ''} data-action="rule-toggle" data-id="${r.id}"></div>`;
      return `
      <div class="rule-row">
        <div class="rule-meta">
          <div class="rule-name">${r.name}</div>
          <div class="rule-desc">${r.desc}</div>
        </div>
        <div class="rule-input-wrap">
          <input type="number" value="${r.val}" step="${r.step}" min="${r.min}"
            ${isDisabled ? 'disabled' : ''}
            data-action="rule-val" data-id="${r.id}">
        </div>
        <span class="rule-unit">${r.unit}</span>
        ${toggleHtml}
      </div>`;
    }).join('');
  });
}

/** Met à jour la valeur numérique d'une règle et déclenche l'auto-sauvegarde différée. */
function updateRuleVal(id, v) { const r = rules.find(x => x.id === id); if (r) { r.val = parseFloat(v) || v; autoSave(); } }

/** Active ou désactive une règle via son toggle, re-rend et auto-sauvegarde. */
function toggleRule(id, on)   { const r = rules.find(x => x.id === id); if (r) { r.on = on; renderRules(); autoSave(); } }

/** Corrige automatiquement les règles incohérentes avant sauvegarde. */
function autoFixRules() {
  const byKey = {};
  rules.forEach(r => { byKey[r.key] = r; });
  const ratioMin = byKey.ratio_min;
  const ratioMax = byKey.ratio_max;
  const ageMin   = byKey.age_min_hours;
  const ageMax   = byKey.age_max_hours;
  const msgs = [];
  if (ratioMax?.on && ratioMax.val <= 0) {
    ratioMax.val = 0.1;
    msgs.push('Ratio maximum doit être supérieur à 0 — corrigé à 0.1');
  }
  if (ageMax?.on && ageMax.val <= 0) {
    ageMax.val = 1;
    msgs.push('Âge maximum doit être supérieur à 0 — corrigé à 1 j');
  }
  if (ratioMax?.on && ratioMin?.on && ratioMax.val <= ratioMin.val) {
    ratioMax.val = Math.round((ratioMin.val + 0.1) * 10) / 10;
    msgs.push(`Ratio maximum doit dépasser le ratio minimum (${ratioMin.val}) — ajusté à ${ratioMax.val}`);
  }
  if (ageMax?.on && ageMin?.on && ageMax.val <= ageMin.val) {
    ageMax.val = ageMin.val + 1;
    msgs.push(`Âge maximum doit dépasser l'âge minimum (${ageMin.val} j) — ajusté à ${ageMax.val} j`);
  }
  return msgs;
}

/** Valide, construit le payload et envoie les règles via POST /api/rules. */
async function saveRules() {
  const fixes = autoFixRules();
  if (fixes.length) { renderRules(); toast(fixes.join(' — '), 'error'); }
  const payload = { _on: {} };
  rules.forEach(r => { payload[r.key] = r.val * (r.displayScale || 1); if (!r.noToggle) payload._on[r.key] = r.on; });
  const r = await fetch(BASE + '/api/rules', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify(payload) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `rules ${r.status}`);
  }
}

// === TIMER COUNTDOWN ===

/** Met à jour l'affichage du temps restant avant le prochain cycle Timer. */
function updateTimerNextRun() {
  const el = document.getElementById('timer-next-run');
  if (!el) return;
  if (!timerNextAt) { el.textContent = 'Prochain cycle : Jamais'; return; }
  const secs = Math.max(0, Math.round((timerNextAt - Date.now()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  el.textContent = h > 0
    ? `Prochain cycle dans : ${h} h ${String(m).padStart(2,'0')} min`
    : `Prochain cycle dans : ${m} min ${String(s).padStart(2,'0')} sec`;
}

/** Calcule timerNextAt et démarre le setInterval du compte à rebours Timer. */
function applyTimerCountdown(intervalHours, enabled) {
  clearInterval(timerCountdown); timerCountdown = null;
  if (!enabled) {
    timerNextAt = null;
    localStorage.removeItem('timerNextAt');
    updateTimerNextRun();
    return;
  }
  const intervalMs = (intervalHours || 1) * 3600000;
  const stored     = parseInt(localStorage.getItem('timerNextAt') || '0');
  timerNextAt = stored > Date.now() ? stored : Date.now() + intervalMs;
  if (!(stored > Date.now())) localStorage.setItem('timerNextAt', timerNextAt);
  timerCountdown = setInterval(updateTimerNextRun, 1000);
  updateTimerNextRun();
}

// === CLEANER ===

/** Charge l'état du cleaner depuis /api/cleaner/status et peuple le formulaire. */
async function loadCleanerStatus() {
  try {
    const d = await fetch(BASE + '/api/cleaner/status', { credentials: 'include' }).then(r => r.json());
    cleanerEnabled = !!d.enabled;
    document.getElementById('cleaner-enabled').checked        = !!d.enabled;
    document.getElementById('cleaner-last-run').textContent   = fmtDate(d.last_run);
    document.getElementById('cleaner-last-count').textContent = d.last_deleted_count ?? '—';
    document.getElementById('cleaner-last-run-type').textContent = d.last_run_type ? `· ${d.last_run_type}` : '';
  } catch (e) { console.error('[cleaner]', e); }
}

/** Sauvegarde le toggle cleaner via POST /api/cleaner/schedule. */
async function saveCleanerSchedule() {
  const enabled = document.getElementById('cleaner-enabled').checked;
  const r = await fetch(BASE + '/api/cleaner/schedule', {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'include',
    body: JSON.stringify({ enabled })
  });
  if (!r.ok) throw new Error(`cleaner ${r.status}`);
  await loadCleanerStatus();
}

/** Charge la config Timer depuis /api/timer/status et peuple le formulaire. */
async function loadTimerStatus() {
  try {
    const d = await fetch(BASE + '/api/timer/status', { credentials: 'include' }).then(r => r.json());
    document.getElementById('timer-enabled').checked   = !!d.enabled;
    document.getElementById('timer-interval').value    = d.interval_hours || 1;
    document.getElementById('timer-interval').disabled = !d.enabled;
    lastSavedTimer = { interval_hours: d.interval_hours || 1, enabled: !!d.enabled };
    applyTimerCountdown(d.interval_hours, d.enabled);
  } catch (e) { console.error('[timer]', e); }
}

/** Sauvegarde la config Timer via POST /api/timer/config. */
async function saveTimerConfig() {
  const interval_hours = parseInt(document.getElementById('timer-interval').value) || 1;
  const enabled        = document.getElementById('timer-enabled').checked;
  const r = await fetch(BASE + '/api/timer/config', {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'include',
    body: JSON.stringify({ interval_hours, enabled })
  });
  if (!r.ok) throw new Error(`timer ${r.status}`);
  const changed = interval_hours !== lastSavedTimer.interval_hours || enabled !== lastSavedTimer.enabled;
  if (changed) { localStorage.removeItem('timerNextAt'); localStorage.removeItem('autoRefreshNextAt'); }
  await loadTimerStatus();
}

/** Exécute le cleaner immédiatement via POST /api/cleaner/run. */
async function runCleanerNow() {
  const btn = document.getElementById('cleaner-run-btn');
  btn.disabled = true;
  btn.textContent = 'En cours...';
  try {
    const r = await fetch(BASE + '/api/cleaner/run', { method: 'POST', credentials: 'include' });
    const d = await r.json();
    const n = d.deleted ?? 0;
    showMsg('cleaner-run-msg', n === 0 ? 'Aucun torrent supprimé' : `${n} torrent${n > 1 ? 's' : ''} supprimé${n > 1 ? 's' : ''}`);
    localStorage.removeItem('cleanerNextAt');
    await loadCleanerStatus();
    loadStats();
  } catch (e) {
    toast('Erreur cleaner : ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Exécuter';
  }
}

// === HISTORIQUE ===

/** Change la colonne de tri de l'historique (inverse si même colonne). */
function setHistSort(key) {
  histSortDir = histSortKey === key ? histSortDir * -1 : -1;
  histSortKey = key;
  localStorage.setItem('hist-sort-key', histSortKey);
  localStorage.setItem('hist-sort-dir', histSortDir);
  renderHistory();
}

/** Trie une copie des données historique selon histSortKey et histSortDir. */
function sortHistData(data) {
  return [...data].sort((a, b) => {
    let va, vb;
    switch (histSortKey) {
      case 'date':   va = a.date;   vb = b.date;   break;
      case 'type':   va = a.type;   vb = b.type;   break;
      case 'count':  va = a.count;  vb = b.count;  break;
      case 'source': va = a.source; vb = b.source; break;
      default: return 0;
    }
    if (va < vb) return -histSortDir;
    if (va > vb) return histSortDir;
    return 0;
  });
}

/** Génère et injecte le tableau HTML de l'historique trié. */
function renderHistory() {
  const el = document.getElementById('history-content');
  if (!el) return;
  if (!histData.length) {
    el.innerHTML = '<div class="hist-empty">Aucun événement enregistré</div>';
    return;
  }
  const cols = [
    { key: 'date',   label: 'Date' },
    { key: 'type',   label: 'Type',     cls: 'col-hist-type' },
    { key: 'count',  label: 'Résultat' },
    { key: 'source', label: 'Source',   cls: 'col-hist-source' },
  ];
  const headers = cols.map(c => {
    const arrow = histSortKey === c.key ? (histSortDir === 1 ? ' ▲' : ' ▼') : '';
    const cls = c.cls ? ` class="${c.cls}"` : '';
    return `<th${cls} data-sort="${c.key}">${c.label}${arrow}</th>`;
  }).join('');

  const sorted = sortHistData(histData);
  const rows = sorted.map(e => {
    const isGrab   = e.type === 'grab';
    const isDelete = e.type === 'delete';
    const badge    = isGrab   ? `<span class="badge badge-blue">Grab</span>`
                   : isDelete ? `<span class="badge badge-gray">Suppression</span>`
                   :            `<span class="badge badge-amber">Clean</span>`;
    const result   = isGrab   ? `${e.count} torrent(s) ajouté(s)`
                   :            `${e.count} torrent(s) supprimé(s)`;
    const names = e.names?.length
      ? `<div class="hist-names">${e.names.map(n => {
          const label = he(typeof n === 'string' ? n : n.name);
          const url   = typeof n === 'object' && n.url ? n.url : null;
          return `<div>${url ? `<a href="${url}" target="_blank" rel="noopener" class="td-link">${label}</a>` : label}</div>`;
        }).join('')}</div>` : '';
    const srcBadge = `<span class="badge badge-gray">${he(e.source)}</span>`;
    const dateB64  = btoa(e.date);
    return `<tr>
      <td class="col-hist-date">${fmtDateStack(e.date)}</td>
      <td class="col-hist-type">${badge}</td>
      <td class="col-hist-result">${result}${names}</td>
      <td class="col-hist-source">${srcBadge}</td>
      <td class="col-hist-del"><button class="btn-del-x" data-action="del-hist" data-date="${dateB64}" title="Supprimer">✕</button></td>
    </tr>`;
  }).join('');

  el.innerHTML = `<table class="hist-table"><thead><tr>${headers}<th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Supprime une entrée de l'historique via DELETE /api/history. */
async function deleteHistEntry(dateB64) {
  const date = atob(dateB64);
  try {
    const r = await fetch(BASE + '/api/history', { method: 'DELETE', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ date }) });
    if (!r.ok) throw new Error();
    histData = histData.filter(e => e.date !== date);
    renderHistory();
  } catch { toast('Erreur suppression', 'error'); }
}

/** Charge l'intégralité de l'historique depuis /api/history et déclenche renderHistory(). */
async function loadHistory() {
  const el = document.getElementById('history-content');
  if (!el) return;
  try {
    histData = await fetch(BASE + '/api/history', { credentials: 'include' }).then(r => r.json());
    renderHistory();
  } catch (e) {
    el.innerHTML = '<div class="hist-error">Erreur chargement historique</div>';
  }
}

// === AUTO-SAVE ===

/** Déclenche une sauvegarde groupée différée (debounce 600 ms) des règles, cleaner, timer et auto-refresh. */
function autoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      const results = await Promise.allSettled([saveRules(), saveCleanerSchedule(), saveTimerConfig(), saveAutoRefresh()]);
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) toast('Erreur sauvegarde : ' + (failed[0].reason?.message || 'inconnue'), 'error');
    } catch (e) {
      toast('Erreur sauvegarde : ' + e.message, 'error');
    }
  }, 600);
}

// === SECRETS & CONNEXIONS ===

/** Charge les secrets/URLs depuis /api/config/secrets et peuple les champs du formulaire. */
async function loadSecrets() {
  try {
    const d = await fetch(BASE + '/api/config/secrets', { credentials: 'include' }).then(r => r.json());
    document.getElementById('sec-c411-url').value      = d.c411_url      || '';
    document.getElementById('sec-qbit-url').value      = d.qbit_url      || '';
    document.getElementById('sec-qbit-username').value = d.qbit_username || '';
    document.getElementById('sec-ultracc-url').value   = d.ultracc_url   || '';
    const setMask = (spanId, inputId, val) => {
      const span  = document.getElementById(spanId);
      const input = document.getElementById(inputId);
      if (span)  span.textContent  = val ? `(actuel : ${val})` : '';
      if (input) input.placeholder = val ? 'Laisser vide pour conserver' : '';
    };
    setMask('sec-c411-apikey-cur',   'sec-c411-apikey',   d.c411_apikey);
    setMask('sec-qbit-password-cur', 'sec-qbit-password', d.qbit_password);
    setMask('sec-ultracc-token-cur', 'sec-ultracc-token', d.ultracc_token);
  } catch (e) { console.error('[secrets]', e); }
}

/** Teste une connexion et met à jour la LED correspondante immédiatement. */
const SERVICE_LABELS = { c411: 'C411', qbittorrent: 'qBittorrent', ultracc: 'Ultra.cc' };
async function testConnection(service, ledId) {
  setLed(ledId, 'checking');
  const label = SERVICE_LABELS[service] || service;
  try {
    const d = await fetch(BASE + '/api/connections', { credentials: 'include' }).then(r => r.json());
    const ok = d[service] === 'ok';
    setLed(ledId, ok ? 'ok' : 'err');
    toast(ok ? `${label} — Connexion OK` : `${label} — ${d[service] || 'Échec'}`, ok ? 'success' : 'error');
  } catch {
    setLed(ledId, 'err');
    toast(`${label} — Erreur réseau`, 'error');
  }
}

/** Envoie uniquement les champs secrets remplis via POST /api/config/secrets. */
async function saveSecrets() {
  const body = {};
  const v = (id) => document.getElementById(id).value.trim();
  if (v('sec-c411-url'))      body.c411_url      = v('sec-c411-url');
  if (v('sec-c411-apikey'))   body.c411_apikey   = v('sec-c411-apikey');
  if (v('sec-qbit-url'))      body.qbit_url       = v('sec-qbit-url');
  if (v('sec-qbit-username')) body.qbit_username  = v('sec-qbit-username');
  if (v('sec-qbit-password')) body.qbit_password  = v('sec-qbit-password');
  if (v('sec-ultracc-url'))   body.ultracc_url    = v('sec-ultracc-url');
  if (v('sec-ultracc-token')) body.ultracc_token  = v('sec-ultracc-token');
  if (!Object.keys(body).length) { showMsg('secrets-msg', 'Aucune modification'); return; }
  try {
    const r = await fetch(BASE + '/api/config/secrets', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { showMsg('secrets-msg', d.error || 'Erreur serveur'); return; }
    document.getElementById('sec-c411-apikey').value   = '';
    document.getElementById('sec-qbit-password').value = '';
    document.getElementById('sec-ultracc-token').value = '';
    await loadSecrets();
    showMsg('secrets-msg', 'Sauvegardé ✓');
  } catch (e) { showMsg('secrets-msg', 'Erreur : ' + e.message); }
}

/** Valide et envoie un changement de mot de passe via POST /api/change-password. */
async function changePassword() {
  const current_password = document.getElementById('pwd-current').value;
  const new_password     = document.getElementById('pwd-new').value;
  const confirm          = document.getElementById('pwd-confirm').value;
  const msg = document.getElementById('pwd-msg');
  if (new_password !== confirm) { msg.style.color = 'var(--red-text)'; msg.textContent = 'Les mots de passe ne correspondent pas'; msg.style.opacity = 1; return; }
  if (new_password.length < 8) { msg.style.color = 'var(--red-text)'; msg.textContent = 'Minimum 8 caractères'; msg.style.opacity = 1; return; }
  try {
    const r = await fetch(BASE + '/api/change-password', {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
      body: JSON.stringify({ current_password, new_password })
    });
    const d = await r.json();
    if (!r.ok) { msg.style.color = 'var(--red-text)'; msg.textContent = d.error || 'Erreur'; msg.style.opacity = 1; return; }
    msg.style.color = 'var(--green)'; msg.textContent = 'Mot de passe changé ✓'; msg.style.opacity = 1;
    document.getElementById('pwd-current').value = '';
    document.getElementById('pwd-new').value     = '';
    document.getElementById('pwd-confirm').value = '';
    setTimeout(() => msg.style.opacity = 0, 3000);
  } catch (e) {
    msg.style.color = 'var(--red-text)'; msg.textContent = 'Erreur réseau'; msg.style.opacity = 1;
  }
}
