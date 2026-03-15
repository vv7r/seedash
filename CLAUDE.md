# CLAUDE.md — SeeDash

## Architecture

Application Node.js/Express monofichier. Pas de framework frontend — vanilla JS dans `public/index.html`.

- **`server.js`** — Express API, auth JWT, proxy qBittorrent et Ultra.cc
- **`cleaner.js`** — module indépendant, chargé par server.js, gère le cron de nettoyage
- **`public/index.html`** — SPA complète : CSS + HTML + JS dans un seul fichier
- **`config.json`** — config persistante, lue/écrite par le serveur à chaud

## Commandes

```bash
npm start              # prod
npm run dev            # hot-reload (node --watch)
pm2 reload seedash     # rechargement gracieux en production
~/.nvm/versions/node/v24.14.0/bin/pm2 reload seedash  # si pm2 pas dans PATH
```

## Config

Lue au démarrage via `fs.readFileSync`. Sauvegardée en temps réel avec `saveCfg()` à chaque modification via l'API. Relit au moment de chaque `runClean()` dans cleaner.js.

Le bloc `auth` (jwt_secret, password_hash) est généré automatiquement par `initAuth()` au premier démarrage si vide.

## Auth

- JWT signé avec `cfg.auth.jwt_secret` (généré aléatoirement, persisté dans config.json)
- Toutes les routes API sauf `POST /api/login` sont protégées par `requireAuth`
- Brute-force : 5 tentatives max → blocage 15 min par IP (in-memory Map, reset au redémarrage)
- Mot de passe par défaut défini dans `initAuth()` — à changer via l'interface

## Cache Ultra.cc

`ultraccCache` : TTL 60s pour l'API Ultra.cc total-stats (appelée par `/api/stats` et `/api/cleaner/status`). Évite les 429.

## Frontend (index.html)

### Sécurité — ne jamais interpoler dans innerHTML sans `he()`

```js
he(valeur)  // échappe &, <, >, ", '
```

Les `onclick` inline ne doivent **jamais** contenir de données non fiables (noms de torrents, URLs). Pattern à suivre :
- Torrents actifs : stocker dans `torrentDataMap` (hash → nom), passer uniquement le hash (hex safe) dans onclick
- Top leechers : stocker dans `topItems[]`, passer uniquement l'index numérique dans onclick

### Rafraîchissement

- Stats globales : `setInterval` toutes les 5s — démarré après auth
- Disque/trafic : `setInterval` toutes les 60s — démarré après auth
- Torrents actifs : `setInterval` toutes les 5s — uniquement quand l'onglet est actif (`switchTab`)
- Top leechers : auto-refresh configurable (minutes), géré par `autoRefreshInterval`

### DOM — deux modes de mise à jour (loadActifs)

1. **Rebuild complet** si la liste de hashs change (torrent ajouté/supprimé)
2. **Mise à jour incrémentale** (`actifsUpdateRow`) si même liste → évite le flicker

### Helmet

CSP désactivée (`contentSecurityPolicy: false`) car tout le JS est inline. Les autres protections Helmet restent actives.

## Conventions

- Messages d'interface en **français**
- Logs serveur en français (préfixe `[module]`)
- Pas de framework CSS — variables CSS custom dans `:root` / `[data-theme="dark"]`
- `table-layout: auto` + `col-nom { width:99%; max-width:0 }` pour la colonne nom flexible
