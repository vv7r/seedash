# CLAUDE.md — SeeDash

## Architecture

Application Node.js/Express. Pas de framework frontend — vanilla JS/CSS séparés dans `public/`.

### Serveur (`lib/`)

- **`server.js`** — Express API, wiring des modules, timers auto-grab, routes
- **`lib/cleaner.js`** — timer de nettoyage, exporte `shouldDelete()` (fonction pure testable)
- **`lib/auth.js`** — auth JWT, brute-force, middleware `requireAuth`, `decryptSecrets`
- **`lib/qbit.js`** — client qBittorrent (login, request, gestion session 403)
- **`lib/ultracc.js`** — client Ultra.cc (stats, cache TTL 5 min)
- **`lib/grab.js`** — auto-grab (cycle, timer, exporte `filterCandidates()` testable)
- **`lib/helpers.js`** — helpers purs (`getIn`, `setIn`, `maskSecret`, `isHttpUrl`)
- **`crypto-config.js`** — chiffrement AES-256-GCM des secrets sur disque
- **`config.json`** — config persistante, lue/écrite par le serveur à chaud (versionné dans git)
- **`connections.json`** — secrets chiffrés + bloc auth (jwt_secret, password_hash) — ignoré par git, toujours écrit en `chmod 600`
- **`ecosystem.config.js`** — config PM2 minimaliste (nom du process + script), sans JWT_SECRET — ignoré par git
- **`install.sh`** — script d'installation automatisé pour Ultra.cc : détecte le port libre, configure config.json, démarre PM2, écrit les connexions qBittorrent/Ultra.cc directement dans connections.json via crypto-config.js, configure le proxy Nginx via `app-nginx reload`

### Frontend (`public/`) — ordre de chargement

- **`theme-init.js`** — 3 lignes bloquantes en `<head>` pour restaurer le thème sans flash
- **`utils.js`** — helpers purs : `he`, `fmt*`, `toast`, `showMsg`, `BASE`, `CAT_NAMES`, `c411Base`
- **`stats.js`** — LEDs de connexion, `loadConnections`, `updateQbitStats`, `loadStats`
- **`charts.js`** — Chart.js : ratio chart, upload chart inline, modal agrandissement
- **`top.js`** — top leechers, tri, sélection, auto-refresh countdown, `triggerAutoGrab`
- **`actifs.js`** — torrents actifs, badge "prêt à supprimer", `insertChartRow`
- **`rules.js`** — règles auto-grab/clean, historique, secrets, countdown cleaner
- **`app.js`** — globals partagés, auth, tabs, event listeners, `startPolling`, init
- **`index.html`** — HTML structurel pur (aucun style ni script inline)
- **`style.css`** — tout le CSS ; variables dans `:root` / `[data-theme="dark"]`

### Tests

- **`tests/cleaner-logic.test.js`** — 23 tests sur `shouldDelete` (toutes les branches logiques)
- **`tests/grab-logic.test.js`** — 21 tests sur `filterCandidates` (filtres, tri, limites)

## Commandes

```bash
npm start              # prod
npm run dev            # hot-reload (node --watch)
npm test               # tests unitaires (node:test natif, 63 tests)
pm2 reload seedash     # rechargement gracieux en production
```

## Config

Lue au démarrage via `fs.readFileSync`. Sauvegardée en temps réel avec `saveCfg()` à chaque modification via l'API. Relit au moment de chaque `runClean()` dans cleaner.js.

Le bloc `auth` (jwt_secret, password_hash) vit dans `connections.json` et est généré automatiquement par `initAuth()` au premier démarrage si absent.

### Modèle `cfg.rules` / `cfg.rules_on`

Les règles utilisent deux objets séparés pour découpler valeur et état :

- `cfg.rules` — valeurs numériques, **toujours stockées** même quand la règle est désactivée
- `cfg.rules_on` — map `{ clé: bool }`, absent = actif par défaut

Ce modèle permet de modifier la valeur sans perdre l'état du toggle, et inversement.
`GET /api/rules` retourne `{ ...cfg.rules, _on: cfg.rules_on }`.
`POST /api/rules` accepte `{ valeurs..., _on: { clé: bool... } }`.

### Noms des règles de nettoyage

- `age_min_hours` / `age_max_hours` — basées sur `t.added_on` (date d'ajout), **pas** `t.seeding_time`
- `ratio_min` / `ratio_max` — ratio upload/download

### Logique des conditions auto clean

Les conditions minimales fonctionnent en **ET** : toutes les règles actives (`ratio_min`, `age_min_hours`, `upload_min_mb`) doivent être vraies simultanément. Si aucune n'est active, rien n'est supprimé.

Les seuils maximaux (`ratio_max`, `age_max_hours`) sont **indépendants** (OU) : ils forcent la suppression dès qu'ils sont atteints.

#### Condition `upload_min_mb`

- Échantillons collectés toutes les 5 minutes dans `logs/upload-history.json` (`[timestamp_s, cumul_bytes]` par hash)
- La fenêtre est **stricte** : l'historique doit couvrir toute la durée — `points[0][0] <= now - upload_window_hours`
- Si l'historique ne couvre pas encore la fenêtre (torrent ancien dont le suivi a démarré récemment, ou torrent trop jeune), la condition est considérée non éligible (`false`) — pas de suppression
- Exige ≥ 2 points dans la fenêtre pour calculer le delta ; pas de fallback sur l'historique total

#### `DEFAULT_GRAB_RULES_ON` / `DEFAULT_CLEAN_RULES_ON` dans `initConfig()`

Ces constantes définissent l'état initial des toggles côté serveur, **aligné sur les `defOn` du frontend** (`RULE_DEFS` dans `app.js`). Ne pas les modifier sans mettre à jour les deux côtés simultanément — un désalignement provoque des règles silencieusement ignorées.

## Auth

- JWT signé avec `cfg.auth.jwt_secret` (source unique : `connections.json`)
- `ecosystem.config.js` — config PM2 minimaliste (nom du process + script), sans JWT_SECRET
- Toutes les routes API sauf `POST /api/login` et `GET|POST /api/setup` sont protégées par `requireAuth`
- Brute-force : 5 tentatives max → blocage 15 min par IP (in-memory Map, nettoyée toutes les 5min)
- Premier démarrage : page setup affichée si `cfg.auth.setup_completed === false` (username + password librement choisis, 1–32 chars alphanum pour le pseudo, 8–72 chars pour le mot de passe)

## Secrets

Chiffrés AES-256-GCM sur disque via `crypto-config.js`. Clé de chiffrement = SHA-256 du JWT secret.
Chemins chiffrés dans `connections.json` : `c411.apikey`, `qbittorrent.username`, `qbittorrent.password`, `ultracc_api.token`.
`c411.url` n'est pas chiffré (URL publique) — modifiable via l'interface **Configuration → Connexions & API** comme les autres connexions.
En mémoire (`cfg`), les valeurs restent en clair après `decryptSecrets()`.
`decryptSecrets()` est résilient : si une valeur ne peut pas être déchiffrée (clé changée), elle est mise à `''` avec un warning — le serveur démarre quand même et l'utilisateur re-saisit la valeur via l'interface.
En cas de rotation du JWT secret, tous les tokens existants sont invalidés et les champs chiffrés dans `connections.json` doivent être re-saisis.

## Noms C411 dans les torrents actifs

`nameMap` (hash → nom C411) est persisté dans `logs/namemap.json`. Il est peuplé à chaque grab (manuel ou auto) via l'`infohash` fourni par le frontend.

Dans `GET /api/torrents`, la priorité de résolution du nom est :
1. `nameMap[hash]` — torrents grabbés avec SeeDash
2. `topCache` par infohash — torrents encore dans le top C411 en cache
3. Nom interne qBittorrent — fallback

Les noms des torrents déjà présents dans qBittorrent avant SeeDash restent avec le nom qBittorrent.

## Cache Ultra.cc

`ultraccCache` : cache frais 5 min (300s), cooldown 60s entre tentatives — pour l'API Ultra.cc total-stats (appelée par `/api/stats` et `/api/connections`). Évite les 429.

## Résilience des sources externes

`/api/stats` et `runAutoGrab()` traitent chaque source (qBittorrent, C411, Ultra.cc) dans un try/catch indépendant. L'échec d'une source ne bloque pas les autres :
- `/api/stats` : qBit down → stats DL/UP/ratio à 0, disque/trafic Ultra.cc toujours retournés
- `runAutoGrab()` : qBit down → return 0 immédiat ; C411 down → return 0 après avoir vérifié qBit

## Timers serveur

Deux timers `setInterval` tournent côté serveur (indépendants du navigateur) :

- **Cleaner** (`cleaner.js`) : vérifie toutes les **minutes** si `interval_hours` est écoulé depuis `last_run`
- **Auto-grab** (`server.js`) : vérifie toutes les **minutes** si `interval_minutes` est écoulé depuis `last_run`

Ce mécanisme (elapsed-time check) permet des intervalles arbitraires sans dépendre d'une lib cron.
`scheduleAutoGrab()` recrée le timer à chaque modification de `POST /api/auto-refresh`.

## Validation des règles

Validation croisée serveur + client avant sauvegarde :

- `ratio_max > ratio_min` si les deux sont actifs
- `age_max_hours > age_min_hours` si les deux sont actifs
- Valeurs forcées > 0

Côté client (`autoFixRules()`) : corrige automatiquement la valeur invalide et affiche un toast explicatif avant de sauvegarder.

## Toast

`toast(msg, type)` crée dynamiquement un élément dans `#toast-container` (fixed, bas-droite). Les toasts s'empilent : le nouveau apparaît en bas, les anciens montent. Chaque toast disparaît après 3,5s (`success`) ou 7s (`error`) avec fondu CSS. `type` accepte `'success'` (vert) ou `'error'` (rouge).

## Frontend

### Historique — suppression d'entrées

`DELETE /api/history` prend `{ date }` (ISO string, identifiant unique de l'entrée) dans le body.
Côté client, la `date` est encodée en base64 dans l'attribut `data-date` pour éviter tout caractère spécial.

### Sécurité — ne jamais interpoler dans innerHTML sans `he()`

```js
he(valeur)  // échappe &, <, >, ", '
```

**Aucun handler inline** (`onclick=`, `onchange=`, etc.) — bloqués par la CSP `script-src 'self'`.
Pattern event delegation à suivre pour les éléments dynamiques :
- Éléments dynamiques : `data-action="..."` + `data-*` pour les paramètres, délégation sur le conteneur stable
- Torrents actifs : `torrentDataMap` (hash → nom), `data-hash` dans les boutons, délégation sur `#actifs-body`
- Top leechers : `topItems[]`, `data-idx` dans les boutons/checkboxes, délégation sur `#top-body`
- Historique : `data-date` (base64) dans le bouton suppr, `data-sort` sur les `<th>`, délégation sur `#history-content`

### Rafraîchissement

- Stats globales : `setInterval` toutes les 5s — démarré après auth
- Disque/trafic : `setInterval` toutes les 60s — démarré après auth
- Torrents actifs : `setInterval` toutes les 5s — uniquement quand l'onglet est actif (`switchTab`)
- `selectedGrab` : `Map<url, {name, infohash, category}>` (pas un Set) pour transmettre l'infohash et la catégorie au grab sélection multiple
- Top leechers : auto-refresh visuel (appel `loadTop()`), le grab réel se fait côté serveur
- Connexions LEDs : `setInterval` toutes les 30s — silencieux si précédent état était OK (pas de flash orange)

### Badge "prêt à supprimer" (torrents actifs)

`actifsCalc(t, ratioMin, seedMin, ratioOn, ageOn, uploadOn)` calcule `canDel` en miroir de `cleaner.js` :
- `canDel = cleanerEnabled && anyOn && ratioOk && timeOk && uploadMet` — logique ET sur les conditions actives
- `cleanerEnabled` : variable module-level mise à jour par `loadCleanerStatus()` — le badge n'apparaît jamais si l'auto clean est désactivé
- `upload_condition` (booléen) est calculé côté serveur dans `GET /api/torrents` et transmis avec chaque torrent ; l'historique d'upload n'est pas accessible côté client

### DOM — deux modes de mise à jour (loadActifs)

1. **Rebuild complet** si la liste de hashs change (torrent ajouté/supprimé)
2. **Mise à jour incrémentale** (`actifsUpdateRow`) si même liste → évite le flicker

### Top leechers — tri côté client

`topSort = { col, dir }` + `sortedTopItems(items)` trient les données en mémoire.
`sortTopBy(col)` inverse la direction si même colonne, sinon tri décroissant (alphabétique pour `name`).
Le tri est appliqué dans `renderTopItems` avant génération du HTML.

### Helmet / CSP

CSP active avec `useDefaults: false` (exclut `upgrade-insecure-requests` qui cassait le chargement CSS en HTTP) :
- `script-src 'self'` — bloque tout script inline et `eval()`
- `style-src 'self'` — pas de styles inline ; les largeurs dynamiques (barre ratio) sont appliquées via `element.style.width` après insertion
- `connect-src 'self'` — fetch() limité à la même origine
- `frame-ancestors 'none'` — pas d'embedding en iframe

## Versionnement & CHANGELOG

Le projet suit [Semantic Versioning](https://semver.org/lang/fr/) et [Keep a Changelog 1.1.0](https://keepachangelog.com/fr/1.1.0/).

### Règles de version

- **Bug fix** → incrémenter le patch : `1.5.0` → `1.5.1`
- **Nouvelle fonctionnalité** → incrémenter le minor : `1.5.0` → `1.6.0`
- **Changement breaking** → incrémenter le major : `1.5.0` → `2.0.0`

### Process à chaque release

1. Déplacer les entrées de `## [Non publié]` vers une nouvelle section `## [X.Y.Z] - YYYY-MM-DD`
2. Remettre une section `## [Non publié]` vide en haut
3. Mettre à jour `package.json` → `"version": "X.Y.Z"`
4. Ajouter le lien de comparaison en bas du fichier :
   ```
   [X.Y.Z]: https://github.com/vv7r/seedash/compare/vA.B.C...vX.Y.Z
   ```
5. Mettre à jour le lien `[Non publié]` :
   ```
   [Non publié]: https://github.com/vv7r/seedash/compare/vX.Y.Z...HEAD
   ```
6. Créer le tag git : `git tag vX.Y.Z && git push origin --tags`

### Sections autorisées dans CHANGELOG

`### Ajouté` · `### Modifié` · `### Déprécié` · `### Supprimé` · `### Corrigé` · `### Sécurité`

### Format des entrées

- Séparateur date : tiret simple ` - ` (pas tiret cadratin `—`)
- Date : format ISO `YYYY-MM-DD`

## Conventions

- Messages d'interface en **français**
- Logs serveur en français (préfixe `[module]`)
- Pas de framework CSS — variables CSS custom dans `:root` / `[data-theme="dark"]`
- `table-layout: auto` + `col-nom { width:99%; max-width:0 }` pour la colonne nom flexible
- Tous les `fetch()` frontend passent par `fetchT()` (`utils.js`) — AbortController 10s intégré
- Tout fichier JS frontend commence par `'use strict';`
