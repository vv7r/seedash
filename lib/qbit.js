/**
 * qbit.js — Client qBittorrent v2.
 * Appeler init(cfg) avant tout usage des autres fonctions.
 */

const axios = require('axios');

let _cfg = null;
let qbitCookie = null;

/** Stocke la référence cfg (partagée avec server.js — mutations visibles des deux côtés). */
function init(cfg) { _cfg = cfg; }

/**
 * Invalide le cookie de session qBittorrent.
 * À appeler quand les credentials changent (POST /api/config/secrets).
 */
function clearCookie() { qbitCookie = null; }

/**
 * Ouvre une session qBittorrent et stocke le cookie de session dans `qbitCookie`.
 * Utilise l'authentification form-urlencoded attendue par l'API qBittorrent v2.
 * @returns {string} Le cookie de session (format "SID=...") extrait de l'en-tête Set-Cookie
 */
async function qbitLogin() {
  const r = await axios.post(
    `${_cfg.qbittorrent.url}/api/v2/auth/login`,
    `username=${encodeURIComponent(_cfg.qbittorrent.username)}&password=${encodeURIComponent(_cfg.qbittorrent.password)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  qbitCookie = r.headers['set-cookie']?.[0]?.split(';')[0];
  return qbitCookie;
}

/**
 * Exécute une requête vers l'API qBittorrent v2 avec gestion automatique de session.
 * Se connecte si aucun cookie n'est disponible.
 * En cas d'erreur 403 (session expirée), effectue un re-login unique et retente la requête.
 * @param {string} method   - Méthode HTTP ('get' ou 'post')
 * @param {string} endpoint - Chemin API après '/api/v2' (ex: '/torrents/info')
 * @param {string|null} data - Corps de la requête POST (form-urlencoded) ou null
 */
async function qbitRequest(method, endpoint, data = null) {
  if (!qbitCookie) await qbitLogin();
  const opts = {
    method,
    url: `${_cfg.qbittorrent.url}/api/v2${endpoint}`,
    data,
    timeout: 10000,
    headers: {
      Cookie: qbitCookie,
      ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    }
  };
  try {
    return (await axios(opts)).data;
  } catch (e) {
    // Session expirée → re-login une fois
    if (e.response?.status === 403) {
      await qbitLogin();
      opts.headers.Cookie = qbitCookie;
      return (await axios(opts)).data;
    }
    throw e;
  }
}

module.exports = { init, qbitRequest, clearCookie };
