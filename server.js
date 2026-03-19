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

/**
 * Lit une valeur imbriquée dans un objet en suivant un chemin de clés.
 * Exemple : getIn(cfg, ['qbittorrent', 'password']) → cfg.qbittorrent.password
 * Retourne undefined si un niveau intermédiaire est absent.
 */
function getIn(obj, path) { return path.reduce((o, k) => o?.[k], obj); }

/**
 * Écrit une valeur à un chemin imbriqué dans un objet existant.
 * Modifie l'objet en place — ne crée pas les niveaux manquants.
 */
function setIn(obj, path, val) {
  const parent = path.slice(0, -1).reduce((o, k) => o[k], obj);
  if (parent) parent[path[path.length - 1]] = val;
}

/**
 * Masque partiellement un secret pour l'affichage (interface utilisateur).
 * Conserve `show` caractères au début et à la fin, remplace le reste par des étoiles.
 * Si la valeur est trop courte, retourne 8 étoiles fixes pour éviter de révéler la longueur.
 */
function maskSecret(val, show = 3) {
  if (!val) return '';
  if (val.length <= show * 2) return '*'.repeat(8);
  return val.slice(0, show) + '*'.repeat(val.length - show * 2) + val.slice(-show);
}

/**
 * Résout la clé de signature JWT.
 * Priorité : variable d'environnement JWT_SECRET (PM2) > cfg.auth.jwt_secret (config.json).
 */
function getJwtSecret() {
  return process.env.JWT_SECRET || cfg.auth?.jwt_secret;
}

/**
 * Déchiffre en mémoire tous les champs secrets de `cfg` qui sont stockés chiffrés sur disque.
 * Doit être appelé au démarrage, après que la clé JWT soit disponible.
 * Sans clé JWT, la fonction est silencieusement sans effet.
 */
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
const CONN_PATH     = path.join(__dirname, 'connections.json');
const HISTORY_PATH  = path.join(__dirname, 'logs', 'history.json');
const HISTORY_MAX   = 500;
const TOP_CACHE_PATH = path.join(__dirname, 'logs', 'top-cache.json');
// Associe hash qBittorrent → nom C411, pour afficher le nom C411 dans les torrents actifs
const NAMEMAP_PATH    = path.join(__dirname, 'logs', 'namemap.json');
const CATMAP_PATH     = path.join(__dirname, 'logs', 'categorymap.json');
const UPLOAD_HISTORY_PATH = path.join(__dirname, 'logs', 'upload-history.json');
// Clés appartenant à connections.json
const CONN_KEYS = ['c411', 'qbittorrent', 'ultracc_api', 'auth'];
let cfg = {
  ...JSON.parse(fs.readFileSync(CFG_PATH)),
  ...(() => { try { return JSON.parse(fs.readFileSync(CONN_PATH)); } catch { return {}; } })(),
};

if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
}

// Cache top leechers (persisté sur disque)
let topCache = { items: [], date: null };
try { topCache = JSON.parse(fs.readFileSync(TOP_CACHE_PATH)); } catch {}

// Correspondance hash → nom C411 (persistée sur disque)
let nameMap = {};
try { nameMap = JSON.parse(fs.readFileSync(NAMEMAP_PATH)); } catch {}

/**
 * Persiste nameMap sur disque via écriture atomique (tmp + rename).
 * Appelée à chaque modification de nameMap pour maintenir la cohérence disque/mémoire.
 */
function saveNameMap() {
  try {
    const tmp = NAMEMAP_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(nameMap, null, 2));
    fs.renameSync(tmp, NAMEMAP_PATH);
  } catch(e) { console.error('[namemap]', e.message); }
}

// Correspondance hash → catégorie C411 (persistée sur disque)
let categoryMap = {};
try { categoryMap = JSON.parse(fs.readFileSync(CATMAP_PATH)); } catch {}

/**
 * Persiste categoryMap sur disque via écriture atomique (tmp + rename).
 * Appelée à chaque modification de categoryMap pour maintenir la cohérence disque/mémoire.
 */
function saveCategoryMap() {
  try {
    const tmp = CATMAP_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(categoryMap, null, 2));
    fs.renameSync(tmp, CATMAP_PATH);
  } catch(e) { console.error('[categorymap]', e.message); }
}

// Historique d'upload par hash : { hash: [[timestamp_s, cumul_bytes], ...] }
let uploadHistory = {};
try { uploadHistory = JSON.parse(fs.readFileSync(UPLOAD_HISTORY_PATH)); } catch {}

/**
 * Persiste uploadHistory sur disque via écriture atomique (tmp + rename).
 * Utilise JSON sans indentation pour limiter la taille du fichier (données volumineuses).
 */
function saveUploadHistory() {
  try {
    const tmp = UPLOAD_HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(uploadHistory));
    fs.renameSync(tmp, UPLOAD_HISTORY_PATH);
  } catch(e) { console.error('[upload-history]', e.message); }
}

/**
 * Supprime de uploadHistory les entrées dont le hash n'est plus actif dans qBittorrent.
 * Évite une accumulation infinie de points de mesure pour des torrents supprimés.
 * @param {Set<string>} activeHashes - Ensemble des hashs actuellement actifs dans qBittorrent
 */
function pruneUploadHistory(activeHashes) {
  let dirty = false;
  for (const hash of Object.keys(uploadHistory)) {
    if (!activeHashes.has(hash)) { delete uploadHistory[hash]; dirty = true; }
  }
  if (dirty) saveUploadHistory();
}

// Liste plate des torrents grabbés (persistée sur disque, max 500 entrées)
const TORRENT_LIST_PATH = path.join(__dirname, 'logs', 'torrent-list.json');
const TORRENT_LIST_MAX  = 500;
let torrentList = [];
try { torrentList = JSON.parse(fs.readFileSync(TORRENT_LIST_PATH)); } catch {}

/**
 * Ajoute des entrées dans la liste plate des torrents grabés (torrent-list.json).
 * Ignore les entrées sans hash ou sans nom, et déduplique par hash.
 * Insère en tête de liste et tronque à TORRENT_LIST_MAX (500) entrées.
 * Persiste immédiatement via écriture atomique.
 * @param {Array<{hash: string, name: string, url?: string}>} entries - Torrents à ajouter
 */
function appendTorrentList(entries) {
  // entries = [{ hash, name, url }]
  for (const e of entries) {
    if (!e.hash || !e.name) continue;
    if (torrentList.some(t => t.hash === e.hash)) continue; // pas de doublon
    torrentList.unshift({ hash: e.hash, name: e.name, url: e.url || null, date: new Date().toISOString() });
  }
  if (torrentList.length > TORRENT_LIST_MAX) torrentList = torrentList.slice(0, TORRENT_LIST_MAX);
  try {
    const tmp = TORRENT_LIST_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(torrentList, null, 2));
    fs.renameSync(tmp, TORRENT_LIST_PATH);
  } catch(e) { console.error('[torrent-list]', e.message); }
}

const app = express();
app.set('trust proxy', 1); // Lit X-Forwarded-For depuis Nginx pour la protection brute-force
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,   // évite upgrade-insecure-requests et les autres defaults Helmet
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'"],
      imgSrc:         ["'self'", "data:"],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      formAction:     ["'self'"],
      frameAncestors: ["'none'"],
    }
  }
}));
app.use(cookieParser());
app.use(express.json({ limit: '64kb' }));
app.use(cfg.baseurl, express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// --- Helpers ---
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * Persiste la configuration générale dans config.json (hors connexions/secrets).
 * Synchronise d'abord le statut live du cleaner (last_run, last_deleted_count, last_run_type)
 * pour ne pas perdre ces données entre deux redémarrages.
 * Utilise un fichier .tmp + renameSync pour éviter les corruptions en cas de crash.
 */
function saveCfg() {
  // Toujours fusionner le statut live du cleaner pour persistance
  const st = cleaner.getStatus();
  cfg.auto_clean.last_run           = st.last_run;
  cfg.auto_clean.last_deleted_count = st.last_deleted_count;
  cfg.auto_clean.last_run_type      = st.last_run_type;
  // N'écrire que les clés de config générale (sans les connexions)
  const toWrite = Object.fromEntries(Object.entries(cfg).filter(([k]) => !CONN_KEYS.includes(k)));
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

/**
 * Persiste les connexions et secrets dans connections.json.
 * Les secrets (apikey, password, token) sont rechiffrés AES-256-GCM avant l'écriture.
 * Si JWT_SECRET provient de la variable d'environnement, la clé n'est pas écrite sur disque.
 * Utilise un fichier .tmp + renameSync pour éviter les corruptions en cas de crash.
 */
function saveConn() {
  // N'écrire que les clés de connexion, secrets chiffrés
  const toWrite = JSON.parse(JSON.stringify(
    Object.fromEntries(Object.entries(cfg).filter(([k]) => CONN_KEYS.includes(k)))
  ));
  const key = getJwtSecret();
  if (key) {
    for (const p of SECRET_PATHS) {
      const v = getIn(toWrite, p);
      if (v && !v.startsWith(PREFIX)) setIn(toWrite, p, encrypt(v, key));
    }
  }
  // Si JWT_SECRET vient de l'env, ne pas le réécrire dans connections.json
  if (process.env.JWT_SECRET && toWrite.auth) delete toWrite.auth.jwt_secret;
  const tmp = CONN_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2));
    fs.renameSync(tmp, CONN_PATH);
  } catch(e) {
    console.error('[connections] ERREUR SAUVEGARDE:', e.message);
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// --- Historique ---

/**
 * Ajoute une entrée dans l'historique des actions (grab, clean, delete).
 * Relit le fichier history.json à chaque appel pour éviter les conflits d'écriture concurrente.
 * Tronque à HISTORY_MAX entrées (500) pour limiter la taille du fichier.
 * @param {string} type    - Type d'action : 'grab', 'clean' ou 'delete'
 * @param {number} count   - Nombre d'éléments concernés
 * @param {string} source  - Origine de l'action : 'manuel', 'auto', etc.
 * @param {Array}  names   - Liste des torrents concernés [{name, url}]
 */
function appendHistory(type, count, source, names = []) {
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(HISTORY_PATH)); } catch {}
  hist.unshift({ type, date: new Date().toISOString(), count, source, names });
  if (hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  try {
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hist, null, 2));
    fs.renameSync(tmp, HISTORY_PATH);
  } catch(e) { console.error('[history] Erreur écriture:', e.message); }
}

// --- Config defaults init (crée les clés manquantes au premier démarrage) ---

/**
 * Initialise les clés de configuration manquantes avec leurs valeurs par défaut.
 * Appelée au démarrage pour assurer la rétrocompatibilité avec les configs antérieures.
 * Sauvegarde automatiquement si des clés ont été ajoutées.
 */
function initConfig() {
  let changed = false;
  // rules_on par défaut alignés sur defOn du client (app.js RULE_DEFS) :
  // absent de rules_on = traité comme true côté serveur → doit être explicitement false pour les règles opt-in
  const DEFAULT_GRAB_RULES_ON  = { grab_limit_per_day: true, size_max_gb: true, active_max: false, min_leechers: false, min_seeders: false };
  if (!cfg.auto_grab) {
    cfg.auto_grab = { enabled: false, interval_minutes: 15, last_run: null, last_grab_count: 0,
      rules: { grab_limit_per_day: 20, size_max_gb: 100, active_max: 15, min_leechers: 0, min_seeders: 0 },
      rules_on: { ...DEFAULT_GRAB_RULES_ON } };
    changed = true;
  }
  if (!cfg.auto_grab.rules)    { cfg.auto_grab.rules    = { grab_limit_per_day: 20, size_max_gb: 100, active_max: 15, min_leechers: 0, min_seeders: 0 }; changed = true; }
  if (!cfg.auto_grab.rules_on) { cfg.auto_grab.rules_on = { ...DEFAULT_GRAB_RULES_ON }; changed = true; }
  const DEFAULT_CLEAN_RULES_ON = { ratio_min: true, ratio_max: false, age_min_hours: true, age_max_hours: false, upload_min_mb: true };
  if (!cfg.auto_clean) {
    cfg.auto_clean = { enabled: false, interval_hours: 1,
      rules: { ratio_min: 1.0, age_min_hours: 48 }, rules_on: { ...DEFAULT_CLEAN_RULES_ON } };
    changed = true;
  }
  if (!cfg.auto_clean.rules)    { cfg.auto_clean.rules    = { ratio_min: 1.0, age_min_hours: 48 }; changed = true; }
  if (!cfg.auto_clean.rules_on) { cfg.auto_clean.rules_on = { ...DEFAULT_CLEAN_RULES_ON }; changed = true; }
  if (changed) {
    saveCfg();
    console.log('[config] Clés manquantes initialisées et sauvegardées');
  }
}

// --- Auth init ---

/**
 * Initialise le bloc d'authentification au premier démarrage.
 * - Génère un jwt_secret aléatoire (64 octets hex) si absent et si JWT_SECRET n'est pas en env.
 * - Hache le mot de passe par défaut 'changeme' (bcrypt, coût 12) si aucun hash existant.
 * - Applique les migrations de clés ajoutées après la v1.0 (token_expiry, issued_after).
 * Sauvegarde via saveConn() uniquement si des modifications ont été faites.
 */
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
  if (changed) saveConn();
}

// --- Brute-force protection ---
const loginAttempts = new Map(); // ip -> { count, blockedUntil }

/**
 * Vérifie si une IP est actuellement bloquée par la protection brute-force.
 * Nettoie automatiquement l'entrée si le blocage a expiré.
 * @returns {boolean} true si l'IP est bloquée, false sinon
 */
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

/**
 * Réinitialise le compteur d'échecs de connexion pour une IP donnée.
 * Appelé après un login réussi.
 */
function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// --- Auth middleware ---

/**
 * Middleware Express qui vérifie l'authentification JWT pour toutes les routes protégées.
 * Accepte le token depuis le cookie httpOnly `seedash_token` (prioritaire)
 * ou depuis l'en-tête `Authorization: Bearer <token>` (compatibilité).
 * Rejette les tokens émis avant le dernier changement de mot de passe (issued_after).
 */
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

// POST /api/login — authentification par username/password, retourne un cookie httpOnly JWT
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

// POST /api/change-password — change le mot de passe et invalide tous les tokens existants
app.post(`${cfg.baseurl}/api/change-password`, requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Champs manquants' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  const ok = await bcrypt.compare(current_password, cfg.auth.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  cfg.auth.password_hash = await bcrypt.hash(new_password, 12);
  // Invalide tous les tokens émis avant ce changement
  cfg.auth.issued_after = Math.floor(Date.now() / 1000);
  saveConn();
  res.json({ ok: true });
});

// POST /api/logout — supprime le cookie de session
app.post(`${cfg.baseurl}/api/logout`, (req, res) => {
  res.clearCookie('seedash_token', { sameSite: 'Strict' });
  res.json({ ok: true });
});

// --- Ultra.cc API cache (TTL 60s) ---
let ultraccCache = { data: null, lastFetch: 0 };

/**
 * Retourne les statistiques Ultra.cc (disque, trafic) avec mise en cache pour éviter les 429.
 * Stratégie de cache à deux niveaux :
 *  - Cache frais (< 5 minutes) : retour immédiat sans requête réseau
 *  - Essai récent (< 60 secondes) : retourne les données périmées si disponibles, sinon erreur
 *  - Sinon : déclenche une nouvelle requête vers l'API Ultra.cc
 * L'horodatage du dernier essai est mis à jour avant la requête pour éviter les appels concurrents.
 */
async function getUltraccStats() {
  const now = Date.now();
  const age = now - ultraccCache.lastFetch;
  // Cache frais → retour immédiat
  if (ultraccCache.data && age < 300000) return ultraccCache.data;
  // Essai récent (succès ou échec) → pas de retry avant 60s pour éviter les 429
  if (age < 60000) {
    if (ultraccCache.data) return ultraccCache.data; // données légèrement périmées, OK
    throw new Error('Ultra.cc indisponible (anti-429)');
  }
  // Marquer l'essai AVANT la requête → bloque les appels concurrents en cas d'erreur
  ultraccCache.lastFetch = now;
  const r = await axios.get(cfg.ultracc_api.url, {
    headers: { Authorization: `Bearer ${cfg.ultracc_api.token}` },
    timeout: 15000
  });
  ultraccCache.data = r.data.service_stats_info;
  return ultraccCache.data;
}

// --- qBittorrent session ---
let qbitCookie = null;

/**
 * Ouvre une session qBittorrent et stocke le cookie de session dans `qbitCookie`.
 * Utilise l'authentification form-urlencoded attendue par l'API qBittorrent v2.
 * @returns {string} Le cookie de session (format "SID=...") extrait de l'en-tête Set-Cookie
 */
async function qbitLogin() {
  const r = await axios.post(
    `${cfg.qbittorrent.url}/api/v2/auth/login`,
    `username=${encodeURIComponent(cfg.qbittorrent.username)}&password=${encodeURIComponent(cfg.qbittorrent.password)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  qbitCookie = r.headers['set-cookie']?.[0]?.split(';')[0];
  return qbitCookie;
}

/**
 * Exécute une requête vers l'API qBittorrent v2 avec gestion automatique de session.
 * Se connecte si aucun cookie n'est disponible.
 * En cas d'erreur 403 (session expirée), effectue un re-login unique et retente la requête.
 * @param {string} method   - Méthode HTTP ('get' ou 'post')
 * @param {string} endpoint - Chemin API après '/api/v2' (ex: '/torrents/info')
 * @param {string|null} data - Corps de la requête POST (form-urlencoded) ou null
 */
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
// Toutes les routes d'accès à l'indexeur C411 (top leechers, cache)
// ============================================================

// GET /api/top-leechers?n=20&cat=all — récupère et trie le top des torrents par nombre de leechers
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
        category: attr('category') || (Array.isArray(item.category) ? item.category[0] : item.category) || '',
        pubDate:  item.pubDate || ''
      };
    });
    list.sort((a, b) => b.leechers - a.leechers);
    topCache = { items: list.slice(0, n), date: new Date().toISOString() };
    try {
      const tmp = TOP_CACHE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(topCache, null, 2));
      fs.renameSync(tmp, TOP_CACHE_PATH);
    } catch(e) { console.error('[top-cache]', e.message); }

    // Fire-and-forget : résoudre en arrière-plan les noms/catégories des torrents actifs
    // absents du nameMap et du cache top courant, via recherche C411 par infohash ou titre
    (async () => {
      try {
        const active = await qbitRequest('get', '/torrents/info');
        // Index top courant hash → {nom, catégorie} (non tronqué à 100, utilise list entière)
        const topByHashName = {};
        const topByHashCat  = {};
        for (const item of list) {
          if (item.infohash) {
            const h = item.infohash.toLowerCase();
            topByHashName[h] = item.name;
            if (item.category != null) topByHashCat[h] = String(item.category);
          }
        }
        // Étape 1 : persister dans nameMap/categoryMap les actifs présents dans le top courant
        let nameMapDirty = false;
        let catMapDirty  = false;
        for (const t of active) {
          const hash = t.hash.toLowerCase();
          if (!nameMap[hash]     && topByHashName[hash]) { nameMap[hash]     = topByHashName[hash]; nameMapDirty = true; }
          if (!categoryMap[hash] && topByHashCat[hash])  { categoryMap[hash] = topByHashCat[hash];  catMapDirty  = true; }
        }
        if (nameMapDirty) saveNameMap();
        if (catMapDirty)  saveCategoryMap();
        // Étape 2 : résoudre via recherche C411 les actifs sans catégorie ou sans nom C411
        const unmapped = active.filter(t => {
          const h = t.hash.toLowerCase();
          return !categoryMap[h] || (!nameMap[h] && !topByHashName[h]);
        });
        for (const t of unmapped) {
          const hash    = t.hash.toLowerCase();
          const needCat  = !categoryMap[hash];
          const needName = !nameMap[hash] && !topByHashName[hash];
          if (!needCat && !needName) continue;
          // Nettoyage du nom interne qBittorrent pour construire des requêtes de recherche exploitables
          const base = t.name.replace(/\.(mkv|avi|mp4|m4v|ts|iso)$/i, '').replace(/\./g, ' ');
          // Supprime l'année et les tags techniques pour isoler le titre significatif
          const titleClean = base.replace(/\b(19\d{2}|20\d{2})\b.*/, '').replace(/\b(1080p|2160p|720p|4K|UHD|BluRay|WEB|HDTV|MULTI|MULTi|COMPLETE|S\d{2}|REMUX|Hybrid)\b.*/i, '').replace(/[-.()\s]+$/, '').trim();
          const stopWords = new Set(['the','a','an','la','le','les','de','du','des','un','une']);
          // Filtre les mots vides pour garder les mots significatifs du titre
          const sigWords = titleClean.split(/\s+/).filter(w => !stopWords.has(w.toLowerCase()));
          // Séquence de requêtes progressivement moins précises : infohash d'abord, puis titre tronqué
          const queries = [
            hash,
            titleClean,
            sigWords.slice(0, 4).join(' '),
            sigWords.slice(0, 3).join(' '),
            sigWords.slice(0, 2).join(' '),
            sigWords[0] || titleClean.split(/\s+/)[0],
          ].filter((q, i, a) => q && q.length >= 2 && a.indexOf(q) === i);
          let resolved = false;
          for (const query of queries) {
            if (resolved) break;
            try {
              const r      = await axios.get(cfg.c411.url, { params: { apikey: cfg.c411.apikey, t: 'search', q: query, limit: 200 }, timeout: 8000 });
              const parsed = xmlParser.parse(r.data);
              const raw    = parsed?.rss?.channel?.item;
              if (raw) {
                const results = Array.isArray(raw) ? raw : [raw];
                for (const item of results) {
                  const attrs = [].concat(item['torznab:attr'] || []);
                  const ih    = (attrs.find(a => a['@_name'] === 'infohash')?.['@_value'] || '').toLowerCase();
                  if (ih === hash) {
                    if (needName && item.title) { nameMap[hash] = item.title; saveNameMap(); console.log(`[nameresolve] ${hash.substring(0,8)}… → ${item.title}`); }
                    const cat = attrs.find(a => a['@_name'] === 'category')?.['@_value']
                      ?? (Array.isArray(item.category) ? item.category[0] : item.category) ?? null;
                    if (needCat && cat != null) { categoryMap[hash] = String(cat); saveCategoryMap(); console.log(`[catresolve] ${hash.substring(0,8)}… → cat ${cat}`); }
                    resolved = true;
                    break;
                  }
                }
              }
            } catch {}
            if (!resolved) await new Promise(resolve => setTimeout(resolve, 400));
          }
          await new Promise(resolve => setTimeout(resolve, 600));
        }
      } catch {}
    })();

    res.json(topCache);
  } catch (e) {
    console.error('[C411]', e.message);
    if (topCache.items?.length) {
      console.log('[C411] fallback sur le cache disque');
      res.json({ ...topCache, _cached: true });
    } else {
      res.status(500).json({ error: 'C411 inaccessible et aucun cache disponible' });
    }
  }
});

// GET /api/top-leechers/cache — retourne le cache top leechers en mémoire sans requête C411
app.get(`${cfg.baseurl}/api/top-leechers/cache`, requireAuth, (req, res) => {
  res.json(topCache);
});

// ============================================================
// ROUTES qBITTORRENT
// Gestion des torrents actifs : liste, ajout (grab), suppression, historique d'upload
// ============================================================

// GET /api/torrents — liste tous les torrents actifs avec résolution du nom C411 et de la catégorie
app.get(`${cfg.baseurl}/api/torrents`, requireAuth, async (req, res) => {
  try {
    // Index du cache top leechers par infohash pour résoudre les noms et catégories C411
    const topByHash = {};
    const topCatByHash = {};
    for (const item of topCache.items || []) {
      if (item.infohash) {
        const h = item.infohash.toLowerCase();
        topByHash[h] = item.name;
        if (item.category != null) topCatByHash[h] = String(item.category);
      }
    }
    const data = await qbitRequest('get', '/torrents/info');
    // Pré-calcul de la condition upload_min_mb (miroir de uploadCondition dans cleaner.js)
    const cleanRules  = cfg.auto_clean?.rules    || {};
    const cleanOn     = cfg.auto_clean?.rules_on || {};
    const isCleanOn   = (k) => cleanOn[k] !== false;
    const nowSec      = Math.floor(Date.now() / 1000);
    const ageMinSec   = (cleanRules.age_min_hours || 48) * 3600;
    const uploadMinMb = isCleanOn('upload_min_mb') && cleanRules.upload_min_mb > 0 ? cleanRules.upload_min_mb : null;
    const uploadWinSec = (cleanRules.upload_window_hours || 48) * 3600;
    const list = data.map(t => {
      const hash = t.hash.toLowerCase();
      // Condition upload : torrent "mort" (upload insuffisant sur la fenêtre glissante)
      let upload_condition = false;
      if (uploadMinMb !== null
        && (!isCleanOn('age_min_hours') || (nowSec - t.added_on) >= ageMinSec)
        && (!isCleanOn('ratio_min')     || t.ratio >= cleanRules.ratio_min)) {
        const points   = uploadHistory[hash] || [];
        const winStart = nowSec - uploadWinSec;
        const inWin    = points.filter(([ts]) => ts >= winStart);
        // L'historique doit couvrir toute la fenêtre (premier point antérieur à winStart)
        const historyCoversWindow = points.length > 0 && points[0][0] <= winStart;
        if (historyCoversWindow && inWin.length >= 2) {
          const delta = inWin[inWin.length - 1][1] - inWin[0][1];
          if (delta >= 0 && delta / 1e6 < uploadMinMb) upload_condition = true;
        }
      }
      return {
        hash:             t.hash,
        name:             nameMap[hash] || topByHash[hash] || t.name,
        size:             t.size,
        progress:         t.progress,
        state:            t.state,
        ratio:            t.ratio,
        seeding_time:     t.seeding_time,
        num_leechs:       t.num_leechs,
        num_seeds:        t.num_seeds,
        dlspeed:          t.dlspeed,
        upspeed:          t.upspeed,
        added_on:         t.added_on,
        completion_on:    t.completion_on,
        category:         categoryMap[hash] || topCatByHash[hash] || '',
        upload_condition,
      };
    });
    res.json({ torrents: list });
  } catch (e) {
    console.error('[qBit]', e.message);
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// POST /api/grab — soumet un torrent C411 à qBittorrent, mémorise le nom et la catégorie C411
app.post(`${cfg.baseurl}/api/grab`, requireAuth, async (req, res) => {
  const { url, name, page_url, infohash, category } = req.body;
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
    if (name && infohash) {
      const lhash = infohash.toLowerCase();
      nameMap[lhash] = name;
      saveNameMap();
      if (category != null) { categoryMap[lhash] = String(category); saveCategoryMap(); }
      appendTorrentList([{ hash: lhash, name, url: page_url || null }]);
    }
    console.log(`[grab] ok: ${name || '(sans nom)'}`);
    if (name) appendHistory('grab', 1, 'manuel', [{ name, url: page_url || null }]);
    res.json({ ok: true });
  } catch (e) {
    console.log('[grab] erreur:', e.response?.status, e.message);
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// DELETE /api/torrents/:hash — supprime un torrent de qBittorrent et nettoie nameMap/categoryMap/uploadHistory
app.delete(`${cfg.baseurl}/api/torrents/:hash`, requireAuth, async (req, res) => {
  const { hash } = req.params;
  if (!/^[a-f0-9]{40}$/i.test(hash)) return res.status(400).json({ error: 'Hash invalide' });
  const deleteFiles = req.query.deleteFiles === 'true';
  const name        = (req.query.name || hash).slice(0, 256);
  try {
    await qbitRequest('post', '/torrents/delete',
      `hashes=${hash}&deleteFiles=${deleteFiles}`
    );
    const lhash = hash.toLowerCase();
    if (nameMap[lhash]) { delete nameMap[lhash]; saveNameMap(); }
    if (categoryMap[lhash]) { delete categoryMap[lhash]; saveCategoryMap(); }
    if (uploadHistory[lhash]) { delete uploadHistory[lhash]; saveUploadHistory(); }
    appendHistory('delete', 1, 'manuel', [{ name, url: `https://c411.org/torrents/${hash}` }]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// GET /api/upload-history/:hash — retourne les points de mesure d'upload pour le graphique du torrent
app.get(`${cfg.baseurl}/api/upload-history/:hash`, requireAuth, (req, res) => {
  const { hash } = req.params;
  if (!/^[a-f0-9]{40}$/i.test(hash)) return res.status(400).json({ error: 'Hash invalide' });
  res.json({ points: uploadHistory[hash.toLowerCase()] || [] });
});

// ============================================================
// ROUTES RÈGLES
// Lecture et écriture des règles auto_grab et auto_clean avec validation croisée.
// Modèle de persistance des règles :
//   cfg.auto_grab.rules / cfg.auto_clean.rules     — valeurs numériques
//   cfg.auto_grab.rules_on / cfg.auto_clean.rules_on — état activé/désactivé par clé

const GRAB_RULE_KEYS  = new Set(['grab_limit_per_day','size_max_gb','active_max','min_leechers','min_seeders']);
const CLEAN_RULE_KEYS = new Set(['ratio_min','ratio_max','age_min_hours','age_max_hours','upload_min_mb','upload_window_hours']);
const VALID_RULE_KEYS = new Set([...GRAB_RULE_KEYS, ...CLEAN_RULE_KEYS]);

// GET /api/rules — retourne toutes les valeurs + toggles à plat (format attendu par le frontend)
app.get(`${cfg.baseurl}/api/rules`, requireAuth, (req, res) => {
  res.json({
    ...cfg.auto_grab.rules,
    ...cfg.auto_clean.rules,
    _on: { ...cfg.auto_grab.rules_on, ...cfg.auto_clean.rules_on },
  });
});

// POST /api/rules — valide et sauvegarde les nouvelles valeurs de règles + états des toggles
app.post(`${cfg.baseurl}/api/rules`, requireAuth, (req, res) => {
  const { _on, ...vals } = req.body;
  const nextGrab  = { ...cfg.auto_grab.rules };
  const nextClean = { ...cfg.auto_clean.rules };
  // Mise à jour des valeurs numériques en les routant vers le bon groupe (grab ou clean)
  for (const [k, v] of Object.entries(vals)) {
    if (!VALID_RULE_KEYS.has(k)) continue;
    if (typeof v === 'number' && isFinite(v) && v >= 0) {
      if (GRAB_RULE_KEYS.has(k))  nextGrab[k]  = v;
      else                         nextClean[k] = v;
    }
  }
  const nextGrabOn  = { ...cfg.auto_grab.rules_on };
  const nextCleanOn = { ...cfg.auto_clean.rules_on };
  // Mise à jour des états de toggles (true/false) par groupe
  if (_on && typeof _on === 'object') {
    for (const [k, v] of Object.entries(_on)) {
      if (!VALID_RULE_KEYS.has(k)) continue;
      if (GRAB_RULE_KEYS.has(k))  nextGrabOn[k]  = !!v;
      else                         nextCleanOn[k] = !!v;
    }
  }
  // Validations croisées (uniquement sur les règles actives)
  const isOn = (k) => (GRAB_RULE_KEYS.has(k) ? nextGrabOn : nextCleanOn)[k] !== false;
  if (isOn('ratio_max') && isOn('ratio_min') && nextClean.ratio_max <= nextClean.ratio_min)
    return res.status(400).json({ error: `Ratio maximum (${nextClean.ratio_max}) doit être strictement supérieur au ratio minimum (${nextClean.ratio_min})` });
  if (isOn('age_max_hours') && isOn('age_min_hours') && nextClean.age_max_hours <= nextClean.age_min_hours)
    return res.status(400).json({ error: `Âge maximum (${nextClean.age_max_hours}h) doit être strictement supérieur à l'âge minimum (${nextClean.age_min_hours}h)` });
  if (isOn('ratio_max') && nextClean.ratio_max <= 0)
    return res.status(400).json({ error: 'Ratio maximum doit être supérieur à 0' });
  if (isOn('age_max_hours') && nextClean.age_max_hours <= 0)
    return res.status(400).json({ error: 'Âge maximum doit être supérieur à 0' });
  cfg.auto_grab.rules    = nextGrab;
  cfg.auto_grab.rules_on = nextGrabOn;
  cfg.auto_clean.rules   = nextClean;
  cfg.auto_clean.rules_on = nextCleanOn;
  saveCfg();
  console.log('[rules] auto_grab:', JSON.stringify(nextGrab), '| auto_clean:', JSON.stringify(nextClean));
  res.json({ ok: true, rules: { ...nextGrab, ...nextClean }, _on: { ...nextGrabOn, ...nextCleanOn } });
});

// ============================================================
// ROUTE STATS GLOBALES
// Agrège les statistiques qBittorrent et Ultra.cc — chaque source est isolée par try/catch
// ============================================================

// GET /api/stats — statistiques agrégées : torrents actifs, ratio, vitesses, disque, trafic
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
// Vérifie en parallèle l'accessibilité des trois services externes
// ============================================================

// GET /api/connections — ping en parallèle de qBittorrent, C411 et Ultra.cc (retourne 'ok' ou 'error')
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
// Déclenchement manuel, consultation du statut et mise à jour du planning du nettoyeur
// ============================================================

// GET /api/cleaner/status — retourne le statut courant du module cleaner (last_run, enabled, etc.)
app.get(`${cfg.baseurl}/api/cleaner/status`, requireAuth, (req, res) => {
  res.json(cleaner.getStatus());
});

let lastCleanerRunAt = 0;

// POST /api/cleaner/run — déclenche un nettoyage immédiat (rate-limit : 1 toutes les 30 secondes)
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

// POST /api/cleaner/schedule — met à jour l'intervalle et l'état activé/désactivé du nettoyeur automatique
app.post(`${cfg.baseurl}/api/cleaner/schedule`, requireAuth, (req, res) => {
  const { interval_hours, enabled } = req.body;
  const hours = Math.max(1, Math.min(8760, parseInt(interval_hours) || 1));
  cfg.auto_clean = { ...cfg.auto_clean, interval_hours: hours, enabled: !!enabled };
  saveCfg();
  cleaner.reschedule(hours, !!enabled);
  console.log(`[cleaner] schedule mis à jour : ${hours}h, enabled=${!!enabled}`);
  res.json({ ok: true, ...cleaner.getStatus() });
});

// ============================================================
// AUTO-GRAB
// Logique de grab automatique : état en mémoire, exécution et planification du timer serveur
// ============================================================

let autoGrabStatus = {
  enabled:          false,
  last_run:         cfg.auto_grab?.last_run          || null,
  last_grab_count:  cfg.auto_grab?.last_grab_count   ?? 0,
  grabs_today:      0,
  grabs_date:       null,
  last_grabbed:     [],
  running:          false,
};

/**
 * Exécute un cycle complet d'auto-grab :
 * 1. Vérifie les limites journalières et le nombre de slots disponibles
 * 2. Récupère le top 100 de C411
 * 3. Filtre les candidats selon les règles actives (taille, leechers, seeders, déjà présents)
 * 4. Soumet les torrents éligibles à qBittorrent dans l'ordre décroissant de leechers
 * 5. Met à jour nameMap, categoryMap et torrentList pour chaque torrent grabé
 * Un mutex simple (autoGrabStatus.running) empêche les exécutions concurrentes.
 * @returns {number} Nombre de torrents effectivement grabés
 */
async function runAutoGrab() {
  if (autoGrabStatus.running) return 0;
  autoGrabStatus.running = true;
  let grabbed = 0;
  try {
    // Utilise cfg en mémoire (déjà déchiffré) — jamais le fichier disque
    const { grab_limit_per_day, size_max_gb, active_max, min_leechers, min_seeders } = cfg.auto_grab.rules || {};
    const rulesOn = cfg.auto_grab.rules_on || {};
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
    // Nombre maximum de torrents à graber lors de ce cycle
    const canGrab        = Math.min(isFinite(remaining) ? remaining : 100, slotsAvailable);
    // Filtrage : exclusion des déjà présents, respect des règles actives, tri par popularité
    const candidates     = list
      .filter(t => !existingHashes.has(t.infohash))
      .filter(t => t.size <= sizeLimitBytes)
      .filter(t => !isRuleOn('min_leechers') || min_leechers == null || t.leechers >= min_leechers)
      .filter(t => !isRuleOn('min_seeders')  || min_seeders  == null || t.seeders  >= min_seeders)
      .sort((a, b) => b.leechers - a.leechers)
      .slice(0, canGrab);

    autoGrabStatus.last_grabbed = [];
    let nameMapDirty = false;
    let catMapDirty  = false;
    const grabbedItems = [];
    for (const t of candidates) {
      try {
        await qbitRequest('post', '/torrents/add', `urls=${encodeURIComponent(t.link)}`);
        if (t.infohash) {
          const lhash = t.infohash.toLowerCase();
          nameMap[lhash] = t.name; nameMapDirty = true;
          if (t.category != null) { categoryMap[lhash] = String(t.category); catMapDirty = true; }
        }
        autoGrabStatus.grabs_today++;
        autoGrabStatus.last_grabbed.push({ name: t.name, url: t.page_url || null });
        grabbedItems.push({ hash: t.infohash, name: t.name, url: t.page_url || null });
        grabbed++;
        console.log(`[auto-grab] Grabé : ${t.name}`);
      } catch(e) {
        console.error(`[auto-grab] Erreur grab "${t.name}" : ${e.message}`);
      }
    }
    if (nameMapDirty) saveNameMap();
    if (catMapDirty)  saveCategoryMap();
    if (grabbedItems.length) appendTorrentList(grabbedItems);
  } catch(e) {
    console.error('[auto-grab]', e.message);
  } finally {
    autoGrabStatus.last_run             = new Date().toISOString();
    autoGrabStatus.last_grab_count      = grabbed;
    autoGrabStatus.running              = false;
    cfg.auto_grab.last_run           = autoGrabStatus.last_run;
    cfg.auto_grab.last_grab_count    = grabbed;
    saveCfg();
    console.log(`[auto-grab] Terminé — ${grabbed} grabé(s)`);
  }
  return grabbed;
}

// GET /api/history — retourne l'historique complet des actions (grab, clean, delete)
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
    fs.writeFileSync(tmp, JSON.stringify(hist, null, 2));
    fs.renameSync(tmp, HISTORY_PATH);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur interne' }); }
});

// GET /api/grabbed-torrents — retourne la liste plate des torrents grabés (max 500, triés du plus récent)
app.get(`${cfg.baseurl}/api/grabbed-torrents`, requireAuth, (req, res) => {
  res.json(torrentList);
});

// DELETE /api/grabbed-torrents — supprime une entrée de la liste par son hash (sans toucher qBittorrent)
app.delete(`${cfg.baseurl}/api/grabbed-torrents`, requireAuth, (req, res) => {
  const { hash } = req.body;
  if (!hash) return res.status(400).json({ error: 'hash requis' });
  torrentList = torrentList.filter(t => t.hash !== hash);
  try {
    const tmp = TORRENT_LIST_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(torrentList, null, 2));
    fs.renameSync(tmp, TORRENT_LIST_PATH);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur interne' }); }
});

// GET /api/auto-grab/status — retourne l'état courant de l'auto-grab (enabled, last_run, compteurs)
app.get(`${cfg.baseurl}/api/auto-grab/status`, requireAuth, (req, res) => {
  res.json({ ...autoGrabStatus });
});

// POST /api/auto-grab/config — active ou désactive l'auto-grab sans modifier l'intervalle
app.post(`${cfg.baseurl}/api/auto-grab/config`, requireAuth, (req, res) => {
  const { enabled } = req.body;
  autoGrabStatus.enabled = !!enabled;
  cfg.auto_grab.enabled = autoGrabStatus.enabled;
  saveCfg();
  console.log(`[auto-grab] enabled=${autoGrabStatus.enabled}`);
  res.json({ ok: true, ...autoGrabStatus });
});

let lastAutoGrabRunAt = 0;

// POST /api/auto-grab/run — déclenche un auto-grab immédiat (rate-limit : 1 toutes les 30 secondes)
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
// Lecture et écriture des credentials des services externes, toujours masqués en lecture
// ============================================================

// GET /api/config/secrets — retourne les credentials masqués (jamais les valeurs en clair)
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

/**
 * Vérifie qu'une chaîne est une URL HTTP(S) valide.
 * Utilisé pour valider les URLs de service (qBittorrent, Ultra.cc) avant de les sauvegarder.
 * @returns {boolean} true si l'URL est valide et utilise le protocole http ou https
 */
function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

// POST /api/config/secrets — met à jour les credentials (champs vides ignorés, URLs validées)
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
  saveConn();
  console.log('[connections] Connexions mises à jour');
  res.json({ ok: true });
});

// ============================================================
// ROUTES AUTO-REFRESH
// Configuration de l'intervalle et de l'état de l'auto-grab (alias de /api/auto-grab/config)
// ============================================================

// GET /api/auto-refresh — retourne l'état et l'intervalle de l'auto-grab
app.get(`${cfg.baseurl}/api/auto-refresh`, requireAuth, (req, res) => {
  res.json({ enabled: cfg.auto_grab.enabled, interval_minutes: cfg.auto_grab.interval_minutes, last_run: autoGrabStatus.last_run, last_grab_count: autoGrabStatus.last_grab_count });
});

// POST /api/auto-refresh — met à jour l'intervalle et l'état de l'auto-grab, recrée le timer serveur
app.post(`${cfg.baseurl}/api/auto-refresh`, requireAuth, (req, res) => {
  const { enabled, interval_minutes } = req.body;
  cfg.auto_grab.enabled          = !!enabled;
  cfg.auto_grab.interval_minutes = Math.max(1, parseInt(interval_minutes) || 15);
  saveCfg();
  scheduleAutoGrab();
  console.log(`[auto-refresh] enabled=${cfg.auto_grab.enabled}, interval=${cfg.auto_grab.interval_minutes}min`);
  res.json({ ok: true, enabled: cfg.auto_grab.enabled, interval_minutes: cfg.auto_grab.interval_minutes });
});

// ============================================================
// AUTO-GRAB TIMER SERVEUR
// Timer setInterval qui vérifie chaque minute si l'intervalle configuré est écoulé
// ============================================================
let autoGrabTimer = null;

/**
 * Crée (ou recrée) le timer serveur de l'auto-grab.
 * Annule le timer précédent s'il existe, puis démarre un nouveau setInterval d'1 minute.
 * À chaque tick, compare l'heure du dernier grab avec l'intervalle configuré (elapsed-time check).
 * Ne fait rien si l'auto-grab est désactivé.
 * Appelée au démarrage et à chaque modification via POST /api/auto-refresh.
 */
function scheduleAutoGrab() {
  if (autoGrabTimer) { clearInterval(autoGrabTimer); autoGrabTimer = null; }
  if (!cfg.auto_grab?.enabled) {
    console.log('[auto-grab] timer désactivé');
    return;
  }
  autoGrabTimer = setInterval(async () => {
    const intervalMs = (cfg.auto_grab.interval_minutes || 15) * 60 * 1000;
    const lastRun    = autoGrabStatus.last_run ? new Date(autoGrabStatus.last_run).getTime() : 0;
    // Déclenche le grab uniquement si le délai configuré est écoulé depuis le dernier run
    if (Date.now() - lastRun >= intervalMs) {
      const grabbed = await runAutoGrab();
      if (grabbed > 0) appendHistory('grab', grabbed, 'auto', autoGrabStatus.last_grabbed || []);
    }
  }, 60 * 1000); // vérifie toutes les minutes
  console.log(`[auto-grab] timer serveur : toutes les ${cfg.auto_grab.interval_minutes}min`);
}

// ============================================================
// START
// Initialisation des modules, démarrage des timers et lancement du serveur HTTP
// ============================================================

/**
 * Enregistre un échec de connexion pour une IP et applique le blocage après 5 tentatives.
 * Après 5 échecs, l'IP est bloquée pendant 15 minutes.
 * Nettoyage périodique assuré par le setInterval ci-dessous.
 */
function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count++;
  entry.lastAttempt = Date.now();
  if (entry.count >= 5) entry.blockedUntil = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(ip, entry);
}

// Nettoyage périodique de la Map loginAttempts toutes les 5 minutes (évite les fuites mémoire)
// Supprime les entrées expirées : blocage expiré ou dernière tentative > 15 min
setInterval(() => {
  const now = Date.now();
  const TTL = 15 * 60 * 1000;
  for (const [ip, entry] of loginAttempts) {
    const expired = entry.blockedUntil ? now > entry.blockedUntil : now - (entry.lastAttempt || 0) > TTL;
    if (expired) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

initConfig();

// Callback appelé par cleaner.js après chaque cycle de nettoyage terminé.
// Persiste la config, nettoie les maps (nameMap, categoryMap, uploadHistory)
// des hashes supprimés, et ajoute une entrée dans l'historique si des torrents ont été supprimés.
cleaner.setRunCompleteCallback((st) => {
  saveCfg();
  if (st.last_deleted_hashes?.length) {
    let nameMapDirty = false, catMapDirty = false, uploadDirty = false;
    for (const h of st.last_deleted_hashes) {
      if (nameMap[h])        { delete nameMap[h];        nameMapDirty = true; }
      if (categoryMap[h])    { delete categoryMap[h];    catMapDirty  = true; }
      if (uploadHistory[h])  { delete uploadHistory[h];  uploadDirty  = true; }
    }
    if (nameMapDirty) saveNameMap();
    if (catMapDirty)  saveCategoryMap();
    if (uploadDirty)  saveUploadHistory();
  }
  if (st.last_deleted_count > 0) {
    appendHistory('clean', st.last_deleted_count, st.last_run_type, st.last_deleted_names || []);
  }
});

/**
 * Purge au démarrage les entrées obsolètes de nameMap, categoryMap et uploadHistory.
 * Supprime toutes les entrées dont le hash n'est plus dans qBittorrent (torrent supprimé manuellement hors SeeDash).
 * Effectue aussi un backfill de categoryMap depuis le cache top leechers pour les torrents actifs sans catégorie.
 * Si qBittorrent est inaccessible, la purge est silencieusement ignorée.
 */
async function pruneNameMap() {
  try {
    const torrents     = await qbitRequest('get', '/torrents/info');
    const activeHashes = new Set(torrents.map(t => t.hash.toLowerCase()));
    const before       = Object.keys(nameMap).length;
    for (const h of Object.keys(nameMap)) {
      if (!activeHashes.has(h)) delete nameMap[h];
    }
    const removed = before - Object.keys(nameMap).length;
    if (removed > 0) { saveNameMap(); console.log(`[namemap] ${removed} entrée(s) obsolète(s) supprimée(s)`); }
    const catBefore = Object.keys(categoryMap).length;
    for (const h of Object.keys(categoryMap)) {
      if (!activeHashes.has(h)) delete categoryMap[h];
    }
    // Backfill depuis topCache pour les hashes actifs sans catégorie connue
    let catBackfilled = 0;
    for (const item of topCache.items || []) {
      if (!item.infohash || item.category == null) continue;
      const h = item.infohash.toLowerCase();
      if (activeHashes.has(h) && !categoryMap[h]) {
        categoryMap[h] = String(item.category);
        catBackfilled++;
      }
    }
    const catRemoved = catBefore - Object.keys(categoryMap).length;
    if (catRemoved > 0 || catBackfilled > 0) {
      saveCategoryMap();
      if (catRemoved  > 0) console.log(`[categorymap] ${catRemoved} entrée(s) obsolète(s) supprimée(s)`);
      if (catBackfilled > 0) console.log(`[categorymap] ${catBackfilled} entrée(s) backfillée(s) depuis topCache`);
    }
    pruneUploadHistory(activeHashes);
  } catch(e) {
    console.log('[namemap] purge ignorée (qBittorrent inaccessible)');
  }
}

// Sampling upload toutes les 5 minutes : enregistre un point [timestamp_s, bytes_uploadés]
// pour chaque torrent actif, utilisé pour le graphique de progression d'upload.
// Purge également les entrées de torrents qui ne sont plus actifs dans qBittorrent.
setInterval(async () => {
  try {
    const torrents = await qbitRequest('get', '/torrents/info');
    const now      = Math.floor(Date.now() / 1000);
    for (const t of torrents) {
      const hash = t.hash.toLowerCase();
      if (!uploadHistory[hash]) uploadHistory[hash] = [];
      uploadHistory[hash].push([now, t.uploaded]);
    }
    const activeHashes = new Set(torrents.map(t => t.hash.toLowerCase()));
    pruneUploadHistory(activeHashes);
    saveUploadHistory();
  } catch(e) { /* qBit inaccessible — silencieux */ }
}, 5 * 60 * 1000);

// Middleware d'erreur global — doit être déclaré après toutes les routes
// En production, masque le message d'erreur interne pour éviter les fuites d'information
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message
  });
});

// Séquence de démarrage asynchrone :
// 1. initAuth() — génère les secrets et hash de mot de passe si absents
// 2. decryptSecrets() — déchiffre les secrets AES-256-GCM en mémoire
// 3. saveCfg() — persiste l'état initial (notamment les valeurs générées par initAuth)
// 4. scheduleAutoGrab() — démarre le timer d'auto-grab si activé
// 5. pruneNameMap() — purge les entrées obsolètes au démarrage
// 6. app.listen() — démarre le serveur HTTP
initAuth().then(() => {
  decryptSecrets();
  saveCfg();
  autoGrabStatus.enabled = cfg.auto_grab?.enabled === true;
  scheduleAutoGrab();
  pruneNameMap();

  app.listen(cfg.port, '0.0.0.0', () => {
    console.log(`SeedDash démarré → http://0.0.0.0:${cfg.port}${cfg.baseurl}`);
  });
});
