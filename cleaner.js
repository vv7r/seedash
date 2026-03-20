'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { decrypt } = require('./crypto-config');

const CFG_PATH            = path.join(__dirname, 'config.json');
const CONN_PATH           = path.join(__dirname, 'connections.json');
const LOG_PATH            = path.join(__dirname, 'logs', 'cleaner.log');
const UPLOAD_HISTORY_PATH = path.join(__dirname, 'logs', 'upload-history.json');

if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
}

// ── État en mémoire ──────────────────────────────────────
const status = {
  enabled:             false,
  interval_hours:      1,
  last_run:            null,
  last_deleted_count:  0,
  last_run_type:       null,
  last_deleted_names:  [],
  last_deleted_hashes: [],
};

let currentTask    = null;
let qbitCookie     = null;
let onRunComplete  = null;
let cleanRunning   = false;

// ── Logger ───────────────────────────────────────────────
/**
 * Écrit un message horodaté dans le fichier de log cleaner et dans la console.
 * @param {string} msg - Message à enregistrer.
 */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line);
  console.log('[cleaner]', msg);
}

// ── qBittorrent helpers ──────────────────────────────────
/**
 * Authentifie le cleaner auprès de l'API qBittorrent et stocke le cookie de session.
 * @param {object} cfg - Configuration complète (doit contenir cfg.qbittorrent.url/username/password).
 * @throws {Error} Si la requête HTTP échoue.
 */
async function qbitLogin(cfg) {
  const r = await axios.post(
    `${cfg.qbittorrent.url}/api/v2/auth/login`,
    `username=${encodeURIComponent(cfg.qbittorrent.username)}&password=${encodeURIComponent(cfg.qbittorrent.password)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  qbitCookie = r.headers['set-cookie']?.[0]?.split(';')[0];
}

/**
 * Effectue une requête vers l'API qBittorrent avec gestion automatique de la session.
 * En cas de 403 (session expirée), se reconnecte et réessaie une fois.
 * @param {object} cfg      - Configuration (url/credentials qBittorrent).
 * @param {string} method   - Méthode HTTP ('get' ou 'post').
 * @param {string} endpoint - Chemin de l'endpoint (ex : '/torrents/info').
 * @param {string|null} data - Corps de la requête POST (format x-www-form-urlencoded).
 * @returns {Promise<*>} Données retournées par l'API.
 * @throws {Error} Si la requête échoue après la tentative de reconnexion.
 */
async function qbitRequest(cfg, method, endpoint, data = null) {
  if (!qbitCookie) await qbitLogin(cfg);
  const opts = {
    method,
    url: `${cfg.qbittorrent.url}/api/v2${endpoint}`,
    data,
    headers: {
      Cookie: qbitCookie,
      ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    timeout: 10000,
  };
  try {
    return (await axios(opts)).data;
  } catch (e) {
    if (e.response?.status === 403) {
      // Session expirée : on se reconnecte et on réessaie une seule fois
      await qbitLogin(cfg);
      opts.headers.Cookie = qbitCookie;
      return (await axios(opts)).data;
    }
    throw e;
  }
}

// ── Logique de nettoyage ─────────────────────────────────

/**
 * Détermine si un torrent doit être supprimé selon les règles et l'historique d'upload.
 * Fonction pure exportée — ne dépend d'aucun état global ni d'I/O.
 *
 * @param {Object} t              - Torrent { hash, ratio, added_on }
 * @param {Object} rules          - cfg.auto_clean.rules (valeurs numériques)
 * @param {Object} rulesOn        - cfg.auto_clean.rules_on (clé → bool ; absent = actif)
 * @param {Object} uploadHistory  - Map hash.toLowerCase() → [[timestamp_s, cumul_bytes], ...]
 * @param {number} now            - Timestamp Unix courant en secondes
 * @returns {boolean} true si le torrent doit être supprimé
 */
function shouldDelete(t, rules, rulesOn, uploadHistory, now) {
  const { ratio_min, ratio_max, age_min_hours, age_max_hours, upload_min_mb, upload_window_hours } = rules || {};
  const isOn = (k) => (rulesOn || {})[k] !== false;

  const ageMin      = (age_min_hours || 48) * 3600;
  const ageMax      = isOn('age_max_hours') && age_max_hours != null ? age_max_hours * 3600 : null;
  const ratioMax    = isOn('ratio_max')     && ratio_max    != null ? ratio_max : null;
  const uploadMinMb = isOn('upload_min_mb') && upload_min_mb > 0   ? upload_min_mb : null;
  const uploadWinSec = (upload_window_hours || 48) * 3600;

  const age = now - t.added_on;

  // Conditions minimales — toutes doivent être satisfaites simultanément si actives
  const ratioCheck = isOn('ratio_min') ? t.ratio >= ratio_min : true;
  const ageCheck   = isOn('age_min_hours') ? age >= ageMin : true;

  // uploadCheck : faible upload sur la fenêtre glissante
  let uploadCheck = true; // neutre si règle désactivée
  if (uploadMinMb !== null) {
    const points   = (uploadHistory || {})[t.hash.toLowerCase()] || [];
    const winStart = now - uploadWinSec;
    const inWin    = points.filter(([ts]) => ts >= winStart);
    // L'historique doit couvrir toute la fenêtre (premier point antérieur à winStart)
    // et contenir au moins 2 mesures dans la fenêtre
    const historyCoversWindow = points.length > 0 && points[0][0] <= winStart;
    uploadCheck = (historyCoversWindow && inWin.length >= 2)
      ? (inWin[inWin.length - 1][1] - inWin[0][1]) / 1e6 < uploadMinMb
      : false;
  }

  // normalCondition : ET sur les règles minimales actives ; rien à supprimer si aucune active
  const anyMinOn        = isOn('ratio_min') || isOn('age_min_hours') || uploadMinMb !== null;
  const normalCondition = anyMinOn && ratioCheck && ageCheck && uploadCheck;

  // Seuils maximaux : OU indépendant, force la suppression dès dépassement
  const maxCondition      = ageMax   !== null && age       >= ageMax;
  const ratioMaxCondition = ratioMax !== null && t.ratio   >= ratioMax;

  return normalCondition || maxCondition || ratioMaxCondition;
}

/**
 * Exécute un cycle de nettoyage : récupère tous les torrents qBittorrent,
 * évalue chaque torrent contre les règles actives, et supprime les torrents éligibles.
 * Relit config.json à chaque exécution pour prendre en compte les modifications à chaud.
 * Met à jour l'objet `status` et appelle `onRunComplete` si défini.
 * @param {string} [source='auto'] - Origine du déclenchement ('auto' ou 'manual').
 * @returns {Promise<number>} Nombre de torrents supprimés.
 */
async function runClean(source = 'auto') {
  if (cleanRunning) { log('Nettoyage déjà en cours — ignoré'); return 0; }
  cleanRunning = true;
  const cfg = {
    ...JSON.parse(fs.readFileSync(CFG_PATH)),
    ...(() => { try { return JSON.parse(fs.readFileSync(CONN_PATH)); } catch { return {}; } })(),
  };
  const key = process.env.JWT_SECRET || cfg.auth?.jwt_secret;
  if (key) {
    if (cfg.qbittorrent?.username) cfg.qbittorrent.username = decrypt(cfg.qbittorrent.username, key);
    if (cfg.qbittorrent?.password) cfg.qbittorrent.password = decrypt(cfg.qbittorrent.password, key);
  }

  const rules   = cfg.auto_clean?.rules   || {};
  const rulesOn = cfg.auto_clean?.rules_on || {};
  // `age` = temps écoulé depuis l'ajout (t.added_on), pas le seedtime réel.
  const now = Math.floor(Date.now() / 1000);

  // Optimisation : ne charger l'historique d'upload que si la règle est active
  const isOn        = (k) => rulesOn[k] !== false;
  const uploadMinMb = isOn('upload_min_mb') && rules.upload_min_mb > 0 ? rules.upload_min_mb : null;
  let uploadHistory = {};
  if (uploadMinMb !== null) {
    try { uploadHistory = JSON.parse(fs.readFileSync(UPLOAD_HISTORY_PATH)); } catch {}
  }

  log('Nettoyage démarré');
  let deleted = 0;
  const deletedNames  = [];
  const deletedHashes = [];
  try {
    const torrents = await qbitRequest(cfg, 'get', '/torrents/info');
    const toDelete  = torrents.filter(t => shouldDelete(t, rules, rulesOn, uploadHistory, now));

    for (const t of toDelete) {
      try {
        await qbitRequest(cfg, 'post', '/torrents/delete',
          `hashes=${t.hash}&deleteFiles=false`);
        const ageDays = Math.floor((now - t.added_on) / 86400);
        log(`Supprimé : ${t.name} (ratio=${t.ratio.toFixed(2)}, âge=${ageDays}j)`);
        deleted++;
        deletedNames.push({ name: t.name, url: `https://c411.org/torrents/${t.hash}` });
        deletedHashes.push(t.hash.toLowerCase());
      } catch (e) {
        log(`Erreur suppression "${t.name}" : ${e.message}`);
      }
    }
  } catch (e) {
    log(`Erreur nettoyage : ${e.message}`);
  }

  status.last_run            = new Date().toISOString();
  status.last_deleted_count  = deleted;
  status.last_run_type       = source;
  status.last_deleted_names  = deletedNames;
  status.last_deleted_hashes = deletedHashes;
  log(`Terminé — ${deleted} torrent(s) supprimé(s)`);
  if (onRunComplete) onRunComplete(status);
  cleanRunning = false;
  return deleted;
}

// ── Replanification ──────────────────────────────────────
// Fréquence de vérification interne : toutes les minutes.
// Permet des intervalles arbitraires (1h–8760h) sans dépendre d'une lib cron.
const CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Annule l'éventuel timer existant et en recrée un nouveau si le nettoyage est activé.
 * Toutes les minutes, le timer vérifie si l'intervalle configuré est écoulé depuis last_run ;
 * si oui, il déclenche runClean('auto').
 * @param {number|null} newIntervalHours - Nouvel intervalle en heures (1–8760), ou null pour conserver l'actuel.
 * @param {boolean|undefined} enabled    - Activation du nettoyage automatique, ou undefined pour conserver.
 */
function reschedule(newIntervalHours, enabled) {
  if (currentTask) { clearInterval(currentTask); currentTask = null; }

  if (enabled !== undefined)      status.enabled        = enabled;
  if (newIntervalHours != null)   status.interval_hours = Math.max(1, Math.min(8760, parseInt(newIntervalHours) || 1));

  if (status.enabled) {
    currentTask = setInterval(async () => {
      const intervalMs = status.interval_hours * 3600 * 1000;
      const lastRunMs  = status.last_run ? new Date(status.last_run).getTime() : 0;
      if (Date.now() - lastRunMs >= intervalMs) {
        await runClean('auto');
      }
    }, CHECK_INTERVAL_MS);
    log(`Planifié : toutes les ${status.interval_hours}h (vérification toutes les 1min)`);
  } else {
    log('Nettoyage automatique désactivé');
  }
}

// ── Init ─────────────────────────────────────────────────
/**
 * Initialise le module cleaner au démarrage : lit config.json, hydrate l'objet `status`
 * avec les valeurs persistées (last_run, enabled, interval_hours…) et démarre le timer
 * via reschedule() si le nettoyage automatique est activé.
 * Appelé automatiquement à l'exigence du module (require).
 */
function init() {
  const cfg        = JSON.parse(fs.readFileSync(CFG_PATH));
  const cleanerCfg = cfg.auto_clean || {};
  status.interval_hours     = Math.max(1, parseInt(cleanerCfg.interval_hours) || 1);
  status.enabled            = cleanerCfg.enabled === true;
  status.last_run           = cleanerCfg.last_run           || null;
  status.last_deleted_count = cleanerCfg.last_deleted_count ?? 0;
  status.last_run_type      = cleanerCfg.last_run_type      || null;
  reschedule(status.interval_hours, status.enabled);
}

init();

// ── Exports ──────────────────────────────────────────────
module.exports = {
  runClean,
  shouldDelete,
  reschedule,
  getStatus: () => ({ ...status }),
  setRunCompleteCallback: (fn) => { onRunComplete = fn; },
  isRunning: () => cleanRunning,
};
