# SeeDash

> [!WARNING]
> Cette application a été développée intégralement avec **Claude Code** (IA générative).
> Elle peut contenir des **bugs** et des **failles de sécurité** non détectés.
> Ne l'exposez pas sur Internet sans audit préalable et utilisez-la à vos propres risques.

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
- `item.guid` — infohash SHA1 (identique à `torznab:attr name="infohash"`)
- `enclosure url` — URL de téléchargement du `.torrent` (`/api?t=get&id={hash}&apikey={key}`)
- `torznab:attr name="infohash"` — hash SHA1 du torrent
- `torznab:attr name="size"` — taille en octets
- `torznab:attr name="seeders"` — nombre de seeders
- `torznab:attr name="peers"` — seeders + leechers (les leechers sont calculés : `peers - seeders`)
- `torznab:attr name="category"` — catégorie numérique
- `torznab:attr name="downloadvolumefactor"` — `0` = freeleech (le téléchargement ne compte pas dans le ratio)

> L'API C411 ne fournit pas de `magneturl`. SeeDash passe l'URL `enclosure` directement à qBittorrent via `POST /torrents/add`.

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

**Récupérer le token (via SSH) :**

Le token est généré lors de l'installation du script Ultra API. Pour l'installer ou afficher un token existant :

```bash
bash <(wget -qO- https://scripts.ultra.cc/util-v2/Ultra-API/main.sh)
# → choisir l'option 4 pour afficher le token existant
```

L'URL à renseigner dans SeeDash suit ce format :
```
https://<user>.<host>.usbx.me/ultra-api/total-stats
```
où `<user>` et `<host>` sont visibles dans votre panneau Ultra.cc ou via `hostname -f` en SSH.

---

## Installation sur Ultra.cc depuis zéro

### Prérequis

- Accès SSH à votre seedbox Ultra.cc ([doc](https://docs.ultra.cc/connection-details/ssh))
- qBittorrent installé via le panneau Ultra.cc ([doc](https://docs.ultra.cc/applications/qbittorrent) — `https://cp.ultra.cc` → Applications → qBittorrent)
- Node.js installé sur votre seedbox — via le [script officieux Ultra.cc](https://docs.ultra.cc/unofficial-language-installers/install-nodejs) : `bash <(wget -qO- https://scripts.ultra.cc/util-v2/LanguageInstaller/Node-Installer/main.sh)` (puis reconnexion SSH)
- PM2 disponible — si absent : `npm install -g pm2`

### Installation automatique (recommandée)

```bash
cd ~
git clone https://github.com/vv7r/seedash seedash
cd seedash
bash install.sh
```

Le script `install.sh` prend en charge automatiquement :
- Détection d'un port libre (`app-ports free`)
- Installation des dépendances npm
- Démarrage via PM2
- Détection et enregistrement des connexions :
  - qBittorrent (port + identifiant depuis `~/.config/qBittorrent/qBittorrent.conf`)
  - Ultra.cc API (URL depuis `hostname -f`, token depuis la base SQLite du script Ultra API — installé automatiquement si absent)

Seule interaction requise :
- **Base URL** (Entrée = `/seedash`)

Le proxy Nginx (`~/.config/nginx/proxy.d/`) est configuré et rechargé automatiquement via `app-nginx reload`.

Une fois le script terminé, ouvrez l'URL publique affichée dans le terminal pour créer votre compte (page de premier démarrage), puis renseignez le **mot de passe qBittorrent** et la **clé API C411** dans **Configuration → Connexions & API**.

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

## Tests

Les tests couvrent les deux fonctions pures critiques de l'application — celles qui décident quoi supprimer et quoi grabber. Elles sont isolées de toute I/O et de tout état global, ce qui les rend fiables et rapides à exécuter.

```bash
npm test
```

Le runner est **node:test** (intégré à Node.js, aucune dépendance externe).

### `tests/cleaner-logic.test.js` — 23 tests

Teste `shouldDelete(torrent, rules, rulesOn, uploadHistory, now)` de `lib/cleaner.js`.

Ce que les tests vérifient :
- Les conditions minimales fonctionnent en **ET** : ratio + âge + upload doivent tous être atteints simultanément (si actifs)
- Les seuils maximaux (`ratio_max`, `age_max_hours`) fonctionnent en **OU** indépendant et forcent la suppression dès dépassement
- Si aucune condition minimale n'est active, rien n'est supprimé
- La condition `upload_min_mb` exige que l'historique couvre toute la fenêtre (torrent trop récent → non éligible)
- Les toggles `rules_on` activent/désactivent correctement chaque règle individuellement

### `tests/grab-logic.test.js` — 21 tests

Teste `filterCandidates(items, existingHashes, rules, rulesOn, canGrab)` de `lib/grab.js`.

Ce que les tests vérifient :
- Les torrents déjà présents dans qBittorrent sont exclus (filtre par infohash)
- Les filtres de taille (`size_max_gb`), leechers (`min_leechers`) et seeders (`min_seeders`) excluent correctement
- La limite journalière (`grab_limit_per_day`) et le plafond de torrents actifs (`active_max`) sont respectés
- Le tri final est par leechers décroissants
- `canGrab` limite le nombre de résultats retournés

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

Généré automatiquement au premier démarrage. Les champs `apikey`, `username`, `password` et `token` sont chiffrés AES-256-GCM automatiquement par le serveur (préfixe `enc:`). Toujours écrit avec les permissions `600` (lecture/écriture propriétaire uniquement).

```json
{
  "auth": {
    "username": "votre_pseudo",
    "password_hash": "$2b$12$...",
    "token_expiry": "24h",
    "issued_after": 0,
    "jwt_secret": "...",
    "setup_completed": true
  },
  "c411": { "apikey": "enc:...", "url": "https://c411.org/api/torznab" },
  "qbittorrent": { "url": "http://...", "username": "enc:...", "password": "enc:..." },
  "ultracc_api": { "url": "https://...", "token": "enc:..." }
}
```

> `connections.json` est dans `.gitignore` — ne jamais committer ce fichier.
> Le `jwt_secret` est la clé maître : il signe les tokens JWT ET dérive la clé AES de chiffrement. En cas de rotation, les tokens existants sont invalidés et les secrets chiffrés doivent être re-saisis via l'interface.

---

## API

Toutes les routes (sauf `/api/login` et `/api/setup`) nécessitent un header `Authorization: Bearer <token>` ou un cookie httpOnly `seedash_token`.

### Authentification

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/setup/status` | `{ setupComplete: bool }` — détecte le premier démarrage |
| `POST` | `/api/setup` | `{username, password}` → crée le compte + génère `ecosystem.config.js` |
| `POST` | `/api/login` | `{username, password}` → cookie JWT httpOnly |
| `POST` | `/api/logout` | Invalide le cookie de session |
| `POST` | `/api/change-password` | `{current_password, new_password}` → change le mot de passe |

### Stats et monitoring

| Méthode | Route | Description |
|---------|-------|-------------|
| `GET` | `/api/stats` | Stats globales : qBittorrent + Ultra.cc (disque, trafic, vitesses) + `c411_base` (URL de base C411 dérivée de la config) |
| `GET` | `/api/connections` | Statut des connexions : `'ok'` ou message d'erreur détaillé (`'HTTP 403'`, `'Connexion refusée'`, `'Timeout'`…) pour chaque service |

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
| `GET` | `/api/config/secrets` | Valeurs masquées des secrets + `c411_url`, `qbit_url`, `qbit_username`, `ultracc_url` en clair |
| `POST` | `/api/config/secrets` | Met à jour les connexions — champs acceptés : `c411_url`, `c411_apikey`, `qbit_url`, `qbit_username`, `qbit_password`, `ultracc_url`, `ultracc_token` |

---

## Structure des fichiers

```
seedash/
├── server.js              — API Express, auth JWT, timers auto-grab, routes
├── resolve-meta.js        — script autonome : résout les noms/catégories C411 manquants (node resolve-meta.js)
├── crypto-config.js       — chiffrement/déchiffrement AES-256-GCM
├── ecosystem.config.js    — config PM2 minimaliste (généré au premier démarrage, ne pas committer)
├── config.json            — config générale : port, baseurl, auto_grab, auto_clean (versionné)
├── connections.json       — secrets chiffrés : auth, c411, qbittorrent, ultracc_api (ignoré git)
├── package.json
├── .gitignore
├── lib/
│   ├── auth.js            — auth JWT, brute-force, middleware requireAuth
│   ├── cleaner.js         — logique de nettoyage + timer setInterval
│   ├── grab.js            — auto-grab (cycle, timer, filterCandidates)
│   ├── qbit.js            — client qBittorrent (login, request, session)
│   ├── ultracc.js         — client Ultra.cc (stats, cache TTL 120s)
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

- **Premier démarrage** : page de setup obligatoire (username + password choisis librement), pas de mot de passe par défaut
- **JWT** signé avec `jwt_secret` (64 octets, généré aléatoirement, stocké uniquement dans `connections.json`)
- **Brute-force** : 5 tentatives de login max → blocage IP 15 minutes
- **AES-256-GCM** : tous les secrets (API keys, mots de passe) chiffrés sur disque — clé dérivée du JWT secret via SHA-256
- **`connections.json` chmod 600** — toujours écrit avec permissions restrictives (lecture propriétaire uniquement)
- **Helmet CSP** : `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`
- **Cache-Control: no-store** sur toutes les routes `/api`
- **SSRF** : validation de l'URL du lien magnet avant envoi à qBittorrent

---

## Contribuer

Les contributions sont les bienvenues. Consultez le [Guide de contribution](CONTRIBUTING.md) pour les conventions de code, le workflow de Pull Request et les règles de signalement de bugs.

L'historique des versions est disponible dans le [Changelog](CHANGELOG.md).

---

## Licence

[![CC BY-NC-SA 4.0](https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

Ce projet est distribué sous licence **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**.

Vous êtes libre de partager et d'adapter ce projet, sous les conditions suivantes :
- **Attribution** — vous devez créditer l'auteur et indiquer les modifications effectuées
- **NonCommercial** — vous ne pouvez pas utiliser ce projet à des fins commerciales
- **ShareAlike** — toute version modifiée doit être distribuée sous la même licence

Texte complet : [creativecommons.org/licenses/by-nc-sa/4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
