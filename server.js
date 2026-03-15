const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const { XMLParser } = require('fast-xml-parser');
const cleaner = require('./cleaner');
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const helmet  = require('helmet');

// --- Config ---
const CFG_PATH = path.join(__dirname, 'config.json');
let cfg = JSON.parse(fs.readFileSync(CFG_PATH));

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cfg.baseurl, express.static(path.join(__dirname, 'public')));

// --- Helpers ---
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function saveCfg() {
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
}

// --- Auth init ---
async function initAuth() {
  let changed = false;
  if (!cfg.auth) cfg.auth = { username: 'admin', password_hash: '', jwt_secret: '', token_expiry: '24h' };
  if (!cfg.auth.jwt_secret) {
    cfg.auth.jwt_secret = crypto.randomBytes(64).toString('hex');
    changed = true;
  }
  if (!cfg.auth.password_hash) {
    cfg.auth.password_hash = await bcrypt.hash('changeme', 12);
    changed = true;
    console.log('⚠️  MOT DE PASSE PAR DÉFAUT : changeme — changez-le dans l\'interface');
  }
  if (changed) saveCfg();
}

// --- Brute-force protection ---
const loginAttempts = new Map(); // ip -> { count, blockedUntil }

function checkBruteForce(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
    loginAttempts.delete(ip);
    return false;
  }
  return false;
}

function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0 };
  entry.count++;
  if (entry.count >= 5) entry.blockedUntil = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(ip, entry);
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, cfg.auth.jwt_secret);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// --- PUBLIC: Login ---
app.post(`${cfg.baseurl}/api/login`, async (req, res) => {
  const ip = req.ip;
  if (checkBruteForce(ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
  if (username !== cfg.auth.username) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  const ok = await bcrypt.compare(password, cfg.auth.password_hash);
  if (!ok) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  resetLoginAttempts(ip);
  const token = jwt.sign({ username }, cfg.auth.jwt_secret, { expiresIn: cfg.auth.token_expiry });
  res.json({ token });
});

// --- PUBLIC: Change password ---
app.post(`${cfg.baseurl}/api/change-password`, requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Champs manquants' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  const ok = await bcrypt.compare(current_password, cfg.auth.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  cfg.auth.password_hash = await bcrypt.hash(new_password, 12);
  saveCfg();
  res.json({ ok: true });
});

// --- Ultra.cc API cache (TTL 60s) ---
let ultraccCache = { data: null, lastFetch: 0 };

async function getUltraccStats() {
  const now = Date.now();
  if (ultraccCache.data && now - ultraccCache.lastFetch < 60000) {
    return ultraccCache.data;
  }
  const r = await axios.get(cfg.ultracc_api.url, {
    headers: { Authorization: `Bearer ${cfg.ultracc_api.token}` }
  });
  ultraccCache.data      = r.data.service_stats_info;
  ultraccCache.lastFetch = now;
  return ultraccCache.data;
}

// --- qBittorrent session ---
let qbitCookie = null;

async function qbitLogin() {
  const r = await axios.post(
    `${cfg.qbittorrent.url}/api/v2/auth/login`,
    `username=${cfg.qbittorrent.username}&password=${cfg.qbittorrent.password}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  qbitCookie = r.headers['set-cookie']?.[0]?.split(';')[0];
  return qbitCookie;
}

async function qbitRequest(method, endpoint, data = null) {
  if (!qbitCookie) await qbitLogin();
  try {
    const r = await axios({
      method,
      url: `${cfg.qbittorrent.url}/api/v2${endpoint}`,
      data,
      headers: {
        Cookie: qbitCookie,
        ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
      }
    });
    return r.data;
  } catch (e) {
    // Session expirée → re-login une fois
    if (e.response?.status === 403) {
      await qbitLogin();
      const r = await axios({
        method,
        url: `${cfg.qbittorrent.url}/api/v2${endpoint}`,
        data,
        headers: { Cookie: qbitCookie, ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }
      });
      return r.data;
    }
    throw e;
  }
}

// ============================================================
// ROUTES C411
// ============================================================

// GET /api/top-leechers?n=20&cat=all
app.get(`${cfg.baseurl}/api/top-leechers`, requireAuth, async (req, res) => {
  const n   = Math.min(parseInt(req.query.n) || 20, 100);
  const cat = req.query.cat || '';
  try {
    const r = await axios.get(cfg.c411.url, {
      params: {
        apikey: cfg.c411.apikey,
        t: 'search',
        q: '',
        limit: 100,
        ...(cat && cat !== 'all' ? { cat } : {})
      }
    });
    const parsed = xmlParser.parse(r.data);
    const items  = parsed?.rss?.channel?.item || [];
    const list   = (Array.isArray(items) ? items : [items]).map(item => {
      const attrs    = [].concat(item['torznab:attr'] || []);
      const attr     = (name) => attrs.find(a => a['@_name'] === name)?.['@_value'];
      const seeders  = parseInt(attr('seeders') || 0);
      const peers    = parseInt(attr('peers')   || 0);
      return {
        name:     item.title,
        size:     parseInt(attr('size') || item.size || 0),
        leechers: Math.max(0, peers - seeders),
        seeders,
        link:     item.enclosure?.['@_url'] || item.link || '',
        infohash: attr('infohash') || '',
        category: item.category || '',
        pubDate:  item.pubDate || ''
      };
    });
    list.sort((a, b) => b.leechers - a.leechers);
    res.json({ items: list.slice(0, n) });
  } catch (e) {
    console.error('[C411]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ROUTES qBITTORRENT
// ============================================================

// GET /api/torrents — liste tous les torrents actifs
app.get(`${cfg.baseurl}/api/torrents`, requireAuth, async (req, res) => {
  try {
    const data = await qbitRequest('get', '/torrents/info');
    const list = data.map(t => ({
      hash:          t.hash,
      name:          t.name,
      size:          t.size,
      progress:      t.progress,
      state:         t.state,
      ratio:         t.ratio,
      seeding_time:  t.seeding_time,   // secondes
      num_leechs:    t.num_leechs,
      num_seeds:     t.num_seeds,
      dlspeed:       t.dlspeed,
      upspeed:       t.upspeed,
      added_on:      t.added_on,
      completion_on: t.completion_on
    }));
    res.json({ torrents: list });
  } catch (e) {
    console.error('[qBit]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/grab — ajouter un torrent à qBittorrent
app.post(`${cfg.baseurl}/api/grab`, requireAuth, async (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ error: 'url requis' });
  // Si l'URL est une page torrent (pas une URL de download), construire l'URL directe
  const downloadUrl = url.includes('/api?t=get') ? url
    : `${cfg.c411.url.replace('/api/torznab','')}/api?t=get&id=${url.split('/').pop()}&apikey=${cfg.c411.apikey}`;
  try {
    const r = await qbitRequest('post', '/torrents/add', `urls=${encodeURIComponent(downloadUrl)}`);
    console.log(`[grab] ok: ${name || '(sans nom)'}`);
    res.json({ ok: true });
  } catch (e) {
    console.log('[grab] erreur:', e.response?.status, e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/torrents/:hash — supprimer un torrent
app.delete(`${cfg.baseurl}/api/torrents/:hash`, requireAuth, async (req, res) => {
  const { hash } = req.params;
  const deleteFiles = req.query.deleteFiles === 'true';
  try {
    await qbitRequest('post', '/torrents/delete',
      `hashes=${hash}&deleteFiles=${deleteFiles}`
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ROUTES RÈGLES
// ============================================================

// GET /api/rules
app.get(`${cfg.baseurl}/api/rules`, requireAuth, (req, res) => {
  res.json(cfg.rules);
});

// POST /api/rules — sauvegarder
app.post(`${cfg.baseurl}/api/rules`, requireAuth, (req, res) => {
  // null = règle désactivée → retirer la clé de config
  const next = { ...cfg.rules };
  for (const [k, v] of Object.entries(req.body)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  cfg.rules = next;
  saveCfg();
  console.log('[rules] sauvegardé:', JSON.stringify(cfg.rules));
  res.json({ ok: true, rules: cfg.rules });
});

// ============================================================
// ROUTE STATS GLOBALES
// ============================================================
app.get(`${cfg.baseurl}/api/stats`, requireAuth, async (req, res) => {
  try {
    const [torrents, transfer] = await Promise.all([
      qbitRequest('get', '/torrents/info'),
      qbitRequest('get', '/transfer/info')
    ]);
    const active   = torrents.length;
    const ratios   = torrents.map(t => t.ratio).filter(r => r > 0);
    const avgRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
    // Ultra.cc API (résultat mis en cache 60s)
    let disk_used_gb = null, disk_total_gb = null;
    let traffic_used_pct = null, traffic_reset_date = null;
    try {
      const info       = await getUltraccStats();
      disk_used_gb     = Math.round(info.used_storage_value / 1024); // MB → GB
      disk_total_gb    = info.total_storage_value;                    // déjà en GB
      traffic_used_pct = Math.round(info.traffic_used_percentage * 10) / 10;
      traffic_reset_date = info.next_traffic_reset
        ? info.next_traffic_reset.split('T')[0]
        : null;
    } catch (e) {
      console.error('[ultracc_api]', e.message);
    }

    res.json({
      active,
      avg_ratio:    Math.round(avgRatio * 100) / 100,
      uploaded:     transfer.alltime_ul || 0,
      dl_speed:     transfer.dl_info_speed || 0,
      up_speed:     transfer.up_info_speed || 0,
      disk_used_gb,
      disk_total_gb,
      traffic_used_pct,
      traffic_reset_date
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ROUTES CLEANER
// ============================================================

// GET /api/cleaner/status
app.get(`${cfg.baseurl}/api/cleaner/status`, requireAuth, (req, res) => {
  res.json(cleaner.getStatus());
});

// POST /api/cleaner/run — nettoyage immédiat
app.post(`${cfg.baseurl}/api/cleaner/run`, requireAuth, async (req, res) => {
  try {
    const deleted = await cleaner.runClean();
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cleaner/schedule — mise à jour planning
app.post(`${cfg.baseurl}/api/cleaner/schedule`, requireAuth, (req, res) => {
  const { cron_schedule, enabled } = req.body;
  if (!cron_schedule) return res.status(400).json({ error: 'cron_schedule requis' });
  cfg.cleaner = { ...cfg.cleaner, cron_schedule, enabled: !!enabled };
  saveCfg();
  cleaner.reschedule(cron_schedule, !!enabled);
  console.log(`[cleaner] schedule mis à jour : ${cron_schedule}, enabled=${!!enabled}`);
  res.json({ ok: true, ...cleaner.getStatus() });
});

// ============================================================
// ROUTES AUTO-REFRESH
// ============================================================

// GET /api/auto-refresh
app.get(`${cfg.baseurl}/api/auto-refresh`, requireAuth, (req, res) => {
  res.json(cfg.auto_refresh || { enabled: false, interval_minutes: 15 });
});

// POST /api/auto-refresh
app.post(`${cfg.baseurl}/api/auto-refresh`, requireAuth, (req, res) => {
  const { enabled, interval_minutes } = req.body;
  cfg.auto_refresh = {
    enabled: !!enabled,
    interval_minutes: parseInt(interval_minutes) || 15
  };
  saveCfg();
  console.log(`[auto-refresh] enabled=${cfg.auto_refresh.enabled}, interval=${cfg.auto_refresh.interval_minutes}min`);
  res.json({ ok: true, ...cfg.auto_refresh });
});

// ============================================================
// START
// ============================================================
initAuth().then(() => {
  app.listen(cfg.port, '0.0.0.0', () => {
    console.log(`SeedDash démarré → http://0.0.0.0:${cfg.port}${cfg.baseurl}`);
  });
});
