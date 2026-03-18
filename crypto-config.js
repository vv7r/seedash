'use strict';

/**
 * Module de chiffrement symétrique AES-256-GCM pour protéger les secrets sur disque.
 * Chaque secret chiffré est préfixé par "enc:" pour distinguer les valeurs chiffrées
 * des valeurs en clair (permettant une migration progressive et un déchiffrement idempotent).
 *
 * Structure d'un secret chiffré (après décodage base64) :
 *   [ IV (16 octets) | Auth Tag (16 octets) | Données chiffrées ]
 *
 * La clé de chiffrement est dérivée du JWT secret via SHA-256 (32 octets → compatible AES-256).
 */

const crypto = require('crypto');
const ALGO   = 'aes-256-gcm';
const PREFIX = 'enc:';

/**
 * Dérive une clé AES-256 de 32 octets depuis une chaîne secrète via SHA-256.
 * @param {string} secret - Secret source (JWT secret ou équivalent).
 * @returns {Buffer} Clé de 32 octets prête pour createCipheriv/createDecipheriv.
 */
function getKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Chiffre une valeur en clair avec AES-256-GCM et retourne une chaîne préfixée "enc:".
 * Un IV aléatoire de 16 octets est généré à chaque appel pour garantir l'unicité des chiffrés.
 * Le tag d'authentification (GCM) est inclus dans la sortie pour détecter toute altération.
 * @param {string} value  - Valeur en clair à chiffrer.
 * @param {string} secret - Secret utilisé pour dériver la clé (doit être le même à la décryption).
 * @returns {string} Chaîne au format "enc:<base64(iv + tag + ciphertext)>".
 */
function encrypt(value, secret) {
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, getKey(secret), iv);
  const enc    = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  // Concaténation IV + tag + données chiffrées → encodage base64 unique
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Déchiffre une valeur produite par encrypt(). Retourne la valeur telle quelle
 * si elle n'est pas préfixée par "enc:" (valeur déjà en clair ou non migrée).
 * @param {string} value  - Valeur potentiellement chiffrée (avec ou sans préfixe "enc:").
 * @param {string} secret - Secret utilisé pour dériver la clé (doit correspondre à celui d'encrypt).
 * @returns {string} Valeur déchiffrée en clair, ou la valeur originale si non chiffrée.
 */
function decrypt(value, secret) {
  // Retourne immédiatement si la valeur n'est pas chiffrée (idempotence)
  if (!value?.startsWith(PREFIX)) return value;
  const buf      = Buffer.from(value.slice(PREFIX.length), 'base64');
  // Extraction des composants : buf[0..15] = IV, buf[16..31] = tag GCM, buf[32..] = données
  const decipher = crypto.createDecipheriv(ALGO, getKey(secret), buf.slice(0, 16));
  decipher.setAuthTag(buf.slice(16, 32));
  return decipher.update(buf.slice(32)) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt, PREFIX };
