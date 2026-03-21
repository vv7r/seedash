'use strict';
// === TOP LEECHERS & AUTO-REFRESH ===

// État local du top leechers
let topItemsCache = [];
let topSort = { col: 'leechers', dir: -1 };
let lastRefreshTime = localStorage.getItem('lastRefreshTime') || null;
let lastRefreshType = localStorage.getItem('lastRefreshType') || null;
let topRetryInterval = null;

// Timers auto-refresh
let autoRefreshInterval     = null;
let autoRefreshNextAt       = null;
let autoRefreshCountdown    = null;
let autoRefreshFirstTimeout = null;
let autoRefreshTimerEnabled  = false;
let autoRefreshIntervalHours = 1;

// === TRI ===

/** Retourne une copie triée des items selon topSort (colonne + direction courantes). */
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

/** Change le tri du tableau top leechers et re-rend le tableau.
 *  @param {string} col - Clé de colonne ('name', 'leechers', 'seeders', 'size') */
function sortTopBy(col) {
  topSort = { col, dir: topSort.col === col ? -topSort.dir : (col === 'name' ? 1 : -1) };
  updateSortHeaders();
  renderTopItems(filterTopItems(topItemsCache), document.getElementById('top-body'));
}

/** Annule le timer de réessai automatique du top leechers. */
function clearTopRetry() {
  clearInterval(topRetryInterval);
  topRetryInterval = null;
}

// === FILTRAGE ===
// getRuleVal() et filterTopItems() sont déclarées dans app.js (chargé après).

// === CATÉGORIE ===

/** Reconstruit le <select> de filtre catégorie à partir des catégories présentes dans items. */
function buildCatFilter(items) {
  const sel = document.getElementById('f-cat');
  if (!sel) return;
  const current = sel.value;
  const cats = [...new Set(items.map(i => i.category).filter(Boolean))].sort((a, b) => a - b);
  sel.innerHTML = '<option value="">Toutes</option>' +
    cats.map(c => `<option value="${he(c)}">${he(CAT_NAMES[c] || c)}</option>`).join('');
  if (current) sel.value = current;
}

/** Retourne la catégorie actuellement sélectionnée dans le filtre du top. */
function getActiveCat() {
  return document.getElementById('f-cat')?.value || '';
}

// === RENDU ===

/** Génère et injecte le HTML du tableau top leechers après filtrage catégorie et tri.
 *  Met aussi à jour topItems (référence globale déclarée dans app.js).
 *  @param {Array}       items - Items filtrés par règles
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

// === AFFICHAGE DATES ===

/** Met à jour l'affichage "Dernier refresh" (date + type) dans la section règles auto-grab. */
function updateLastRefreshDisplay() {
  const el   = document.getElementById('autorefresh-last');
  const type = document.getElementById('autorefresh-last-type');
  if (el)   el.textContent   = lastRefreshTime ? fmtDate(lastRefreshTime) : '—';
  if (type) type.textContent = lastRefreshType ? `· ${lastRefreshType}` : '';
}

/** Met à jour la ligne "Dernière actualisation" du top et déclenche le recalcul du countdown. */
function updateTopLastRefresh(date) {
  const el = document.getElementById('top-last-refresh');
  if (el) el.textContent = date ? `Dernière actualisation : ${fmtDate(date)}` : '';
  updateTopNextRefresh();
}

/** Recalcule et affiche le temps restant avant le prochain refresh automatique du top. */
function updateTopNextRefresh() {
  const el = document.getElementById('top-next-refresh');
  if (!el) return;
  if (!autoRefreshNextAt) { el.textContent = 'Prochaine : Jamais'; return; }
  const secs = Math.max(0, Math.round((autoRefreshNextAt - Date.now()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  el.textContent = h > 0
    ? `Prochaine dans : ${h} h ${String(m).padStart(2,'0')} min`
    : `Prochaine dans : ${m} min ${String(s).padStart(2,'0')} sec`;
}

// === CHARGEMENT ===

/** Charge le dernier cache top leechers depuis /api/top-leechers/cache et l'affiche
 *  immédiatement sans déclencher un appel C411. */
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
 *  En cas d'erreur réseau, programme un réessai avec compte à rebours.
 *  @param {string} [source] - Origine du déclenchement : 'manuel' ou 'auto' */
async function loadTop(source = 'manuel') {
  const catSel = document.getElementById('f-cat'); if (catSel) catSel.value = '';
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
    if (d._cached && d.date) { lastRefreshTime = d.date; }
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

// === SÉLECTION ===

/** Coche ou décoche tous les torrents visibles du top dans selectedGrab. */
function toggleSelectAll(el) {
  topItems.forEach((t, i) => {
    if (!t.link) return;
    el.checked ? selectedGrab.set(t.link, { name: t.name, infohash: t.infohash || '', category: t.category ?? null }) : selectedGrab.delete(t.link);
    const cb = document.querySelector(`#top-body input[data-idx="${i}"]`);
    if (cb) cb.checked = el.checked;
  });
}

/** Ajoute ou retire un item de la sélection multiple (selectedGrab) selon l'état de la checkbox. */
function toggleGrab(idx, el) {
  const t = topItems[idx];
  if (!t?.link) return;
  el.checked ? selectedGrab.set(t.link, { name: t.name, infohash: t.infohash || '', category: t.category ?? null }) : selectedGrab.delete(t.link);
  const all = document.getElementById('top-select-all');
  if (all) all.checked = topItems.every(t => !t.link || selectedGrab.has(t.link));
}

/** Envoie un seul torrent du top à qBittorrent via POST /api/grab. */
async function grabOne(idx) {
  const item = topItems[idx];
  if (!item) return;
  try {
    await fetchT(BASE + '/api/grab', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ url: item.link, name: item.name, page_url: item.page_url || null, infohash: item.infohash || '', category: item.category ?? null }) });
    toast('Ajouté : ' + item.name);
    loadStats();
  } catch (e) { toast('Erreur : ' + e.message, 'error'); }
}

/** Envoie en séquence tous les torrents de la sélection multiple à qBittorrent. */
async function grabSelected() {
  if (!selectedGrab.size) { toast('Aucun torrent sélectionné.', 'error'); return; }
  for (const [url, data] of selectedGrab) await fetchT(BASE + '/api/grab', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ url, name: data.name, infohash: data.infohash, category: data.category ?? null }) });
  toast(selectedGrab.size + ' torrent(s) envoyé(s) à qBittorrent.');
  selectedGrab.clear();
  loadTop(); loadStats();
}

// === AUTO-REFRESH ===

/** Met à jour l'affichage du compteur de torrents grabbés lors du dernier auto-grab. */
function updateLastGrabDisplay(count) {
  const el = document.getElementById('autograb-last-count');
  if (el) el.textContent = count != null ? count : '—';
}

/** Charge la config auto-refresh depuis /api/auto-refresh et peuple le formulaire.
 *  @param {boolean} [startInterval] - Démarre le timer client si true */
async function loadAutoRefreshConfig(startInterval = false) {
  try {
    const d = await fetchT(BASE + '/api/auto-refresh', { credentials: 'include' }).then(r => r.json());
    document.getElementById('autorefresh-enabled').checked = !!d.grab_enabled;
    autoRefreshTimerEnabled  = !!d.timer_enabled;
    autoRefreshIntervalHours = d.timer_interval_hours || 1;
    const serverDate = d.last_run || d.top_cache_date;
    if (serverDate) {
      const serverTime = new Date(serverDate).getTime();
      const localTime  = lastRefreshTime ? new Date(lastRefreshTime).getTime() : 0;
      if (serverTime > localTime) {
        lastRefreshTime = serverDate;
        lastRefreshType = d.last_run_source || 'auto';
        localStorage.setItem('lastRefreshTime', lastRefreshTime);
        localStorage.setItem('lastRefreshType', lastRefreshType);
        updateLastGrabDisplay(d.last_grab_count ?? 0);
      }
    }
    if (d.top_cache_date) updateTopLastRefresh(d.top_cache_date);
    updateLastRefreshDisplay();
    if (startInterval) applyAutoRefresh(d.last_run);
  } catch (e) { console.error('[auto-refresh]', e); }
}

/** Configure les timers clients du refresh automatique du top leechers.
 *  L'intervalle et l'état enabled proviennent de la config Timer (autoRefreshTimerEnabled / Hours).
 *  @param {string|null} [lastRun] - Date ISO du dernier run serveur */
function applyAutoRefresh(lastRun = null) {
  clearInterval(autoRefreshInterval);    autoRefreshInterval    = null;
  clearInterval(autoRefreshCountdown);   autoRefreshCountdown   = null;
  clearTimeout(autoRefreshFirstTimeout); autoRefreshFirstTimeout = null;

  if (!autoRefreshTimerEnabled) {
    autoRefreshNextAt = null;
    localStorage.removeItem('autoRefreshNextAt');
    updateTopNextRefresh();
    return;
  }

  const intervalMs = autoRefreshIntervalHours * 3600000;
  // Source de vérité partagée avec la card Timer (timerNextAt)
  const timerStored = parseInt(localStorage.getItem('timerNextAt') || '0');
  const fromLastRun = lastRun ? new Date(lastRun).getTime() + intervalMs : 0;
  let nextAt;
  if (timerStored > Date.now()) {
    nextAt = timerStored;                          // en sync avec la card Timer
  } else if (fromLastRun > Date.now()) {
    nextAt = fromLastRun;
  } else {
    nextAt = Date.now() + intervalMs;
  }

  autoRefreshNextAt = nextAt;

  const delay = Math.max(0, autoRefreshNextAt - Date.now());

  autoRefreshFirstTimeout = setTimeout(() => {
    autoRefreshNextAt = Date.now() + intervalMs;
    localStorage.setItem('timerNextAt', autoRefreshNextAt); // maintient la synchro
    loadTop('auto');
    autoRefreshInterval = setInterval(() => {
      autoRefreshNextAt = Date.now() + intervalMs;
      localStorage.setItem('timerNextAt', autoRefreshNextAt);
      loadTop('auto');
    }, intervalMs);
  }, delay);

  autoRefreshCountdown = setInterval(updateTopNextRefresh, 1000);
  updateTopNextRefresh();
}

/** Enregistre l'état du toggle grab via POST /api/auto-refresh. */
async function saveAutoRefresh() {
  const enabled = document.getElementById('autorefresh-enabled').checked;
  const r = await fetchT(BASE + '/api/auto-refresh', {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'include',
    body: JSON.stringify({ enabled })
  });
  if (!r.ok) throw new Error(`auto-refresh ${r.status}`);
}

/** Déclenche un auto-grab via POST /api/auto-grab/run. */
async function triggerAutoGrab(showFeedback = false) {
  try {
    const source = showFeedback ? 'manuel' : 'auto';
    const r = await fetchT(BASE + '/api/auto-grab/run', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ source }) });
    const d = await r.json();
    lastRefreshTime = new Date().toISOString();
    lastRefreshType = showFeedback ? 'manuel' : 'auto';
    localStorage.setItem('lastRefreshTime', lastRefreshTime);
    localStorage.setItem('lastRefreshType', lastRefreshType);
    localStorage.removeItem('autoRefreshNextAt');
    applyAutoRefresh(lastRefreshTime);
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
