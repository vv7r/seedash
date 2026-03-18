'use strict';
/**
 * resolve-meta.js — Script autonome de résolution des métadonnées manquantes.
 * Pour chaque torrent actif dans qBittorrent dont le nom C411 ou la catégorie
 * est absent de namemap.json / categorymap.json, ce script interroge l'API C411
 * via une série de requêtes de recherche progressivement moins précises.
 * Les résultats sont persistés dans logs/namemap.json et logs/categorymap.json.
 * Usage : node resolve-meta.js
 */

const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');
const { XMLParser } = require('fast-xml-parser');
const { decrypt } = require('./crypto-config');

const CFG_PATH     = path.join(__dirname, 'config.json');
const CONN_PATH    = path.join(__dirname, 'connections.json');
const NAMEMAP_PATH = path.join(__dirname, 'logs', 'namemap.json');
const CATMAP_PATH  = path.join(__dirname, 'logs', 'categorymap.json');

const cfg = {
  ...JSON.parse(fs.readFileSync(CFG_PATH)),
  ...(() => { try { return JSON.parse(fs.readFileSync(CONN_PATH)); } catch { return {}; } })(),
};
let key = process.env.JWT_SECRET;
if (!key) {
  try { key = require('./ecosystem.config.js').apps[0].env.JWT_SECRET; } catch {}
}
if (!key) key = cfg.auth?.jwt_secret;
if (key) {
  if (cfg.qbittorrent?.username) cfg.qbittorrent.username = decrypt(cfg.qbittorrent.username, key);
  if (cfg.qbittorrent?.password) cfg.qbittorrent.password = decrypt(cfg.qbittorrent.password, key);
  if (cfg.c411?.apikey)          cfg.c411.apikey          = decrypt(cfg.c411.apikey, key);
}

let nameMap    = {};
let categoryMap = {};
try { nameMap     = JSON.parse(fs.readFileSync(NAMEMAP_PATH)); }  catch {}
try { categoryMap = JSON.parse(fs.readFileSync(CATMAP_PATH));  }  catch {}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function saveJson(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

let qbitCookie = null;
/**
 * Authentifie le script auprès de l'API qBittorrent et stocke le cookie de session.
 * Les en-têtes Origin et Referer sont requis par certaines configurations de qBittorrent
 * pour valider la provenance de la requête de login.
 * @throws {Error} Si le serveur ne retourne pas de cookie (login refusé ou IP bloquée).
 */
async function qbitLogin() {
  const origin = cfg.qbittorrent.url;
  const r = await axios.post(
    `${origin}/api/v2/auth/login`,
    `username=${encodeURIComponent(cfg.qbittorrent.username)}&password=${encodeURIComponent(cfg.qbittorrent.password)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': origin, 'Referer': origin + '/' }, timeout: 10000 }
  );
  qbitCookie = r.headers['set-cookie']?.[0]?.split(';')[0];
  if (!qbitCookie) throw new Error(`Login échoué (réponse : ${r.data})`);
}

/**
 * Effectue une requête GET vers l'API qBittorrent avec gestion automatique de la session.
 * En cas de 403 (session expirée), se reconnecte et réessaie l'appel une seule fois.
 * @param {string} endpoint - Chemin de l'endpoint (ex : '/torrents/info').
 * @returns {Promise<*>} Données JSON retournées par l'API.
 * @throws {Error} Si la requête échoue après la tentative de reconnexion.
 */
async function qbitGet(endpoint) {
  if (!qbitCookie) await qbitLogin();
  try {
    const r = await axios.get(`${cfg.qbittorrent.url}/api/v2${endpoint}`, {
      headers: { Cookie: qbitCookie, 'Referer': cfg.qbittorrent.url + '/' }, timeout: 10000
    });
    return r.data;
  } catch(e) {
    if (e.response?.status === 403) { await qbitLogin(); return qbitGet(endpoint); }
    throw e;
  }
}

/**
 * Interroge l'API Torznab de C411 avec une requête texte et retourne les items RSS parsés.
 * L'API peut retourner un objet unique (1 résultat) ou un tableau — les deux cas sont normalisés
 * en tableau pour simplifier le traitement en aval.
 * @param {string} query - Terme de recherche (infohash, titre complet ou mots-clés).
 * @returns {Promise<object[]>} Tableau d'items Torznab (peut être vide si aucun résultat).
 */
async function c411Search(query) {
  const r = await axios.get(cfg.c411.url, {
    params: { apikey: cfg.c411.apikey, t: 'search', q: query, limit: 200 },
    timeout: 10000
  });
  const parsed = xmlParser.parse(r.data);
  const raw    = parsed?.rss?.channel?.item;
  if (!raw) return [];
  // L'API retourne un objet seul si 1 résultat, un tableau sinon — on normalise en tableau
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Extrait les champs utiles (infohash, nom, catégorie) d'un item Torznab brut.
 * Les attributs Torznab sont stockés dans "torznab:attr" sous forme de tableau ou d'objet unique ;
 * [].concat() normalise les deux cas. La catégorie peut être dans les attrs ou dans item.category
 * (format RSS standard), la priorité est donnée aux attrs Torznab.
 * @param {object} item - Item brut issu du parsing XML de la réponse C411.
 * @returns {{ infohash: string, name: string, category: string|null }}
 */
function extractItem(item) {
  const attrs = [].concat(item['torznab:attr'] || []);
  const attr  = name => attrs.find(a => a['@_name'] === name)?.['@_value'];
  const cat   = attr('category') ?? (Array.isArray(item.category) ? item.category[0] : item.category) ?? null;
  return { infohash: (attr('infohash') || '').toLowerCase(), name: item.title || '', category: cat };
}

/**
 * Tente de résoudre le nom C411 et/ou la catégorie d'un torrent qBittorrent.
 * Envoie jusqu'à 6 requêtes à C411 dans l'ordre décroissant de précision :
 *   1. Infohash exact (identifiant unique — la plus fiable)
 *   2. Titre nettoyé complet
 *   3. 4 mots significatifs
 *   4. 3 mots significatifs
 *   5. 2 mots significatifs
 *   6. Premier mot significatif (fallback large)
 * S'arrête dès qu'une correspondance par infohash est trouvée dans les résultats.
 * @param {object} t - Objet torrent qBittorrent (doit avoir .hash et .name).
 * @returns {Promise<boolean>} true si au moins un champ a été résolu, false sinon.
 */
async function resolve(t) {
  const hash     = t.hash.toLowerCase();
  const needName = !nameMap[hash];
  const needCat  = !categoryMap[hash];
  if (!needName && !needCat) return false;

  // Nettoyage du titre qBittorrent : suppression de l'extension, des points, de l'année
  // et des tags techniques (résolution, source, saison…) pour extraire le titre pur.
  const base = t.name.replace(/\.(mkv|avi|mp4|m4v|ts|iso)$/i, '').replace(/\./g, ' ');
  const titleClean = base
    .replace(/\b(19\d{2}|20\d{2})\b.*/, '')
    .replace(/\b(1080p|2160p|720p|4K|UHD|BluRay|WEB|HDTV|MULTI|MULTi|COMPLETE|S\d{2}|REMUX|Hybrid)\b.*/i, '')
    .replace(/[-.()\s]+$/, '').trim();
  const words = titleClean.split(/\s+/);
  // Mots vides (articles, prépositions) filtrés pour ne garder que les mots porteurs de sens
  const stopWords = new Set(['the','a','an','la','le','les','de','du','des','un','une']);
  const sigWords = words.filter(w => !stopWords.has(w.toLowerCase()));
  // Tableau de requêtes ordonné du plus précis au plus large, doublons et chaînes courtes exclus
  const queries = [
    hash,                           // 1. Recherche par infohash exact
    titleClean,                     // 2. Titre complet nettoyé
    sigWords.slice(0, 4).join(' '), // 3. 4 mots significatifs
    sigWords.slice(0, 3).join(' '), // 4. 3 mots significatifs
    sigWords.slice(0, 2).join(' '), // 5. 2 mots significatifs
    sigWords[0] || words[0],        // 6. Premier mot (fallback large)
  ].filter((q, i, a) => q && q.length >= 2 && a.indexOf(q) === i); // dédoublonnage et longueur min

  for (const query of queries) {
    try {
      const results = await c411Search(query);
      for (const item of results) {
        const { infohash, name, category } = extractItem(item);
        if (infohash !== hash) continue;
        let changed = false;
        if (needName && name) {
          nameMap[hash] = name;
          console.log(`  [nom]      ${hash.substring(0, 8)}… → ${name}`);
          changed = true;
        }
        if (needCat && category != null) {
          categoryMap[hash] = String(category);
          console.log(`  [catégorie] ${hash.substring(0, 8)}… → ${category}`);
          changed = true;
        }
        if (changed) return true;
      }
    } catch (e) {
      console.log(`  [erreur] requête "${query}" : ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

/**
 * Point d'entrée du script : récupère la liste des torrents actifs depuis qBittorrent,
 * filtre ceux dont le nom C411 ou la catégorie est manquant, et appelle resolve() sur chacun.
 * Un délai de 600 ms entre chaque torrent évite de surcharger l'API C411.
 * Sauvegarde les maps mises à jour uniquement si au moins un torrent a été résolu.
 */
async function main() {
  console.log('=== resolve-meta.js ===');
  const torrents = await qbitGet('/torrents/info');
  console.log(`${torrents.length} torrent(s) actif(s)`);

  const toResolve = torrents.filter(t => {
    const h = t.hash.toLowerCase();
    return !nameMap[h] || !categoryMap[h];
  });

  if (!toResolve.length) {
    console.log('Rien à résoudre — tous les noms et catégories sont déjà connus.');
    return;
  }

  console.log(`${toResolve.length} torrent(s) à résoudre (nom ou catégorie manquant)\n`);
  let resolved = 0;

  for (const t of toResolve) {
    const hash = t.hash.toLowerCase();
    // Affiche les champs manquants (ex: "[nom+cat]") avant la tentative de résolution
    const misses = [!nameMap[hash] && 'nom', !categoryMap[hash] && 'cat'].filter(Boolean).join('+');
    process.stdout.write(`[${misses}] ${t.name.substring(0, 60)} … `);
    const ok = await resolve(t);
    console.log(ok ? 'OK' : 'non trouvé');
    if (ok) resolved++;
    // Pause entre les torrents pour ne pas déclencher de rate-limiting côté C411
    await new Promise(r => setTimeout(r, 600));
  }

  if (resolved > 0) {
    saveJson(NAMEMAP_PATH, nameMap);
    saveJson(CATMAP_PATH, categoryMap);
    console.log(`\n${resolved}/${toResolve.length} résolu(s) — fichiers sauvegardés.`);
  } else {
    console.log(`\nAucun nouveau résultat.`);
  }
}

main().catch(e => { console.error('Erreur fatale :', e.message); process.exit(1); });
