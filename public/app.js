// === CONFIG ===
/** Préfixe de toutes les routes API — doit correspondre au mountPath Express */
const BASE = '/seedash';

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
    const r = await fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password })
    });
    const d = await r.json();
    if (!r.ok) { document.getElementById('login-error').textContent = d.error || 'Erreur'; return; }
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
  await fetch(BASE + '/api/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  showLogin();
}

/** Vérifie si la session est encore valide en sondant /api/stats.
 *  Retourne true si authentifié, false sinon (affiche le login dans les deux cas d'échec). */
async function checkAuth() {
  try {
    const r = await fetch(BASE + '/api/stats', { credentials: 'include' });
    if (r.status === 401) { showLogin(); return false; }
    hideLogin();
    return true;
  } catch (e) {
    showLogin('Erreur réseau — réessayez');
    return false;
  }
}

// === ÉTAT GLOBAL ===
let selectedGrab = new Map();
let topItems = [];
const torrentDataMap = new Map();
let rules = [];
let rulesOrig = [];

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
let autoRefreshInterval = null;
let autoRefreshNextAt      = null;
let autoRefreshCountdown    = null;
let autoRefreshFirstTimeout = null;
let cleanerNextAt      = null;
let cleanerCountdown   = null;
let lastRefreshTime = localStorage.getItem('lastRefreshTime') || null;
let lastRefreshType = localStorage.getItem('lastRefreshType') || null;
let topRetryInterval = null;

// === UTILS ===
/** Échappe les caractères HTML spéciaux (&, <, >, ", ') pour sécuriser l'interpolation dans innerHTML.
 *  À utiliser systématiquement sur toute donnée utilisateur ou provenant de l'API. */
function he(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Liste fixe ordonnée des règles
const RULE_DEFS = [
  { group: 'cond',  key: 'ratio_min',         name: 'Ratio minimum',          desc: 'Supprimer si ratio ≥ seuil',                                              unit: '',     step: 0.1, min: 0, defVal: 1.0,  defOn: true  },
  { group: 'cond',  key: 'ratio_max',         name: 'Ratio maximum',          desc: 'Force la suppression malgré les autres règles si le ratio dépasse N',       unit: '',     step: 0.1, min: 0, defVal: 5.0,  defOn: false },
  { group: 'cond',  key: 'age_min_hours',      name: 'Âge minimum',            desc: 'Supprimer si le torrent a été ajouté il y a plus de N jours',             unit: 'j',    step: 1,   min: 0, defVal: 2,    defOn: true,  displayScale: 24 },
  { group: 'cond',  key: 'age_max_hours',      name: 'Âge maximum',            desc: 'Force la suppression malgré les autres règles si l\'âge dépasse N jours',   unit: 'j',    step: 1,   min: 0, defVal: 14,   defOn: false, displayScale: 24 },
  { group: 'cond',  key: 'upload_min_mb',      name: 'Upload minimum',         desc: 'Supprimer si upload < N MB dans la fenêtre de temps ci-dessous',            unit: 'MB',   step: 100, min: 0, defVal: 500,  defOn: false },
  { group: 'cond',  key: 'upload_window_hours',name: 'Fenêtre upload',         desc: 'Fenêtre de vérification de l\'upload minimum',                              unit: 'h',    step: 1,   min: 1, defVal: 48,   defOn: false, noToggle: true, linkedTo: 'upload_min_mb' },
  { group: 'limit', key: 'grab_limit_per_day', name: 'Grab automatique par jour', desc: 'Nombre max de torrents grabbés par jour',                                 unit: '/jour', step: 1,  min: 1, defVal: 20,   defOn: true  },
  { group: 'limit', key: 'size_max_gb',       name: 'Taille max par torrent', desc: 'Ignorer les torrents plus lourds',                                          unit: 'GB',   step: 1,   min: 1, defVal: 100,  defOn: true  },
  { group: 'limit', key: 'active_max',        name: 'Max torrents simultanés', desc: 'File d\'attente si limite atteinte',                                       unit: '',     step: 1,   min: 1, defVal: 15,   defOn: false },
  { group: 'limit', key: 'min_leechers',      name: 'Leechers minimum',       desc: 'Ignorer les torrents avec moins de N leechers',                            unit: '',     step: 1,   min: 0, defVal: 5,    defOn: false },
  { group: 'limit', key: 'min_seeders',       name: 'Seeders minimum',        desc: 'Ignorer les torrents avec moins de N seeders',                             unit: '',     step: 1,   min: 0, defVal: 3,    defOn: false },
];

/** Formate un nombre d'octets en chaîne lisible (KB, MB, GB, TB).
 *  Retourne '—' si la valeur est absente ou nulle. */
function fmtBytes(b) {
  if (!b) return '—';
  if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6)  return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}
/** Formate une vitesse en octets/seconde en KB/s ou MB/s lisibles.
 *  Retourne '—' si la vitesse est nulle ou négative. */
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
  return bps + ' B/s';
}
/** Convertit un nombre de secondes en chaîne "Xj Yh" ou "Zh".
 *  Utilisé pour afficher le seedtime et l'âge des torrents. */
function fmtSecs(s) {
  if (!s) return '0h';
  const h = Math.floor(s / 3600);
  if (h >= 24) return Math.floor(h / 24) + 'j ' + (h % 24) + 'h';
  return h + 'h';
}
/** Calcule et formate l'âge d'un torrent à partir de son timestamp d'ajout Unix (added_on).
 *  @param {number} added_on - Timestamp Unix en secondes (champ qBittorrent) */
function fmtAge(added_on) {
  if (!added_on) return '—';
  const secs = Math.floor(Date.now() / 1000) - added_on;
  return fmtSecs(secs);
}
/** Formate une date ISO en "JJ/MM/AAAA HH:MM" selon la locale fr-FR. */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
/** Formate une date ISO en deux spans HTML empilés (date / heure) pour l'affichage dans l'historique. */
function fmtDateStack(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `<span class="hist-date-day">${d.toLocaleDateString('fr-FR')}</span><span class="hist-date-time">${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>`;
}
/** Affiche temporairement un message dans un élément DOM (fade-in puis fade-out après 2,5 s).
 *  @param {string} id   - ID de l'élément cible
 *  @param {string} [text] - Texte à injecter (optionnel, conserve le texte existant sinon) */
function showMsg(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  if (text !== undefined) el.textContent = text;
  el.style.opacity = 1;
  setTimeout(() => el.style.opacity = 0, 2500);
}

// === MODAL ===
let pendingConfirm = null;

/** Ouvre la modale de confirmation générique.
 *  @param {string}   msg          - Message à afficher dans la modale
 *  @param {Function} onConfirm    - Callback exécuté si l'utilisateur confirme
 *  @param {string}   [confirmLabel] - Libellé du bouton de confirmation (défaut : 'Supprimer') */
function showConfirm(msg, onConfirm, confirmLabel = 'Supprimer') {
  pendingConfirm = onConfirm;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-confirm').textContent = confirmLabel;
  document.getElementById('modal-overlay').classList.add('active');
}

/** Ferme la modale de confirmation et efface le callback en attente. */
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  pendingConfirm = null;
}

// === TOAST ===
let toastTimer = null;
/** Affiche une notification temporaire (toast) en bas de l'écran.
 *  Les toasts d'erreur restent 7 s, les autres 3,5 s. Un seul toast à la fois.
 *  @param {string} msg          - Message à afficher
 *  @param {'success'|'error'} [type] - Variante visuelle */
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 7000 : 3500);
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
  if (name === 'regles')     { loadRules(); loadCleanerStatus(); loadAutoRefreshConfig(); loadSecrets(); }
  if (name === 'historique') loadHistory();
}

// === CONNEXIONS LED ===
const ledState = { 'led-c411': null, 'led-qbit': null, 'led-ultracc': null };
/** Met à jour l'état visuel d'une LED de connexion ('checking', 'ok', 'err').
 *  Mémorise l'état pour éviter des flashs orange inutiles lors des prochains polls silencieux.
 *  @param {string} id    - ID DOM de la LED (ex. 'led-c411')
 *  @param {string} state - Nouvel état */
function setLed(id, state) {
  const el = document.getElementById(id);
  if (el) el.className = 'led led-' + state;
  ledState[id] = state;
}
/** Interroge /api/connections et met à jour les trois LEDs (C411, qBittorrent, Ultra.cc).
 *  Ne passe en 'checking' que si la LED n'était pas déjà 'ok' — évite les flashs orange. */
async function loadConnections() {
  ['led-c411', 'led-qbit', 'led-ultracc'].forEach(id => {
    if (ledState[id] !== 'ok') setLed(id, 'checking');
  });
  try {
    const d = await fetch(BASE + '/api/connections', { credentials: 'include' }).then(r => r.json());
    setLed('led-c411',    d.c411        === 'ok' ? 'ok' : 'err');
    setLed('led-qbit',    d.qbittorrent === 'ok' ? 'ok' : 'err');
    setLed('led-ultracc', d.ultracc     === 'ok' ? 'ok' : 'err');
  } catch (e) {
    ['led-c411', 'led-qbit', 'led-ultracc'].forEach(id => setLed(id, 'err'));
  }
}

// === STATS ===
/** Recalcule et affiche les stats qBittorrent (actifs, ratio moyen, vitesses DL/UP)
 *  directement depuis la liste des torrents en mémoire, sans nouvel appel API.
 *  @param {Array} torrents - Liste des torrents actifs retournée par /api/torrents */
function updateQbitStats(torrents) {
  const active   = torrents.length;
  const ratios   = torrents.map(t => t.ratio).filter(r => r > 0);
  const avgRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
  const dlSpeed  = torrents.reduce((s, t) => s + (t.dlspeed || 0), 0);
  const upSpeed  = torrents.reduce((s, t) => s + (t.upspeed || 0), 0);
  document.getElementById('s-active').textContent  = active;
  document.getElementById('s-ratio').textContent   = ratios.length ? avgRatio.toFixed(2) : '—';
  document.getElementById('s-dlspeed').textContent = fmtSpeed(dlSpeed);
  document.getElementById('s-upspeed').textContent = fmtSpeed(upSpeed);
}

/** Charge et affiche toutes les statistiques globales depuis /api/stats :
 *  torrents actifs, ratio moyen, vitesses, disque et trafic mensuel Ultra.cc. */
async function loadStats() {
  try {
    const r = await fetch(BASE + '/api/stats', { credentials: 'include' });
    if (r.status === 401) { showLogin('Session expirée'); return; }
    const d = await r.json();
    document.getElementById('s-active').textContent  = d.active ?? '—';
    document.getElementById('s-ratio').textContent   = d.avg_ratio > 0 ? d.avg_ratio.toFixed(2) : '—';
    document.getElementById('s-dlspeed').textContent = fmtSpeed(d.dl_speed || 0);
    document.getElementById('s-upspeed').textContent = fmtSpeed(d.up_speed || 0);
    if (d.disk_used_gb != null && d.disk_total_gb != null) {
      document.getElementById('s-disk').textContent     = `${d.disk_used_gb} / ${d.disk_total_gb} GB`;
      document.getElementById('s-disk-sub').textContent = `${d.disk_total_gb - d.disk_used_gb} GB libre`;
    }
    if (d.traffic_used_pct != null) {
      document.getElementById('s-traffic').textContent = `${d.traffic_used_pct} %`;
      const reset = d.traffic_reset_date
        ? new Date(d.traffic_reset_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
        : '—';
      document.getElementById('s-traffic-sub').textContent = `reset le ${reset}`;
    }
  } catch (e) { /* silencieux */ }
}

// === TOP LEECHERS ===
let topItemsCache = [];
let topSort = { col: 'leechers', dir: -1 }; // tri courant : colonne + direction (1 = asc, -1 = desc)

/** Retourne une copie triée des items selon topSort (colonne + direction courantes).
 *  Le tri sur 'name' est alphabétique ; les autres colonnes sont numériques.
 *  @param {Array} items - Items à trier */
function sortedTopItems(items) {
  const { col, dir } = topSort;
  return [...items].sort((a, b) => {
    if (col === 'name') return dir * a.name.localeCompare(b.name);
    return dir * ((a[col] || 0) - (b[col] || 0));
  });
}

/** Met à jour les indicateurs de tri (▲ / ▼) sur les en-têtes du tableau top leechers. */
function updateSortHeaders() {
  document.querySelectorAll('#top-thead th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === topSort.col) th.classList.add(topSort.dir === 1 ? 'sort-asc' : 'sort-desc');
  });
}

/** Change le tri du tableau top leechers : inverse la direction si même colonne, sinon tri
 *  décroissant par défaut (alphabétique croissant pour 'name'), puis re-rend le tableau.
 *  @param {string} col - Clé de colonne ('name', 'leechers', 'seeders', 'size') */
function sortTopBy(col) {
  topSort = { col, dir: topSort.col === col ? -topSort.dir : (col === 'name' ? 1 : -1) };
  updateSortHeaders();
  renderTopItems(filterTopItems(topItemsCache), document.getElementById('top-body'));
}

/** Annule le timer de réessai automatique du top leechers (lancé après une erreur réseau). */
function clearTopRetry() {
  clearInterval(topRetryInterval);
  topRetryInterval = null;
}

const CAT_NAMES = {
  1000: 'Consoles', 2030: 'Films', 2050: 'Vidéo-clips', 2060: 'Animé (film)',
  2070: 'Documentaires', 2080: 'Spectacles', 2090: 'Concerts', 3010: 'Musique',
  3030: 'Audiobooks', 4000: 'PC / Apps', 4050: 'Jeux PC', 5000: 'Séries TV',
  5060: 'Sport', 5070: 'Animé (série)', 5080: 'Émissions TV', 6000: 'XXX',
  6010: 'Érotisme', 7010: 'Presse', 7020: 'Livres', 7030: 'BD / Comics / Manga',
  8010: 'Impression 3D',
};

/** Reconstruit le <select> de filtre catégorie à partir des catégories présentes dans items.
 *  Conserve la valeur sélectionnée si elle existe encore après rebuild.
 *  @param {Array} items - Liste complète des items (avant filtrage catégorie) */
function buildCatFilter(items) {
  const sel = document.getElementById('f-cat');
  if (!sel) return;
  const current = sel.value;
  const cats = [...new Set(items.map(i => i.category).filter(Boolean))].sort((a, b) => a - b);
  sel.innerHTML = '<option value="">Toutes</option>' +
    cats.map(c => `<option value="${he(c)}">${he(CAT_NAMES[c] || c)}</option>`).join('');
  if (current) sel.value = current;
}

/** Retourne la catégorie actuellement sélectionnée dans le filtre du top, ou '' si 'Toutes'. */
function getActiveCat() {
  return document.getElementById('f-cat')?.value || '';
}

/** Génère et injecte le HTML du tableau top leechers après filtrage catégorie et tri.
 *  Met aussi à jour topItems (référence globale utilisée par grabOne/toggleGrab).
 *  @param {Array}       items - Items filtrés par règles (filterTopItems)
 *  @param {HTMLElement} tbody - Élément tbody cible */
function renderTopItems(items, tbody) {
  buildCatFilter(items);
  const cat = getActiveCat();
  const visible = cat ? items.filter(i => i.category === cat) : items;
  topItems = sortedTopItems(visible);
  const sa = document.getElementById('top-select-all'); if (sa) sa.checked = false;
  tbody.innerHTML = topItems.map((t, i) => {
    const sel = selectedGrab.has(t.link);
    const nameHtml = t.page_url
      ? `<a href="${he(t.page_url)}" target="_blank" rel="noopener" class="td-link">${he(t.name)}</a>`
      : he(t.name);
    return `<tr>
      <td><input type="checkbox" ${sel ? 'checked' : ''} data-idx="${i}"></td>
      <td class="col-nom"><div class="td-name" title="${he(t.name)}">${nameHtml}</div></td>
      <td class="td-size col-size">${fmtBytes(t.size)}</td>
      <td class="col-leechers"><span class="num-red">${t.leechers.toLocaleString()}</span></td>
      <td class="col-seeders"><span class="num-green">${t.seeders.toLocaleString()}</span></td>
      <td class="col-action-top"><button class="btn-sm btn-grab" data-action="grab-one" data-idx="${i}">Grab</button></td>
    </tr>`;
  }).join('');
}

/** Met à jour l'affichage "Dernier refresh" (date + type) dans la section règles auto-grab. */
function updateLastRefreshDisplay() {
  const el   = document.getElementById('autorefresh-last');
  const type = document.getElementById('autorefresh-last-type');
  if (el)   el.textContent   = lastRefreshTime ? fmtDate(lastRefreshTime) : '—';
  if (type) type.textContent = lastRefreshType ? `· ${lastRefreshType}` : '';
}

/** Met à jour la ligne "Dernière actualisation" du top et déclenche le recalcul du countdown.
 *  @param {string|null} date - Date ISO de la dernière actualisation */
function updateTopLastRefresh(date) {
  const el = document.getElementById('top-last-refresh');
  if (el) el.textContent = date ? `Dernière actualisation : ${fmtDate(date)}` : '';
  updateTopNextRefresh();
}

/** Recalcule et affiche le temps restant avant le prochain refresh automatique du top
 *  dans les deux éléments concernés (top et section auto-grab des règles). */
function updateTopNextRefresh() {
  const el  = document.getElementById('top-next-refresh');
  const el2 = document.getElementById('autograb-next-refresh');
  if (!el && !el2) return;
  if (!autoRefreshNextAt) {
    if (el)  el.textContent  = 'Prochaine : Jamais';
    if (el2) el2.textContent = 'Prochaine : Jamais';
    return;
  }
  const secs = Math.max(0, Math.round((autoRefreshNextAt - Date.now()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const txt = `Prochaine dans : ${m} min ${String(s).padStart(2, '0')} sec`;
  if (el)  el.textContent  = txt;
  if (el2) el2.textContent = txt;
}

/** Charge le dernier cache top leechers depuis /api/top-leechers/cache et l'affiche
 *  immédiatement sans déclencher un appel C411. Utilisé à l'ouverture de l'onglet top. */
async function loadTopCache() {
  try {
    const d = await fetch(`${BASE}/api/top-leechers/cache`, { credentials: 'include' }).then(r => r.json());
    updateTopLastRefresh(d.date);
    if (!d.items?.length) return;
    const items = filterTopItems(d.items);
    topItemsCache = items;
    const tbody = document.getElementById('top-body');
    if (items.length) renderTopItems(items, tbody);
  } catch (e) { console.error('[top-cache]', e); }
}

/** Déclenche un refresh complet du top leechers via /api/top-leechers.
 *  En cas d'erreur réseau, affiche les données en cache et programme un réessai toutes les secondes
 *  avec compte à rebours visible (réessai automatique après 5 min).
 *  @param {string} [source] - Origine du déclenchement : 'manuel' ou 'auto' */
async function loadTop(source = 'manuel') {
  const catSel = document.getElementById('f-cat'); if (catSel) catSel.value = '';
  lastRefreshTime = new Date().toISOString();
  lastRefreshType = source;
  localStorage.setItem('lastRefreshTime', lastRefreshTime);
  localStorage.setItem('lastRefreshType', lastRefreshType);
  updateLastRefreshDisplay();
  clearTopRetry();
  document.getElementById('top-spinner')?.classList.add('active');
  const n    = 100;
  const tbody = document.getElementById('top-body');
  if (!topItemsCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="tbl-empty">Chargement...</td></tr>`;
  }
  try {
    const r = await fetch(`${BASE}/api/top-leechers?n=${n}`, { credentials: 'include' });
    if (r.status === 401) { showLogin('Session expirée'); return; }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Erreur ${r.status}`);
    const errEl = document.getElementById('top-error-msg');
    const cacheMsg = d._cached ? 'C411 inaccessible — données en cache' : '';
    if (errEl) errEl.textContent = cacheMsg;
    const errEl2 = document.getElementById('autograb-error-msg');
    if (errEl2) errEl2.textContent = cacheMsg;
    if (d._cached && d.date) { lastRefreshTime = d.date; updateLastRefreshDisplay(); }
    const items = filterTopItems(d.items || []);
    topItemsCache = items;
    updateTopLastRefresh(d.date || lastRefreshTime);
    document.getElementById('top-spinner')?.classList.remove('active');
    if (!items.length) { tbody.innerHTML = `<tr><td colspan="6" class="tbl-empty">Aucun résultat</td></tr>`; return; }
    renderTopItems(items, tbody);
  } catch (e) {
    document.getElementById('top-spinner')?.classList.remove('active');
    if (topItemsCache.length) renderTopItems(topItemsCache, tbody);
    let remaining = 300;
    const updateMsg = () => {
      const m = Math.floor(remaining / 60);
      const s = String(remaining % 60).padStart(2, '0');
      const el = document.getElementById('top-error-msg');
      if (el) el.textContent = `Erreur — réessai dans ${m}:${s}`;
    };
    updateMsg();
    topRetryInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) { clearTopRetry(); loadTop(); }
      else updateMsg();
    }, 1000);
  }
}

/** Coche ou décoche tous les torrents visibles du top dans selectedGrab.
 *  @param {HTMLInputElement} el - La checkbox "sélectionner tout" */
function toggleSelectAll(el) {
  topItems.forEach((t, i) => {
    if (!t.link) return;
    el.checked ? selectedGrab.set(t.link, { name: t.name, infohash: t.infohash || '', category: t.category ?? null }) : selectedGrab.delete(t.link);
    const cb = document.querySelector(`#top-body input[data-idx="${i}"]`);
    if (cb) cb.checked = el.checked;
  });
}

/** Ajoute ou retire un item de la sélection multiple (selectedGrab) selon l'état de la checkbox.
 *  Met aussi à jour la checkbox "sélectionner tout" si tous les items sont sélectionnés.
 *  @param {number}           idx - Index dans topItems[]
 *  @param {HTMLInputElement} el  - La checkbox correspondant à cet item */
function toggleGrab(idx, el) {
  const t = topItems[idx];
  if (!t?.link) return;
  el.checked ? selectedGrab.set(t.link, { name: t.name, infohash: t.infohash || '' }) : selectedGrab.delete(t.link);
  const all = document.getElementById('top-select-all');
  if (all) all.checked = topItems.every(t => !t.link || selectedGrab.has(t.link));
}

/** Envoie un seul torrent du top à qBittorrent via POST /api/grab, avec son infohash
 *  pour alimenter le nameMap côté serveur.
 *  @param {number} idx - Index dans topItems[] */
async function grabOne(idx) {
  const item = topItems[idx];
  if (!item) return;
  try {
    await fetch(BASE + '/api/grab', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ url: item.link, name: item.name, page_url: item.page_url || null, infohash: item.infohash || '', category: item.category ?? null }) });
    toast('Ajouté : ' + item.name);
    loadStats();
  } catch (e) { toast('Erreur : ' + e.message, 'error'); }
}

/** Envoie en séquence tous les torrents de la sélection multiple à qBittorrent,
 *  puis vide la sélection et rafraîchit le top et les stats. */
async function grabSelected() {
  if (!selectedGrab.size) { toast('Aucun torrent sélectionné.', 'error'); return; }
  for (const [url, data] of selectedGrab) await fetch(BASE + '/api/grab', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ url, name: data.name, infohash: data.infohash, category: data.category ?? null }) });
  toast(selectedGrab.size + ' torrent(s) envoyé(s) à qBittorrent.');
  selectedGrab.clear();
  loadTop(); loadStats();
}

// === TORRENTS ACTIFS ===
let actifsHashes = '';
let actifsSortKey = localStorage.getItem('actifs-sort-key') || null;
const openChartHashes = new Set();
let actifsSortDir = parseInt(localStorage.getItem('actifs-sort-dir')) || 1;

/** Change la clé de tri des torrents actifs (inverse la direction si même clé),
 *  persiste le choix en localStorage et force un rebuild du tableau.
 *  @param {string} key - Clé de colonne ('name', 'ratio', 'added_on', etc.) */
function setActifsSort(key) {
  actifsSortDir = actifsSortKey === key ? actifsSortDir * -1 : 1;
  actifsSortKey = key;
  localStorage.setItem('actifs-sort-key', actifsSortKey);
  localStorage.setItem('actifs-sort-dir', actifsSortDir);
  actifsHashes = '';
  loadActifs();
}

/** Trie une liste de torrents selon actifsSortKey/actifsSortDir.
 *  Le tri 'status' compare le flag canDel calculé par actifsCalc().
 *  @param {Array}  torrents - Torrents à trier
 *  @param {number} ratioMin - Seuil de ratio minimum (pour calcul du statut)
 *  @param {number} seedMin  - Âge minimum en secondes (pour calcul du statut) */
function sortActifsData(torrents, ratioMin, seedMin) {
  if (!actifsSortKey) return torrents;
  return [...torrents].sort((a, b) => {
    let va, vb;
    switch (actifsSortKey) {
      case 'name':    va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'size':    va = a.size;      vb = b.size;      break;
      case 'ratio':   va = a.ratio;     vb = b.ratio;     break;
      case 'added_on': va = a.added_on; vb = b.added_on;  break;
      case 'dlspeed': va = a.dlspeed;   vb = b.dlspeed;   break;
      case 'upspeed': va = a.upspeed;   vb = b.upspeed;   break;
      case 'state':   va = a.state;     vb = b.state;     break;
      case 'status':  va = actifsCalc(a, ratioMin, seedMin).canDel ? 1 : 0;
                      vb = actifsCalc(b, ratioMin, seedMin).canDel ? 1 : 0; break;
      default: return 0;
    }
    if (va < vb) return -actifsSortDir;
    if (va > vb) return actifsSortDir;
    return 0;
  });
}

/** Reconstruit dynamiquement le <tr> d'en-tête du tableau des torrents actifs avec les
 *  indicateurs de tri (▲/▼) sur la colonne courante. Appelé à chaque loadActifs(). */
function renderActifsHeaders() {
  const cols = [
    { key: 'state',    label: 'État',   cls: 'cell-status' },
    { key: 'name',     label: 'Nom',    cls: 'col-nom' },
    { key: 'size',     label: 'Taille', cls: 'col-size' },
    { key: 'ratio',    label: 'Ratio',  cls: '' },
    { key: 'added_on', label: 'Age',    cls: 'cell-seedtime' },
    { key: 'dlspeed',  label: 'DL',     cls: 'cell-dl' },
    { key: 'upspeed',  label: 'UP',     cls: 'cell-up' },
    { key: 'status',   label: 'Statut', cls: 'cell-label' },
    { key: null,       label: '',       cls: 'cell-action-th' },
  ];
  const tr = document.querySelector('#sec-actifs thead tr');
  if (!tr) return;
  tr.innerHTML = cols.map(c => {
    const cls = c.cls ? ` class="${c.cls}"` : '';
    if (!c.key) return `<th${cls}>${c.label}</th>`;
    const arrow = actifsSortKey === c.key ? (actifsSortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th${cls} data-action="sort-actifs" data-key="${c.key}">${c.label}${arrow}</th>`;
  }).join('');
}

/** Retourne le badge HTML coloré correspondant à l'état qBittorrent d'un torrent
 *  (DL, upload, seed inactif, erreur, etc.).
 *  @param {Object} t - Objet torrent avec les champs state et progress */
function actifsStateBadge(t) {
  const pct = t.progress >= 1 ? 100 : Math.floor((t.progress || 0) * 100);
  switch (t.state) {
    case 'downloading': case 'forcedDL':
      return `<span class="badge badge-blue">DL ${pct}%</span>`;
    case 'metaDL':
      return `<span class="badge badge-blue">métadonnées</span>`;
    case 'allocating':
      return `<span class="badge badge-gray">allocation</span>`;
    case 'stalledDL':
      return `<span class="badge badge-amber">DL bloqué</span>`;
    case 'pausedDL':
      return `<span class="badge badge-gray">DL pausé</span>`;
    case 'queuedDL':
      return `<span class="badge badge-gray">DL en file</span>`;
    case 'uploading': case 'forcedUP':
      return `<span class="badge badge-green">upload ↑</span>`;
    case 'stalledUP':
      return `<span class="badge badge-gray">seed inactif</span>`;
    case 'pausedUP':
      return `<span class="badge badge-gray">seed pausé</span>`;
    case 'queuedUP':
      return `<span class="badge badge-gray">en file</span>`;
    case 'checkingDL': case 'checkingUP': case 'checkingResumeData':
      return `<span class="badge badge-gray">vérification</span>`;
    case 'moving':
      return `<span class="badge badge-gray">déplacement</span>`;
    case 'missingFiles':
      return `<span class="badge badge-amber">fichiers manquants</span>`;
    case 'error': case 'unknown':
      return `<span class="badge badge-amber">erreur</span>`;
    default:
      return t.progress < 1
        ? `<span class="badge badge-blue">DL ${pct}%</span>`
        : `<span class="badge badge-green">seed ✓</span>`;
  }
}

/** Calcule les indicateurs de suppression d'un torrent : ratio atteint, âge suffisant,
 *  pourcentage vers le ratio cible et classe CSS pour la barre de progression.
 *  @param {Object} t        - Objet torrent (ratio, added_on)
 *  @param {number} ratioMin - Seuil de ratio minimum
 *  @param {number} seedMin  - Âge minimum requis en secondes */
function actifsCalc(t, ratioMin, seedMin) {
  const ratioOk    = t.ratio >= ratioMin;
  const age        = Math.floor(Date.now() / 1000) - t.added_on;
  const timeOk     = age >= seedMin;
  const canDel     = ratioOk && timeOk;
  const pct        = Math.min(100, Math.round((t.ratio / ratioMin) * 100));
  const ratioState = ratioOk ? 'ok' : (pct > 60 ? 'warn' : 'low');
  return { ratioOk, timeOk, canDel, pct, ratioState };
}

/** Génère le HTML complet d'une ligne torrent pour le tableau des actifs.
 *  Enregistre le nom dans torrentDataMap pour le retrouver lors d'une suppression.
 *  @param {Object} t        - Objet torrent complet
 *  @param {number} ratioMin - Seuil de ratio minimum
 *  @param {number} seedMin  - Âge minimum requis en secondes */
function actifsRowHTML(t, ratioMin, seedMin) {
  const { timeOk, canDel, pct, ratioState } = actifsCalc(t, ratioMin, seedMin);
  torrentDataMap.set(t.hash, t.name);
  return `<tr data-hash="${t.hash}">
    <td class="cell-status">${actifsStateBadge(t)}</td>
    <td class="col-nom"><div class="td-name" title="${he(t.name)}"><a href="https://c411.org/torrents/${t.hash}" target="_blank" rel="noopener" class="td-link">${he(t.name)}</a></div></td>
    <td class="td-size col-size">${fmtBytes(t.size)}</td>
    <td class="cell-ratio-td ratio-state-${ratioState}"><div class="prog-wrap">
      <div class="prog-bar-bg"><div class="cell-ratio-bar prog-bar" data-pct="${pct}"></div></div>
      <span class="cell-ratio-val prog-val">${t.ratio.toFixed(2)}</span>
    </div></td>
    <td class="cell-seedtime${timeOk ? ' time-ok' : ''}" title="Seedtime : ${fmtSecs(t.seeding_time)}">${fmtAge(t.added_on)}</td>
    <td class="cell-dl">${fmtSpeed(t.dlspeed)}</td>
    <td class="cell-up">${fmtSpeed(t.upspeed)}</td>
    <td class="cell-label">${canDel ? `<span class="badge badge-amber">prêt à suppr.</span>` : `<span class="badge badge-gray">conservation</span>`}</td>
    <td class="cell-action"><span><button class="btn-del-x" data-action="delete-manual" data-hash="${t.hash}">✕</button></span></td>
  </tr>`;
}

/** Met à jour les cellules mutables d'une ligne existante sans reconstruire le DOM complet.
 *  Évite le flicker lors des rafraîchissements périodiques quand la liste de torrents n'a pas changé.
 *  @param {HTMLElement} row     - La <tr> existante dans #actifs-body
 *  @param {Object}      t       - Données torrent mises à jour
 *  @param {number}      ratioMin
 *  @param {number}      seedMin */
function actifsUpdateRow(row, t, ratioMin, seedMin) {
  const { timeOk, canDel, pct, ratioState } = actifsCalc(t, ratioMin, seedMin);
  row.querySelector('.cell-status').innerHTML = actifsStateBadge(t);
  const bar = row.querySelector('.cell-ratio-bar');
  bar.style.width = pct + '%';
  row.querySelector('.cell-ratio-td').className = 'cell-ratio-td ratio-state-' + ratioState;
  row.querySelector('.cell-ratio-val').textContent = t.ratio.toFixed(2);
  const st = row.querySelector('.cell-seedtime');
  st.textContent = fmtAge(t.added_on);
  st.className = 'cell-seedtime' + (timeOk ? ' time-ok' : '');
  st.title = 'Seedtime : ' + fmtSecs(t.seeding_time);
  row.querySelector('.cell-dl').textContent = fmtSpeed(t.dlspeed);
  row.querySelector('.cell-up').textContent = fmtSpeed(t.upspeed);
  row.querySelector('.cell-label').innerHTML = canDel
    ? `<span class="badge badge-amber">prêt à suppr.</span>`
    : `<span class="badge badge-gray">conservation</span>`;
  torrentDataMap.set(t.hash, t.name);
  row.querySelector('.cell-action').innerHTML =
    `<span><button class="btn-del-x" data-action="delete-manual" data-hash="${t.hash}">✕</button></span>`;
}

/** Charge la liste des torrents actifs depuis /api/torrents et met à jour le tableau.
 *  - Rebuild complet si la liste de hashs change (ajout/suppression de torrent ou changement de tri).
 *  - Mise à jour incrémentale (actifsUpdateRow) si la liste est identique → évite le flicker.
 *  Preserve les lignes de graphique ouvertes (openChartHashes) lors d'un rebuild. */
async function loadActifs() {
  const tbody = document.getElementById('actifs-body');
  try {
    const [tr, rr] = await Promise.all([
      fetch(BASE + '/api/torrents', { credentials: 'include' }).then(r => { if (r.status === 401) { showLogin('Session expirée'); throw new Error('401'); } return r.json(); }),
      fetch(BASE + '/api/rules', { credentials: 'include' }).then(r => r.json())
    ]);
    const torrents = tr.torrents || [];
    updateQbitStats(torrents);
    const ratioMin = rr.ratio_min || 1.0;
    const seedMin  = (rr.age_min_hours || 48) * 3600;
    renderActifsHeaders();
    if (!torrents.length) {
      actifsHashes = '';
      tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">Aucun torrent actif</td></tr>`;
      return;
    }
    // Filtre catégorie — basé sur t.category retourné par l'API (categoryMap serveur)
    const catSel = document.getElementById('f-cat-actifs');
    const catCurrent = catSel.value;
    const cats = [...new Set(torrents.map(t => t.category).filter(Boolean))].sort((a, b) => a - b);
    catSel.innerHTML = '<option value="">Toutes</option>' +
      cats.map(c => `<option value="${he(c)}">${he(CAT_NAMES[c] || c)}</option>`).join('');
    if (catCurrent) catSel.value = catCurrent;
    const activeCat = catSel.value;
    const filtered = activeCat ? torrents.filter(t => t.category === activeCat) : torrents;
    const sorted = sortActifsData(filtered, ratioMin, seedMin);
    const newHashes = sorted.map(t => t.hash).join(',') + '|' + actifsSortKey + actifsSortDir + '|' + activeCat;
    if (newHashes !== actifsHashes) {
      actifsHashes = newHashes;
      // Sauvegarder les chart-rows existants avant le rebuild pour éviter le flash
      const savedChartRows = new Map();
      for (const hash of openChartHashes) {
        const existing = tbody.querySelector(`.chart-row[data-hash="${hash}"]`);
        if (existing) savedChartRows.set(hash, existing);
      }
      tbody.innerHTML = sorted.map(t => actifsRowHTML(t, ratioMin, seedMin)).join('');
      tbody.querySelectorAll('.cell-ratio-bar[data-pct]').forEach(bar => { bar.style.width = bar.dataset.pct + '%'; });
      for (const hash of openChartHashes) {
        const dataRow = tbody.querySelector(`tr[data-hash="${hash}"]:not(.chart-row)`);
        if (!dataRow) { openChartHashes.delete(hash); continue; }
        if (savedChartRows.has(hash)) {
          dataRow.insertAdjacentElement('afterend', savedChartRows.get(hash));
        } else {
          const chartTr = document.createElement('tr');
          chartTr.className = 'chart-row'; chartTr.dataset.hash = hash;
          const td = document.createElement('td'); td.colSpan = 9;
          td.innerHTML = '<div class="chart-container"><button class="chart-expand-btn" data-action="expand-chart" data-hash="' + hash + '" title="Agrandir">⤢</button><canvas class="upload-chart"></canvas></div>';
          chartTr.appendChild(td);
          dataRow.insertAdjacentElement('afterend', chartTr);
          renderUploadChart(hash, td.querySelector('canvas'));
        }
      }
    } else {
      for (const t of sorted) {
        const row = tbody.querySelector(`tr[data-hash="${t.hash}"]`);
        if (row) actifsUpdateRow(row, t, ratioMin, seedMin);
      }
    }
  } catch (e) {
    actifsHashes = '';
    tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">Erreur API qBittorrent</td></tr>`;
  }
}

/** Supprime un torrent après confirmation via la modale générique.
 *  Utilise torrentDataMap pour afficher le nom lisible dans le message.
 *  @param {string} hash - Hash SHA1 du torrent */
async function deleteTorrent(hash) {
  const name = torrentDataMap.get(hash) || hash;
  showConfirm('Supprimer "' + name + '" ?', async () => {
    actifsHashes = '';
    await fetch(BASE + '/api/torrents/' + hash + '?name=' + encodeURIComponent(name), { method: 'DELETE', credentials: 'include' });
    loadActifs(); loadStats();
  });
}

/** Suppression manuelle d'un torrent depuis le bouton ✕ du tableau actifs.
 *  Identique à deleteTorrent mais avec un libellé de confirmation différent.
 *  @param {string} hash - Hash SHA1 du torrent */
async function deleteManual(hash) {
  const name = torrentDataMap.get(hash) || hash;
  showConfirm('Supprimer ce torrent ?\n\n"' + name + '"', async () => {
    actifsHashes = '';
    await fetch(BASE + '/api/torrents/' + hash + '?name=' + encodeURIComponent(name), { method: 'DELETE', credentials: 'include' });
    loadActifs(); loadStats();
  });
}

// === RÈGLES ===
/** Charge la configuration des règles depuis /api/rules, fusionne avec RULE_DEFS
 *  (valeurs, états on/off, displayScale), persiste une copie originale pour détection
 *  de changements, puis déclenche le rendu. */
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

/** Génère le HTML des deux groupes de règles ('cond' et 'limit') dans leurs conteneurs
 *  respectifs. Les règles liées (noToggle) sont désactivées si leur règle parente est off. */
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

/** Met à jour la valeur numérique d'une règle et déclenche l'auto-sauvegarde différée.
 *  @param {number} id - ID de la règle (index dans RULE_DEFS)
 *  @param {string|number} v - Nouvelle valeur saisie */
function updateRuleVal(id, v) { const r = rules.find(x => x.id === id); if (r) { r.val = parseFloat(v) || v; autoSave(); } }

/** Active ou désactive une règle via son toggle, re-rend les règles et auto-sauvegarde.
 *  @param {number}  id - ID de la règle
 *  @param {boolean} on - Nouvel état */
function toggleRule(id, on)   { const r = rules.find(x => x.id === id); if (r) { r.on = on; renderRules(); autoSave(); } }

/** Corrige automatiquement les règles incohérentes avant sauvegarde :
 *  - ratio_max/age_max doivent être > 0
 *  - ratio_max > ratio_min si les deux sont actifs
 *  - age_max > age_min si les deux sont actifs
 *  Retourne la liste des messages de correction appliqués (affichés en toast). */
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

/** Valide (autoFixRules), construit le payload et envoie les règles via POST /api/rules.
 *  Applique le displayScale (ex. jours → heures) avant envoi.
 *  Lance une exception en cas de réponse non-OK pour que autoSave() puisse la capturer. */
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

// === CLEANER COUNTDOWN ===
/** Met à jour l'affichage du temps restant avant la prochaine exécution du cleaner.
 *  Affiche "Prochaine : Jamais" si cleanerNextAt est nul (cleaner désactivé). */
function updateCleanerNextRun() {
  const el = document.getElementById('cleaner-next-run');
  if (!el) return;
  if (!cleanerNextAt) { el.textContent = 'Prochaine : Jamais'; return; }
  const secs = Math.max(0, Math.round((cleanerNextAt - Date.now()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  el.textContent = h > 0
    ? `Prochaine dans : ${h} h ${String(m).padStart(2,'0')} min`
    : `Prochaine dans : ${m} min ${String(s).padStart(2,'0')} sec`;
}

/** Calcule cleanerNextAt et démarre le setInterval de compte à rebours du cleaner.
 *  Priorité pour la date cible : localStorage (reload) > calculée depuis last_run > dans intervalHours.
 *  @param {string|null} lastRun       - Date ISO de la dernière exécution
 *  @param {number}      intervalHours - Intervalle configuré en heures
 *  @param {boolean}     enabled       - Cleaner activé ou non */
function applyCleanerCountdown(lastRun, intervalHours, enabled) {
  clearInterval(cleanerCountdown); cleanerCountdown = null;
  if (!enabled) {
    cleanerNextAt = null;
    localStorage.removeItem('cleanerNextAt');
    updateCleanerNextRun();
    return;
  }
  const intervalMs  = (intervalHours || 1) * 3600000;
  const stored      = parseInt(localStorage.getItem('cleanerNextAt') || '0');
  const fromLastRun = lastRun ? new Date(lastRun).getTime() + intervalMs : 0;
  // Priorité : localStorage (reload) > calculé depuis last_run > dans ~1 min si dépassé
  if (stored > Date.now()) {
    cleanerNextAt = stored;
  } else if (fromLastRun > Date.now()) {
    cleanerNextAt = fromLastRun;
    localStorage.setItem('cleanerNextAt', cleanerNextAt);
  } else {
    cleanerNextAt = Date.now() + intervalMs;
    localStorage.setItem('cleanerNextAt', cleanerNextAt);
  }
  cleanerCountdown = setInterval(updateCleanerNextRun, 1000);
  updateCleanerNextRun();
}

// === CLEANER ===
/** Charge l'état du cleaner depuis /api/cleaner/status et peuple le formulaire :
 *  checkbox activé, intervalle, date/type du dernier run, compteur supprimés, countdown. */
async function loadCleanerStatus() {
  try {
    const d = await fetch(BASE + '/api/cleaner/status', { credentials: 'include' }).then(r => r.json());
    document.getElementById('cleaner-enabled').checked   = !!d.enabled;
    document.getElementById('cleaner-interval').value    = d.interval_hours || 1;
    document.getElementById('cleaner-interval').disabled = !d.enabled;
    document.getElementById('cleaner-last-run').textContent      = fmtDate(d.last_run);
    document.getElementById('cleaner-last-count').textContent    = d.last_deleted_count ?? '—';
    document.getElementById('cleaner-last-run-type').textContent = d.last_run_type ? `· ${d.last_run_type}` : '';
    applyCleanerCountdown(d.last_run, d.interval_hours, d.enabled);
  } catch (e) { console.error('[cleaner]', e); }
}

/** Sauvegarde la planification du cleaner (interval_hours, enabled) via POST /api/cleaner/schedule,
 *  efface la date mémorisée en localStorage et recharge le statut pour recalculer le countdown. */
async function saveCleanerSchedule() {
  const interval_hours = parseInt(document.getElementById('cleaner-interval').value) || 1;
  const enabled        = document.getElementById('cleaner-enabled').checked;
  const r = await fetch(BASE + '/api/cleaner/schedule', {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'include',
    body: JSON.stringify({ interval_hours, enabled })
  });
  if (!r.ok) throw new Error(`cleaner ${r.status}`);
  localStorage.removeItem('cleanerNextAt');
  await loadCleanerStatus();
}

/** Exécute le cleaner immédiatement via POST /api/cleaner/run.
 *  Désactive le bouton pendant l'appel, affiche le résultat et recharge le statut. */
async function runCleanerNow() {
  const btn = document.getElementById('cleaner-run-btn');
  btn.disabled = true;
  btn.textContent = 'En cours...';
  try {
    const r = await fetch(BASE + '/api/cleaner/run', { method: 'POST', credentials: 'include' });
    await r.json();
    showMsg('cleaner-run-msg');
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

// === AUTO-REFRESH TOP LEECHERS ===
/** Charge la config auto-refresh depuis /api/auto-refresh et peuple le formulaire.
 *  Si startInterval est vrai, démarre également le countdown côté client.
 *  @param {boolean} [startInterval] - Démarre le timer client si true (appel initial après login) */
async function loadAutoRefreshConfig(startInterval = false) {
  try {
    const d = await fetch(BASE + '/api/auto-refresh', { credentials: 'include' }).then(r => r.json());
    document.getElementById('autorefresh-enabled').checked   = !!d.enabled;
    document.getElementById('autorefresh-interval').value    = d.interval_minutes || 15;
    document.getElementById('autorefresh-interval').disabled = !d.enabled;
    updateLastGrabDisplay(d.last_grab_count ?? 0);
    updateLastRefreshDisplay();
    if (startInterval) applyAutoRefresh(d.last_run);
  } catch (e) { console.error('[auto-refresh]', e); }
}

/** Configure les timers clients du refresh automatique du top leechers.
 *  Calcule la prochaine échéance (localStorage > last_run serveur > maintenant + intervalle),
 *  programme un premier setTimeout puis un setInterval régulier, et démarre le countdown.
 *  @param {string|null} [lastRun] - Date ISO du dernier run serveur (optionnel) */
function applyAutoRefresh(lastRun = null) {
  clearInterval(autoRefreshInterval);   autoRefreshInterval    = null;
  clearInterval(autoRefreshCountdown);  autoRefreshCountdown   = null;
  clearTimeout(autoRefreshFirstTimeout); autoRefreshFirstTimeout = null;

  const enabled    = document.getElementById('autorefresh-enabled')?.checked;
  const mins       = Math.max(1, parseInt(document.getElementById('autorefresh-interval')?.value) || 15);
  const intervalMs = mins * 60000;

  if (!enabled) {
    autoRefreshNextAt = null;
    localStorage.removeItem('autoRefreshNextAt');
    updateTopNextRefresh();
    return;
  }

  // Priorité : localStorage (page reload) > last_run serveur > maintenant
  const stored      = parseInt(localStorage.getItem('autoRefreshNextAt') || '0');
  const fromLastRun = lastRun ? new Date(lastRun).getTime() + intervalMs : 0;
  let nextAt;
  if (lastRun !== null && stored > Date.now()) {
    nextAt = stored;
  } else if (fromLastRun > Date.now()) {
    nextAt = fromLastRun;
  } else {
    nextAt = Date.now() + intervalMs;
  }

  autoRefreshNextAt = nextAt;
  localStorage.setItem('autoRefreshNextAt', autoRefreshNextAt);

  const delay = Math.max(0, autoRefreshNextAt - Date.now());

  autoRefreshFirstTimeout = setTimeout(() => {
    autoRefreshNextAt = Date.now() + intervalMs;
    localStorage.setItem('autoRefreshNextAt', autoRefreshNextAt);
    loadTop('auto');
    autoRefreshInterval = setInterval(() => {
      autoRefreshNextAt = Date.now() + intervalMs;
      localStorage.setItem('autoRefreshNextAt', autoRefreshNextAt);
      loadTop('auto');
    }, intervalMs);
  }, delay);

  autoRefreshCountdown = setInterval(updateTopNextRefresh, 1000);
  updateTopNextRefresh();
}

/** Enregistre la configuration auto-refresh (enabled + interval_minutes) via POST /api/auto-refresh.
 *  Lance une exception en cas d'erreur pour que autoSave() puisse la capturer. */
async function saveAutoRefresh() {
  const enabled          = document.getElementById('autorefresh-enabled').checked;
  const interval_minutes = Math.max(1, parseInt(document.getElementById('autorefresh-interval').value) || 15);
  const r = await fetch(BASE + '/api/auto-refresh', {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'include',
    body: JSON.stringify({ enabled, interval_minutes })
  });
  if (!r.ok) throw new Error(`auto-refresh ${r.status}`);
}

// === AUTO-GRAB ===
/** Met à jour l'affichage du compteur de torrents grabbés lors du dernier auto-grab.
 *  @param {number|null} count - Nombre de torrents grabbés (null affiche '—') */
function updateLastGrabDisplay(count) {
  const el = document.getElementById('autograb-last-count');
  if (el) el.textContent = count != null ? count : '—';
}


/** Déclenche un auto-grab via POST /api/auto-grab/run et met à jour les indicateurs
 *  de dernier refresh et du nombre de torrents ajoutés.
 *  @param {boolean} [showFeedback] - Affiche un message de résultat si true (appel manuel) */
async function triggerAutoGrab(showFeedback = false) {
  try {
    const source = showFeedback ? 'manuel' : 'auto';
    const r = await fetch(BASE + '/api/auto-grab/run', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ source }) });
    const d = await r.json();
    lastRefreshTime = new Date().toISOString();
    lastRefreshType = showFeedback ? 'manuel' : 'auto';
    localStorage.setItem('lastRefreshTime', lastRefreshTime);
    localStorage.setItem('lastRefreshType', lastRefreshType);
    updateLastRefreshDisplay();
    updateLastGrabDisplay(d.grabbed ?? 0);
    if (d.grabbed > 0) {
      const msg = document.getElementById('autograb-run-msg');
      if (msg) { msg.textContent = `${d.grabbed} ajouté(s) ✓`; showMsg('autograb-run-msg'); }
      loadStats();
    } else if (showFeedback) {
      const msg = document.getElementById('autograb-run-msg');
      if (msg) { msg.textContent = 'Aucun nouveau torrent'; showMsg('autograb-run-msg'); }
    }
  } catch (e) { console.error('[auto-grab]', e); }
}

// === HISTORIQUE ===
let histData    = [];
let histSortKey = localStorage.getItem('hist-sort-key') || 'date'; // colonne de tri courante
let histSortDir = parseInt(localStorage.getItem('hist-sort-dir')) || -1; // direction : 1=asc, -1=desc

/** Change la colonne de tri de l'historique (inverse si même colonne), persiste en localStorage
 *  et re-rend le tableau.
 *  @param {string} key - Colonne cible ('date', 'type', 'count', 'source') */
function setHistSort(key) {
  histSortDir = histSortKey === key ? histSortDir * -1 : -1;
  histSortKey = key;
  localStorage.setItem('hist-sort-key', histSortKey);
  localStorage.setItem('hist-sort-dir', histSortDir);
  renderHistory();
}

/** Trie une copie des données historique selon histSortKey et histSortDir.
 *  @param {Array} data - Entrées d'historique à trier */
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

/** Génère et injecte le tableau HTML de l'historique trié, avec badges de type,
 *  noms cliquables, source et bouton de suppression.
 *  La date est encodée en base64 dans data-date pour éviter tout caractère spécial. */
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

/** Supprime une entrée de l'historique via DELETE /api/history.
 *  La date est décodée depuis le base64 stocké dans data-date, puis filtrée localement
 *  pour mise à jour immédiate de l'affichage sans rechargement complet.
 *  @param {string} dateB64 - Date ISO encodée en base64 */
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


// Sauvegarde automatique (déclenchée à chaque changement de config)
let autoSaveTimer = null;
/** Déclenche une sauvegarde groupée différée (debounce 600 ms) des règles, du cleaner
 *  et de l'auto-refresh. En cas d'échec d'un des appels, affiche un toast d'erreur. */
function autoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      const results = await Promise.allSettled([saveRules(), saveCleanerSchedule(), saveAutoRefresh()]);
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) toast('Erreur sauvegarde : ' + (failed[0].reason?.message || 'inconnue'), 'error');
    } catch (e) {
      toast('Erreur sauvegarde : ' + e.message, 'error');
    }
  }, 600);
}

// === CONNEXIONS & API ===
/** Charge les secrets/URLs depuis /api/config/secrets et peuple les champs du formulaire.
 *  Les valeurs sensibles (apikey, password, token) sont masquées partiellement via setMask(). */
async function loadSecrets() {
  try {
    const d = await fetch(BASE + '/api/config/secrets', { credentials: 'include' }).then(r => r.json());
    document.getElementById('sec-qbit-url').value      = d.qbit_url      || '';
    document.getElementById('sec-qbit-username').value = d.qbit_username || '';
    document.getElementById('sec-ultracc-url').value   = d.ultracc_url   || '';
    const setMask = (spanId, val) => {
      const el = document.getElementById(spanId);
      if (el) el.textContent = val ? `(actuel : ${val})` : '';
    };
    setMask('sec-c411-apikey-cur',   d.c411_apikey);
    setMask('sec-qbit-password-cur', d.qbit_password);
    setMask('sec-ultracc-token-cur', d.ultracc_token);
  } catch (e) { console.error('[secrets]', e); }
}

/** Envoie uniquement les champs secrets remplis via POST /api/config/secrets.
 *  Les champs vides sont ignorés pour ne pas effacer les valeurs existantes.
 *  Vide les champs sensibles après sauvegarde et recharge les masques. */
async function saveSecrets() {
  const body = {};
  const v = (id) => document.getElementById(id).value.trim();
  if (v('sec-c411-apikey'))   body.c411_apikey   = v('sec-c411-apikey');
  if (v('sec-qbit-url'))      body.qbit_url       = v('sec-qbit-url');
  if (v('sec-qbit-username')) body.qbit_username  = v('sec-qbit-username');
  if (v('sec-qbit-password')) body.qbit_password  = v('sec-qbit-password');
  if (v('sec-ultracc-url'))   body.ultracc_url    = v('sec-ultracc-url');
  if (v('sec-ultracc-token')) body.ultracc_token  = v('sec-ultracc-token');
  if (!Object.keys(body).length) { showMsg('secrets-msg', 'Aucune modification'); return; }
  try {
    await fetch(BASE + '/api/config/secrets', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify(body) });
    document.getElementById('sec-c411-apikey').value   = '';
    document.getElementById('sec-qbit-password').value = '';
    document.getElementById('sec-ultracc-token').value = '';
    await loadSecrets();
    showMsg('secrets-msg', 'Sauvegardé ✓');
  } catch (e) { showMsg('secrets-msg', 'Erreur : ' + e.message); }
}

/** Valide et envoie un changement de mot de passe via POST /api/change-password.
 *  Vérifie la confirmation et la longueur minimale côté client avant l'appel réseau. */
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

// === THÈME ===
/** Met à jour l'icône du bouton thème (☀ en mode dark, ☽ en mode light). */
function updateThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.getElementById('btn-theme').textContent = dark ? '☀' : '☽';
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
// Formulaire de connexion : clic sur le bouton et touche Entrée dans les deux champs
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// Boutons globaux de la barre de navigation (thème et déconnexion)
document.getElementById('btn-theme').addEventListener('click', toggleTheme);
document.getElementById('btn-logout').addEventListener('click', doLogout);

// Modal graphique : fermeture en cliquant sur le fond, changement de plage temporelle, bouton ✕
document.getElementById('chart-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('chart-modal')) closeChartModal();
  const rangeBtn = e.target.closest('.btn-range');
  if (rangeBtn) {
    chartModalRange = rangeBtn.dataset.range;
    document.querySelectorAll('#chart-modal .btn-range').forEach(b => b.classList.toggle('active', b === rangeBtn));
    renderModalChart();
  }
  if (e.target.id === 'chart-modal-close') closeChartModal();
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
document.getElementById('btn-load-top').addEventListener('click', () => { loadTop(); localStorage.removeItem('autoRefreshNextAt'); applyAutoRefresh(); });
// Filtre catégorie des torrents actifs : force un rebuild complet
document.getElementById('f-cat-actifs').addEventListener('change', () => { actifsHashes = ''; loadActifs(); });
// Filtre catégorie du top leechers : re-rend depuis le cache sans appel réseau
document.getElementById('f-cat').addEventListener('change', () => {
  const tbody = document.getElementById('top-body');
  renderTopItems(topItemsCache, tbody);
});
// Envoi groupé des torrents sélectionnés dans le top
document.getElementById('btn-grab-selected').addEventListener('click', grabSelected);

// Auto-refresh : changement d'intervalle → recalcul immédiat du countdown + sauvegarde différée
document.getElementById('autorefresh-interval').addEventListener('change', () => { applyAutoRefresh(); autoSave(); });
// Auto-refresh : activation/désactivation → active/désactive le champ intervalle
document.getElementById('autorefresh-enabled').addEventListener('change', (e) => { document.getElementById('autorefresh-interval').disabled = !e.target.checked; applyAutoRefresh(); autoSave(); });
// Bouton auto-grab manuel avec feedback toast
document.getElementById('btn-auto-grab').addEventListener('click', () => triggerAutoGrab(true));

// Cleaner : changement d'intervalle → sauvegarde différée
document.getElementById('cleaner-interval').addEventListener('change', autoSave);
// Cleaner : activation/désactivation → active/désactive le champ intervalle
document.getElementById('cleaner-enabled').addEventListener('change', (e) => { document.getElementById('cleaner-interval').disabled = !e.target.checked; autoSave(); });
// Bouton d'exécution manuelle du cleaner
document.getElementById('cleaner-run-btn').addEventListener('click', runCleanerNow);

// Section connexions & API : sauvegarde des secrets et changement de mot de passe
document.getElementById('btn-save-secrets').addEventListener('click', saveSecrets);
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
      const chartTr = document.createElement('tr');
      chartTr.className = 'chart-row'; chartTr.dataset.hash = hash;
      const td = document.createElement('td'); td.colSpan = 9;
      td.innerHTML = '<div class="chart-container"><button class="chart-expand-btn" data-action="expand-chart" data-hash="' + hash + '" title="Agrandir">⤢</button><canvas class="upload-chart"></canvas></div>';
      chartTr.appendChild(td);
      row.insertAdjacentElement('afterend', chartTr);
      renderUploadChart(hash, td.querySelector('canvas'));
    }
    btn.textContent = 'Replier tout';
  }
});

// Clic dans le tableau actifs : boutons d'action (supprimer, agrandir chart) ou clic ligne → toggle graph inline
document.getElementById('actifs-body').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    if (btn.dataset.action === 'delete')        deleteTorrent(btn.dataset.hash);
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
    const chartTr = document.createElement('tr');
    chartTr.className = 'chart-row';
    chartTr.dataset.hash = hash;
    const td = document.createElement('td');
    td.colSpan = 9;
    td.innerHTML = '<div class="chart-container"><button class="chart-expand-btn" data-action="expand-chart" data-hash="' + hash + '" title="Agrandir">⤢</button><canvas class="upload-chart"></canvas></div>';
    chartTr.appendChild(td);
    row.insertAdjacentElement('afterend', chartTr);
    renderUploadChart(hash, td.querySelector('canvas'));
  }
  const allRows = [...document.querySelectorAll('#actifs-body tr[data-hash]:not(.chart-row)')];
  const toggleBtn = document.getElementById('btn-toggle-all-charts');
  toggleBtn.textContent = (allRows.length > 0 && allRows.every(r => openChartHashes.has(r.dataset.hash)))
    ? 'Replier tout' : 'Déployer tout';
});

/** Calcule un pas d'axe Y "propre" (1, 2 ou 5 × puissance de 10) donnant au plus 4 graduations.
 *  @param {number} maxVal - Valeur maximale à représenter sur l'axe */
function niceTick(maxVal) {
  if (maxVal <= 0) return 1;
  const raw = maxVal / 4;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const f of [1, 2, 5, 10]) { if (f * exp >= raw) return f * exp; }
  return exp * 10;
}

// ── Utilitaires graphique ────────────────────────────────

/** Réduit un tableau de points [timestamp, valeur] à maxPts entrées maximum par sous-échantillonnage
 *  linéaire. Conserve toujours le premier et le dernier point pour garder la plage temporelle exacte.
 *  @param {Array}  points - Points bruts
 *  @param {number} maxPts - Nombre maximum de points à retourner */
function downsamplePoints(points, maxPts) {
  if (points.length <= maxPts) return points;
  const result = [points[0]];
  const step = (points.length - 1) / (maxPts - 2);
  for (let i = 1; i < maxPts - 1; i++) result.push(points[Math.round(i * step)]);
  result.push(points[points.length - 1]);
  return result;
}

/** Formate une durée en minutes en chaîne lisible : "X min", "Xh Ymin", "Xj Yh".
 *  Utilisé pour la légende du graphique (durée de la fenêtre représentée).
 *  @param {number} winMins - Durée en minutes */
function fmtWindow(winMins) {
  if (winMins < 60) return `${winMins} minute${winMins > 1 ? 's' : ''}`;
  const h = Math.floor(winMins / 60), m = winMins % 60;
  if (h < 24) return `${h}h${m > 0 ? ` ${m}min` : ''}`;
  const d = Math.floor(h / 24), rh = h % 24;
  return `${d}j${rh > 0 ? ` ${rh}h` : ''}${m > 0 ? ` ${m}min` : ''}`;
}

/** Dessine le graphique d'upload cumulatif sur un canvas 2D.
 *  Gère le device pixel ratio, les axes Y (MB/GB) et X (heures/jours), l'aire remplie,
 *  la ligne et la légende. Retourne un état snapshot utilisé par attachChartHover().
 *  @param {HTMLCanvasElement} canvas      - Canvas cible
 *  @param {Array}             points      - Points [[timestamp, uploaded_bytes], ...]
 *  @param {number}            H           - Hauteur du canvas en pixels CSS
 *  @param {string|null}       [windowLabel] - Libellé de plage pour la légende (ex. '24h') */
function drawChartOnCanvas(canvas, points, H, windowLabel = null) {
  const base    = points[0][1];
  const rates   = points.map(([, u]) => Math.max(0, (u - base) / 1e6));
  const times   = points.map(([t]) => t);
  const totalMb = rates[rates.length - 1];
  const winMins = Math.max(1, Math.round((points[points.length-1][0] - points[0][0]) / 60));

  const dpr = window.devicePixelRatio || 1;
  const W   = (canvas.parentElement.clientWidth || 600);
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD = { top: 22, right: H > 150 ? 16 : 30, bottom: 34, left: 52 };
  const CW  = W - PAD.left - PAD.right;
  const CH  = H - PAD.top - PAD.bottom;
  const maxRate = Math.max(...rates, 0.1);
  const yStep   = niceTick(maxRate);
  const yMax    = Math.ceil(maxRate / yStep) * yStep;

  const isDark    = document.documentElement.dataset.theme === 'dark';
  const bg2       = isDark ? '#1c1c1f' : '#faf9f6';
  const textColor = isDark ? '#999'    : '#777';
  const gridColor = isDark ? '#2a2a2d' : '#ddddd8';
  const fillColor = isDark ? 'rgba(29,158,117,0.2)' : 'rgba(29,158,117,0.12)';
  const lineColor = '#1D9E75';

  ctx.fillStyle = bg2;
  ctx.fillRect(0, 0, W, H);
  ctx.font = '10px system-ui,sans-serif';

  // Grilles + labels Y
  const yTicks = Math.min(5, Math.ceil(yMax / yStep));
  for (let i = 0; i <= yTicks; i++) {
    const v = i * yStep;
    const y = PAD.top + CH - (v / yMax) * CH;
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + CW, y); ctx.stroke();
    ctx.fillStyle = textColor; ctx.textAlign = 'right';
    ctx.fillText(v >= 1000 ? (v/1000).toFixed(1)+'G' : v >= 100 ? v.toFixed(0) : v.toFixed(1), PAD.left - 4, y + 3);
  }
  ctx.save(); ctx.translate(10, PAD.top + CH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillStyle = textColor; ctx.fillText('MB', 0, 0); ctx.restore();

  // Labels axe X — ticks sur minutes/heures/jours ronds
  const tMin = times[0], tMax = times[times.length - 1];
  const spanMin = Math.round((tMax - tMin) / 60);
  const ivCandidates = [5, 10, 15, 20, 30, 60, 120, 240, 720, 1440, 4320, 10080, 43200];
  const tickIntervalMin = ivCandidates.find(iv => Math.floor(spanMin / iv) <= 5) || 43200;
  const firstTickTs = Math.ceil(tMin / (tickIntervalMin * 60)) * (tickIntervalMin * 60);
  ctx.fillStyle = textColor; ctx.textAlign = 'center';
  for (let ts = firstTickTs; ts <= tMax; ts += tickIntervalMin * 60) {
    const x  = PAD.left + ((ts - tMin) / (tMax - tMin)) * CW;
    const dd = new Date(ts * 1000);
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + CH); ctx.stroke();
    const lbl = tickIntervalMin >= 1440
      ? `${dd.getDate()}/${dd.getMonth()+1}`
      : String(dd.getHours()).padStart(2,'0') + ':' + String(dd.getMinutes()).padStart(2,'0');
    ctx.fillText(lbl, x, H - 6);
  }

  // Aire + ligne
  ctx.beginPath();
  rates.forEach((v, i) => {
    const x = PAD.left + (i / Math.max(rates.length - 1, 1)) * CW;
    const y = PAD.top + CH - (v / yMax) * CH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(PAD.left + CW, PAD.top + CH);
  ctx.lineTo(PAD.left, PAD.top + CH);
  ctx.closePath(); ctx.fillStyle = fillColor; ctx.fill();
  ctx.beginPath();
  rates.forEach((v, i) => {
    const x = PAD.left + (i / Math.max(rates.length - 1, 1)) * CW;
    const y = PAD.top + CH - (v / yMax) * CH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5; ctx.stroke();

  // Légende
  const totalStr = totalMb >= 1000 ? (totalMb/1000).toFixed(2)+' GB' : totalMb.toFixed(0)+' MB';
  ctx.fillStyle = textColor; ctx.textAlign = 'right'; ctx.font = '10px system-ui,sans-serif';
  ctx.fillText(`${totalStr} uploadés sur ${windowLabel || fmtWindow(winMins)}`, PAD.left + CW, PAD.top - 6);

  const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { snapshot, ctx, PAD, CW, CH, rates, times, yMax, W, H, isDark, lineColor };
}

/** Attache les gestionnaires mousemove/mouseleave pour afficher un tooltip au survol du graphique.
 *  Utilise un AbortSignal pour pouvoir détacher proprement les handlers lors d'un re-rendu.
 *  @param {HTMLCanvasElement} canvas - Canvas sur lequel écouter
 *  @param {Object}            state  - Résultat retourné par drawChartOnCanvas()
 *  @param {AbortSignal}       signal - Signal d'annulation (AbortController.signal) */
function attachChartHover(canvas, state, signal) {
  const { snapshot, ctx, PAD, CW, CH, rates, times, yMax, W, isDark, lineColor } = state;
  function drawHover(mouseX) {
    const relX = mouseX - PAD.left;
    if (relX < 0 || relX > CW) return;
    const idx = Math.round((relX / CW) * (rates.length - 1));
    const px  = PAD.left + (idx / Math.max(rates.length - 1, 1)) * CW;
    const val = rates[idx];
    const py  = PAD.top + CH - (val / yMax) * CH;
    const dd  = new Date(times[idx] * 1000);
    const timeStr = String(dd.getHours()).padStart(2,'0') + ':' + String(dd.getMinutes()).padStart(2,'0');
    const valStr  = val >= 1000 ? (val/1000).toFixed(2)+' GB' : val.toFixed(1)+' MB';
    ctx.putImageData(snapshot, 0, 0);
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + CH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor; ctx.fill();
    ctx.strokeStyle = isDark ? '#1c1c1f' : '#faf9f6'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = '10px system-ui,sans-serif';
    const label = `${timeStr}  ${valStr}`;
    const tW = ctx.measureText(label).width + 12, tH = 18;
    let tx = px + 8;
    if (tx + tW > W - 4) tx = px - tW - 8;
    const ty = Math.max(PAD.top, py - tH / 2 - 1);
    ctx.fillStyle = isDark ? 'rgba(40,40,44,0.92)' : 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(tx, ty, tW, tH, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = isDark ? '#e5e5e7' : '#1c1c1f'; ctx.textAlign = 'left';
    ctx.fillText(label, tx + 6, ty + 12);
  }
  canvas.addEventListener('mousemove', e => {
    drawHover(e.clientX - canvas.getBoundingClientRect().left);
  }, { signal });
  canvas.addEventListener('mouseleave', () => ctx.putImageData(snapshot, 0, 0), { signal });
}

/** Charge l'historique d'upload d'un torrent via /api/upload-history/:hash et dessine le graphique
 *  sur le canvas inline de la ligne chart-row. Filtre les données aux dernières 24h.
 *  Annule les anciens handlers hover via AbortController avant chaque nouveau dessin.
 *  @param {string}            hash   - Hash SHA1 du torrent
 *  @param {HTMLCanvasElement} canvas - Canvas de la chart-row */
async function renderUploadChart(hash, canvas) {
  const container = canvas.parentElement;
  try {
    const d = await fetch(BASE + '/api/upload-history/' + hash, { credentials: 'include' }).then(r => r.json());
    const allPoints = d.points || [];
    if (allPoints.length < 2) {
      container.innerHTML = '<div class="chart-empty">Collecte en cours… (données disponibles après 5 min)</div>';
      return;
    }
    if (canvas._hoverAC) { canvas._hoverAC.abort(); }
    const ac = new AbortController();
    canvas._hoverAC = ac;
    const cutoff = (allPoints.length ? allPoints[allPoints.length-1][0] : 0) - 86400;
    const windowed = allPoints.filter(([t]) => t >= cutoff);
    const state = drawChartOnCanvas(canvas, downsamplePoints(windowed.length >= 2 ? windowed : allPoints, 600), 150);
    attachChartHover(canvas, state, ac.signal);
  } catch {
    container.innerHTML = '<div class="chart-empty">Erreur chargement</div>';
  }
}

// ── Modal graphique (desktop uniquement) ─────────────────

let chartModalHash    = null;
let chartModalPoints  = null;
let chartModalRange   = 'all';
let chartModalHoverAC = null;

/** Filtre les points d'historique selon la plage temporelle sélectionnée dans la modal.
 *  @param {Array}  points - Points bruts [[timestamp, bytes], ...]
 *  @param {string} range  - Plage : 'all', '1h', '6h', '24h', '7d', '30d' */
function filterByRange(points, range) {
  if (range === 'all' || !points.length) return points;
  const secs = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
  const cutoff = points[points.length-1][0] - (secs[range] || 0);
  return points.filter(([t]) => t >= cutoff);
}

/** Re-dessine le graphique de la modal avec la plage temporelle courante (chartModalRange).
 *  Annule les anciens handlers hover avant chaque dessin via AbortController. */
function renderModalChart() {
  if (!chartModalPoints || chartModalPoints.length < 2) return;
  const filtered = filterByRange(chartModalPoints, chartModalRange);
  if (filtered.length < 2) return;
  if (chartModalHoverAC) { chartModalHoverAC.abort(); }
  chartModalHoverAC = new AbortController();
  const canvas = document.getElementById('chart-modal-canvas');
  const rangeLabels = { '1h':'1h', '6h':'6h', '24h':'24h', '7d':'7j', '30d':'30j' };
  const state  = drawChartOnCanvas(canvas, downsamplePoints(filtered, 1200), 360, rangeLabels[chartModalRange] || null);
  attachChartHover(canvas, state, chartModalHoverAC.signal);
}

/** Ouvre la modal graphique plein écran pour un torrent donné.
 *  Charge les points d'historique depuis l'API et dessine le graphique sur la plage 'all'.
 *  @param {string} hash - Hash SHA1 du torrent */
async function openChartModal(hash) {
  chartModalHash  = hash;
  chartModalRange = 'all';
  document.getElementById('chart-modal-title').textContent = torrentDataMap.get(hash) || hash;
  document.querySelectorAll('#chart-modal .btn-range').forEach(b => {
    b.classList.toggle('active', b.dataset.range === 'all');
  });
  document.getElementById('chart-modal').classList.add('open');
  try {
    const d = await fetch(BASE + '/api/upload-history/' + hash, { credentials: 'include' }).then(r => r.json());
    chartModalPoints = d.points || [];
  } catch { chartModalPoints = []; }
  renderModalChart();
}

/** Ferme la modal graphique et annule les handlers hover en cours via AbortController. */
function closeChartModal() {
  document.getElementById('chart-modal').classList.remove('open');
  if (chartModalHoverAC) { chartModalHoverAC.abort(); chartModalHoverAC = null; }
}

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
function startPolling() {
  // Rafraîchissement des torrents actifs uniquement si l'onglet est visible
  setInterval(() => {
    if (document.getElementById('sec-actifs')?.classList.contains('active')) loadActifs();
  }, 5000);
  // Vérification des connexions (LEDs) toutes les 30 secondes
  setInterval(loadConnections, 30000);
  // Rafraîchissement des stats globales (disque, trafic) toutes les 60 secondes
  setInterval(loadStats, 60000);
}

// === INIT ===
// Point d'entrée : vérifie la session, et si valide, initialise toute l'application
checkAuth().then(async authenticated => {
  if (authenticated) {
    loadStats();
    loadConnections();
    loadAutoRefreshConfig(true);
    startPolling();
    await loadRules();
    switchTab(localStorage.getItem('active-tab') || 'top');
  }
});
