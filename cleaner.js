'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const cron  = require('node-cron');

const CFG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'logs', 'cleaner.log');

// Ensure logs/ exists at runtime (au cas où)
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
}

// ── État en mémoire ──────────────────────────────────────
const status = {
  enabled:            false,
  cron_schedule:      '0 * * * *',
  last_run:           null,
  last_deleted_count: 0,
};

let currentTask  = null;
let qbitCookie   = null;

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
    `username=${cfg.qbittorrent.username}&password=${cfg.qbittorrent.password}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
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
async function runClean() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH));
  const { ratio_min, seedtime_min_hours } = cfg.rules;
  const seedtime_min_secs = seedtime_min_hours * 3600;

  log('Nettoyage démarré');
  let deleted = 0;
  try {
    const torrents = await qbitRequest(cfg, 'get', '/torrents/info');
    const toDelete = torrents.filter(
      t => t.ratio >= ratio_min && t.seeding_time >= seedtime_min_secs
    );

    for (const t of toDelete) {
      try {
        await qbitRequest(cfg, 'post', '/torrents/delete',
          `hashes=${t.hash}&deleteFiles=false`);
        log(`Supprimé : ${t.name} (ratio=${t.ratio.toFixed(2)}, seedtime=${Math.floor(t.seeding_time / 3600)}h)`);
        deleted++;
      } catch (e) {
        log(`Erreur suppression "${t.name}" : ${e.message}`);
      }
    }
  } catch (e) {
    log(`Erreur nettoyage : ${e.message}`);
  }

  status.last_run           = new Date().toISOString();
  status.last_deleted_count = deleted;
  log(`Terminé — ${deleted} torrent(s) supprimé(s)`);
  return deleted;
}

// ── Replanification ──────────────────────────────────────
function reschedule(newCronExpr, enabled) {
  // Arrêter la tâche courante
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  if (enabled !== undefined) status.enabled = enabled;
  if (newCronExpr)           status.cron_schedule = newCronExpr;

  if (status.enabled) {
    if (!cron.validate(status.cron_schedule)) {
      log(`Expression cron invalide : "${status.cron_schedule}" — cron désactivé`);
      return;
    }
    currentTask = cron.schedule(status.cron_schedule, () => runClean());
    log(`Cron planifié : ${status.cron_schedule}`);
  } else {
    log('Cron désactivé');
  }
}

// ── Init ─────────────────────────────────────────────────
function init() {
  const cfg        = JSON.parse(fs.readFileSync(CFG_PATH));
  const cleanerCfg = cfg.cleaner || {};
  status.cron_schedule = cleanerCfg.cron_schedule || '0 * * * *';
  status.enabled       = cleanerCfg.enabled === true;
  reschedule(status.cron_schedule, status.enabled);
}

init();

// ── Exports ──────────────────────────────────────────────
module.exports = {
  runClean,
  reschedule,
  getStatus: () => ({ ...status }),
};
