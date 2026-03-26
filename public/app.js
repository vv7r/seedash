'use strict';
// === CONFIG & INIT RAPIDE ===

// Restaure l'onglet actif avant checkAuth pour éviter le flash
(function () {
  const t = localStorage.getItem('active-tab') || 'top';
  document.querySelectorAll('.tab[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === t));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('sec-' + t)?.classList.add('active');
})();

// === AUTH ===
// Le token JWT est stocké dans un cookie httpOnly — le JS n'y a pas accès.
// Le navigateur l'envoie automatiquement via credentials:'include'.

/** Retourne les en-têtes JSON minimaux pour les requêtes POST/DELETE authentifiées.
 *  Le token JWT voyage dans un cookie httpOnly — pas besoin d'un header Authorization. */
function authHeaders() {
  return { 'Content-Type': 'application/json' };
}

/** Affiche l'écran de connexion et masque le bouton logout.
 *  @param {string} [msg] - Message d'erreur optionnel à afficher sous le formulaire */
function showLogin(msg) {
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('btn-logout').style.display = 'none';
  if (msg) { document.getElementById('login-error').textContent = msg; }
}

/** Masque l'écran de connexion et rend le bouton logout visible. */
function hideLogin() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('btn-logout').style.display = 'block';
}

/** Soumet le formulaire de login, obtient le cookie JWT, puis initialise l'application
 *  (stats, connexions, règles, polling) et bascule sur le dernier onglet mémorisé. */
async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  document.getElementById('login-error').textContent = '';
  try {
    const r = await fetchT(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password })
    });
    const d = await r.json();
    if (!r.ok) { document.getElementById('login-error').textContent = d.error || 'Erreur'; return; }
    localStorage.setItem('seedash-authed', '1');
    document.documentElement.classList.add('ready');
    hideLogin();
    loadStats();
    loadConnections();
    loadAutoRefreshConfig(true);
    startPolling();
    await loadRules();
    switchTab(localStorage.getItem('active-tab') || 'top');
  } catch (e) {
    document.getElementById('login-error').textContent = 'Erreur réseau';
  }
}

/** Invalide la session côté serveur (suppression du cookie JWT) puis affiche le login. */
async function doLogout() {
  await fetchT(BASE + '/api/logout', { method: 'POST', credentials: 'include' }).catch(e => console.warn('[logout]', e.message));
  _authFailed();
  showLogin();
}

/** Affiche la page de premier démarrage. */
function showSetup() { document.getElementById('setup-screen').classList.add('active'); }
/** Masque la page de premier démarrage. */
function hideSetup()  { document.getElementById('setup-screen').classList.remove('active'); }

/**
 * Soumet le formulaire de premier démarrage : valide les champs côté client,
 * appelle POST /api/setup, puis connecte automatiquement l'utilisateur.
 */
async function submitSetup() {
  const username = document.getElementById('setup-username').value.trim();
  const p1   = document.getElementById('setup-password').value;
  const p2   = document.getElementById('setup-password2').value;
  const err  = document.getElementById('setup-error');
  err.textContent = '';
  if (!username || username.length > 32 || !/^[a-zA-Z0-9._-]+$/.test(username))
    { err.textContent = 'Nom d\'utilisateur invalide (1–32 caractères alphanumériques, . _ -)'; return; }
  if (p1.length < 8)  { err.textContent = 'Mot de passe trop court (min 8 caractères)'; return; }
  if (p1.length > 72) { err.textContent = 'Mot de passe trop long (max 72 caractères)'; return; }
  if (p1 !== p2)      { err.textContent = 'Les mots de passe ne correspondent pas'; return; }
  try {
    const r = await fetchT(BASE + '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: p1 })
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Erreur'; return; }
    // Connexion automatique avec les identifiants saisis
    hideSetup();
    const lr = await fetchT(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ username, password: p1 })
    });
    if (!lr.ok) { showLogin('Compte créé — connectez-vous'); return; }
    localStorage.setItem('seedash-authed', '1');
    document.documentElement.classList.add('ready');
    hideLogin();
    loadStats(); loadConnections(); loadAutoRefreshConfig(true); startPolling();
    await loadRules();
    switchTab(localStorage.getItem('active-tab') || 'top');
  } catch { err.textContent = 'Erreur réseau'; }
}

/** Vérifie si la session est encore valide en sondant /api/stats.
 *  Retourne true si authentifié, false sinon (affiche le login dans les deux cas d'échec). */
async function checkAuth() {
  try {
    const s = await fetchT(BASE + '/api/setup/status').then(r => r.json());
    if (!s.setupComplete) { _authFailed(); showSetup(); return false; }
  } catch {}
  try {
    const r = await fetchT(BASE + '/api/stats', { credentials: 'include' });
    if (r.status === 401) { _authFailed(); showLogin(); return false; }
    localStorage.setItem('seedash-authed', '1');
    hideLogin();
    return true;
  } catch (e) {
    _authFailed(); showLogin('Erreur réseau — réessayez');
    return false;
  }
}
function _authFailed() {
  localStorage.removeItem('seedash-authed');
  document.documentElement.classList.remove('ready');
}

// === ÉTAT GLOBAL ===
let selectedGrab = new Map();
let topItems = [];
const torrentDataMap = new Map();
const openChartHashes = new Set();
let rules = [];

/** Retourne la valeur numérique d'une règle si elle est active, null sinon.
 *  Utilisé pour filtrer les items du top avant affichage.
 *  @param {string} key - Clé de la règle (ex. 'min_leechers') */
function getRuleVal(key) {
  const rule = rules.find(r => r.key === key);
  return (rule && rule.on) ? rule.val : null;
}

/** Filtre la liste des items du top selon les règles actives (leechers min, seeders min, taille max).
 *  Les règles désactivées sont ignorées — seules les règles dont getRuleVal() retourne non-null s'appliquent.
 *  @param {Array} items - Liste brute retournée par l'API top-leechers */
function filterTopItems(items) {
  const minL = getRuleVal('min_leechers');
  const minS = getRuleVal('min_seeders');
  const maxGB = getRuleVal('size_max_gb');
  return items.filter(i => {
    if (minL  !== null && i.leechers < minL) return false;
    if (minS  !== null && i.seeders  < minS) return false;
    if (maxGB !== null && i.size > maxGB * 1e9) return false;
    return true;
  });
}

// === MODAL ===
let pendingConfirm = null;

/** Ouvre la modale de confirmation générique.
 *  @param {string}   msg          - Message à afficher dans la modale
 *  @param {Function} onConfirm    - Callback exécuté si l'utilisateur confirme
 *  @param {string}   [confirmLabel] - Libellé du bouton de confirmation (défaut : 'Supprimer') */
function showConfirm(msg, onConfirm, confirmLabel = 'Supprimer', { showDeleteFiles = false } = {}) {
  pendingConfirm = onConfirm;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-confirm').textContent = confirmLabel;
  const wrap = document.getElementById('modal-delete-files-wrap');
  const cb   = document.getElementById('modal-delete-files');
  wrap.style.display = showDeleteFiles ? '' : 'none';
  cb.checked = false;
  document.getElementById('modal-overlay').classList.add('active');
}

/** Ferme la modale de confirmation et efface le callback en attente. */
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  pendingConfirm = null;
}

// === TABS ===
/** Bascule vers l'onglet demandé : met à jour les classes CSS actives, persiste le choix
 *  en localStorage, puis charge les données propres à chaque section.
 *  @param {string} name - Identifiant de l'onglet ('top', 'actifs', 'regles', 'historique') */
function switchTab(name) {
  localStorage.setItem('active-tab', name);
  document.querySelectorAll('.tab[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('sec-' + name).classList.add('active');
  if (name === 'top')        { const s = document.getElementById('f-cat'); if (s) s.value = ''; loadTopCache(); }
  if (name === 'actifs')     { const s = document.getElementById('f-cat-actifs'); if (s) s.value = ''; actifsHashes = ''; loadActifs(); }
  if (name === 'regles')     { loadRules(); loadCleanerStatus(); loadTimerStatus(); loadAutoRefreshConfig(); loadSecrets(); }
  if (name === 'historique') loadHistory();
}

// === THÈME ===
/** Met à jour l'icône du bouton thème (☀ en mode dark, ☽ en mode light). */
function updateThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.querySelectorAll('.btn-theme').forEach(btn => btn.textContent = dark ? '☀' : '☽');
}
/** Bascule entre le thème clair et sombre : modifie data-theme sur <html>,
 *  persiste le choix en localStorage, met à jour la meta-couleur du navigateur
 *  et re-rend tous les graphiques ouverts pour adapter leurs couleurs. */
function toggleTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (dark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('seedash-theme', 'light');
    document.getElementById('meta-theme-color')?.setAttribute('content', '#f5f4ef');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('seedash-theme', 'dark');
    document.getElementById('meta-theme-color')?.setAttribute('content', '#0f0f11');
  }
  updateThemeIcon();
  for (const hash of openChartHashes) {
    const canvas = document.querySelector(`#actifs-body .chart-row[data-hash="${hash}"] canvas`);
    if (canvas) renderUploadChart(hash, canvas);
  }
  if (chartModalHash) renderModalChart();
}
updateThemeIcon();

// === ÉVÉNEMENTS STATIQUES ===
// Formulaire de premier démarrage
document.getElementById('setup-btn').addEventListener('click', submitSetup);
document.getElementById('setup-password2').addEventListener('keydown', e => { if (e.key === 'Enter') submitSetup(); });
// Formulaire de connexion : clic sur le bouton et touche Entrée dans les deux champs
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// Boutons globaux de la barre de navigation (thème et déconnexion)
document.getElementById('btn-theme').addEventListener('click', toggleTheme);
document.querySelectorAll('.btn-theme-screen').forEach(btn => btn.addEventListener('click', toggleTheme));
document.getElementById('btn-logout').addEventListener('click', doLogout);

// Modal graphique : fermeture en cliquant sur le fond ou bouton ✕
// Utilise mousedown+mouseup sur le même élément pour éviter de fermer lors d'un drag brush
let chartModalMouseDownTarget = null;
document.getElementById('chart-modal').addEventListener('mousedown', e => { chartModalMouseDownTarget = e.target; });
document.getElementById('chart-modal').addEventListener('click', e => {
  if (e.target.id === 'chart-modal-close') { closeChartModal(); return; }
  if (e.target === document.getElementById('chart-modal') && chartModalMouseDownTarget === e.target) closeChartModal();
});
// Touche Échap pour fermer la modal graphique depuis n'importe où
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChartModal(); });

// Navigation entre onglets : délégation sur chaque bouton .tab[data-tab]
document.querySelectorAll('.tab[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Sélection globale du top leechers, bouton de refresh manuel, filtres catégorie
document.getElementById('top-select-all').addEventListener('change', function () { toggleSelectAll(this); });
// Refresh manuel : efface le countdown mémorisé pour repartir de zéro
document.getElementById('btn-load-top').addEventListener('click', () => { loadTop(); });
// Filtre catégorie des torrents actifs : force un rebuild complet
document.getElementById('f-cat-actifs').addEventListener('change', () => { actifsHashes = ''; loadActifs(); });
// Filtre catégorie du top leechers : re-rend depuis le cache sans appel réseau
document.getElementById('f-cat').addEventListener('change', () => {
  const tbody = document.getElementById('top-body');
  renderTopItems(topItemsCache, tbody);
});
// Envoi groupé des torrents sélectionnés dans le top
document.getElementById('btn-grab-selected').addEventListener('click', grabSelected);

// Auto-grab toggle
document.getElementById('autorefresh-enabled').addEventListener('change', () => { autoSave(); });
// Bouton auto-grab manuel avec feedback toast
document.getElementById('btn-auto-grab').addEventListener('click', () => triggerAutoGrab(true));

// Cleaner toggle
document.getElementById('cleaner-enabled').addEventListener('change', () => { autoSave(); });
document.getElementById('clean-delete-files').addEventListener('change', () => { autoSave(); });
// Bouton d'exécution manuelle du cleaner
document.getElementById('cleaner-run-btn').addEventListener('click', runCleanerNow);

// Timer : changement d'intervalle → sauvegarde différée
document.getElementById('timer-interval').addEventListener('change', () => { autoSave(); });
// Timer : activation/désactivation → active/désactive le champ intervalle
document.getElementById('timer-enabled').addEventListener('change', (e) => {
  document.getElementById('timer-interval').disabled = !e.target.checked;
  autoSave();
});

// Section connexions & API : sauvegarde des secrets et changement de mot de passe
document.getElementById('btn-save-secrets').addEventListener('click', saveSecrets);
document.getElementById('btn-test-c411').addEventListener('click',    () => testConnection('c411',        'led-c411'));
document.getElementById('btn-test-qbit').addEventListener('click',    () => testConnection('qbittorrent', 'led-qbit'));
document.getElementById('btn-test-ultracc').addEventListener('click', () => testConnection('ultracc',     'led-ultracc'));
document.getElementById('btn-change-password').addEventListener('click', changePassword);

// Modal de confirmation générique : confirmer, annuler, clic sur le fond
document.getElementById('modal-confirm').addEventListener('click', () => { const fn = pendingConfirm; closeModal(); fn?.(); });
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });

// === DÉLÉGATION — TOP LEECHERS ===
// Tri par colonne : délégation sur le thead statique, dispatch vers sortTopBy()
document.getElementById('top-thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (th) sortTopBy(th.dataset.col);
});

// Clic sur une ligne du top : bouton Grab → grabOne() ; clic sur la ligne → toggle de la checkbox
document.getElementById('top-body').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action="grab-one"]');
  if (btn) { grabOne(parseInt(btn.dataset.idx)); return; }
  if (e.target.closest('a') || e.target.closest('input[type=checkbox]')) return;
  const row = e.target.closest('tr');
  if (!row) return;
  const cb = row.querySelector('input[type=checkbox][data-idx]');
  if (cb) { cb.checked = !cb.checked; toggleGrab(parseInt(cb.dataset.idx), cb); }
});
// Changement direct d'une checkbox du top (clavier ou clic direct) → toggleGrab()
document.getElementById('top-body').addEventListener('change', e => {
  const cb = e.target.closest('input[type=checkbox][data-idx]');
  if (cb) toggleGrab(parseInt(cb.dataset.idx), cb);
});

// === DÉLÉGATION — TORRENTS ACTIFS ===
// Tri par colonne : délégation sur le thead entier car renderActifsHeaders() rebuild le <tr> à chaque appel
document.querySelector('#sec-actifs thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-action="sort-actifs"]');
  if (th) setActifsSort(th.dataset.key);
});

// Bouton "Déployer/Replier tout" : ouvre ou ferme les graphiques de tous les torrents d'un coup
document.getElementById('btn-toggle-all-charts').addEventListener('click', () => {
  const tbody = document.getElementById('actifs-body');
  const allRows = [...tbody.querySelectorAll('tr[data-hash]:not(.chart-row)')];
  const allExpanded = allRows.length > 0 && allRows.every(r => openChartHashes.has(r.dataset.hash));
  const btn = document.getElementById('btn-toggle-all-charts');
  if (allExpanded) {
    tbody.querySelectorAll('.chart-row').forEach(r => r.remove());
    openChartHashes.clear();
    btn.textContent = 'Déployer tout';
  } else {
    for (const row of allRows) {
      const hash = row.dataset.hash;
      if (openChartHashes.has(hash)) continue;
      openChartHashes.add(hash);
      insertChartRow(hash, row);
    }
    btn.textContent = 'Replier tout';
  }
});

// Clic dans le tableau actifs : boutons d'action (supprimer, agrandir chart) ou clic ligne → toggle graph inline
document.getElementById('actifs-body').addEventListener('click', e => {
  const badge = e.target.closest('[data-action="toggle-exclude"]');
  if (badge) { toggleExclude(badge.dataset.hash); return; }
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    if (btn.dataset.action === 'delete-manual') deleteManual(btn.dataset.hash);
    if (btn.dataset.action === 'expand-chart')  openChartModal(btn.dataset.hash);
    return;
  }
  if (e.target.closest('a')) return;
  const row = e.target.closest('tr[data-hash]:not(.chart-row)');
  if (!row) return;
  const hash = row.dataset.hash;
  const existing = document.querySelector(`#actifs-body .chart-row[data-hash="${hash}"]`);
  if (existing) { existing.remove(); openChartHashes.delete(hash); }
  else {
    openChartHashes.add(hash);
    insertChartRow(hash, row);
  }
  const allRows = [...document.querySelectorAll('#actifs-body tr[data-hash]:not(.chart-row)')];
  const toggleBtn = document.getElementById('btn-toggle-all-charts');
  toggleBtn.textContent = (allRows.length > 0 && allRows.every(r => openChartHashes.has(r.dataset.hash)))
    ? 'Replier tout' : 'Déployer tout';
});

// === DÉLÉGATION — RÈGLES ===
// 'change' pour les toggles et les champs numériques (perte de focus)
document.getElementById('sec-regles').addEventListener('change', e => {
  const inp = e.target.closest('input[data-action="rule-val"]');
  if (inp) updateRuleVal(parseInt(inp.dataset.id), inp.value);
  const tog = e.target.closest('input[data-action="rule-toggle"]');
  if (tog) toggleRule(parseInt(tog.dataset.id), tog.checked);
});
// 'input' pour mise à jour temps réel pendant la saisie dans les champs numériques des règles
document.getElementById('sec-regles').addEventListener('input', e => {
  const inp = e.target.closest('input[data-action="rule-val"]');
  if (inp) updateRuleVal(parseInt(inp.dataset.id), inp.value);
});

// === DÉLÉGATION — HISTORIQUE ===
// Suppression d'une entrée (data-action="del-hist") et tri par en-tête (data-sort)
document.getElementById('history-content').addEventListener('click', e => {
  const chartBtn = e.target.closest('button[data-action="hist-chart"]');
  if (chartBtn) { openChartModal(chartBtn.dataset.hash, chartBtn.dataset.name); return; }
  const del = e.target.closest('button[data-action="del-hist"]');
  if (del) { deleteHistEntry(del.dataset.date); return; }
  const th = e.target.closest('th[data-sort]');
  if (th) setHistSort(th.dataset.sort);
});

// === POLLING ===
/** Démarre les trois intervalles de polling côté client (déclenchés une fois après login) :
 *  - Torrents actifs : toutes les 5 s, uniquement si l'onglet actifs est visible
 *  - Connexions LEDs : toutes les 30 s
 *  - Stats globales  : toutes les 60 s */
let pollingStarted = false;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  setInterval(() => {
    if (document.getElementById('sec-actifs')?.classList.contains('active')) loadActifs();
  }, 5000);
  setInterval(loadConnections, 30000);
  setInterval(loadStats, 60000);
  setInterval(() => loadAutoRefreshConfig(false), 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadStats();
  });
}

// === INIT ===
// Point d'entrée : vérifie la session, et si valide, initialise toute l'application
checkAuth().then(async authenticated => {
  if (authenticated) {
    document.documentElement.classList.add('ready');
    loadStats();
    loadConnections();
    loadAutoRefreshConfig(true);
    startPolling();
    await loadRules();
    switchTab(localStorage.getItem('active-tab') || 'top');
  }
});
