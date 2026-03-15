# SeeDash

Dashboard Node.js/Express pour gérer une seedbox Ultra.cc : tracker C411 (Torznab) + qBittorrent.

## Fonctionnalités

- **Top leechers** — top des torrents C411 par leechers, filtrage par catégorie, grab direct vers qBittorrent
- **Torrents actifs** — suivi ratio/seedtime en temps réel, suppression manuelle ou automatique
- **Stats globales** — torrents actifs, ratio moyen, vitesses DL/UP, espace disque, trafic réseau
- **Cleaner automatique** — suppression planifiée (cron) des torrents ayant atteint les règles
- **Authentification JWT** — login avec protection brute-force, changement de mot de passe
- **Thème clair/sombre**

## Installation

```bash
git clone <repo> seedash && cd seedash
npm install
cp config.example.json config.json   # éditer les valeurs
npm start
# dev avec hot-reload :
npm run dev
```

## Configuration (`config.json`)

```json
{
  "port": 44962,
  "baseurl": "/seedash",
  "c411": {
    "apikey": "...",
    "url": "https://c411.org/api/torznab"
  },
  "qbittorrent": {
    "url": "http://127.0.0.1:PORT",
    "username": "...",
    "password": "..."
  },
  "ultracc_api": {
    "url": "https://USER.HOST.usbx.me/ultra-api/total-stats",
    "token": "..."
  },
  "rules": {
    "ratio_min": 1.5,
    "seedtime_min_hours": 48,
    "grab_limit_per_day": 20,
    "size_max_gb": 100,
    "active_max": 15
  },
  "cleaner": {
    "enabled": false,
    "cron_schedule": "0 * * * *"
  },
  "auto_refresh": {
    "enabled": true,
    "interval_minutes": 15
  }
}
```

> `auth` (jwt_secret, password_hash) est généré automatiquement au premier démarrage.
> Mot de passe par défaut : **changeme**
> ⚠️ À changer immédiatement dans l'interface (onglet Configuration) avant toute mise en production.

## Déploiement Ultra.cc (pm2)

```bash
# 1. Choisir un port libre
app-ports free

# 2. Mettre à jour config.json avec le port

# 3. Démarrer avec pm2
pm2 start server.js --name seedash
pm2 save

# 4. Configurer Nginx (proxy_pass vers le port choisi)
# 5. Recharger après modification de code
pm2 reload seedash
```

## API (toutes les routes nécessitent un Bearer token JWT)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/login` | Authentification → token JWT |
| POST | `/api/change-password` | Changer le mot de passe |
| GET | `/api/stats` | Stats globales (qBit + Ultra.cc) |
| GET | `/api/top-leechers?n=20&cat=2000` | Top leechers C411 par catégorie |
| GET | `/api/torrents` | Torrents actifs qBittorrent |
| POST | `/api/grab` | Ajouter un torrent `{url, name}` |
| DELETE | `/api/torrents/:hash` | Supprimer un torrent |
| GET | `/api/rules` | Lire la configuration |
| POST | `/api/rules` | Sauvegarder la configuration |
| GET | `/api/cleaner/status` | Statut du cleaner |
| POST | `/api/cleaner/run` | Lancer le nettoyage immédiatement |
| POST | `/api/cleaner/schedule` | Mettre à jour le planning cron |
| GET | `/api/auto-refresh` | Config auto-refresh |
| POST | `/api/auto-refresh` | Mettre à jour l'auto-refresh |

## Structure

```
seedash/
├── server.js        — API Express + auth JWT
├── cleaner.js       — logique de nettoyage + cron
├── config.json      — configuration (ne pas committer avec les secrets)
├── public/
│   └── index.html   — frontend SPA (vanilla JS)
└── logs/
    └── cleaner.log  — journal du cleaner
```
