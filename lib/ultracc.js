/**
 * ultracc.js — Client Ultra.cc avec cache TTL.
 * Appeler init(cfg) avant tout usage des autres fonctions.
 */

const axios = require('axios');

let _cfg = null;
let ultraccCache = { data: null, lastFetch: 0 };

/** Stocke la référence cfg (partagée avec server.js — mutations visibles des deux côtés). */
function init(cfg) { _cfg = cfg; }

/**
 * Invalide le cache Ultra.cc.
 * À appeler quand l'URL ou le token changent (POST /api/config/secrets).
 */
function invalidateCache() { ultraccCache = { data: null, lastFetch: 0 }; }

/**
 * Retourne les statistiques Ultra.cc (disque, trafic) avec mise en cache pour éviter les 429.
 * Stratégie de cache à deux niveaux :
 *  - Cache frais (< 5 minutes) : retour immédiat sans requête réseau
 *  - Essai récent (< 60 secondes) : retourne les données périmées si disponibles, sinon erreur
 *  - Sinon : déclenche une nouvelle requête vers l'API Ultra.cc
 * L'horodatage du dernier essai est mis à jour avant la requête pour éviter les appels concurrents.
 */
async function getUltraccStats() {
  const now = Date.now();
  const age = now - ultraccCache.lastFetch;
  // Cache frais → retour immédiat
  if (ultraccCache.data && age < 300000) return ultraccCache.data;
  // Essai récent (succès ou échec) → pas de retry avant 60s pour éviter les 429
  if (age < 60000) {
    if (ultraccCache.data) return ultraccCache.data;
    throw new Error('Ultra.cc indisponible (anti-429)');
  }
  // Marquer l'essai AVANT la requête → bloque les appels concurrents en cas d'erreur
  ultraccCache.lastFetch = now;
  const r = await axios.get(_cfg.ultracc_api.url, {
    headers: { Authorization: `Bearer ${_cfg.ultracc_api.token}` },
    timeout: 15000
  });
  ultraccCache.data = r.data.service_stats_info;
  return ultraccCache.data;
}

module.exports = { init, getUltraccStats, invalidateCache };
