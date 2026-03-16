'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { decrypt } = require('./crypto-config');

const CFG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'logs', 'cleaner.log');

if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
}

// ── État en mémoire ──────────────────────────────────────
const status = {
  enabled:            false,
  interval_hours:     1,
  last_run:           null,
  last_deleted_count: 0,
  last_run_type:      null,
  last_deleted_names: [],
};

let currentTask    = null;
let qbitCookie     = null;
let onRunComplete  = null;

// ── Logger ───────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line);
  console.log('[cleaner]', msg);
}

// ── qBittorrent helpers ──────────────────────────────────
async function qbitLogin(cfg) {
  const r = await axios.post(
    `${cfg.qbittorrent.url}/api/v2/auth/login`,
    `username=${encodeURIComponent(cfg.qbittorrent.username)}&password=${encodeURIComponent(cfg.qbittorrent.password)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  qbitCookie = r.headers['set-cookie']?.[0]?.split(';')[0];
}

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
      await qbitLogin(cfg);
      opts.headers.Cookie = qbitCookie;
      return (await axios(opts)).data;
    }
    throw e;
  }
}

// ── Logique de nettoyage ─────────────────────────────────
// Relit config.json à chaque exécution pour prendre en compte les modifications à chaud.
async function runClean(source = 'auto') {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH));
  const key = process.env.JWT_SECRET || cfg.auth?.jwt_secret;
  if (key && cfg.qbittorrent?.password) cfg.qbittorrent.password = decrypt(cfg.qbittorrent.password, key);
  const { ratio_min, ratio_max, age_min_hours, age_max_hours } = cfg.rules;
  // cfg.rules_on stocke l'état activé/désactivé séparément des valeurs.
  // Par défaut (clé absente) une règle est considérée active.
  const rulesOn  = cfg.rules_on || {};
  const isOn     = (k) => rulesOn[k] !== false;
  const ageMin   = (age_min_hours || 48) * 3600;
  const ageMax   = isOn('age_max_hours') && age_max_hours != null ? age_max_hours * 3600 : null;
  const ratioMax = isOn('ratio_max') && ratio_max != null ? ratio_max : null;
  // `age` = temps écoulé depuis l'ajout (t.added_on), pas le seedtime réel.
  // Un torrent pausé voit son âge compter normalement.
  const now    = Math.floor(Date.now() / 1000);

  log('Nettoyage démarré');
  let deleted = 0;
  const deletedNames = [];
  try {
    const torrents = await qbitRequest(cfg, 'get', '/torrents/info');
    const toDelete = torrents.filter(t => {
      const age = now - t.added_on;
      // Condition normale : ratio ET âge minimum tous les deux atteints
      const normalCondition   = t.ratio >= ratio_min && age >= ageMin;
      // Conditions forcées : indépendantes l'une de l'autre et de normalCondition
      const maxCondition      = ageMax     !== null && age >= ageMax;
      const ratioMaxCondition = ratioMax   !== null && t.ratio >= ratioMax;
      return normalCondition || maxCondition || ratioMaxCondition;
    });

    for (const t of toDelete) {
      try {
        await qbitRequest(cfg, 'post', '/torrents/delete',
          `hashes=${t.hash}&deleteFiles=false`);
        const ageDays = Math.floor((now - t.added_on) / 86400);
        log(`Supprimé : ${t.name} (ratio=${t.ratio.toFixed(2)}, âge=${ageDays}j)`);
        deleted++;
        deletedNames.push({ name: t.name, url: `https://c411.org/torrents/${t.hash}` });
      } catch (e) {
        log(`Erreur suppression "${t.name}" : ${e.message}`);
      }
    }
  } catch (e) {
    log(`Erreur nettoyage : ${e.message}`);
  }

  status.last_run           = new Date().toISOString();
  status.last_deleted_count = deleted;
  status.last_run_type      = source;
  status.last_deleted_names = deletedNames;
  log(`Terminé — ${deleted} torrent(s) supprimé(s)`);
  if (onRunComplete) onRunComplete(status);
  return deleted;
}

// ── Replanification ──────────────────────────────────────
// Vérifie toutes les minutes si l'intervalle configuré est écoulé depuis last_run.
// Permet des intervalles arbitraires (1h–8760h) sans dépendre d'une lib cron.
const CHECK_INTERVAL_MS = 60 * 1000;

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
    log(`Planifié : toutes les ${status.interval_hours}h (vérification toutes les 5min)`);
  } else {
    log('Nettoyage automatique désactivé');
  }
}

// ── Init ─────────────────────────────────────────────────
function init() {
  const cfg        = JSON.parse(fs.readFileSync(CFG_PATH));
  const cleanerCfg = cfg.cleaner || {};
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
  reschedule,
  getStatus: () => ({ ...status }),
  setRunCompleteCallback: (fn) => { onRunComplete = fn; },
};
