/**
 * grab.js — Logique d'auto-grab : exécution d'un cycle, planification du timer serveur.
 * Appeler init(cfg, maps, fns) avant tout usage des autres fonctions.
 *
 * @param {Object}   cfg  - Référence partagée à la config (mutations visibles par server.js)
 * @param {Object}   maps - { nameMap, categoryMap } — objets mutés en place
 * @param {Object}   fns  - {
 *   getTopCache, setTopCache,   // callbacks pour topCache (réassigné, pas muté)
 *   saveCfg, saveNameMap, saveCategoryMap, appendTorrentList, appendHistory,
 *   qbitRequest
 * }
 */

const axios         = require('axios');
const fs            = require('fs');
const path          = require('path');
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const LOG_PATH = path.join(__dirname, '..', 'logs', 'auto.log');

let _logSource = 'auto-grab'; // mis à jour en début de runAutoGrab()

function log(msg) {
  const line = `[${new Date().toISOString()}] [${_logSource}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
  console.log(`[${_logSource}]`, msg);
}

let _cfg  = null;
let _maps = null;  // { nameMap, categoryMap }
let _fns  = null;  // { getTopCache, setTopCache, saveCfg, saveNameMap, saveCategoryMap, appendTorrentList, appendHistory, qbitRequest }
let TOP_CACHE_PATH = null;

let autoGrabStatus = {
  enabled:          false,
  last_run:         null,
  last_run_source:  null,
  last_grab_count:  0,
  grabs_today:      0,
  grabs_date:       null,
  last_grabbed:     [],
  running:          false,
};


/**
 * Initialise le module grab avec les dépendances injectées.
 * @param {Object}   cfg           - Référence partagée à la config
 * @param {Object}   maps          - { nameMap, categoryMap }
 * @param {Object}   fns           - Fonctions et callbacks requis
 * @param {string}   topCachePath  - Chemin vers le fichier logs/top-cache.json
 */
function init(cfg, maps, fns, topCachePath) {
  _cfg          = cfg;
  _maps         = maps;
  _fns          = fns;
  TOP_CACHE_PATH = topCachePath;
  autoGrabStatus.last_run        = cfg.auto_grab?.last_run        || null;
  autoGrabStatus.last_grab_count = cfg.auto_grab?.last_grab_count ?? 0;
  autoGrabStatus.enabled         = cfg.auto_grab?.enabled === true;
}

/** Retourne une copie de l'état courant de l'auto-grab. */
function getStatus() { return { ...autoGrabStatus }; }

/** Met à jour le flag enabled (appelé depuis server.js). */
function setEnabled(v) { autoGrabStatus.enabled = !!v; }

/**
 * Filtre et trie la liste C411 pour sélectionner les candidats à graber.
 * Fonction pure exportée — ne dépend d'aucun état global ni d'I/O.
 *
 * @param {Array}  list           - Items du top C411 ({ infohash, size, leechers, seeders, ... })
 * @param {Set}    existingHashes - Hashes (lowercase) déjà présents dans qBittorrent
 * @param {Object} rules          - cfg.auto_grab.rules (valeurs numériques)
 * @param {Object} rulesOn        - cfg.auto_grab.rules_on (clé → bool ; absent = actif)
 * @param {number} canGrab        - Nombre maximum de torrents à retourner
 * @returns {Array} Liste filtrée, triée par leechers décroissant, limitée à canGrab
 */
function filterCandidates(list, existingHashes, rules, rulesOn, canGrab) {
  const { size_max_gb, min_leechers, min_seeders } = rules || {};
  const isRuleOn = (k) => (rulesOn || {})[k] !== false;
  const sizeLimitBytes = isRuleOn('size_max_gb') && size_max_gb ? size_max_gb * 1e9 : Infinity;
  return list
    .filter(t => !existingHashes.has(t.infohash))
    .filter(t => t.size <= sizeLimitBytes)
    .filter(t => !isRuleOn('min_leechers') || min_leechers == null || t.leechers >= min_leechers)
    .filter(t => !isRuleOn('min_seeders')  || min_seeders  == null || t.seeders  >= min_seeders)
    .sort((a, b) => b.leechers - a.leechers)
    .slice(0, canGrab);
}

/**
 * Vérifie les conditions pré-grab dépendant d'Ultra.cc (trafic réseau + espace disque).
 * Fonction pure exportée — ne dépend d'aucun état global ni d'I/O.
 *
 * @param {Object}      rules       - cfg.auto_grab.rules (valeurs numériques)
 * @param {Object}      rulesOn     - cfg.auto_grab.rules_on (clé → bool ; absent = actif)
 * @param {Object|null} ultraccInfo - { free_storage_gb, traffic_used_pct } ou null si Ultra.cc inaccessible
 * @param {Array}       candidates  - Liste des candidats retournée par filterCandidates()
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function checkGrabConditions(rules, rulesOn, ultraccInfo, candidates) {
  const isRuleOn = (k) => (rulesOn || {})[k] !== false;
  const { network_max_pct } = rules || {};

  // Condition réseau (règle visible) : trafic mensuel Ultra.cc
  if (isRuleOn('network_max_pct') && network_max_pct != null && network_max_pct > 0) {
    if (ultraccInfo?.traffic_used_pct != null && ultraccInfo.traffic_used_pct >= network_max_pct) {
      return { allowed: false, reason: `réseau ${ultraccInfo.traffic_used_pct}% ≥ ${network_max_pct}%` };
    }
  }

  // Condition disque (invisible) : espace libre vs taille totale des candidats
  if (candidates.length > 0 && ultraccInfo?.free_storage_gb != null) {
    const totalBytes = candidates.reduce((s, t) => s + (t.size || 0), 0);
    if (totalBytes > ultraccInfo.free_storage_gb * 1e9) {
      return {
        allowed: false,
        reason: `espace insuffisant : ${(totalBytes / 1e9).toFixed(1)} GB requis, ${ultraccInfo.free_storage_gb.toFixed(1)} GB libre`,
      };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Exécute un cycle complet d'auto-grab :
 * 1. Fetch C411 en premier (topCache toujours mis à jour, même si grab impossible)
 * 2. Vérifie les limites journalières et le nombre de slots disponibles
 * 3. Filtre les candidats selon les règles actives (taille, leechers, seeders, déjà présents)
 * 4. Soumet les torrents éligibles à qBittorrent dans l'ordre décroissant de leechers
 * 5. Met à jour nameMap, categoryMap et torrentList pour chaque torrent grabé
 * Un mutex simple (autoGrabStatus.running) empêche les exécutions concurrentes.
 * @returns {number} Nombre de torrents effectivement grabés
 */
async function runAutoGrab(source = 'auto') {
  _logSource = source === 'auto' ? 'auto-grab' : 'manuel-grab';
  if (autoGrabStatus.running) return 0;
  if (_fns.isCleanRunning?.()) { log('Cleaner en cours — grab reporté'); return 0; }
  autoGrabStatus.running = true;
  let grabbed = 0;
  try {
    const { grab_limit_per_day, active_max } = _cfg.auto_grab.rules || {};
    const rulesOn  = _cfg.auto_grab.rules_on || {};
    const isRuleOn = (k) => rulesOn[k] !== false;

    // Remise à zéro du compteur journalier si nouveau jour
    const today = new Date().toISOString().split('T')[0];
    if (autoGrabStatus.grabs_date !== today) {
      autoGrabStatus.grabs_today = 0;
      autoGrabStatus.grabs_date  = today;
    }

    log('Démarrage');

    // Fetch C411 en premier : topCache toujours mis à jour même si grab impossible
    let list = [];
    try {
      const r      = await axios.get(_cfg.c411.url, {
        params: { apikey: _cfg.c411.apikey, t: 'search', q: '', limit: 100 },
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
          category: attr('category') || (Array.isArray(item.category) ? item.category[0] : item.category) || '',
          pubDate:  item.pubDate || '',
        }];
      });
      const newCache = { items: [...list].sort((a, b) => b.leechers - a.leechers).slice(0, 100), date: new Date().toISOString() };
      _fns.setTopCache(newCache);
      try {
        const tmp = TOP_CACHE_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(newCache, null, 2));
        fs.renameSync(tmp, TOP_CACHE_PATH);
      } catch(e) { log(`Erreur écriture cache : ${e.message}`); }
    } catch(e) {
      log(`C411 inaccessible : ${e.message}`);
      return 0;
    }

    // Condition réseau (règle visible) : trafic mensuel Ultra.cc
    if (_fns.getUltraccInfo) {
      try {
        const info = await _fns.getUltraccInfo();
        const { allowed, reason } = checkGrabConditions(_cfg.auto_grab.rules || {}, rulesOn, info, []);
        if (!allowed) { log(`${reason} — grab annulé`); return 0; }
      } catch(e) { log(`Erreur vérif. réseau : ${e.message}`); }
    }

    // Vérification des limites avant de tenter le grab
    const limit     = isRuleOn('grab_limit_per_day') ? (grab_limit_per_day ?? 20) : Infinity;
    const remaining = isFinite(limit) ? limit - autoGrabStatus.grabs_today : Infinity;
    if (isFinite(remaining) && remaining <= 0) {
      log('Limite journalière atteinte');
      return 0;
    }

    let torrents = [];
    try {
      torrents = await _fns.qbitRequest('get', '/torrents/info');
    } catch(e) {
      log(`qBittorrent inaccessible : ${e.message}`);
      return 0;
    }
    const existingHashes = new Set(torrents.map(t => t.hash.toLowerCase()));

    const maxActive      = isRuleOn('active_max') && active_max != null ? active_max : null;
    const slotsAvailable = maxActive != null ? Math.max(0, maxActive - torrents.length) : (isFinite(remaining) ? remaining : 100);
    if (slotsAvailable <= 0) {
      log(`Limite active atteinte (${torrents.length}/${maxActive})`);
      return 0;
    }

    const canGrab    = Math.min(isFinite(remaining) ? remaining : 100, slotsAvailable);
    const candidates = filterCandidates(list, existingHashes, _cfg.auto_grab.rules || {}, rulesOn, canGrab);

    // Condition disque (invisible) : espace libre vs taille totale des candidats
    if (candidates.length > 0 && _fns.getUltraccInfo) {
      try {
        const info = await _fns.getUltraccInfo();
        const { allowed, reason } = checkGrabConditions(_cfg.auto_grab.rules || {}, rulesOn, info, candidates);
        if (!allowed) { log(`${reason} — grab annulé`); return 0; }
      } catch(e) { log(`Erreur vérif. disque : ${e.message}`); }
    }

    autoGrabStatus.last_grabbed = [];
    let nameMapDirty = false;
    let catMapDirty  = false;
    const grabbedItems = [];
    for (const t of candidates) {
      try {
        await _fns.qbitRequest('post', '/torrents/add', `urls=${encodeURIComponent(t.link)}`);
        if (t.infohash) {
          const lhash = t.infohash.toLowerCase();
          _maps.nameMap[lhash] = t.name; nameMapDirty = true;
          if (t.category != null) { _maps.categoryMap[lhash] = String(t.category); catMapDirty = true; }
        }
        autoGrabStatus.grabs_today++;
        autoGrabStatus.last_grabbed.push({ name: t.name, url: t.page_url || null });
        grabbedItems.push({ hash: t.infohash, name: t.name, url: t.page_url || null });
        grabbed++;
        const sizeStr = t.size >= 1e9 ? `${(t.size / 1e9).toFixed(1)} GB` : `${(t.size / 1e6).toFixed(0)} MB`;
        log(`Grabé : ${t.name} (${sizeStr}, ${t.leechers}L/${t.seeders}S)`);
      } catch(e) {
        log(`Erreur grab "${t.name}" : ${e.message}`);
      }
    }
    if (nameMapDirty) _fns.saveNameMap();
    if (catMapDirty)  _fns.saveCategoryMap();
    if (grabbedItems.length) _fns.appendTorrentList(grabbedItems);
  } catch(e) {
    log(`Erreur : ${e.message}`);
  } finally {
    autoGrabStatus.last_run        = new Date().toISOString();
    autoGrabStatus.last_run_source = source;
    autoGrabStatus.last_grab_count = grabbed;
    autoGrabStatus.running         = false;
    _cfg.auto_grab.last_run        = autoGrabStatus.last_run;
    _cfg.auto_grab.last_grab_count = grabbed;
    _fns.saveCfg();
    log(`Terminé — ${grabbed} grabé(s)`);
  }
  return grabbed;
}

module.exports = { init, runAutoGrab, filterCandidates, checkGrabConditions, getStatus, setEnabled };
