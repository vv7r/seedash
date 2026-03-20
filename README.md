# SeeDash

Dashboard Node.js/Express pour gérer une seedbox Ultra.cc : tracker C411 (Torznab) + qBittorrent.

## Fonctionnalités

- **Top leechers** — top des torrents C411 par leechers, filtrage par catégorie, tri par colonne, grab direct vers qBittorrent
- **Torrents actifs** — suivi ratio/âge/upload en temps réel, courbe d'upload, suppression manuelle
- **Stats globales** — torrents actifs, ratio moyen, vitesses DL/UP, espace disque, trafic réseau mensuel
- **Auto clean** — suppression planifiée des torrents selon des règles configurables (ratio, âge, upload minimum)
- **Auto grab** — grab automatique périodique des meilleurs torrents selon des limites configurables
- **Historique** — journal des grabs et suppressions automatiques/manuels, suppression individuelle d'entrées
- **LEDs de statut** — indicateurs de connexion C411 / qBittorrent / Ultra.cc en temps réel
- **Authentification JWT** — login avec protection brute-force, changement de mot de passe
- **Secrets chiffrés** — API keys et mots de passe chiffrés AES-256-GCM sur disque
- **Thème clair/sombre**

---

## APIs externes utilisées

### C411 — API Torznab (RSS/XML)

C411 expose une API compatible **Torznab** (extension du standard RSS/Atom pour les trackers privés).

**Base URL :** `https://c411.org/api/torznab`

| Paramètre | Description |
|-----------|-------------|
| `apikey` | Clé API personnelle C411 |
| `t=caps` | Capacités du tracker (catégories disponibles) |
| `t=search&q=...&limit=N` | Recherche textuelle (ou par infohash) |
| `t=search&cat=2000&limit=N` | Filtrage par catégorie (2000 = Films, 5000 = TV…) |

**Format de réponse :** XML RSS avec attributs `torznab:attr` — le serveur parse avec `fast-xml-parser`.

Champs extraits par SeeDash :
- `item.title` — nom du torrent
- `torznab:attr name="infohash"` — hash SHA1 du torrent
- `torznab:attr name="magneturl"` — lien magnet pour l'ajout dans qBittorrent
- `torznab:attr name="size"` — taille en octets
- `torznab:attr name="seeders"` / `"leechers"` — état du swarm
- `torznab:attr name="category"` — catégorie numérique

> La clé API C411 est stockée chiffrée AES-256-GCM dans `connections.json`.

---

### qBittorrent — WebUI API v2

qBittorrent expose une API REST locale sur `http://127.0.0.1:PORT/api/v2/`.

**Authentification :** cookie de session obtenu via `POST /auth/login` (username + password en form-urlencoded). SeeDash gère automatiquement la session et la reconnexion en cas d'expiration (403).

Endpoints utilisés par SeeDash :

| Endpoint | Usage |
|----------|-------|
| `POST /auth/login` | Authentification, récupération du cookie SID |
| `GET /torrents/info` | Liste complète des torrents (hash, name, size, ratio, state, added_on…) |
| `GET /transfer/info` | Vitesses globales DL/UP |
| `POST /torrents/add` | Ajout d'un torrent par lien magnet (`urls=magnet:...`) |
| `POST /torrents/delete` | Suppression d'un torrent (`hashes=..., deleteFiles=true`) |
| `GET /sync/maindata` | Données de synchronisation (utilisé pour l'historique d'upload) |

> Le mot de passe qBittorrent est stocké chiffré AES-256-GCM dans `connections.json`.

---

### Ultra.cc — REST API total-stats

Ultra.cc expose une API propriétaire pour les statistiques du compte (espace disque, trafic réseau).

**Endpoint :** `GET https://<user>.<host>.usbx.me/ultra-api/total-stats`
**Authentification :** header `Authorization: Bearer <token>`

Champs retournés utilisés par SeeDash :
- `disk_used_bytes` / `disk_quota_bytes` — utilisation disque
- `monthly_upload_bytes` / `monthly_download_bytes` / `monthly_quota_bytes` — trafic mensuel
- `hostname` — nom de l'hôte seedbox

> L'API est mise en cache 120s côté serveur pour éviter les erreurs 429.
> Le token est stocké chiffré AES-256-GCM dans `connections.json`.

---

## Installation sur Ultra.cc depuis zéro

### Prérequis

- Accès SSH à votre seedbox Ultra.cc
- qBittorrent installé et configuré via le panneau Ultra.cc
- Node.js disponible (préinstallé sur Ultra.cc : `node --version`)
- PM2 disponible (`pm2 --version`) — gestionnaire de processus

### 1. Cloner le dépôt

```bash
cd ~
git clone <url-du-repo> seedash
cd seedash
npm install
```

### 2. Choisir un port libre

Ultra.cc fournit un outil pour connaître les ports disponibles :

```bash
app-ports show     # ports déjà utilisés
app-ports free     # suggère un port libre
```

Notez le port choisi (ex : `44962`).

### 3. Configurer `config.json`

`config.json` est inclus dans le dépôt avec des valeurs par défaut. Éditez-le pour renseigner le port choisi et l'URL de base :

```json
{
  "port": 44962,
  "baseurl": "/seedash"
}
```

Les blocs `auto_grab` et `auto_clean` sont déjà présents avec des valeurs par défaut raisonnables — vous pouvez les ajuster avant le premier démarrage ou via l'interface ensuite.

### 4. Premier démarrage pour générer le JWT secret

```bash
node server.js
# Attendez le message "[server] SeeDash en écoute sur le port..."
# Ctrl+C pour arrêter
```

Ce premier lancement génère automatiquement `connections.json` avec :
- `jwt_secret` — clé de signature JWT aléatoire 64 octets
- `password_hash` — hash bcrypt du mot de passe par défaut `changeme`

### 5. Configurer `ecosystem.config.js`

Ouvrez `connections.json` et copiez la valeur de `auth.jwt_secret` :

```bash
cat connections.json | grep jwt_secret
```

Ouvrez `ecosystem.config.js` et collez cette valeur dans `JWT_SECRET` :

```js
module.exports = {
  apps: [{
    name: 'seedash',
    script: 'server.js',
    watch: false,
    env: {
      NODE_ENV: 'production',
      JWT_SECRET: 'COLLER_ICI_LA_VALEUR_DE_jwt_secret'
    }
  }]
};
```

> `ecosystem.config.js` est dans `.gitignore` — ne jamais commiter ce fichier.

### 6. Configurer `connections.json`

Éditez `connections.json` pour renseigner vos identifiants **en clair** — le serveur les chiffre automatiquement au démarrage :

```json
{
  "auth": {
    "username": "admin",
    "password_hash": "...",
    "token_expiry": "24h",
    "issued_after": 0,
    "jwt_secret": "..."
  },
  "c411": {
    "apikey": "VOTRE_CLE_API_C411",
    "url": "https://c411.org/api/torznab"
  },
  "qbittorrent": {
    "url": "http://127.0.0.1:PORT_QBITTORRENT",
    "username": "VOTRE_USER_QBITTORRENT",
    "password": "VOTRE_MOT_DE_PASSE_QBITTORRENT"
  },
  "ultracc_api": {
    "url": "https://USER.HOST.usbx.me/ultra-api/total-stats",
    "token": "VOTRE_TOKEN_ULTRACC"
  }
}
```

- **Port qBittorrent** : visible dans le panneau Ultra.cc → Applications → qBittorrent
- **Clé API C411** : dans votre profil C411 → API Key
- **Token Ultra.cc** : dans le panneau Ultra.cc → API / Token

### 7. Démarrer via PM2

```bash
pm2 start ecosystem.config.js
pm2 save
```

Vérifier que l'application tourne :

```bash
pm2 status
pm2 logs seedash --lines 20 --nostream
```

### 8. Configurer le proxy Nginx

Sur Ultra.cc, le proxy Nginx est géré via le panneau d'administration. Créez un proxy vers :

```
http://127.0.0.1:44962
```

avec le sous-chemin `/seedash` (correspondant à `baseurl` dans `config.json`).

### 9. Changer le mot de passe par défaut

Accédez à l'interface via votre navigateur, connectez-vous avec :
- **Identifiant :** `admin`
- **Mot de passe :** `changeme`

Allez dans l'onglet **Configuration** → section **Sécurité** → changez le mot de passe immédiatement.

### Commandes utiles

```bash
npm test               # tests unitaires (44 tests, runner natif node:test)
pm2 reload seedash     # rechargement gracieux après modification du code
pm2 logs seedash       # logs en temps réel
pm2 flush seedash      # vider les logs
pm2 stop seedash       # arrêt
pm2 delete seedash     # suppression du processus PM2
```

---

## Structure des fichiers de configuration

### `config.json` — configuration générale

```json
{
  "port": 44962,
  "baseurl": "/seedash",
  "auto_grab": {
    "enabled": false,
    "interval_minutes": 60,
    "last_run": "2024-01-01T00:00:00.000Z",
    "last_grab_count": 0,
    "rules": {
      "grab_limit_per_day": 20,
      "size_max_gb": 25,
      "active_max": 15,
      "min_leechers": 10,
      "min_seeders": 2
    },
    "rules_on": {
      "grab_limit_per_day": true,
      "size_max_gb": true,
      "active_max": true,
      "min_leechers": true,
      "min_seeders": true
    }
  },
  "auto_clean": {
    "enabled": false,
    "interval_hours": 6,
    "last_run": null,
    "last_deleted_count": 0,
    "last_run_type": null,
    "rules": {
      "ratio_min": 2,
      "ratio_max": 5,
      "age_min_hours": 168,
      "age_max_hours": 720,
      "upload_min_mb": 500,
      "upload_window_hours": 72
    },
    "rules_on": {
      "ratio_min": true,
      "ratio_max": false,
      "age_min_hours": true,
      "age_max_hours": false,
      "upload_min_mb": true
    }
  }
}
```

**Règles auto_grab :**

| Clé | Description |
|-----|-------------|
| `grab_limit_per_day` | Nombre max de torrents grabbés par jour |
| `size_max_gb` | Taille maximale par torrent (Go) |
| `active_max` | Nombre max de torrents actifs dans qBittorrent |
| `min_leechers` | Nombre minimum de leechers requis |
| `min_seeders` | Nombre minimum de seeders requis |

**Règles auto_clean :**

| Clé | Description |
|-----|-------------|
| `ratio_min` | Ratio minimum atteint avant suppression possible |
| `ratio_max` | Ratio maximum — suppression forcée au-delà (indépendant) |
| `age_min_hours` | Âge minimum (heures depuis `added_on`) avant suppression possible |
| `age_max_hours` | Âge maximum — suppression forcée au-delà (indépendant) |
| `upload_min_mb` | Upload total requis (en Mo) sur la fenêtre `upload_window_hours` |
| `upload_window_hours` | Durée de la fenêtre glissante pour `upload_min_mb` |

**Logique des conditions :**

- `ratio_min`, `age_min_hours` et `upload_min_mb` fonctionnent en **ET** : toutes les conditions actives doivent être vraies simultanément pour déclencher une suppression.
- `ratio_max` et `age_max_hours` sont des seuils **indépendants** (OU) : ils forcent la suppression dès qu'ils sont atteints, quelle que soit l'état des autres conditions.
- La condition `upload_min_mb` exige que l'historique d'upload couvre effectivement toute la fenêtre (premier point enregistré antérieur à `now - upload_window_hours`). Les torrents dont le suivi a démarré récemment ne sont pas éligibles tant que cette couverture n'est pas atteinte.

### `connections.json` — secrets et connexions

Généré automatiquement au premier démarrage. Les champs `apikey`, `username`, `password` et `token` sont chiffrés AES-256-GCM automatiquement par le serveur (préfixe `enc:`).

```json
{
  "auth": {
    "username": "admin",
    "password_hash": "$2b$12$...",
    "token_expiry": "24h",
    "issued_after": 0,
    "jwt_secret": "..."
  },
  "c411": {
    "apikey": "enc:...",
    "url": "https://c411.org/api/torznab"
  },
  "qbittorrent": {
    "url": "http://127.0.0.1:PORT",
    "username": "enc:...",
    "password": "enc:..."
  },
  "ultracc_api": {
    "url": "https://USER.HOST.usbx.me/ultra-api/total-stats",
    "token": "enc:..."
  }
}
```

> `connections.json` est dans `.gitignore` — ne jamais committer ce fichier (contient les secrets chiffrés et le JWT secret).

---

## API

Toutes les routes (sauf `/api/login`) nécessitent un header `Authorization: Bearer <token>` ou un cookie `token`.

### Authentification

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/api/login` | `{username, password}` → `{token}` JWT |
| `POST` | `/api/logout` | Invalide le cookie de session |
| `POST` | `/api/change-password` | `{current, newPassword}` → change le mot de passe |

### Stats et monitoring

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/stats` | Stats globales : qBittorrent + Ultra.cc (disque, trafic, vitesses) |
| `GET` | `/api/connections` | Statut des connexions C411 / qBittorrent / Ultra.cc (LEDs) |

### Top leechers C411

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/top-leechers?n=20&cat=2000` | Top leechers (fetch C411 + mise en cache disque) |
| `GET` | `/api/top-leechers/cache` | Dernier résultat en cache sans nouveau fetch |

Paramètres `GET /api/top-leechers` :

| Paramètre | Défaut | Description |
|-----------|--------|-------------|
| `n` | `20` | Nombre de résultats |
| `cat` | _(toutes)_ | Catégorie Torznab (ex : `2000`=Films, `5000`=TV) |

### Torrents actifs

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/torrents` | Liste des torrents actifs qBittorrent avec résolution nom C411 |
| `POST` | `/api/grab` | Ajoute un torrent `{url, name, infohash}` (magnet → qBittorrent) |
| `DELETE` | `/api/torrents/:hash` | Supprime un torrent et ses fichiers |
| `GET` | `/api/upload-history/:hash` | Historique d'upload (points de données) pour un torrent |

### Torrents grabbés

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/grabbed-torrents` | Liste des torrents grabbés via SeeDash (namemap) |
| `DELETE` | `/api/grabbed-torrents` | `{hash}` — retire un torrent du namemap |

### Règles de configuration

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/rules` | Lit les règles auto_grab + auto_clean avec état des toggles |
| `POST` | `/api/rules` | Sauvegarde `{valeurs..., _on: {clé: bool}}` |

Format retourné par `GET /api/rules` :
```json
{
  "grab_limit_per_day": 20,
  "size_max_gb": 25,
  "active_max": 15,
  "min_leechers": 10,
  "min_seeders": 2,
  "ratio_min": 2,
  "ratio_max": 5,
  "age_min_hours": 168,
  "age_max_hours": 720,
  "upload_min_mb": 500,
  "upload_window_hours": 72,
  "_on": {
    "grab_limit_per_day": true,
    "size_max_gb": true,
    ...
  }
}
```

### Auto clean

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/cleaner/status` | Statut : activé, dernier run, prochain run estimé |
| `POST` | `/api/cleaner/run` | Déclenche un nettoyage immédiat |
| `POST` | `/api/cleaner/schedule` | `{interval_hours, enabled}` — configure le timer |

### Auto grab

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/auto-grab/status` | Statut : activé, dernier run, dernier count |
| `POST` | `/api/auto-grab/run` | Déclenche un grab immédiat |
| `POST` | `/api/auto-grab/config` | `{enabled, interval_minutes}` — configure le timer |
| `GET` | `/api/auto-refresh` | Alias lecture `auto_grab` (compatibilité) |
| `POST` | `/api/auto-refresh` | Alias écriture `auto_grab` (compatibilité) |

### Historique

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/history` | Historique des actions (500 entrées max, ordre décroissant) |
| `DELETE` | `/api/history` | `{date}` (ISO string) — supprime une entrée |

### Secrets / connexions

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/config/secrets` | Valeurs masquées des secrets (lecture seule) |
| `POST` | `/api/config/secrets` | Met à jour les connexions (chiffrement automatique) |

---

## Structure des fichiers

```
seedash/
├── server.js              — API Express, auth JWT, timers auto-grab, routes
├── cleaner.js             — logique de nettoyage + timer setInterval
├── resolve-meta.js        — script autonome : résout les noms/catégories C411 manquants (node resolve-meta.js)
├── crypto-config.js       — chiffrement/déchiffrement AES-256-GCM
├── ecosystem.config.js    — config PM2 avec JWT_SECRET (ne pas committer)
├── config.json            — config générale : port, baseurl, auto_grab, auto_clean (versionné)
├── connections.json       — secrets chiffrés : auth, c411, qbittorrent, ultracc_api (ignoré git)
├── package.json
├── .gitignore
├── lib/
│   ├── auth.js            — auth JWT, brute-force, middleware requireAuth
│   ├── qbit.js            — client qBittorrent (login, request, session)
│   ├── ultracc.js         — client Ultra.cc (stats, cache TTL 120s)
│   ├── grab.js            — auto-grab (cycle, timer, filterCandidates)
│   └── helpers.js         — helpers purs (getIn, setIn, maskSecret, isHttpUrl)
├── public/
│   ├── index.html         — HTML structurel pur (aucun style ni script inline)
│   ├── style.css          — tout le CSS (variables CSS, layout, composants, thème sombre)
│   ├── theme-init.js      — restauration du thème sombre avant rendu (évite le flash)
│   ├── utils.js           — helpers purs : he(), fmt*(), toast, CAT_NAMES, BASE
│   ├── stats.js           — LEDs de connexion, loadStats, updateQbitStats
│   ├── charts.js          — graphiques Chart.js (ratio, upload, modal)
│   ├── top.js             — top leechers, tri, sélection, auto-refresh
│   ├── actifs.js          — torrents actifs, badge suppression, insertChartRow
│   ├── rules.js           — règles, cleaner, historique, secrets
│   └── app.js             — globals partagés, auth, tabs, event listeners, init
├── tests/
│   ├── cleaner-logic.test.js — 23 tests shouldDelete (toutes branches logiques)
│   └── grab-logic.test.js    — 21 tests filterCandidates (filtres, tri, limites)
└── logs/                  — créé automatiquement au démarrage
    ├── history.json        — historique grabs/suppressions (500 entrées max)
    ├── top-cache.json      — cache du dernier top leechers C411
    ├── namemap.json        — correspondance hash qBittorrent → nom C411
    ├── categorymap.json    — correspondance hash qBittorrent → catégorie C411
    ├── upload-history.json — courbe d'upload par torrent (points horodatés)
    └── cleaner.log         — journal du cleaner automatique
```

---

## Sécurité

- **JWT** signé avec une clé 64 octets générée aléatoirement au premier démarrage
- **Brute-force** : 5 tentatives de login max → blocage IP 15 minutes
- **AES-256-GCM** : tous les secrets (API keys, mots de passe) chiffrés sur disque avec la clé dérivée du JWT secret
- **Helmet CSP** : `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`
- **Cache-Control: no-store** sur toutes les routes `/api`
- **SSRF** : validation de l'URL du lien magnet avant envoi à qBittorrent
- **NODE_ENV=production** injecté par PM2

> Le JWT secret est la clé maître de l'application : il signe les tokens d'authentification ET dérive la clé de chiffrement AES des secrets. En cas de perte ou de rotation du secret, tous les tokens existants sont invalidés et les champs chiffrés dans `connections.json` doivent être re-saisis.

---

## Licence

[![CC BY-NC-SA 4.0](https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

Ce projet est distribué sous licence **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**.

Vous êtes libre de partager et d'adapter ce projet, sous les conditions suivantes :
- **Attribution** — vous devez créditer l'auteur et indiquer les modifications effectuées
- **NonCommercial** — vous ne pouvez pas utiliser ce projet à des fins commerciales
- **ShareAlike** — toute version modifiée doit être distribuée sous la même licence

Texte complet : [creativecommons.org/licenses/by-nc-sa/4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
