const express      = require('express');
const axios        = require('axios');
const path         = require('path');
const fs           = require('fs');
const { XMLParser } = require('fast-xml-parser');
const cleaner      = require('./cleaner');
const crypto       = require('crypto');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const { encrypt, decrypt, PREFIX } = require('./crypto-config');

// Champs secrets à chiffrer sur disque
const SECRET_PATHS = [
  ['c411', 'apikey'],
  ['qbittorrent', 'username'],
  ['qbittorrent', 'password'],
  ['ultracc_api', 'token'],
];
function getIn(obj, path) { return path.reduce((o, k) => o?.[k], obj); }
function setIn(obj, path, val) {
  const parent = path.slice(0, -1).reduce((o, k) => o[k], obj);
  if (parent) parent[path[path.length - 1]] = val;
}
function maskSecret(val, show = 3) {
  if (!val) return '';
  if (val.length <= show * 2) return '*'.repeat(8);
  return val.slice(0, show) + '*'.repeat(val.length - show * 2) + val.slice(-show);
}
// Résoudre la clé JWT : variable d'env en priorité, fallback config.json
function getJwtSecret() {
  return process.env.JWT_SECRET || cfg.auth?.jwt_secret;
}

function decryptSecrets() {
  const key = getJwtSecret();
  if (!key) return;
  for (const p of SECRET_PATHS) {
    const v = getIn(cfg, p);
    if (v) setIn(cfg, p, decrypt(v, key));
  }
}

// --- Config ---
const CFG_PATH      = path.join(__dirname, 'config.json');
const HISTORY_PATH  = path.join(__dirname, 'logs', 'history.json');
const HISTORY_MAX   = 500;
const TOP_CACHE_PATH = path.join(__dirname, 'logs', 'top-cache.json');
// Associe hash qBittorrent → nom C411, pour afficher le nom C411 dans les torrents actifs
const NAMEMAP_PATH  = path.join(__dirname, 'logs', 'namemap.json');
let cfg = JSON.parse(fs.readFileSync(CFG_PATH));

if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
}

// Cache top leechers (persisté sur disque)
let topCache = { items: [], date: null };
try { topCache = JSON.parse(fs.readFileSync(TOP_CACHE_PATH)); } catch {}

// Correspondance hash → nom C411 (persistée sur disque)
let nameMap = {};
try { nameMap = JSON.parse(fs.readFileSync(NAMEMAP_PATH)); } catch {}
function saveNameMap() {
  try {
    const tmp = NAMEMAP_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(nameMap));
    fs.renameSync(tmp, NAMEMAP_PATH);
  } catch(e) { console.error('[namemap]', e.message); }
}

const app = express();
app.set('trust proxy', 1); // Lit X-Forwarded-For depuis Nginx pour la protection brute-force
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,   // évite upgrade-insecure-requests et les autres defaults Helmet
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],            // bloque tout script inline
      styleSrc:       ["'self'", "'unsafe-inline'"], // inline styles dans les innerHTML dynamiques
      imgSrc:         ["'self'", "data:"],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
}));
app.use(cookieParser());
app.use(express.json({ limit: '64kb' }));
app.use(cfg.baseurl, express.static(path.join(__dirname, 'public')));

// --- Helpers ---
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function saveCfg() {
  // Toujours fusionner le statut live du cleaner pour persistance
  const st = cleaner.getStatus();
  cfg.cleaner.last_run           = st.last_run;
  cfg.cleaner.last_deleted_count = st.last_deleted_count;
  cfg.cleaner.last_run_type      = st.last_run_type;
  // Écrire une copie avec les secrets chiffrés (cfg en mémoire reste en clair)
  const toWrite = JSON.parse(JSON.stringify(cfg));
  const key = getJwtSecret();
  if (key) {
    for (const p of SECRET_PATHS) {
      const v = getIn(toWrite, p);
      if (v && !v.startsWith(PREFIX)) setIn(toWrite, p, encrypt(v, key));
    }
  }
  // Si JWT_SECRET vient de l'env, ne pas l'écrire dans config.json
  if (process.env.JWT_SECRET && toWrite.auth) delete toWrite.auth.jwt_secret;
  const tmp = CFG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2));
    fs.renameSync(tmp, CFG_PATH);
  } catch(e) {
    console.error('[config] ERREUR SAUVEGARDE:', e.message);
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// --- Historique ---
function appendHistory(type, count, source, names = []) {
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(HISTORY_PATH)); } catch {}
  hist.unshift({ type, date: new Date().toISOString(), count, source, names });
  if (hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  try {
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hist));
    fs.renameSync(tmp, HISTORY_PATH);
  } catch(e) { console.error('[history] Erreur écriture:', e.message); }
}

// --- Config defaults init (crée les clés manquantes au premier démarrage) ---
function initConfig() {
  let changed = false;
  if (!cfg.rules)        { cfg.rules        = { ratio_min: 1.0, age_min_hours: 48, grab_limit_per_day: 20, size_max_gb: 100 }; changed = true; }
  if (!cfg.cleaner)      { cfg.cleaner      = { enabled: false, interval_hours: 1 };           changed = true; }
  if (!cfg.auto_refresh) { cfg.auto_refresh = { enabled: false, interval_minutes: 15 };         changed = true; }
  if (!cfg.auto_grab)    { cfg.auto_grab    = { enabled: false };                                changed = true; }
  if (!cfg.rules_on) {
    // Migration depuis l'ancien format : la présence d'une clé dans cfg.rules = règle activée
    cfg.rules_on = {};
    for (const k of ['ratio_max','age_max_hours','active_max','min_leechers','min_seeders']) {
      if (cfg.rules?.[k] != null) cfg.rules_on[k] = true;
    }
    changed = true;
  }
  if (changed) {
    saveCfg();
    console.log('[config] Clés manquantes initialisées et sauvegardées');
  }
}

// --- Auth init ---
async function initAuth() {
  let changed = false;
  if (!cfg.auth) cfg.auth = { username: 'admin', password_hash: '', jwt_secret: '', token_expiry: '24h', issued_after: 0 };
  // Générer jwt_secret uniquement si pas de variable d'env et pas déjà présent
  if (!process.env.JWT_SECRET && !cfg.auth.jwt_secret) {
    cfg.auth.jwt_secret = crypto.randomBytes(64).toString('hex');
    changed = true;
  }
  if (!cfg.auth.password_hash) {
    cfg.auth.password_hash = await bcrypt.hash('changeme', 12);
    changed = true;
    console.log('⚠️  MOT DE PASSE PAR DÉFAUT : changeme — changez-le dans l\'interface');
  }
  // Migrations : clés ajoutées après la v1.0
  if (!cfg.auth.token_expiry)              { cfg.auth.token_expiry  = '24h'; changed = true; }
  if (cfg.auth.issued_after === undefined) { cfg.auth.issued_after  = 0;     changed = true; }
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

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  // Cookie httpOnly en priorité, fallback Authorization Bearer (compatibilité)
  const token = req.cookies?.seedash_token || req.headers['authorization']?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    // Invalide les tokens émis avant le dernier changement de mot de passe
    if (decoded.iat < (cfg.auth.issued_after || 0)) {
      return res.status(401).json({ error: 'Token révoqué' });
    }
    req.user = decoded;
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
  const token = jwt.sign({ username }, getJwtSecret(), { expiresIn: cfg.auth.token_expiry || '24h', algorithm: 'HS256' });
  // Cookie httpOnly : inaccessible depuis JS, protégé contre XSS
  res.cookie('seedash_token', token, {
    httpOnly: true,
    secure:   req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'Strict',
    maxAge:   24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

// --- PUBLIC: Change password ---
app.post(`${cfg.baseurl}/api/change-password`, requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Champs manquants' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  const ok = await bcrypt.compare(current_password, cfg.auth.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  cfg.auth.password_hash = await bcrypt.hash(new_password, 12);
  // Invalide tous les tokens émis avant ce changement
  cfg.auth.issued_after = Math.floor(Date.now() / 1000);
  saveCfg();
  res.json({ ok: true });
});

// POST /api/logout — supprime le cookie de session
app.post(`${cfg.baseurl}/api/logout`, (req, res) => {
  res.clearCookie('seedash_token', { sameSite: 'Strict' });
  res.json({ ok: true });
});

// --- Ultra.cc API cache (TTL 60s) ---
let ultraccCache = { data: null, lastFetch: 0 };

async function getUltraccStats() {
  const now = Date.now();
  if (ultraccCache.data && now - ultraccCache.lastFetch < 120000) {
    return ultraccCache.data;
  }
  const r = await axios.get(cfg.ultracc_api.url, {
    headers: { Authorization: `Bearer ${cfg.ultracc_api.token}` },
    timeout: 15000
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
    `username=${encodeURIComponent(cfg.qbittorrent.username)}&password=${encodeURIComponent(cfg.qbittorrent.password)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  qbitCookie = r.headers['set-cookie']?.[0]?.split(';')[0];
  return qbitCookie;
}

async function qbitRequest(method, endpoint, data = null) {
  if (!qbitCookie) await qbitLogin();
  const opts = {
    method,
    url: `${cfg.qbittorrent.url}/api/v2${endpoint}`,
    data,
    timeout: 10000,
    headers: {
      Cookie: qbitCookie,
      ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    }
  };
  try {
    return (await axios(opts)).data;
  } catch (e) {
    // Session expirée → re-login une fois
    if (e.response?.status === 403) {
      await qbitLogin();
      opts.headers.Cookie = qbitCookie;
      return (await axios(opts)).data;
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
      },
      timeout: 15000
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
        link:     item.enclosure?.['@_url'] || '',
        page_url: item.link || '',
        infohash: attr('infohash') || '',
        category: item.category || '',
        pubDate:  item.pubDate || ''
      };
    });
    list.sort((a, b) => b.leechers - a.leechers);
    topCache = { items: list.slice(0, n), date: new Date().toISOString() };
    try {
      const tmp = TOP_CACHE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(topCache));
      fs.renameSync(tmp, TOP_CACHE_PATH);
    } catch(e) { console.error('[top-cache]', e.message); }
    res.json(topCache);
  } catch (e) {
    console.error('[C411]', e.message);
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// GET /api/top-leechers/cache — retourne le dernier résultat sans refetch
app.get(`${cfg.baseurl}/api/top-leechers/cache`, requireAuth, (req, res) => {
  res.json(topCache);
});

// ============================================================
// ROUTES qBITTORRENT
// ============================================================

// GET /api/torrents — liste tous les torrents actifs
app.get(`${cfg.baseurl}/api/torrents`, requireAuth, async (req, res) => {
  try {
    // Index du cache top leechers par infohash pour résoudre les noms C411
    const topByHash = {};
    for (const item of topCache.items || []) {
      if (item.infohash) topByHash[item.infohash.toLowerCase()] = item.name;
    }
    const data = await qbitRequest('get', '/torrents/info');
    const list = data.map(t => ({
      hash:          t.hash,
      name:          nameMap[t.hash.toLowerCase()] || topByHash[t.hash.toLowerCase()] || t.name,
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
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// POST /api/grab — ajouter un torrent à qBittorrent
app.post(`${cfg.baseurl}/api/grab`, requireAuth, async (req, res) => {
  const { url, name, page_url, infohash } = req.body;
  if (!url) return res.status(400).json({ error: 'url requis' });
  // Vérifier que l'URL cible bien le domaine C411 configuré (prévention SSRF)
  try {
    const allowed = new URL(cfg.c411.url).hostname;
    const target  = new URL(url).hostname;
    if (target !== allowed) return res.status(400).json({ error: 'URL non autorisée' });
  } catch {
    return res.status(400).json({ error: 'URL invalide' });
  }
  // Si l'URL est une page torrent (pas une URL de download), construire l'URL directe
  const downloadUrl = url.includes('/api?t=get') ? url
    : `${cfg.c411.url.replace('/api/torznab','')}/api?t=get&id=${url.split('/').pop()}&apikey=${cfg.c411.apikey}`;
  try {
    await qbitRequest('post', '/torrents/add', `urls=${encodeURIComponent(downloadUrl)}`);
    // Mémorise hash → nom C411 pour l'afficher dans les torrents actifs à la place du nom interne qBittorrent
    if (name && infohash) { nameMap[infohash.toLowerCase()] = name; saveNameMap(); }
    console.log(`[grab] ok: ${name || '(sans nom)'}`);
    if (name) appendHistory('grab', 1, 'manuel', [{ name, url: page_url || null }]);
    res.json({ ok: true });
  } catch (e) {
    console.log('[grab] erreur:', e.response?.status, e.message);
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// DELETE /api/torrents/:hash — supprimer un torrent
app.delete(`${cfg.baseurl}/api/torrents/:hash`, requireAuth, async (req, res) => {
  const { hash } = req.params;
  if (!/^[a-f0-9]{40}$/i.test(hash)) return res.status(400).json({ error: 'Hash invalide' });
  const deleteFiles = req.query.deleteFiles === 'true';
  const name        = (req.query.name || hash).slice(0, 256);
  try {
    await qbitRequest('post', '/torrents/delete',
      `hashes=${hash}&deleteFiles=${deleteFiles}`
    );
    appendHistory('delete', 1, 'manuel', [{ name, url: `https://c411.org/torrents/${hash}` }]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// ============================================================
// ROUTES RÈGLES
// ============================================================
// Modèle de persistance des règles :
//   cfg.rules     — valeurs numériques, toujours stockées même si la règle est désactivée
//   cfg.rules_on  — état activé/désactivé par clé (absent = actif par défaut)
// Ce modèle permet de changer la valeur sans perdre l'état du toggle, et vice-versa.

// GET /api/rules — retourne valeurs + état des toggles
app.get(`${cfg.baseurl}/api/rules`, requireAuth, (req, res) => {
  res.json({ ...cfg.rules, _on: cfg.rules_on || {} });
});

const VALID_RULE_KEYS = new Set(['ratio_min','ratio_max','age_min_hours','age_max_hours','grab_limit_per_day','size_max_gb','active_max','min_leechers','min_seeders']);

// POST /api/rules — sauvegarder
app.post(`${cfg.baseurl}/api/rules`, requireAuth, (req, res) => {
  const { _on, ...vals } = req.body;
  // Valeurs — toujours stockées (indépendant du toggle)
  const next = { ...cfg.rules };
  for (const [k, v] of Object.entries(vals)) {
    if (!VALID_RULE_KEYS.has(k)) continue;
    if (typeof v === 'number' && isFinite(v) && v >= 0) next[k] = v;
  }
  // État activé/désactivé — stocké séparément
  const nextOn = { ...(cfg.rules_on || {}) };
  if (_on && typeof _on === 'object') {
    for (const [k, v] of Object.entries(_on)) {
      if (VALID_RULE_KEYS.has(k)) nextOn[k] = !!v;
    }
  }
  // Validations croisées (uniquement sur les règles actives)
  const isOn = (k) => nextOn[k] !== false;
  if (isOn('ratio_max') && isOn('ratio_min') && next.ratio_max <= next.ratio_min)
    return res.status(400).json({ error: `Ratio maximum (${next.ratio_max}) doit être strictement supérieur au ratio minimum (${next.ratio_min})` });
  if (isOn('age_max_hours') && isOn('age_min_hours') && next.age_max_hours <= next.age_min_hours)
    return res.status(400).json({ error: `Âge maximum (${next.age_max_hours}h) doit être strictement supérieur à l'âge minimum (${next.age_min_hours}h)` });
  if (isOn('ratio_max') && next.ratio_max <= 0)
    return res.status(400).json({ error: 'Ratio maximum doit être supérieur à 0' });
  if (isOn('age_max_hours') && next.age_max_hours <= 0)
    return res.status(400).json({ error: 'Âge maximum doit être supérieur à 0' });
  cfg.rules    = next;
  cfg.rules_on = nextOn;
  saveCfg();
  console.log('[rules] sauvegardé:', JSON.stringify(cfg.rules), 'on:', JSON.stringify(cfg.rules_on));
  res.json({ ok: true, rules: cfg.rules, _on: cfg.rules_on });
});

// ============================================================
// ROUTE STATS GLOBALES
// ============================================================
app.get(`${cfg.baseurl}/api/stats`, requireAuth, async (req, res) => {
  // Les deux sources sont indépendantes — l'échec de l'une ne bloque pas l'autre
  let active = 0, avgRatio = 0, dl_speed = 0, up_speed = 0;
  try {
    const torrents = await qbitRequest('get', '/torrents/info');
    active   = torrents.length;
    const ratios = torrents.map(t => t.ratio).filter(r => r > 0);
    avgRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
    dl_speed = torrents.reduce((s, t) => s + (t.dlspeed || 0), 0);
    up_speed = torrents.reduce((s, t) => s + (t.upspeed || 0), 0);
  } catch (e) {
    console.error('[qBit]', e.message);
  }

  let disk_used_gb = null, disk_total_gb = null;
  let traffic_used_pct = null, traffic_reset_date = null;
  try {
    const info       = await getUltraccStats();
    disk_total_gb    = info.total_storage_value;
    disk_used_gb     = Math.round(disk_total_gb - info.free_storage_gb);
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
    dl_speed,
    up_speed,
    disk_used_gb,
    disk_total_gb,
    traffic_used_pct,
    traffic_reset_date
  });
});

// ============================================================
// ROUTE STATUT CONNEXIONS
// ============================================================
app.get(`${cfg.baseurl}/api/connections`, requireAuth, async (req, res) => {
  const [qbit, c411, ultracc] = await Promise.allSettled([
    qbitRequest('get', '/app/version').then(() => 'ok'),
    axios.get(cfg.c411.url, { params: { apikey: cfg.c411.apikey, t: 'caps' }, timeout: 8000 }).then(() => 'ok'),
    getUltraccStats().then(() => 'ok'),
  ]);
  res.json({
    qbittorrent: qbit.status    === 'fulfilled' ? 'ok' : 'error',
    c411:        c411.status    === 'fulfilled' ? 'ok' : 'error',
    ultracc:     ultracc.status === 'fulfilled' ? 'ok' : 'error',
  });
});

// ============================================================
// ROUTES CLEANER
// ============================================================

// GET /api/cleaner/status
app.get(`${cfg.baseurl}/api/cleaner/status`, requireAuth, (req, res) => {
  res.json(cleaner.getStatus());
});

let lastCleanerRunAt = 0;

// POST /api/cleaner/run — nettoyage immédiat
app.post(`${cfg.baseurl}/api/cleaner/run`, requireAuth, async (req, res) => {
  if (Date.now() - lastCleanerRunAt < 30000) return res.status(429).json({ error: 'Réessayez dans quelques secondes' });
  lastCleanerRunAt = Date.now();
  try {
    const deleted = await cleaner.runClean('manuel');
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// POST /api/cleaner/schedule — mise à jour planning
app.post(`${cfg.baseurl}/api/cleaner/schedule`, requireAuth, (req, res) => {
  const { interval_hours, enabled } = req.body;
  const hours = Math.max(1, Math.min(8760, parseInt(interval_hours) || 1));
  cfg.cleaner = { ...cfg.cleaner, interval_hours: hours, enabled: !!enabled };
  saveCfg();
  cleaner.reschedule(hours, !!enabled);
  console.log(`[cleaner] schedule mis à jour : ${hours}h, enabled=${!!enabled}`);
  res.json({ ok: true, ...cleaner.getStatus() });
});

// ============================================================
// AUTO-GRAB
// ============================================================

let autoGrabStatus = {
  enabled:      false,
  last_run:     null,
  grabs_today:  0,
  grabs_date:   null,
  last_grabbed: [],
  running:      false,
};

async function runAutoGrab() {
  if (autoGrabStatus.running) return 0;
  autoGrabStatus.running = true;
  let grabbed = 0;
  try {
    // Utilise cfg en mémoire (déjà déchiffré) — jamais le fichier disque
    const { grab_limit_per_day, size_max_gb, active_max, min_leechers, min_seeders } = cfg.rules || {};
    const rulesOn = cfg.rules_on || {};
    const isRuleOn = (k) => rulesOn[k] !== false;

    // Remise à zéro du compteur journalier si nouveau jour
    const today = new Date().toISOString().split('T')[0];
    if (autoGrabStatus.grabs_date !== today) {
      autoGrabStatus.grabs_today = 0;
      autoGrabStatus.grabs_date  = today;
    }

    console.log('[auto-grab] Démarrage');

    const limit     = isRuleOn('grab_limit_per_day') ? (grab_limit_per_day ?? 20) : Infinity;
    const remaining = isFinite(limit) ? limit - autoGrabStatus.grabs_today : Infinity;
    if (isFinite(remaining) && remaining <= 0) {
      console.log('[auto-grab] Limite journalière atteinte');
      return 0;
    }

    let torrents = [];
    try {
      torrents = await qbitRequest('get', '/torrents/info');
    } catch(e) {
      console.error('[auto-grab] qBittorrent inaccessible :', e.message);
      return 0;
    }
    const existingHashes = new Set(torrents.map(t => t.hash.toLowerCase()));

    const maxActive      = isRuleOn('active_max') && active_max != null ? active_max : null;
    // Si aucune des deux limites n'est active, on cap à 100 par sécurité
    const slotsAvailable = maxActive != null ? Math.max(0, maxActive - torrents.length) : (isFinite(remaining) ? remaining : 100);
    if (slotsAvailable <= 0) {
      console.log(`[auto-grab] Limite active atteinte (${torrents.length}/${maxActive})`);
      return 0;
    }

    let list = [];
    try {
      const r      = await axios.get(cfg.c411.url, {
        params: { apikey: cfg.c411.apikey, t: 'search', q: '', limit: 100 },
        timeout: 15000
      });
      const parsed = xmlParser.parse(r.data);
      const items  = parsed?.rss?.channel?.item || [];
      list = (Array.isArray(items) ? items : [items]).flatMap(item => {
        const attrs    = [].concat(item['torznab:attr'] || []);
        const attr     = (name) => attrs.find(a => a['@_name'] === name)?.['@_value'];
        const infohash = (attr('infohash') || '').toLowerCase();
        const link     = item.enclosure?.['@_url'] || '';
        if (!link || !infohash) return [];
        const seeders  = parseInt(attr('seeders') || 0);
        const peers    = parseInt(attr('peers')   || 0);
        return [{
          name:     item.title,
          size:     parseInt(attr('size') || item.size || 0),
          leechers: Math.max(0, peers - seeders),
          seeders,
          infohash,
          link,
          page_url: item.link || '',
        }];
      });
    } catch(e) {
      console.error('[auto-grab] C411 inaccessible :', e.message);
      return 0;
    }

    const sizeLimitBytes = isRuleOn('size_max_gb') && size_max_gb ? size_max_gb * 1e9 : Infinity;
    const canGrab        = Math.min(isFinite(remaining) ? remaining : 100, slotsAvailable);
    const candidates     = list
      .filter(t => !existingHashes.has(t.infohash))
      .filter(t => t.size <= sizeLimitBytes)
      .filter(t => !isRuleOn('min_leechers') || min_leechers == null || t.leechers >= min_leechers)
      .filter(t => !isRuleOn('min_seeders')  || min_seeders  == null || t.seeders  >= min_seeders)
      .sort((a, b) => b.leechers - a.leechers)
      .slice(0, canGrab);

    autoGrabStatus.last_grabbed = [];
    let nameMapDirty = false;
    for (const t of candidates) {
      try {
        await qbitRequest('post', '/torrents/add', `urls=${encodeURIComponent(t.link)}`);
        if (t.infohash) { nameMap[t.infohash.toLowerCase()] = t.name; nameMapDirty = true; }
        autoGrabStatus.grabs_today++;
        autoGrabStatus.last_grabbed.push({ name: t.name, url: t.page_url || null });
        grabbed++;
        console.log(`[auto-grab] Grabé : ${t.name}`);
      } catch(e) {
        console.error(`[auto-grab] Erreur grab "${t.name}" : ${e.message}`);
      }
    }
    if (nameMapDirty) saveNameMap();
  } catch(e) {
    console.error('[auto-grab]', e.message);
  } finally {
    autoGrabStatus.last_run = new Date().toISOString();
    autoGrabStatus.running  = false;
    console.log(`[auto-grab] Terminé — ${grabbed} grabé(s)`);
  }
  return grabbed;
}

// GET /api/history
app.get(`${cfg.baseurl}/api/history`, requireAuth, (req, res) => {
  try {
    const hist = JSON.parse(fs.readFileSync(HISTORY_PATH));
    res.json(hist);
  } catch { res.json([]); }
});

// DELETE /api/history — supprimer une entrée par sa date (identifiant unique)
app.delete(`${cfg.baseurl}/api/history`, requireAuth, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date requis' });
  try {
    let hist = JSON.parse(fs.readFileSync(HISTORY_PATH));
    const idx = hist.findIndex(e => e.date === date);
    if (idx === -1) return res.status(404).json({ error: 'Entrée introuvable' });
    hist.splice(idx, 1);
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hist));
    fs.renameSync(tmp, HISTORY_PATH);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur interne' }); }
});

// GET /api/auto-grab/status
app.get(`${cfg.baseurl}/api/auto-grab/status`, requireAuth, (req, res) => {
  res.json({ ...autoGrabStatus });
});

// POST /api/auto-grab/config
app.post(`${cfg.baseurl}/api/auto-grab/config`, requireAuth, (req, res) => {
  const { enabled } = req.body;
  autoGrabStatus.enabled = !!enabled;
  cfg.auto_grab = { enabled: autoGrabStatus.enabled };
  saveCfg();
  console.log(`[auto-grab] enabled=${autoGrabStatus.enabled}`);
  res.json({ ok: true, ...autoGrabStatus });
});

let lastAutoGrabRunAt = 0;

// POST /api/auto-grab/run
app.post(`${cfg.baseurl}/api/auto-grab/run`, requireAuth, async (req, res) => {
  if (Date.now() - lastAutoGrabRunAt < 30000) return res.status(429).json({ error: 'Réessayez dans quelques secondes' });
  lastAutoGrabRunAt = Date.now();
  try {
    const source  = req.body?.source || 'auto';
    const grabbed = await runAutoGrab();
    if (grabbed > 0) {
      appendHistory('grab', grabbed, source, autoGrabStatus.last_grabbed || []);
    }
    res.json({ ok: true, grabbed, ...autoGrabStatus });
  } catch(e) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// ============================================================
// ROUTES SECRETS (connexions & API)
// ============================================================

// GET /api/config/secrets — valeurs masquées pour l'interface
app.get(`${cfg.baseurl}/api/config/secrets`, requireAuth, (req, res) => {
  res.json({
    c411_apikey:   maskSecret(cfg.c411?.apikey),
    qbit_url:      cfg.qbittorrent?.url      || '',
    qbit_username: cfg.qbittorrent?.username || '',
    qbit_password: maskSecret(cfg.qbittorrent?.password, 1),
    ultracc_url:   cfg.ultracc_api?.url      || '',
    ultracc_token: maskSecret(cfg.ultracc_api?.token),
  });
});

function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

// POST /api/config/secrets — mise à jour (champs vides ignorés)
app.post(`${cfg.baseurl}/api/config/secrets`, requireAuth, (req, res) => {
  const { c411_apikey, qbit_url, qbit_username, qbit_password, ultracc_url, ultracc_token } = req.body;
  if (qbit_url    && !isHttpUrl(qbit_url))    return res.status(400).json({ error: 'qbit_url invalide (doit commencer par http:// ou https://)' });
  if (ultracc_url && !isHttpUrl(ultracc_url)) return res.status(400).json({ error: 'ultracc_url invalide (doit commencer par http:// ou https://)' });
  if (c411_apikey)   cfg.c411.apikey          = c411_apikey;
  if (qbit_url)      cfg.qbittorrent.url       = qbit_url;
  if (qbit_username) cfg.qbittorrent.username  = qbit_username;
  if (qbit_password) { cfg.qbittorrent.password = qbit_password; qbitCookie = null; }
  if (ultracc_url)   { cfg.ultracc_api.url      = ultracc_url;   ultraccCache = { data: null, lastFetch: 0 }; }
  if (ultracc_token) { cfg.ultracc_api.token    = ultracc_token; ultraccCache = { data: null, lastFetch: 0 }; }
  saveCfg();
  console.log('[secrets] Connexions mises à jour');
  res.json({ ok: true });
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
    interval_minutes: Math.max(1, parseInt(interval_minutes) || 15)
  };
  saveCfg();
  scheduleAutoGrab();
  console.log(`[auto-refresh] enabled=${cfg.auto_refresh.enabled}, interval=${cfg.auto_refresh.interval_minutes}min`);
  res.json({ ok: true, ...cfg.auto_refresh });
});

// ============================================================
// AUTO-GRAB TIMER SERVEUR
// ============================================================
let autoGrabTimer = null;

function scheduleAutoGrab() {
  if (autoGrabTimer) { clearInterval(autoGrabTimer); autoGrabTimer = null; }
  if (!cfg.auto_refresh?.enabled) {
    console.log('[auto-grab] timer désactivé');
    return;
  }
  autoGrabTimer = setInterval(async () => {
    const intervalMs = (cfg.auto_refresh.interval_minutes || 15) * 60 * 1000;
    const lastRun    = autoGrabStatus.last_run ? new Date(autoGrabStatus.last_run).getTime() : 0;
    if (Date.now() - lastRun >= intervalMs) {
      const grabbed = await runAutoGrab();
      if (grabbed > 0) appendHistory('grab', grabbed, 'auto', autoGrabStatus.last_grabbed || []);
    }
  }, 60 * 1000); // vérifie toutes les minutes
  console.log(`[auto-grab] timer serveur : toutes les ${cfg.auto_refresh.interval_minutes}min`);
}

// ============================================================
// START
// ============================================================

// Nettoyage périodique de loginAttempts (évite fuite mémoire)
function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count++;
  entry.lastAttempt = Date.now();
  if (entry.count >= 5) entry.blockedUntil = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(ip, entry);
}
setInterval(() => {
  const now = Date.now();
  const TTL = 15 * 60 * 1000;
  for (const [ip, entry] of loginAttempts) {
    const expired = entry.blockedUntil ? now > entry.blockedUntil : now - (entry.lastAttempt || 0) > TTL;
    if (expired) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

initConfig();
cleaner.setRunCompleteCallback((st) => {
  saveCfg();
  if (st.last_deleted_count > 0) {
    appendHistory('clean', st.last_deleted_count, st.last_run_type, st.last_deleted_names || []);
  }
});
initAuth().then(() => {
  decryptSecrets();
  saveCfg();
  autoGrabStatus.enabled = cfg.auto_grab.enabled === true;
  scheduleAutoGrab();

  app.listen(cfg.port, '0.0.0.0', () => {
    console.log(`SeedDash démarré → http://0.0.0.0:${cfg.port}${cfg.baseurl}`);
  });
});
