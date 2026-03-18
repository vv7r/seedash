# CLAUDE.md — SeeDash

## Architecture

Application Node.js/Express. Pas de framework frontend — vanilla JS/CSS séparés dans `public/`.

- **`server.js`** — Express API, auth JWT, proxy qBittorrent et Ultra.cc, timers serveur
- **`cleaner.js`** — module indépendant, chargé par server.js, gère le timer de nettoyage
- **`crypto-config.js`** — chiffrement AES-256-GCM des secrets sur disque
- **`public/index.html`** — HTML structurel pur (aucun style ni script inline)
- **`public/style.css`** — tout le CSS ; variables dans `:root` / `[data-theme="dark"]`
- **`public/app.js`** — tout le JS frontend ; zéro handler inline, event delegation
- **`public/theme-init.js`** — 3 lignes bloquantes en `<head>` pour restaurer le thème sans flash
- **`config.json`** — config persistante, lue/écrite par le serveur à chaud
- **`ecosystem.config.js`** — config PM2, injecte `JWT_SECRET` comme variable d'env (ne pas committer)

## Commandes

```bash
npm start              # prod
npm run dev            # hot-reload (node --watch)
pm2 reload seedash     # rechargement gracieux en production
```

## Config

Lue au démarrage via `fs.readFileSync`. Sauvegardée en temps réel avec `saveCfg()` à chaque modification via l'API. Relit au moment de chaque `runClean()` dans cleaner.js.

Le bloc `auth` (jwt_secret, password_hash) est généré automatiquement par `initAuth()` au premier démarrage si vide.

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

## Auth

- JWT signé avec la clé résolue par `getJwtSecret()` : `process.env.JWT_SECRET || cfg.auth.jwt_secret`
- `JWT_SECRET` en variable d'env PM2 (`ecosystem.config.js`) — prioritaire sur config.json
- Toutes les routes API sauf `POST /api/login` sont protégées par `requireAuth`
- Brute-force : 5 tentatives max → blocage 15 min par IP (in-memory Map, nettoyée toutes les 5min)
- Mot de passe par défaut `changeme` défini dans `initAuth()` — à changer via l'interface

## Secrets

Chiffrés AES-256-GCM sur disque via `crypto-config.js`. Clé de chiffrement = SHA-256 du JWT secret.
Chemins chiffrés : `c411.apikey`, `qbittorrent.password`, `ultracc_api.token`.
En mémoire (`cfg`), les valeurs restent en clair après `decryptSecrets()`.

## Noms C411 dans les torrents actifs

`nameMap` (hash → nom C411) est persisté dans `logs/namemap.json`. Il est peuplé à chaque grab (manuel ou auto) via l'`infohash` fourni par le frontend.

Dans `GET /api/torrents`, la priorité de résolution du nom est :
1. `nameMap[hash]` — torrents grabbés avec SeeDash
2. `topCache` par infohash — torrents encore dans le top C411 en cache
3. Nom interne qBittorrent — fallback

Les noms des torrents déjà présents dans qBittorrent avant SeeDash restent avec le nom qBittorrent.

## Cache Ultra.cc

`ultraccCache` : TTL 120s pour l'API Ultra.cc total-stats (appelée par `/api/stats` et `/api/connections`). Évite les 429.

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

## Frontend (app.js / index.html)

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
- `selectedGrab` : `Map<url, {name, infohash}>` (pas un Set) pour transmettre l'infohash au grab sélection multiple
- Top leechers : auto-refresh visuel (appel `loadTop()`), le grab réel se fait côté serveur
- Connexions LEDs : `setInterval` toutes les 30s — silencieux si précédent état était OK (pas de flash orange)

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

## Conventions

- Messages d'interface en **français**
- Logs serveur en français (préfixe `[module]`)
- Pas de framework CSS — variables CSS custom dans `:root` / `[data-theme="dark"]`
- `table-layout: auto` + `col-nom { width:99%; max-width:0 }` pour la colonne nom flexible
