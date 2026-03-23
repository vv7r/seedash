'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT                = path.join(__dirname, '..');
const CFG_PATH            = path.join(ROOT, 'config.json');
const CONN_PATH           = path.join(ROOT, 'connections.json');
const LOG_PATH            = path.join(ROOT, 'logs', 'auto.log');
const UPLOAD_HISTORY_PATH = path.join(ROOT, 'logs', 'upload-history.json');

if (!fs.existsSync(path.join(ROOT, 'logs'))) {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
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

let _qbitRequest   = null; // injecté via initQbit()
let onRunComplete  = null;
let cleanRunning   = false;

// ── Logger ───────────────────────────────────────────────
let _logSource = 'auto-cleaner'; // mis à jour en début de runClean()

/**
 * Écrit un message horodaté dans auto.log et dans la console.
 * Le préfixe reflète la source du cycle en cours (auto-cleaner / manuel-cleaner).
 * @param {string} msg - Message à enregistrer.
 */
function log(msg) {
  const line = `[${new Date().toISOString()}] [${_logSource}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line);
  console.log(`[${_logSource}]`, msg);
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
 * Retourne la raison de suppression d'un torrent (pour le log).
 * Mêmes paramètres que shouldDelete — à appeler uniquement si shouldDelete === true.
 * @returns {string} Raison lisible (ex: "ratio_max (>2.0)")
 */
function deleteReason(t, rules, rulesOn, uploadHistory, now) {
  const isOn = (k) => (rulesOn || {})[k] !== false;
  const age  = now - t.added_on;
  const reasons = [];

  // Seuils maximaux (prioritaires dans le log)
  if (isOn('ratio_max') && rules.ratio_max != null && t.ratio >= rules.ratio_max)
    reasons.push(`ratio_max (≥${rules.ratio_max})`);
  if (isOn('age_max_hours') && rules.age_max_hours != null && age >= rules.age_max_hours * 3600)
    reasons.push(`age_max (≥${rules.age_max_hours}h)`);

  if (reasons.length) return reasons.join(' + ');

  // Conditions minimales (ET)
  const parts = [];
  if (isOn('ratio_min'))     parts.push(`ratio≥${rules.ratio_min}`);
  if (isOn('age_min_hours')) parts.push(`âge≥${rules.age_min_hours}h`);
  if (isOn('upload_min_mb') && rules.upload_min_mb > 0)
    parts.push(`upload<${rules.upload_min_mb}MB/${rules.upload_window_hours || 48}h`);

  return parts.join(' + ') || 'conditions min';
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
  _logSource = source === 'auto' ? 'auto-cleaner' : 'manuel-cleaner';
  if (cleanRunning) { log('Nettoyage déjà en cours — ignoré'); return 0; }
  cleanRunning = true;
  const cfg = {
    ...JSON.parse(fs.readFileSync(CFG_PATH)),
    ...(() => { try { return JSON.parse(fs.readFileSync(CONN_PATH)); } catch { return {}; } })(),
  };

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
    const torrents = await _qbitRequest('get', '/torrents/info');
    const toDelete  = torrents.filter(t => shouldDelete(t, rules, rulesOn, uploadHistory, now));

    for (const t of toDelete) {
      try {
        await _qbitRequest('post', '/torrents/delete',
          `hashes=${t.hash}&deleteFiles=${!!cfg.auto_clean?.delete_files}`);
        const ageDays = Math.floor((now - t.added_on) / 86400);
        const reason = deleteReason(t, rules, rulesOn, uploadHistory, now);
        log(`Supprimé : ${t.name} (ratio=${t.ratio.toFixed(2)}, âge=${ageDays}j) — ${reason}`);
        deleted++;
        deletedNames.push({ name: t.name, hash: t.hash.toLowerCase(), url: `${(cfg.c411?.url || '').replace('/api/torznab', '') || 'https://c411.org'}/torrents/${t.hash}` });
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

// ── Init ─────────────────────────────────────────────────
/**
 * Initialise le module cleaner au démarrage : lit config.json, hydrate l'objet `status`
 * avec les valeurs persistées (last_run, enabled, interval_hours…) et démarre le timer
 * via reschedule() si le nettoyage automatique est activé.
 * Appelé automatiquement à l'exigence du module (require).
 */
function setEnabled(v) { status.enabled = !!v; }

/** Injecte la fonction qbitRequest partagée (lib/qbit.js). */
function initQbit(qbitRequestFn) { _qbitRequest = qbitRequestFn; }

function init() {
  const cfg        = JSON.parse(fs.readFileSync(CFG_PATH));
  const cleanerCfg = cfg.auto_clean || {};
  status.interval_hours     = Math.max(1, parseInt(cleanerCfg.interval_hours) || 1);
  status.enabled            = cleanerCfg.enabled === true;
  status.last_run           = cleanerCfg.last_run           || null;
  status.last_deleted_count = cleanerCfg.last_deleted_count ?? 0;
  status.last_run_type      = cleanerCfg.last_run_type      || null;
  // Le timer est géré par server.js via reschedule() — pas de setInterval ici
}

init();

// ── Exports ──────────────────────────────────────────────
module.exports = {
  runClean,
  shouldDelete,
  deleteReason,
  setEnabled,
  initQbit,
  getStatus: () => ({ ...status }),
  setRunCompleteCallback: (fn) => { onRunComplete = fn; },
  isRunning: () => cleanRunning,
};
