/**
 * helpers.js — Fonctions utilitaires pures et constantes partagées côté serveur.
 * Aucun état interne, aucune dépendance externe.
 */

/** Chemins des champs secrets à chiffrer sur disque via crypto-config.js */
const SECRET_PATHS = [
  ['c411', 'apikey'],
  ['qbittorrent', 'username'],
  ['qbittorrent', 'password'],
  ['ultracc_api', 'token'],
];

/** Clés de règles appartenant au groupe auto_grab */
const GRAB_RULE_KEYS  = new Set(['grab_limit_per_day','size_max_gb','active_max','min_leechers','min_seeders','network_max_pct']);
/** Clés de règles appartenant au groupe auto_clean */
const CLEAN_RULE_KEYS = new Set(['ratio_min','ratio_max','age_min_hours','age_max_hours','upload_min_mb','upload_window_hours']);
/** Union des deux ensembles, utilisée pour la validation des payloads POST /api/rules */
const VALID_RULE_KEYS = new Set([...GRAB_RULE_KEYS, ...CLEAN_RULE_KEYS]);

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
  const parent = path.slice(0, -1).reduce((o, k) => o?.[k], obj);
  if (!parent) return;
  parent[path[path.length - 1]] = val;
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
 * Vérifie qu'une chaîne est une URL HTTP(S) valide.
 * Utilisé pour valider les URLs de service (qBittorrent, Ultra.cc) avant de les sauvegarder.
 * @returns {boolean} true si l'URL est valide et utilise le protocole http ou https
 */
function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

/**
 * Vérifie qu'une URL HTTP(S) ne pointe pas vers une adresse dangereuse (SSRF).
 * Bloque : 169.254.0.0/16 (metadata cloud / link-local, y compris IPv4-mapped IPv6 ::ffff:),
 *          0.0.0.0, ::, ::1, fe80::/10 (link-local IPv6), localhost, metadata
 * Autorise : 127.0.0.1, 10.x, 172.16-31.x, 192.168.x (services locaux légitimes)
 * @returns {boolean} true si l'URL est sûre
 */
function isSafeUrl(s) {
  if (!isHttpUrl(s)) return false;
  let host = new URL(s).hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '0.0.0.0' || host === '::' || host === '::1') return false;
  const lowerHost = host.toLowerCase();
  if (lowerHost === 'localhost' || lowerHost === 'metadata') return false;
  const mappedHex2 = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex2) {
    const v = parseInt(mappedHex2[1], 16);
    if ((v >> 8) === 169 && (v & 0xff) === 254) return false;
  }
  const mappedHex4 = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex4) {
    if (parseInt(mappedHex4[1], 16) === 169 && parseInt(mappedHex4[2], 16) === 254) return false;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [, a, b, c, d] = m.map(Number);
    if (a === 169 && b === 254) return false;
    if (a === 127 && !(b === 0 && c === 0 && d === 1)) return false;
  }
  if (/^fe[89ab]/i.test(host)) return false;
  return true;
}

/**
 * Calcule si la condition upload est remplie pour un torrent.
 * Fonction pure — pas d'I/O, pas d'état global.
 *
 * @param {string}   hash     - Hash du torrent (lowercase)
 * @param {Array}    points   - Historique [[timestamp_s, cumul_bytes], ...]
 * @param {number}   nowSec   - Timestamp Unix courant (secondes)
 * @param {number}   winSec   - Fenêtre en secondes
 * @param {number}   minMb    - Seuil minimum en MB
 * @returns {boolean} true si l'upload est sous le seuil sur la fenêtre
 */
function checkUploadCondition(hash, points, nowSec, winSec, minMb) {
  const p = points || [];
  const winStart = nowSec - winSec;
  const inWin    = p.filter(([ts]) => ts >= winStart);
  const historyCoversWindow = p.length > 0 && p[0][0] <= winStart;
  if (!historyCoversWindow || inWin.length < 2) return false;
  const delta = inWin[inWin.length - 1][1] - inWin[0][1];
  return delta >= 0 && delta / 1e6 < minMb;
}

module.exports = { SECRET_PATHS, GRAB_RULE_KEYS, CLEAN_RULE_KEYS, VALID_RULE_KEYS, getIn, setIn, maskSecret, isHttpUrl, isSafeUrl, checkUploadCondition };
