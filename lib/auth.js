/**
 * auth.js — Authentification JWT, chiffrement des secrets, protection brute-force.
 * Appeler init(cfg) avant tout usage des autres fonctions.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const { decrypt, PREFIX } = require('../crypto-config');
const { getIn, setIn, SECRET_PATHS } = require('./helpers');

let _cfg = null;

/** Stocke la référence cfg (partagée avec server.js — mutations visibles des deux côtés). */
function init(cfg) { _cfg = cfg; }

/**
 * Résout la clé de signature JWT.
 * Priorité : variable d'environnement JWT_SECRET (PM2) > cfg.auth.jwt_secret (connections.json).
 */
function getJwtSecret() {
  return process.env.JWT_SECRET || _cfg.auth?.jwt_secret;
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
    if (v) setIn(_cfg, p, decrypt(v, key));
  }
}

/**
 * Initialise le bloc d'authentification au premier démarrage.
 * - Génère un jwt_secret aléatoire (64 octets hex) si absent et si JWT_SECRET n'est pas en env.
 * - Hache le mot de passe par défaut 'changeme' (bcrypt, coût 12) si aucun hash existant.
 * - Applique les migrations de clés ajoutées après la v1.0 (token_expiry, issued_after).
 * Sauvegarde via saveConn() uniquement si des modifications ont été faites.
 * @param {Function} saveConn - Fonction de persistance des connexions (fournie par server.js)
 */
async function initAuth(saveConn) {
  let changed = false;
  if (!_cfg.auth) _cfg.auth = { username: 'admin', password_hash: '', jwt_secret: '', token_expiry: '24h', issued_after: 0 };
  // Générer jwt_secret uniquement si pas de variable d'env et pas déjà présent
  if (!process.env.JWT_SECRET && !_cfg.auth.jwt_secret) {
    _cfg.auth.jwt_secret = crypto.randomBytes(64).toString('hex');
    changed = true;
  }
  if (!_cfg.auth.password_hash) {
    _cfg.auth.password_hash = await bcrypt.hash('changeme', 12);
    changed = true;
    console.log('⚠️  MOT DE PASSE PAR DÉFAUT : changeme — changez-le dans l\'interface');
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
setInterval(() => {
  const now = Date.now();
  const TTL = 15 * 60 * 1000;
  for (const [ip, entry] of loginAttempts) {
    const expired = entry.blockedUntil ? now > entry.blockedUntil : now - (entry.lastAttempt || 0) > TTL;
    if (expired) loginAttempts.delete(ip);
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

module.exports = { init, getJwtSecret, decryptSecrets, initAuth, requireAuth, checkBruteForce, resetLoginAttempts, recordFailedLogin };
