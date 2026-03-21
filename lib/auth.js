/**
 * auth.js — Authentification JWT, chiffrement des secrets, protection brute-force.
 * Appeler init(cfg) avant tout usage des autres fonctions.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { decrypt, PREFIX } = require('../crypto-config');
const { getIn, setIn, SECRET_PATHS } = require('./helpers');

let _cfg = null;

/** Stocke la référence cfg (partagée avec server.js — mutations visibles des deux côtés). */
function init(cfg) { _cfg = cfg; }

/**
 * Retourne la clé de signature JWT depuis connections.json (cfg.auth.jwt_secret).
 */
function getJwtSecret() {
  return _cfg.auth?.jwt_secret;
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
    const v = getIn(_cfg, p);
    if (!v) continue;
    try {
      setIn(_cfg, p, decrypt(v, key));
    } catch {
      console.warn(`[auth] Impossible de déchiffrer ${p.join('.')} — clé obsolète, re-saisissez la valeur dans l'interface`);
      setIn(_cfg, p, '');
    }
  }
}

/**
 * Initialise le bloc d'authentification au premier démarrage.
 * - Génère un jwt_secret aléatoire (64 octets hex) si absent.
 * - Si aucun password_hash, set setup_completed=false pour que la page de premier
 *   démarrage intercepte et laisse l'utilisateur choisir ses identifiants.
 * - Applique les migrations de clés ajoutées après la v1.0 (token_expiry, issued_after).
 * Sauvegarde via saveConn() uniquement si des modifications ont été faites.
 * @param {Function} saveConn - Fonction de persistance des connexions (fournie par server.js)
 */
async function initAuth(saveConn) {
  let changed = false;
  if (!_cfg.auth) _cfg.auth = { username: '', password_hash: '', jwt_secret: '', token_expiry: '24h', issued_after: 0, setup_completed: false };
  // Générer jwt_secret s'il est absent
  if (!_cfg.auth.jwt_secret) {
    _cfg.auth.jwt_secret = crypto.randomBytes(64).toString('hex');
    changed = true;
  }
  // Premier démarrage : pas encore de compte créé
  if (!_cfg.auth.password_hash && _cfg.auth.setup_completed === undefined) {
    _cfg.auth.setup_completed = false;
    changed = true;
  }
  // Migrations : clés ajoutées après la v1.0
  if (!_cfg.auth.token_expiry)              { _cfg.auth.token_expiry  = '24h'; changed = true; }
  if (_cfg.auth.issued_after === undefined) { _cfg.auth.issued_after  = 0;     changed = true; }
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

/**
 * Enregistre un échec de connexion pour une IP et applique le blocage après 5 tentatives.
 * Après 5 échecs, l'IP est bloquée pendant 15 minutes.
 */
function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count++;
  entry.lastAttempt = Date.now();
  if (entry.count >= 5) entry.blockedUntil = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(ip, entry);
}

// Nettoyage périodique de la Map loginAttempts toutes les 5 minutes (évite les fuites mémoire)
const LOGIN_ATTEMPTS_MAX = 10000; // cap contre attaques distribuées
setInterval(() => {
  const now = Date.now();
  const TTL = 15 * 60 * 1000;
  for (const [ip, entry] of loginAttempts) {
    const expired = entry.blockedUntil ? now > entry.blockedUntil : now - (entry.lastAttempt || 0) > TTL;
    if (expired) loginAttempts.delete(ip);
  }
  // Si la Map est encore trop grande après nettoyage TTL, supprime les entrées les plus anciennes
  if (loginAttempts.size > LOGIN_ATTEMPTS_MAX) {
    const oldest = [...loginAttempts.entries()]
      .sort((a, b) => (a[1].lastAttempt || 0) - (b[1].lastAttempt || 0))
      .slice(0, loginAttempts.size - LOGIN_ATTEMPTS_MAX);
    for (const [ip] of oldest) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

/**
 * Middleware Express qui vérifie l'authentification JWT pour toutes les routes protégées.
 * Accepte le token depuis le cookie httpOnly `seedash_token` (prioritaire)
 * ou depuis l'en-tête `Authorization: Bearer <token>` (compatibilité).
 * Rejette les tokens émis avant le dernier changement de mot de passe (issued_after).
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.seedash_token || req.headers['authorization']?.replace(/^Bearer /, '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    if (decoded.iat < (_cfg.auth.issued_after || 0)) {
      return res.status(401).json({ error: 'Token révoqué' });
    }
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

/**
 * Indique si la configuration initiale (page de premier démarrage) a été complétée.
 * Retourne true pour toutes les installations existantes (setup_completed absent = true).
 */
function isSetupComplete() {
  return _cfg.auth?.setup_completed !== false;
}

module.exports = { init, getJwtSecret, decryptSecrets, initAuth, isSetupComplete, requireAuth, checkBruteForce, resetLoginAttempts, recordFailedLogin };
