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
 * Vérifie qu'une chaîne est une URL HTTP(S) valide.
 * Utilisé pour valider les URLs de service (qBittorrent, Ultra.cc) avant de les sauvegarder.
 * @returns {boolean} true si l'URL est valide et utilise le protocole http ou https
 */
function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

module.exports = { SECRET_PATHS, GRAB_RULE_KEYS, CLEAN_RULE_KEYS, VALID_RULE_KEYS, getIn, setIn, maskSecret, isHttpUrl };
