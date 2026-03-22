'use strict';
// === CONNEXIONS LED & STATS GLOBALES ===
// Dépend de : utils.js (fmtSpeed)
// Appelé depuis : app.js (startPolling, checkAuth), actifs.js (loadActifs), top.js (triggerAutoGrab, grabOne)

const ledState = { 'led-c411': null, 'led-qbit': null, 'led-ultracc': null };

/** Met à jour l'état visuel d'une LED de connexion ('checking', 'ok', 'err'). */
function setLed(id, state) {
  const el = document.getElementById(id);
  if (el) el.className = 'led led-' + state;
  ledState[id] = state;
}

/** Interroge /api/connections et met à jour les trois LEDs (C411, qBittorrent, Ultra.cc).
 *  Passe en 'checking' uniquement si l'état précédent n'était pas 'ok' (évite le flash orange). */
async function loadConnections() {
  ['led-c411', 'led-qbit', 'led-ultracc'].forEach(id => {
    if (ledState[id] !== 'ok') setLed(id, 'checking');
  });
  try {
    const r = await fetchT(BASE + '/api/connections', { credentials: 'include' });
    if (r.status === 401) { showLogin('Session expirée'); return; }
    const d = await r.json();
    setLed('led-c411',    d.c411        === 'ok' ? 'ok' : 'err');
    setLed('led-qbit',    d.qbittorrent === 'ok' ? 'ok' : 'err');
    setLed('led-ultracc', d.ultracc     === 'ok' ? 'ok' : 'err');
  } catch (e) {
    ['led-c411', 'led-qbit', 'led-ultracc'].forEach(id => setLed(id, 'err'));
  }
}

/** Recalcule et affiche les stats qBittorrent (actifs, ratio moyen, vitesses DL/UP)
 *  directement depuis la liste des torrents en mémoire, sans nouvel appel API.
 *  @param {Array} torrents - Liste des torrents actifs */
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

/** Charge et affiche toutes les statistiques globales depuis /api/stats
 *  (disque, trafic réseau, et stats qBittorrent si l'onglet actifs n'est pas actif). */
async function loadStats() {
  try {
    const r = await fetchT(BASE + '/api/stats', { credentials: 'include' });
    if (r.status === 401) { showLogin('Session expirée'); return; }
    const d = await r.json();
    if (d.c411_base) c411Base = d.c411_base;
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
    window.dispatchEvent(new CustomEvent('timer-status', {
      detail: { enabled: !!d.timer_enabled, next_at: d.timer_next_at || null }
    }));
  } catch (e) { /* silencieux */ }
}
