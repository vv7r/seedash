// === CONFIG ===
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

function authHeaders() {
  return { 'Content-Type': 'application/json' };
}

function showLogin(msg) {
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('btn-logout').style.display = 'none';
  if (msg) { document.getElementById('login-error').textContent = msg; }
}

function hideLogin() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('btn-logout').style.display = '';
}

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
    setInterval(loadStats, 5000);
    setInterval(loadConnections, 30000);
    switchTab(localStorage.getItem('active-tab') || 'top');
  } catch (e) {
    document.getElementById('login-error').textContent = 'Erreur réseau';
  }
}

async function doLogout() {
  await fetch(BASE + '/api/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  showLogin();
}

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
let actifsInterval = null;
let autoRefreshInterval = null;
let lastRefreshTime = localStorage.getItem('lastRefreshTime') || null;
let lastRefreshType = localStorage.getItem('lastRefreshType') || null;
let topRetryInterval = null;

// === UTILS ===
function he(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Liste fixe ordonnée des règles
const RULE_DEFS = [
  { group: 'cond',  key: 'ratio_min',         name: 'Ratio minimum',          desc: 'Supprimer si ratio ≥ seuil',                                              unit: '',     step: 0.1, min: 0, defVal: 1.0,  defOn: true  },
  { group: 'cond',  key: 'ratio_max',         name: 'Ratio maximum',          desc: 'Force la suppression malgré les autres règles si le ratio dépasse N',       unit: '',     step: 0.1, min: 0, defVal: 5.0,  defOn: false },
  { group: 'cond',  key: 'age_min_hours',     name: 'Âge minimum',            desc: 'Supprimer si le torrent a été ajouté il y a plus de N heures',             unit: 'h',    step: 1,   min: 0, defVal: 48,   defOn: true  },
  { group: 'cond',  key: 'age_max_hours',     name: 'Âge maximum',            desc: 'Force la suppression malgré les autres règles si l\'âge dépasse N heures', unit: 'h',    step: 1,   min: 0, defVal: 336,  defOn: false },
  { group: 'limit', key: 'grab_limit_per_day', name: 'Grab automatique / jour', desc: 'Nombre max de torrents grabbés par jour',                                 unit: '/jour', step: 1,  min: 1, defVal: 20,   defOn: true  },
  { group: 'limit', key: 'size_max_gb',       name: 'Taille max par torrent', desc: 'Ignorer les torrents plus lourds',                                          unit: 'GB',   step: 1,   min: 1, defVal: 100,  defOn: true  },
  { group: 'limit', key: 'active_max',        name: 'Max torrents simultanés', desc: 'File d\'attente si limite atteinte',                                       unit: '',     step: 1,   min: 1, defVal: 15,   defOn: false },
  { group: 'limit', key: 'min_leechers',      name: 'Leechers minimum',       desc: 'Ignorer les torrents avec moins de N leechers',                            unit: '',     step: 1,   min: 0, defVal: 5,    defOn: false },
  { group: 'limit', key: 'min_seeders',       name: 'Seeders minimum',        desc: 'Ignorer les torrents avec moins de N seeders',                             unit: '',     step: 1,   min: 0, defVal: 3,    defOn: false },
];

function fmtBytes(b) {
  if (!b) return '—';
  if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6)  return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
  return bps + ' B/s';
}
function fmtSecs(s) {
  if (!s) return '0h';
  const h = Math.floor(s / 3600);
  if (h >= 24) return Math.floor(h / 24) + 'j ' + (h % 24) + 'h';
  return h + 'h';
}
function fmtAge(added_on) {
  if (!added_on) return '—';
  const secs = Math.floor(Date.now() / 1000) - added_on;
  return fmtSecs(secs);
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function showMsg(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  if (text !== undefined) el.textContent = text;
  el.style.opacity = 1;
  setTimeout(() => el.style.opacity = 0, 2500);
}

// === MODAL ===
let pendingConfirm = null;

function showConfirm(msg, onConfirm, confirmLabel = 'Supprimer') {
  pendingConfirm = onConfirm;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-confirm').textContent = confirmLabel;
  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  pendingConfirm = null;
}

// === TOAST ===
let toastTimer = null;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), type === 'error' ? 7000 : 3500);
}

// === TABS ===
function switchTab(name) {
  localStorage.setItem('active-tab', name);
  document.querySelectorAll('.tab[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById('sec-' + name).classList.add('active');
  clearInterval(actifsInterval); actifsInterval = null;
  if (name === 'top')        loadTopCache();
  if (name === 'actifs')     { loadActifs(); actifsInterval = setInterval(loadActifs, 5000); }
  if (name === 'regles')     { loadRules(); loadCleanerStatus(); loadAutoRefreshConfig(); loadAutoGrabStatus(); loadSecrets(); }
  if (name === 'historique') loadHistory();
}

// === CONNEXIONS LED ===
const ledState = { 'led-c411': null, 'led-qbit': null, 'led-ultracc': null };
function setLed(id, state) {
  const el = document.getElementById(id);
  if (el) el.className = 'led led-' + state;
  ledState[id] = state;
}
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
async function loadStats() {
  try {
    const r = await fetch(BASE + '/api/stats', { credentials: 'include' });
    if (r.status === 401) { showLogin('Session expirée'); return; }
    const d = await r.json();
    document.getElementById('s-active').textContent  = d.active ?? '—';
    document.getElementById('s-ratio').textContent   = d.avg_ratio != null ? d.avg_ratio.toFixed(2) : '—';
    document.getElementById('s-dlspeed').textContent = fmtSpeed(d.dl_speed);
    document.getElementById('s-upspeed').textContent = fmtSpeed(d.up_speed);
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
let topSort = { col: 'leechers', dir: -1 };

function sortedTopItems(items) {
  const { col, dir } = topSort;
  return [...items].sort((a, b) => {
    if (col === 'name') return dir * a.name.localeCompare(b.name);
    return dir * ((a[col] || 0) - (b[col] || 0));
  });
}

function updateSortHeaders() {
  document.querySelectorAll('#top-thead th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === topSort.col) th.classList.add(topSort.dir === 1 ? 'sort-asc' : 'sort-desc');
  });
}

function sortTopBy(col) {
  topSort = { col, dir: topSort.col === col ? -topSort.dir : (col === 'name' ? 1 : -1) };
  updateSortHeaders();
  const minL = parseInt(document.getElementById('f-leech').value) || 0;
  renderTopItems(topItemsCache.filter(i => i.leechers >= minL), document.getElementById('top-body'));
}

function clearTopRetry() {
  clearInterval(topRetryInterval);
  topRetryInterval = null;
}

function renderTopItems(items, tbody) {
  topItems = sortedTopItems(items);
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
      <td><span class="num-red">${t.leechers.toLocaleString()}</span></td>
      <td class="col-seeders"><span class="num-green">${t.seeders.toLocaleString()}</span></td>
      <td><button class="btn-sm" data-action="grab-one" data-idx="${i}">Grab</button></td>
    </tr>`;
  }).join('');
}

function updateLastRefreshDisplay() {
  const el   = document.getElementById('autorefresh-last');
  const type = document.getElementById('autorefresh-last-type');
  if (el)   el.textContent   = lastRefreshTime ? fmtDate(lastRefreshTime) : '—';
  if (type) type.textContent = lastRefreshType ? `· ${lastRefreshType}` : '';
}

function updateTopLastRefresh(date) {
  const el = document.getElementById('top-last-refresh');
  if (el) el.textContent = date ? `Dernière actualisation : ${fmtDate(date)}` : '';
}

async function loadTopCache() {
  try {
    const d = await fetch(`${BASE}/api/top-leechers/cache`, { credentials: 'include' }).then(r => r.json());
    updateTopLastRefresh(d.date);
    if (!d.items?.length) return;
    const minL  = parseInt(document.getElementById('f-leech').value) || 0;
    const items = d.items.filter(i => i.leechers >= minL);
    topItemsCache = items;
    const tbody = document.getElementById('top-body');
    if (items.length) renderTopItems(items, tbody);
  } catch (e) { console.error('[top-cache]', e); }
}

async function loadTop(source = 'manuel') {
  lastRefreshTime = new Date().toISOString();
  lastRefreshType = source;
  localStorage.setItem('lastRefreshTime', lastRefreshTime);
  localStorage.setItem('lastRefreshType', lastRefreshType);
  updateLastRefreshDisplay();
  clearTopRetry();
  document.getElementById('top-spinner')?.classList.add('active');
  const n    = document.getElementById('f-top').value;
  const cat  = document.getElementById('f-cat').value;
  const minL = parseInt(document.getElementById('f-leech').value) || 0;
  const tbody = document.getElementById('top-body');
  if (!topItemsCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text3)">Chargement...</td></tr>`;
  }
  try {
    const r = await fetch(`${BASE}/api/top-leechers?n=${n}&cat=${encodeURIComponent(cat)}`, { credentials: 'include' });
    if (r.status === 401) { showLogin('Session expirée'); return; }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Erreur ${r.status}`);
    const errEl = document.getElementById('top-error-msg');
    if (errEl) errEl.textContent = '';
    const items = (d.items || []).filter(i => i.leechers >= minL);
    topItemsCache = items;
    updateTopLastRefresh(d.date || lastRefreshTime);
    document.getElementById('top-spinner')?.classList.remove('active');
    if (!items.length) { tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text3)">Aucun résultat</td></tr>`; return; }
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

function toggleSelectAll(el) {
  topItems.forEach((t, i) => {
    if (!t.link) return;
    el.checked ? selectedGrab.set(t.link, { name: t.name, infohash: t.infohash || '' }) : selectedGrab.delete(t.link);
    const cb = document.querySelector(`#top-body input[data-idx="${i}"]`);
    if (cb) cb.checked = el.checked;
  });
}

function toggleGrab(idx, el) {
  const t = topItems[idx];
  if (!t?.link) return;
  el.checked ? selectedGrab.set(t.link, { name: t.name, infohash: t.infohash || '' }) : selectedGrab.delete(t.link);
  const all = document.getElementById('top-select-all');
  if (all) all.checked = topItems.every(t => !t.link || selectedGrab.has(t.link));
}

async function grabOne(idx) {
  const item = topItems[idx];
  if (!item) return;
  try {
    await fetch(BASE + '/api/grab', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ url: item.link, name: item.name, page_url: item.page_url || null, infohash: item.infohash || '' }) });
    toast('Ajouté : ' + item.name);
    loadStats();
  } catch (e) { toast('Erreur : ' + e.message, 'error'); }
}

async function grabSelected() {
  if (!selectedGrab.size) { toast('Aucun torrent sélectionné.', 'error'); return; }
  for (const [url, data] of selectedGrab) await fetch(BASE + '/api/grab', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ url, name: data.name, infohash: data.infohash }) });
  toast(selectedGrab.size + ' torrent(s) envoyé(s) à qBittorrent.');
  selectedGrab.clear();
  loadTop(); loadStats();
}

// === TORRENTS ACTIFS ===
let actifsHashes = '';
let actifsSortKey = localStorage.getItem('actifs-sort-key') || null;
let actifsSortDir = parseInt(localStorage.getItem('actifs-sort-dir')) || 1;

function setActifsSort(key) {
  actifsSortDir = actifsSortKey === key ? actifsSortDir * -1 : 1;
  actifsSortKey = key;
  localStorage.setItem('actifs-sort-key', actifsSortKey);
  localStorage.setItem('actifs-sort-dir', actifsSortDir);
  actifsHashes = '';
  loadActifs();
}

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

function renderActifsHeaders() {
  const cols = [
    { key: 'state',    label: 'État',   cls: '' },
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

const DL_STATES = ['downloading', 'stalledDL', 'checkingDL', 'metaDL', 'allocating'];

function actifsStateBadge(t) {
  const pct = Math.round((t.progress || 0) * 100);
  if (t.state === 'error' || t.state === 'unknown')
    return `<span class="badge badge-amber">erreur</span>`;
  if (DL_STATES.includes(t.state) || t.progress < 1)
    return `<span class="badge badge-blue">DL ${pct}%</span>`;
  if (['stalledUP', 'pausedUP', 'queuedUP', 'checkingUP'].includes(t.state))
    return `<span class="badge badge-gray">en attente</span>`;
  return `<span class="badge badge-green">seed ✓</span>`;
}

function actifsCalc(t, ratioMin, seedMin) {
  const ratioOk    = t.ratio >= ratioMin;
  const age        = Math.floor(Date.now() / 1000) - t.added_on;
  const timeOk     = age >= seedMin;
  const canDel     = ratioOk && timeOk;
  const pct        = Math.min(100, Math.round((t.ratio / ratioMin) * 100));
  const barColor   = ratioOk ? '#1D9E75' : (pct > 60 ? '#c97d10' : '#c03030');
  const ratioColor = ratioOk ? 'var(--green)' : (pct > 60 ? 'var(--amber-text)' : 'var(--red-text)');
  return { ratioOk, timeOk, canDel, pct, barColor, ratioColor };
}

function actifsRowHTML(t, ratioMin, seedMin) {
  const { ratioOk, timeOk, canDel, pct, barColor, ratioColor } = actifsCalc(t, ratioMin, seedMin);
  torrentDataMap.set(t.hash, t.name);
  const suppBtn = canDel
    ? `<button class="btn-sm btn-danger" data-action="delete" data-hash="${t.hash}">Suppr.</button>` : '';
  return `<tr data-hash="${t.hash}">
    <td class="cell-status">${actifsStateBadge(t)}</td>
    <td class="col-nom"><div class="td-name" title="${he(t.name)}"><a href="https://c411.org/torrents/${t.hash}" target="_blank" rel="noopener" class="td-link">${he(t.name)}</a></div></td>
    <td class="td-size col-size">${fmtBytes(t.size)}</td>
    <td class="cell-ratio-td"><div class="prog-wrap">
      <div class="prog-bar-bg"><div class="cell-ratio-bar prog-bar" style="width:${pct}%;background:${barColor}"></div></div>
      <span class="cell-ratio-val prog-val" style="color:${ratioColor}">${t.ratio.toFixed(2)}</span>
    </div></td>
    <td class="cell-seedtime" style="font-size:12px;color:${timeOk ? 'var(--green)' : 'var(--text2)'}" title="Seedtime : ${fmtSecs(t.seeding_time)}">${fmtAge(t.added_on)}</td>
    <td class="cell-dl" style="font-size:12px;color:var(--blue-text)">${fmtSpeed(t.dlspeed)}</td>
    <td class="cell-up" style="font-size:12px;color:var(--green)">${fmtSpeed(t.upspeed)}</td>
    <td class="cell-label">${canDel ? `<span class="badge badge-amber">prêt à suppr.</span>` : `<span class="badge badge-gray">conservation</span>`}</td>
    <td class="cell-action"><span style="display:flex;align-items:center;gap:5px;">${suppBtn}<button class="btn-del-x" data-action="delete-manual" data-hash="${t.hash}">✕</button></span></td>
  </tr>`;
}

function actifsUpdateRow(row, t, ratioMin, seedMin) {
  const { ratioOk, timeOk, canDel, pct, barColor, ratioColor } = actifsCalc(t, ratioMin, seedMin);
  row.querySelector('.cell-status').innerHTML = actifsStateBadge(t);
  const bar = row.querySelector('.cell-ratio-bar');
  bar.style.width = pct + '%'; bar.style.background = barColor;
  const rv = row.querySelector('.cell-ratio-val');
  rv.textContent = t.ratio.toFixed(2); rv.style.color = ratioColor;
  const st = row.querySelector('.cell-seedtime');
  st.textContent = fmtAge(t.added_on); st.style.color = timeOk ? 'var(--green)' : 'var(--text2)';
  st.title = 'Seedtime : ' + fmtSecs(t.seeding_time);
  row.querySelector('.cell-dl').textContent = fmtSpeed(t.dlspeed);
  row.querySelector('.cell-up').textContent = fmtSpeed(t.upspeed);
  row.querySelector('.cell-label').innerHTML = canDel
    ? `<span class="badge badge-amber">prêt à suppr.</span>`
    : `<span class="badge badge-gray">conservation</span>`;
  torrentDataMap.set(t.hash, t.name);
  const suppBtn = canDel
    ? `<button class="btn-sm btn-danger" data-action="delete" data-hash="${t.hash}">Suppr.</button>` : '';
  row.querySelector('.cell-action').innerHTML =
    `<span style="display:flex;align-items:center;gap:5px;">${suppBtn}<button class="btn-del-x" data-action="delete-manual" data-hash="${t.hash}">✕</button></span>`;
}

async function loadActifs() {
  const tbody = document.getElementById('actifs-body');
  try {
    const [tr, rr] = await Promise.all([
      fetch(BASE + '/api/torrents', { credentials: 'include' }).then(r => { if (r.status === 401) { showLogin('Session expirée'); throw new Error('401'); } return r.json(); }),
      fetch(BASE + '/api/rules', { credentials: 'include' }).then(r => r.json())
    ]);
    const torrents = tr.torrents || [];
    const ratioMin = rr.ratio_min || 1.0;
    const seedMin  = (rr.age_min_hours || 48) * 3600;
    renderActifsHeaders();
    if (!torrents.length) {
      actifsHashes = '';
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text3)">Aucun torrent actif</td></tr>`;
      return;
    }
    const sorted = sortActifsData(torrents, ratioMin, seedMin);
    const newHashes = torrents.map(t => t.hash).join(',') + '|' + actifsSortKey + actifsSortDir;
    if (newHashes !== actifsHashes) {
      actifsHashes = newHashes;
      tbody.innerHTML = sorted.map(t => actifsRowHTML(t, ratioMin, seedMin)).join('');
    } else {
      for (const t of sorted) {
        const row = tbody.querySelector(`tr[data-hash="${t.hash}"]`);
        if (row) actifsUpdateRow(row, t, ratioMin, seedMin);
      }
    }
  } catch (e) {
    actifsHashes = '';
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text3)">Erreur API qBittorrent</td></tr>`;
  }
}

async function deleteTorrent(hash) {
  const name = torrentDataMap.get(hash) || hash;
  showConfirm('Supprimer "' + name + '" ?', async () => {
    actifsHashes = '';
    await fetch(BASE + '/api/torrents/' + hash + '?name=' + encodeURIComponent(name), { method: 'DELETE', credentials: 'include' });
    loadActifs(); loadStats();
  });
}

async function deleteManual(hash) {
  const name = torrentDataMap.get(hash) || hash;
  showConfirm('Supprimer ce torrent ?\n\n"' + name + '"', async () => {
    actifsHashes = '';
    await fetch(BASE + '/api/torrents/' + hash + '?name=' + encodeURIComponent(name), { method: 'DELETE', credentials: 'include' });
    loadActifs(); loadStats();
  });
}

// === RÈGLES ===
async function loadRules() {
  try {
    const d = await fetch(BASE + '/api/rules', { credentials: 'include' }).then(r => r.json());
    const on = d._on || {};
    rules = RULE_DEFS.map((def, i) => ({
      id: i,
      ...def,
      val: d[def.key] ?? def.defVal,
      on: on[def.key] !== undefined ? on[def.key] : def.defOn,
    }));
    rulesOrig = JSON.parse(JSON.stringify(rules));
    renderRules();
  } catch (e) { console.error(e); }
}

function renderRules() {
  ['cond', 'limit'].forEach(group => {
    const el = document.getElementById('rules-' + group);
    el.innerHTML = rules.filter(r => r.group === group).map(r => `
      <div class="rule-row">
        <div class="rule-meta">
          <div class="rule-name">${r.name}</div>
          <div class="rule-desc">${r.desc}</div>
        </div>
        <div class="rule-input-wrap">
          <input type="number" value="${r.val}" step="${r.step}" min="${r.min}"
            ${r.on ? '' : 'disabled'}
            data-action="rule-val" data-id="${r.id}">
        </div>
        <span class="rule-unit">${r.unit}</span>
        <div class="rule-actions">
          <input type="checkbox" class="toggle" ${r.on ? 'checked' : ''} data-action="rule-toggle" data-id="${r.id}">
        </div>
      </div>`).join('');
  });
}

function updateRuleVal(id, v) { const r = rules.find(x => x.id === id); if (r) { r.val = parseFloat(v) || v; autoSave(); } }
function toggleRule(id, on)   { const r = rules.find(x => x.id === id); if (r) { r.on = on; renderRules(); autoSave(); } }

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
    msgs.push('Âge maximum doit être supérieur à 0 — corrigé à 1h');
  }
  if (ratioMax?.on && ratioMin?.on && ratioMax.val <= ratioMin.val) {
    ratioMax.val = Math.round((ratioMin.val + 0.1) * 10) / 10;
    msgs.push(`Ratio maximum doit dépasser le ratio minimum (${ratioMin.val}) — ajusté à ${ratioMax.val}`);
  }
  if (ageMax?.on && ageMin?.on && ageMax.val <= ageMin.val) {
    ageMax.val = ageMin.val + 1;
    msgs.push(`Âge maximum doit dépasser l'âge minimum (${ageMin.val}h) — ajusté à ${ageMax.val}h`);
  }
  return msgs;
}

async function saveRules() {
  const fixes = autoFixRules();
  if (fixes.length) { renderRules(); toast(fixes.join(' — '), 'error'); }
  const payload = { _on: {} };
  rules.forEach(r => { payload[r.key] = r.val; payload._on[r.key] = r.on; });
  const r = await fetch(BASE + '/api/rules', { method: 'POST', headers: authHeaders(), credentials: 'include', body: JSON.stringify(payload) });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `rules ${r.status}`);
  }
}

// === CLEANER ===
async function loadCleanerStatus() {
  try {
    const d = await fetch(BASE + '/api/cleaner/status', { credentials: 'include' }).then(r => r.json());
    document.getElementById('cleaner-enabled').checked = !!d.enabled;
    document.getElementById('cleaner-interval').value  = d.interval_hours || 1;
    document.getElementById('cleaner-last-run').textContent      = fmtDate(d.last_run);
    document.getElementById('cleaner-last-count').textContent    = d.last_deleted_count ?? '—';
    document.getElementById('cleaner-last-run-type').textContent = d.last_run_type ? `· ${d.last_run_type}` : '';
  } catch (e) { console.error('[cleaner]', e); }
}

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
  await loadCleanerStatus();
}

async function runCleanerNow() {
  const btn = document.getElementById('cleaner-run-btn');
  btn.disabled = true;
  btn.textContent = 'En cours...';
  try {
    const r = await fetch(BASE + '/api/cleaner/run', { method: 'POST', credentials: 'include' });
    await r.json();
    showMsg('cleaner-run-msg');
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
async function loadAutoRefreshConfig(startInterval = false) {
  try {
    const d = await fetch(BASE + '/api/auto-refresh', { credentials: 'include' }).then(r => r.json());
    document.getElementById('autorefresh-enabled').checked = !!d.enabled;
    document.getElementById('autorefresh-interval').value  = d.interval_minutes || 15;
    updateLastRefreshDisplay();
    if (startInterval) applyAutoRefresh();
  } catch (e) { console.error('[auto-refresh]', e); }
}

function applyAutoRefresh() {
  clearInterval(autoRefreshInterval); autoRefreshInterval = null;
  const enabled = document.getElementById('autorefresh-enabled')?.checked;
  const mins    = Math.max(1, parseInt(document.getElementById('autorefresh-interval')?.value) || 15);
  autoSave();
  if (enabled) {
    autoRefreshInterval = setInterval(() => loadTop('auto'), mins * 60000);
  }
}

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
function updateLastGrabDisplay(count) {
  const el = document.getElementById('autograb-last-count');
  if (el) el.textContent = count != null ? count : '—';
}

async function loadAutoGrabStatus() {
  const saved = localStorage.getItem('lastGrabCount');
  updateLastGrabDisplay(saved != null ? saved : 0);
}

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
    localStorage.setItem('lastGrabCount', d.grabbed ?? 0);
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
let histSortKey = localStorage.getItem('hist-sort-key') || 'date';
let histSortDir = parseInt(localStorage.getItem('hist-sort-dir')) || -1;

function setHistSort(key) {
  histSortDir = histSortKey === key ? histSortDir * -1 : -1;
  histSortKey = key;
  localStorage.setItem('hist-sort-key', histSortKey);
  localStorage.setItem('hist-sort-dir', histSortDir);
  renderHistory();
}

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

function renderHistory() {
  const el = document.getElementById('history-content');
  if (!el) return;
  if (!histData.length) {
    el.innerHTML = '<div style="padding:24px 16px;font-size:13px;color:var(--text2);text-align:center;">Aucun événement enregistré</div>';
    return;
  }
  const cols = [
    { key: 'date',   label: 'Date' },
    { key: 'type',   label: 'Type' },
    { key: 'count',  label: 'Résultat' },
    { key: 'source', label: 'Source' },
  ];
  const headers = cols.map(c => {
    const arrow = histSortKey === c.key ? (histSortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th data-sort="${c.key}">${c.label}${arrow}</th>`;
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
      <td class="col-hist-date">${fmtDate(e.date)}</td>
      <td class="col-hist-type">${badge}</td>
      <td class="col-hist-result">${result}${names}</td>
      <td class="col-hist-source">${srcBadge}</td>
      <td class="col-hist-del"><span style="display:flex;align-items:center;"><button class="btn-del-x" data-action="del-hist" data-date="${dateB64}" title="Supprimer">✕</button></span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `<table class="hist-table"><thead><tr>${headers}<th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function deleteHistEntry(dateB64) {
  const date = atob(dateB64);
  try {
    const r = await fetch(BASE + '/api/history', { method: 'DELETE', headers: authHeaders(), credentials: 'include', body: JSON.stringify({ date }) });
    if (!r.ok) throw new Error();
    histData = histData.filter(e => e.date !== date);
    renderHistory();
  } catch { toast('Erreur suppression', 'error'); }
}

async function loadHistory() {
  const el = document.getElementById('history-content');
  if (!el) return;
  try {
    histData = await fetch(BASE + '/api/history', { credentials: 'include' }).then(r => r.json());
    renderHistory();
  } catch (e) {
    el.innerHTML = '<div style="padding:16px;color:var(--red-text);font-size:13px;">Erreur chargement historique</div>';
  }
}

// Sauvegarde automatique (déclenchée à chaque changement de config)
let autoSaveTimer = null;
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
function updateThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.getElementById('btn-theme').textContent = dark ? '☀' : '☽';
}
function toggleTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (dark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('seedash-theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('seedash-theme', 'dark');
  }
  updateThemeIcon();
}
updateThemeIcon();

// === ÉVÉNEMENTS STATIQUES ===
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

document.getElementById('btn-theme').addEventListener('click', toggleTheme);
document.getElementById('btn-logout').addEventListener('click', doLogout);

document.querySelectorAll('.tab[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

document.getElementById('top-select-all').addEventListener('change', function () { toggleSelectAll(this); });
document.getElementById('btn-load-top').addEventListener('click', () => loadTop());
document.getElementById('btn-grab-selected').addEventListener('click', grabSelected);

document.getElementById('autorefresh-interval').addEventListener('change', applyAutoRefresh);
document.getElementById('autorefresh-enabled').addEventListener('change', applyAutoRefresh);
document.getElementById('btn-auto-grab').addEventListener('click', () => triggerAutoGrab(true));

document.getElementById('cleaner-interval').addEventListener('change', autoSave);
document.getElementById('cleaner-enabled').addEventListener('change', autoSave);
document.getElementById('cleaner-run-btn').addEventListener('click', runCleanerNow);

document.getElementById('btn-save-secrets').addEventListener('click', saveSecrets);
document.getElementById('btn-change-password').addEventListener('click', changePassword);

// Modal
document.getElementById('modal-confirm').addEventListener('click', () => { const fn = pendingConfirm; closeModal(); fn?.(); });
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });

// === DÉLÉGATION — TOP LEECHERS ===
// Colonnes triables (thead statique)
document.getElementById('top-thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (th) sortTopBy(th.dataset.col);
});

// Lignes dynamiques
document.getElementById('top-body').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action="grab-one"]');
  if (btn) grabOne(parseInt(btn.dataset.idx));
});
document.getElementById('top-body').addEventListener('change', e => {
  const cb = e.target.closest('input[type=checkbox][data-idx]');
  if (cb) toggleGrab(parseInt(cb.dataset.idx), cb);
});

// === DÉLÉGATION — TORRENTS ACTIFS ===
// En-têtes dynamiques (renderActifsHeaders rebuild le <tr> dans le <thead>)
document.querySelector('#sec-actifs thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-action="sort-actifs"]');
  if (th) setActifsSort(th.dataset.key);
});

// Boutons de suppression dans les lignes
document.getElementById('actifs-body').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'delete')        deleteTorrent(btn.dataset.hash);
  if (btn.dataset.action === 'delete-manual') deleteManual(btn.dataset.hash);
});

// === DÉLÉGATION — RÈGLES ===
document.getElementById('sec-regles').addEventListener('change', e => {
  const inp = e.target.closest('input[data-action="rule-val"]');
  if (inp) updateRuleVal(parseInt(inp.dataset.id), inp.value);
  const tog = e.target.closest('input[data-action="rule-toggle"]');
  if (tog) toggleRule(parseInt(tog.dataset.id), tog.checked);
});
document.getElementById('sec-regles').addEventListener('input', e => {
  const inp = e.target.closest('input[data-action="rule-val"]');
  if (inp) updateRuleVal(parseInt(inp.dataset.id), inp.value);
});

// === DÉLÉGATION — HISTORIQUE ===
document.getElementById('history-content').addEventListener('click', e => {
  const del = e.target.closest('button[data-action="del-hist"]');
  if (del) { deleteHistEntry(del.dataset.date); return; }
  const th = e.target.closest('th[data-sort]');
  if (th) setHistSort(th.dataset.sort);
});

// === INIT ===
checkAuth().then(authenticated => {
  if (authenticated) {
    loadStats();
    loadConnections();
    loadAutoRefreshConfig(true);
    setInterval(loadStats, 5000);
    setInterval(loadConnections, 30000);
    switchTab(localStorage.getItem('active-tab') || 'top');
  }
});
