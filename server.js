const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const { XMLParser } = require('fast-xml-parser');
const axios        = require('axios');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const cleaner      = require('./lib/cleaner');
const { encrypt, PREFIX } = require('./crypto-config');

const helpers  = require('./lib/helpers');
const auth     = require('./lib/auth');
const qbit     = require('./lib/qbit');
const ultracc  = require('./lib/ultracc');
const grab     = require('./lib/grab');

const { SECRET_PATHS, GRAB_RULE_KEYS, VALID_RULE_KEYS, getIn, setIn, maskSecret, isHttpUrl } = helpers;

// --- Config ---
const CFG_PATH           = path.join(__dirname, 'config.json');
const CONN_PATH          = path.join(__dirname, 'connections.json');
const HISTORY_PATH       = path.join(__dirname, 'logs', 'history.json');
const HISTORY_MAX        = 500;
const TOP_CACHE_PATH     = path.join(__dirname, 'logs', 'top-cache.json');
const NAMEMAP_PATH       = path.join(__dirname, 'logs', 'namemap.json');
const CATMAP_PATH        = path.join(__dirname, 'logs', 'categorymap.json');
const UPLOAD_HISTORY_PATH = path.join(__dirname, 'logs', 'upload-history.json');
const TORRENT_LIST_PATH  = path.join(__dirname, 'logs', 'torrent-list.json');
const TORRENT_LIST_MAX   = 500;

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

// Callbacks pour grab.js (topCache est réassigné, pas muté)
const getTopCache = () => topCache;
const setTopCache = (val) => { topCache = val; };

// Correspondance hash → nom C411
let nameMap = {};
try { nameMap = JSON.parse(fs.readFileSync(NAMEMAP_PATH)); } catch {}

/**
 * Persiste nameMap sur disque via écriture atomique (tmp + rename).
 */
function saveNameMap() {
  try {
    const tmp = NAMEMAP_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(nameMap, null, 2));
    fs.renameSync(tmp, NAMEMAP_PATH);
  } catch(e) { console.error('[namemap]', e.message); }
}

// Correspondance hash → catégorie C411
let categoryMap = {};
try { categoryMap = JSON.parse(fs.readFileSync(CATMAP_PATH)); } catch {}

/**
 * Persiste categoryMap sur disque via écriture atomique (tmp + rename).
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
 * Persiste uploadHistory sur disque via écriture atomique.
 */
function saveUploadHistory() {
  try {
    const tmp = UPLOAD_HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(uploadHistory));
    fs.renameSync(tmp, UPLOAD_HISTORY_PATH);
  } catch(e) { console.error('[upload-history]', e.message); }
}

/**
 * Purge les entrées inactives les plus anciennes de uploadHistory si le cap est dépassé.
 * Les torrents actifs ne sont jamais purgés.
 * @param {Set<string>} activeHashes - Ensemble des hashs actuellement actifs
 */
const UPLOAD_HISTORY_MAX = 500;
function pruneUploadHistory(activeHashes) {
  const allHashes = Object.keys(uploadHistory);
  if (allHashes.length <= UPLOAD_HISTORY_MAX) return;
  const inactive = allHashes.filter(h => !activeHashes.has(h));
  inactive.sort((a, b) => {
    const lastA = uploadHistory[a]?.length ? uploadHistory[a][uploadHistory[a].length - 1][0] : 0;
    const lastB = uploadHistory[b]?.length ? uploadHistory[b][uploadHistory[b].length - 1][0] : 0;
    return lastA - lastB;
  });
  const toRemove = inactive.slice(0, allHashes.length - UPLOAD_HISTORY_MAX);
  if (!toRemove.length) return;
  for (const h of toRemove) delete uploadHistory[h];
  saveUploadHistory();
}

// Liste plate des torrents grabbés
let torrentList = [];
try { torrentList = JSON.parse(fs.readFileSync(TORRENT_LIST_PATH)); } catch {}

/**
 * Ajoute des entrées dans la liste plate des torrents grabés.
 * Déduplique par hash, insère en tête, tronque à TORRENT_LIST_MAX.
 * @param {Array<{hash: string, name: string, url?: string}>} entries
 */
function appendTorrentList(entries) {
  for (const e of entries) {
    if (!e.hash || !e.name) continue;
    if (torrentList.some(t => t.hash === e.hash)) continue;
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
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
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

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * Persiste la configuration générale dans config.json (hors connexions/secrets).
 */
function saveCfg() {
  const st = cleaner.getStatus();
  cfg.auto_clean.last_run           = st.last_run;
  cfg.auto_clean.last_deleted_count = st.last_deleted_count;
  cfg.auto_clean.last_run_type      = st.last_run_type;
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
 * Les secrets sont rechiffrés AES-256-GCM avant l'écriture.
 */
function saveConn() {
  const toWrite = JSON.parse(JSON.stringify(
    Object.fromEntries(Object.entries(cfg).filter(([k]) => CONN_KEYS.includes(k)))
  ));
  const key = auth.getJwtSecret();
  if (key) {
    for (const p of SECRET_PATHS) {
      const v = getIn(toWrite, p);
      if (v && !v.startsWith(PREFIX)) setIn(toWrite, p, encrypt(v, key));
    }
  }
  const tmp = CONN_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
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

// --- Config defaults init ---

/**
 * Initialise les clés de configuration manquantes avec leurs valeurs par défaut.
 */
function initConfig() {
  let changed = false;
  const DEFAULT_GRAB_RULES_ON  = { grab_limit_per_day: true, size_max_gb: true, active_max: false, min_leechers: false, min_seeders: false, network_max_pct: false };
  if (!cfg.auto_grab) {
    cfg.auto_grab = { enabled: false, last_run: null, last_grab_count: 0,
      rules: { grab_limit_per_day: 20, size_max_gb: 100, active_max: 15, min_leechers: 0, min_seeders: 0, network_max_pct: 90 },
      rules_on: { ...DEFAULT_GRAB_RULES_ON } };
    changed = true;
  }
  if (!cfg.auto_grab.rules)    { cfg.auto_grab.rules    = { grab_limit_per_day: 20, size_max_gb: 100, active_max: 15, min_leechers: 0, min_seeders: 0, network_max_pct: 90 }; changed = true; }
  if (!cfg.auto_grab.rules_on) { cfg.auto_grab.rules_on = { ...DEFAULT_GRAB_RULES_ON }; changed = true; }
  if (!('network_max_pct' in (cfg.auto_grab.rules || {})))    { cfg.auto_grab.rules.network_max_pct = 90;    changed = true; }
  if (!('network_max_pct' in (cfg.auto_grab.rules_on || {}))) { cfg.auto_grab.rules_on.network_max_pct = false; changed = true; }
  const DEFAULT_CLEAN_RULES_ON = { ratio_min: true, ratio_max: false, age_min_hours: true, age_max_hours: false, upload_min_mb: false };
  if (!cfg.auto_clean) {
    cfg.auto_clean = { enabled: false,
      rules: { ratio_min: 1.0, age_min_hours: 48 }, rules_on: { ...DEFAULT_CLEAN_RULES_ON } };
    changed = true;
  }
  if (!cfg.auto_clean.rules)    { cfg.auto_clean.rules    = { ratio_min: 1.0, age_min_hours: 48 }; changed = true; }
  if (!cfg.auto_clean.rules_on) { cfg.auto_clean.rules_on = { ...DEFAULT_CLEAN_RULES_ON }; changed = true; }
  // Initialiser les blocs de connexion s'ils sont absents (fresh install sans connections.json complet)
  // Timer combiné clean → grab
  if (!cfg.timer) {
    cfg.timer = { enabled: false, interval_hours: 6, last_run: null };
    changed = true;
  }
  if (!cfg.c411)        { cfg.c411        = { url: 'https://c411.org/api/torznab', apikey: '' }; }
  if (!cfg.qbittorrent) { cfg.qbittorrent = { url: '', username: '', password: '' }; }
  if (!cfg.ultracc_api) { cfg.ultracc_api = { url: '', token: '' }; }
  if (changed) {
    saveCfg();
    console.log('[config] Clés manquantes initialisées et sauvegardées');
  }
}

// ============================================================
// ROUTES C411
// ============================================================

// GET /api/top-leechers?n=20&cat=all
app.get(`${cfg.baseurl}/api/top-leechers`, auth.requireAuth, async (req, res) => {
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

    // Fire-and-forget : résolution en arrière-plan des noms/catégories
    (async () => {
      try {
        const active = await qbit.qbitRequest('get', '/torrents/info');
        const topByHashName = {};
        const topByHashCat  = {};
        for (const item of list) {
          if (item.infohash) {
            const h = item.infohash.toLowerCase();
            topByHashName[h] = item.name;
            if (item.category != null) topByHashCat[h] = String(item.category);
          }
        }
        let nameMapDirty = false;
        let catMapDirty  = false;
        for (const t of active) {
          const hash = t.hash.toLowerCase();
          if (!nameMap[hash]     && topByHashName[hash]) { nameMap[hash]     = topByHashName[hash]; nameMapDirty = true; }
          if (!categoryMap[hash] && topByHashCat[hash])  { categoryMap[hash] = topByHashCat[hash];  catMapDirty  = true; }
        }
        if (nameMapDirty) saveNameMap();
        if (catMapDirty)  saveCategoryMap();
        const unmapped = active.filter(t => {
          const h = t.hash.toLowerCase();
          return !categoryMap[h] || (!nameMap[h] && !topByHashName[h]);
        });
        for (const t of unmapped) {
          const hash    = t.hash.toLowerCase();
          const needCat  = !categoryMap[hash];
          const needName = !nameMap[hash] && !topByHashName[hash];
          if (!needCat && !needName) continue;
          const base = t.name.replace(/\.(mkv|avi|mp4|m4v|ts|iso)$/i, '').replace(/\./g, ' ');
          const titleClean = base.replace(/\b(19\d{2}|20\d{2})\b.*/, '').replace(/\b(1080p|2160p|720p|4K|UHD|BluRay|WEB|HDTV|MULTI|MULTi|COMPLETE|S\d{2}|REMUX|Hybrid)\b.*/i, '').replace(/[-.()\s]+$/, '').trim();
          const stopWords = new Set(['the','a','an','la','le','les','de','du','des','un','une']);
          const sigWords = titleClean.split(/\s+/).filter(w => !stopWords.has(w.toLowerCase()));
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

// GET /api/top-leechers/cache
app.get(`${cfg.baseurl}/api/top-leechers/cache`, auth.requireAuth, (req, res) => {
  res.json(topCache);
});

// ============================================================
// ROUTES qBITTORRENT
// ============================================================

// GET /api/torrents
app.get(`${cfg.baseurl}/api/torrents`, auth.requireAuth, async (req, res) => {
  try {
    const topByHash = {};
    const topCatByHash = {};
    for (const item of topCache.items || []) {
      if (item.infohash) {
        const h = item.infohash.toLowerCase();
        topByHash[h] = item.name;
        if (item.category != null) topCatByHash[h] = String(item.category);
      }
    }
    const data = await qbit.qbitRequest('get', '/torrents/info');
    const cleanRules  = cfg.auto_clean?.rules    || {};
    const cleanOn     = cfg.auto_clean?.rules_on || {};
    const isCleanOn   = (k) => cleanOn[k] !== false;
    const nowSec      = Math.floor(Date.now() / 1000);
    const ageMinSec   = (cleanRules.age_min_hours || 48) * 3600;
    const uploadMinMb = isCleanOn('upload_min_mb') && cleanRules.upload_min_mb > 0 ? cleanRules.upload_min_mb : null;
    const uploadWinSec = (cleanRules.upload_window_hours || 48) * 3600;
    const list = data.map(t => {
      const hash = t.hash.toLowerCase();
      let upload_condition = false;
      if (uploadMinMb !== null
        && (!isCleanOn('age_min_hours') || (nowSec - t.added_on) >= ageMinSec)
        && (!isCleanOn('ratio_min')     || t.ratio >= cleanRules.ratio_min)) {
        const points   = uploadHistory[hash] || [];
        const winStart = nowSec - uploadWinSec;
        const inWin    = points.filter(([ts]) => ts >= winStart);
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

// POST /api/grab
app.post(`${cfg.baseurl}/api/grab`, auth.requireAuth, async (req, res) => {
  const { url, name, page_url, infohash, category, size, leechers, seeders } = req.body;
  if (!url) return res.status(400).json({ error: 'url requis' });
  try {
    const allowed = new URL(cfg.c411.url).hostname;
    const target  = new URL(url).hostname;
    if (target !== allowed) return res.status(400).json({ error: 'URL non autorisée' });
  } catch {
    return res.status(400).json({ error: 'URL invalide' });
  }
  const downloadUrl = url.includes('/api?t=get') ? url
    : `${cfg.c411.url.replace('/api/torznab','')}/api?t=get&id=${url.split('/').pop()}&apikey=${cfg.c411.apikey}`;
  try {
    await qbit.qbitRequest('post', '/torrents/add', `urls=${encodeURIComponent(downloadUrl)}`);
    if (name && infohash) {
      const lhash = infohash.toLowerCase();
      nameMap[lhash] = name;
      saveNameMap();
      if (category != null) { categoryMap[lhash] = String(category); saveCategoryMap(); }
      appendTorrentList([{ hash: lhash, name, url: page_url || null }]);
    }
    const sizeNum = parseInt(size) || 0;
    const sizeStr = sizeNum >= 1e9 ? `${(sizeNum / 1e9).toFixed(1)} GB` : `${(sizeNum / 1e6).toFixed(0)} MB`;
    console.log(`[grab] ok: ${name || '(sans nom)'} (${sizeStr}, ${parseInt(leechers) || 0}L/${parseInt(seeders) || 0}S)`);
    if (name) appendHistory('grab', 1, 'manuel', [{ name, url: page_url || null }]);
    res.json({ ok: true });
  } catch (e) {
    console.log('[grab] erreur:', e.response?.status, e.message);
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// DELETE /api/torrents/:hash
app.delete(`${cfg.baseurl}/api/torrents/:hash`, auth.requireAuth, async (req, res) => {
  const { hash } = req.params;
  if (!/^[a-f0-9]{40}$/i.test(hash)) return res.status(400).json({ error: 'Hash invalide' });
  const deleteFiles = req.query.deleteFiles === 'true';
  const name        = (typeof req.query.name === 'string' ? req.query.name : hash).slice(0, 256);
  try {
    await qbit.qbitRequest('post', '/torrents/delete', `hashes=${hash}&deleteFiles=${deleteFiles}`);
    const lhash = hash.toLowerCase();
    if (nameMap[lhash]) { delete nameMap[lhash]; saveNameMap(); }
    if (categoryMap[lhash]) { delete categoryMap[lhash]; saveCategoryMap(); }
    appendHistory('delete', 1, 'manuel', [{ name, hash: lhash, url: `${(cfg.c411?.url || '').replace('/api/torznab', '') || 'https://c411.org'}/torrents/${hash}` }]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// GET /api/upload-history/:hash
app.get(`${cfg.baseurl}/api/upload-history/:hash`, auth.requireAuth, (req, res) => {
  const { hash } = req.params;
  if (!/^[a-f0-9]{40}$/i.test(hash)) return res.status(400).json({ error: 'Hash invalide' });
  res.json({ points: uploadHistory[hash.toLowerCase()] || [] });
});

// ============================================================
// ROUTES RÈGLES
// ============================================================

// GET /api/rules
app.get(`${cfg.baseurl}/api/rules`, auth.requireAuth, (req, res) => {
  res.json({
    ...cfg.auto_grab.rules,
    ...cfg.auto_clean.rules,
    _on: { ...cfg.auto_grab.rules_on, ...cfg.auto_clean.rules_on },
  });
});

// POST /api/rules
app.post(`${cfg.baseurl}/api/rules`, auth.requireAuth, (req, res) => {
  const { _on, ...vals } = req.body;
  const nextGrab  = { ...cfg.auto_grab.rules };
  const nextClean = { ...cfg.auto_clean.rules };
  for (const [k, v] of Object.entries(vals)) {
    if (!VALID_RULE_KEYS.has(k)) continue;
    if (typeof v === 'number' && isFinite(v) && v >= 0) {
      if (GRAB_RULE_KEYS.has(k))  nextGrab[k]  = v;
      else                         nextClean[k] = v;
    }
  }
  const nextGrabOn  = { ...cfg.auto_grab.rules_on };
  const nextCleanOn = { ...cfg.auto_clean.rules_on };
  if (_on && typeof _on === 'object') {
    for (const [k, v] of Object.entries(_on)) {
      if (!VALID_RULE_KEYS.has(k)) continue;
      if (GRAB_RULE_KEYS.has(k))  nextGrabOn[k]  = !!v;
      else                         nextCleanOn[k] = !!v;
    }
  }
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
// ============================================================

// GET /api/stats
app.get(`${cfg.baseurl}/api/stats`, auth.requireAuth, async (req, res) => {
  let active = 0, avgRatio = 0, dl_speed = 0, up_speed = 0;
  try {
    const torrents = await qbit.qbitRequest('get', '/torrents/info');
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
    const info       = await ultracc.getUltraccStats();
    disk_total_gb    = info.total_storage_value;
    disk_used_gb     = Math.round(disk_total_gb - info.free_storage_gb);
    traffic_used_pct = Math.round(info.traffic_used_percentage * 10) / 10;
    traffic_reset_date = info.next_traffic_reset
      ? info.next_traffic_reset.split('T')[0]
      : null;
  } catch (e) {
    console.error('[ultracc_api]', e.message);
  }

  const c411_base     = (cfg.c411?.url || '').replace('/api/torznab', '') || 'https://c411.org';
  const timerEnabled  = !!cfg.timer?.enabled;
  const timerLastRun  = cfg.timer?.last_run ? new Date(cfg.timer.last_run).getTime() : 0;
  const timerNextAt   = timerEnabled && timerLastRun
    ? new Date(timerLastRun + (cfg.timer.interval_hours || 1) * 3600000).toISOString()
    : null;
  res.json({ active, avg_ratio: Math.round(avgRatio * 100) / 100, dl_speed, up_speed, disk_used_gb, disk_total_gb, traffic_used_pct, traffic_reset_date, c411_base, timer_enabled: timerEnabled, timer_next_at: timerNextAt });
});

// ============================================================
// ROUTE STATUT CONNEXIONS
// ============================================================

// GET /api/connections
app.get(`${cfg.baseurl}/api/connections`, auth.requireAuth, async (req, res) => {
  const [qbitRes, c411Res, ultraccRes] = await Promise.allSettled([
    qbit.qbitRequest('get', '/app/version').then(() => 'ok'),
    axios.get(cfg.c411.url, { params: { apikey: cfg.c411.apikey, t: 'caps' }, timeout: 8000 }).then(() => 'ok'),
    ultracc.getUltraccStats().then(() => 'ok'),
  ]);
  const errMsg = r => {
    const e = r.reason;
    if (!e) return 'Erreur inconnue';
    if (e.response) return `HTTP ${e.response.status}`;
    if (e.code === 'ECONNREFUSED') return 'Connexion refusée';
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return 'Timeout';
    if (e.code === 'ENOTFOUND') return 'Hôte introuvable';
    return e.message?.slice(0, 60) || 'Erreur inconnue';
  };
  res.json({
    qbittorrent: qbitRes.status    === 'fulfilled' ? 'ok' : errMsg(qbitRes),
    c411:        c411Res.status    === 'fulfilled' ? 'ok' : errMsg(c411Res),
    ultracc:     ultraccRes.status === 'fulfilled' ? 'ok' : errMsg(ultraccRes),
  });
});

// ============================================================
// ROUTES CLEANER
// ============================================================

// GET /api/cleaner/status
app.get(`${cfg.baseurl}/api/cleaner/status`, auth.requireAuth, (req, res) => {
  res.json(cleaner.getStatus());
});

let lastCleanerRunAt = 0;

// POST /api/cleaner/run
app.post(`${cfg.baseurl}/api/cleaner/run`, auth.requireAuth, async (req, res) => {
  if (Date.now() - lastCleanerRunAt < 30000) return res.status(429).json({ error: 'Réessayez dans quelques secondes' });
  lastCleanerRunAt = Date.now();
  try {
    const deleted = await cleaner.runClean('manuel');
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// POST /api/cleaner/schedule
app.post(`${cfg.baseurl}/api/cleaner/schedule`, auth.requireAuth, (req, res) => {
  const { enabled } = req.body;
  cfg.auto_clean = { ...cfg.auto_clean, enabled: !!enabled };
  cleaner.setEnabled(!!enabled);
  saveCfg();
  console.log(`[cleaner] enabled=${!!enabled}`);
  res.json({ ok: true, ...cleaner.getStatus() });
});

// ============================================================
// ROUTES AUTO-GRAB
// ============================================================

let lastAutoGrabRunAt = 0;

// POST /api/auto-grab/run
app.post(`${cfg.baseurl}/api/auto-grab/run`, auth.requireAuth, async (req, res) => {
  if (Date.now() - lastAutoGrabRunAt < 30000) return res.status(429).json({ error: 'Réessayez dans quelques secondes' });
  lastAutoGrabRunAt = Date.now();
  try {
    const source  = req.body?.source || 'auto';
    const grabbed = await grab.runAutoGrab(source);
    if (grabbed > 0) {
      appendHistory('grab', grabbed, source, grab.getStatus().last_grabbed || []);
    }
    res.json({ ok: true, grabbed, ...grab.getStatus() });
  } catch(e) {
    res.status(500).json({ error: 'Erreur serveur interne' });
  }
});

// GET /api/history
app.get(`${cfg.baseurl}/api/history`, auth.requireAuth, (req, res) => {
  try {
    const hist = JSON.parse(fs.readFileSync(HISTORY_PATH));
    res.json(hist);
  } catch { res.json([]); }
});

// DELETE /api/history
app.delete(`${cfg.baseurl}/api/history`, auth.requireAuth, (req, res) => {
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

// ============================================================
// ROUTES SETUP (premier démarrage — non protégées)
// ============================================================

// GET /api/setup/status
app.get(`${cfg.baseurl}/api/setup/status`, (_req, res) => {
  res.json({ setupComplete: auth.isSetupComplete() });
});

// POST /api/setup
app.post(`${cfg.baseurl}/api/setup`, async (req, res) => {
  if (auth.isSetupComplete()) return res.status(403).json({ error: 'Setup déjà effectué' });
  const { username, password } = req.body;
  const u = typeof username === 'string' ? username.trim() : '';
  const p = typeof password === 'string' ? password : '';
  if (!u || u.length > 32 || !/^[a-zA-Z0-9._-]+$/.test(u))
    return res.status(400).json({ error: 'Nom d\'utilisateur invalide (1–32 caractères alphanumériques, . _ -)' });
  if (p.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  if (p.length > 72)
    return res.status(400).json({ error: 'Mot de passe trop long (max 72 caractères)' });
  cfg.auth.username      = u;
  cfg.auth.password_hash = await bcrypt.hash(p, 12);
  cfg.auth.setup_completed = true;
  saveConn();
  console.log('[setup] Configuration initiale complétée');
  res.json({ ok: true });
});

// ============================================================
// ROUTES SECRETS
// ============================================================

// POST /api/login
app.post(`${cfg.baseurl}/api/login`, async (req, res) => {
  const ip = req.ip;
  if (auth.checkBruteForce(ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
  if (username !== cfg.auth.username) {
    auth.recordFailedLogin(ip);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  if (!cfg.auth.password_hash) return res.status(401).json({ error: 'Identifiants incorrects' });
  const ok = await bcrypt.compare(password, cfg.auth.password_hash);
  if (!ok) {
    auth.recordFailedLogin(ip);
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  auth.resetLoginAttempts(ip);
  const ALLOWED_EXPIRIES = ['1h','2h','4h','8h','12h','24h','48h','72h','168h'];
  const expiry = ALLOWED_EXPIRIES.includes(cfg.auth.token_expiry) ? cfg.auth.token_expiry : '24h';
  const token = jwt.sign({ username }, auth.getJwtSecret(), { expiresIn: expiry, algorithm: 'HS256' });
  res.cookie('seedash_token', token, {
    httpOnly: true,
    secure:   req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'Strict',
    maxAge:   parseInt(expiry) * (expiry.endsWith('h') ? 3600000 : 86400000),
    path:     cfg.baseurl + '/',
  });
  res.json({ ok: true });
});

// POST /api/change-password
app.post(`${cfg.baseurl}/api/change-password`, auth.requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Champs manquants' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  const ok = await bcrypt.compare(current_password, cfg.auth.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  cfg.auth.password_hash = await bcrypt.hash(new_password, 12);
  cfg.auth.issued_after = Math.floor(Date.now() / 1000);
  saveConn();
  res.json({ ok: true });
});

// POST /api/logout
app.post(`${cfg.baseurl}/api/logout`, (req, res) => {
  res.clearCookie('seedash_token', { sameSite: 'Strict', path: cfg.baseurl + '/' });
  res.clearCookie('seedash_token', { sameSite: 'Strict', path: '/' });
  res.json({ ok: true });
});

// GET /api/config/secrets
app.get(`${cfg.baseurl}/api/config/secrets`, auth.requireAuth, (req, res) => {
  res.json({
    c411_url:      cfg.c411?.url             || '',
    c411_apikey:   maskSecret(cfg.c411?.apikey),
    qbit_url:      cfg.qbittorrent?.url      || '',
    qbit_username: cfg.qbittorrent?.username || '',
    qbit_password: maskSecret(cfg.qbittorrent?.password, 1),
    ultracc_url:   cfg.ultracc_api?.url      || '',
    ultracc_token: maskSecret(cfg.ultracc_api?.token),
  });
});

// POST /api/config/secrets
app.post(`${cfg.baseurl}/api/config/secrets`, auth.requireAuth, (req, res) => {
  const { c411_url, c411_apikey, qbit_url, qbit_username, qbit_password, ultracc_url, ultracc_token } = req.body;
  if (c411_url    && !isHttpUrl(c411_url))    return res.status(400).json({ error: 'c411_url invalide (doit commencer par http:// ou https://)' });
  if (qbit_url    && !isHttpUrl(qbit_url))    return res.status(400).json({ error: 'qbit_url invalide (doit commencer par http:// ou https://)' });
  if (ultracc_url && !isHttpUrl(ultracc_url)) return res.status(400).json({ error: 'ultracc_url invalide (doit commencer par http:// ou https://)' });
  if (c411_url)      cfg.c411.url              = c411_url;
  if (c411_apikey)   cfg.c411.apikey           = c411_apikey;
  if (qbit_url)      cfg.qbittorrent.url        = qbit_url;
  if (qbit_username) cfg.qbittorrent.username  = qbit_username;
  if (qbit_password) { cfg.qbittorrent.password = qbit_password; qbit.clearCookie(); }
  if (ultracc_url)   { cfg.ultracc_api.url      = ultracc_url;   ultracc.invalidateCache(); }
  if (ultracc_token) { cfg.ultracc_api.token    = ultracc_token; ultracc.invalidateCache(); }
  saveConn();
  console.log('[connections] Connexions mises à jour');
  res.json({ ok: true });
});

// ============================================================
// ROUTES AUTO-REFRESH
// ============================================================

// GET /api/auto-refresh
app.get(`${cfg.baseurl}/api/auto-refresh`, auth.requireAuth, (req, res) => {
  const st = grab.getStatus();
  res.json({
    grab_enabled:          cfg.auto_grab.enabled,
    last_run:              st.last_run,
    last_run_source:       st.last_run_source || 'auto',
    last_grab_count:       st.last_grab_count,
    top_cache_date:        topCache.date || null,
  });
});

// POST /api/auto-refresh
app.post(`${cfg.baseurl}/api/auto-refresh`, auth.requireAuth, (req, res) => {
  const { enabled } = req.body;
  cfg.auto_grab.enabled = !!enabled;
  grab.setEnabled(!!enabled);
  saveCfg();
  console.log(`[auto-grab] enabled=${!!enabled}`);
  res.json({ ok: true, grab_enabled: cfg.auto_grab.enabled });
});

// ============================================================
// ROUTES TIMER
// ============================================================

// GET /api/timer/status
app.get(`${cfg.baseurl}/api/timer/status`, auth.requireAuth, (req, res) => {
  res.json({ enabled: !!cfg.timer?.enabled, interval_hours: cfg.timer?.interval_hours || 1, last_run: cfg.timer?.last_run || null });
});

// POST /api/timer/config
app.post(`${cfg.baseurl}/api/timer/config`, auth.requireAuth, (req, res) => {
  const { enabled, interval_hours } = req.body;
  const hours = Math.max(1, Math.min(8760, parseInt(interval_hours) || 1));
  const wasDisabled = !cfg.timer?.enabled;
  const last_run = (!!enabled && wasDisabled) ? new Date().toISOString() : (cfg.timer?.last_run || null);
  cfg.timer = { ...cfg.timer, enabled: !!enabled, interval_hours: hours, last_run };
  saveCfg();
  scheduleTimer();
  console.log(`[timer] config : ${hours}h, enabled=${!!enabled}`);
  res.json({ ok: true, ...cfg.timer });
});

// ============================================================
// DÉMARRAGE
// ============================================================

/**
 * Purge au démarrage les entrées obsolètes de nameMap, categoryMap et uploadHistory.
 */
async function pruneNameMap() {
  try {
    const torrents     = await qbit.qbitRequest('get', '/torrents/info');
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

// Sampling upload toutes les 5 minutes
setInterval(async () => {
  try {
    const torrents = await qbit.qbitRequest('get', '/torrents/info');
    const now      = Math.floor(Date.now() / 1000 / 300) * 300; // arrondi à 5min
    for (const t of torrents) {
      const hash = t.hash.toLowerCase();
      if (!uploadHistory[hash]) uploadHistory[hash] = [];
      uploadHistory[hash].push([now, t.uploaded]);
      if (uploadHistory[hash].length > 8640) uploadHistory[hash] = uploadHistory[hash].slice(-8640);
    }
    const activeHashes = new Set(torrents.map(t => t.hash.toLowerCase()));
    pruneUploadHistory(activeHashes);
    saveUploadHistory();
  } catch(e) { /* qBit inaccessible — silencieux */ }
}, 5 * 60 * 1000);

// Middleware d'erreur global
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message
  });
});

// Callback cleaner.js
cleaner.setRunCompleteCallback((st) => {
  saveCfg();
  if (st.last_deleted_hashes?.length) {
    let nameMapDirty = false, catMapDirty = false;
    for (const h of st.last_deleted_hashes) {
      if (nameMap[h])        { delete nameMap[h];        nameMapDirty = true; }
      if (categoryMap[h])    { delete categoryMap[h];    catMapDirty  = true; }
    }
    if (nameMapDirty) saveNameMap();
    if (catMapDirty)  saveCategoryMap();
  }
  if (st.last_deleted_count > 0) {
    appendHistory('clean', st.last_deleted_count, st.last_run_type, st.last_deleted_names || []);
  }
});

// Séquence de démarrage
initConfig();

// Initialisation des modules lib
auth.init(cfg);
qbit.init(cfg);
ultracc.init(cfg);
grab.init(cfg, { nameMap, categoryMap }, {
  getTopCache, setTopCache,
  saveCfg, saveNameMap, saveCategoryMap, appendTorrentList, appendHistory,
  qbitRequest: qbit.qbitRequest,
  isCleanRunning: () => cleaner.isRunning(),
  getUltraccInfo: async () => {
    const info = await ultracc.getUltraccStats();
    return {
      free_storage_gb:  info?.free_storage_gb           ?? null,
      traffic_used_pct: info?.traffic_used_percentage != null
        ? Math.round(info.traffic_used_percentage * 10) / 10 : null,
    };
  },
}, TOP_CACHE_PATH);

// ============================================================
// TIMER COMBINÉ CLEAN → GRAB
// ============================================================

let timerTask    = null;
let timerRunning = false;

/**
 * Planifie (ou replanifie) le timer combiné clean → grab.
 * Vérifie toutes les minutes si l'intervalle configuré est écoulé.
 * Séquence : clean (si enabled) → délai 10 s → grab (si enabled).
 */
function scheduleTimer() {
  if (timerTask) { clearInterval(timerTask); timerTask = null; }
  if (!cfg.timer?.enabled) { console.log('[timer] désactivé'); return; }
  timerTask = setInterval(async () => {
    if (timerRunning) return;
    const intervalMs = (cfg.timer.interval_hours || 1) * 3600 * 1000;
    const lastRun    = cfg.timer.last_run ? new Date(cfg.timer.last_run).getTime() : 0;
    if (Date.now() - lastRun < intervalMs) return;
    timerRunning       = true;
    cfg.timer.last_run = new Date().toISOString();
    saveCfg();
    console.log('[timer] Cycle démarré');
    try {
      if (cfg.auto_clean?.enabled) await cleaner.runClean('auto');
      await new Promise(r => setTimeout(r, 10000));
      if (cfg.auto_grab?.enabled) {
        const grabbed = await grab.runAutoGrab('auto');
        if (grabbed > 0) appendHistory('grab', grabbed, 'auto', grab.getStatus().last_grabbed || []);
      }
      console.log('[timer] Cycle terminé');
    } catch(e) {
      console.error('[timer] Erreur cycle :', e.message);
    } finally {
      timerRunning = false;
    }
  }, 60 * 1000);
  console.log(`[timer] planifié : toutes les ${cfg.timer.interval_hours}h`);
}

auth.initAuth(saveConn).then(() => {
  auth.decryptSecrets();
  saveCfg();
  scheduleTimer();
  pruneNameMap();

  app.listen(cfg.port, '0.0.0.0', () => {
    console.log(`SeedDash démarré → http://0.0.0.0:${cfg.port}${cfg.baseurl}`);
  });
});
