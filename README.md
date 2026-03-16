# SeeDash

Dashboard Node.js/Express pour gérer une seedbox Ultra.cc : tracker C411 (Torznab) + qBittorrent.

## Fonctionnalités

- **Top leechers** — top des torrents C411 par leechers, filtrage par catégorie, tri par colonne, grab direct vers qBittorrent
- **Torrents actifs** — suivi ratio/âge en temps réel, suppression manuelle
- **Stats globales** — torrents actifs, ratio moyen, vitesses DL/UP, espace disque, trafic réseau
- **Auto clean** — suppression planifiée des torrents selon des règles configurables (ratio, âge)
- **Auto grab** — grab automatique périodique des meilleurs torrents selon des limites configurables
- **Historique** — journal des grabs et suppressions automatiques/manuels, suppression individuelle d'entrées
- **LEDs de statut** — indicateurs de connexion C411 / qBittorrent / Ultra.cc en temps réel
- **Authentification JWT** — login avec protection brute-force, changement de mot de passe
- **Secrets chiffrés** — API keys et mots de passe chiffrés AES-256-GCM sur disque
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
    "age_min_hours": 48,
    "grab_limit_per_day": 20,
    "size_max_gb": 100
  },
  "cleaner": {
    "enabled": false,
    "interval_hours": 1
  },
  "auto_refresh": {
    "enabled": false,
    "interval_minutes": 15
  }
}
```

> `auth` (jwt_secret, password_hash) est généré automatiquement au premier démarrage.
> Mot de passe par défaut : **changeme**
> ⚠️ À changer immédiatement dans l'interface (onglet Configuration) avant toute mise en production.

> `rules_on` est géré automatiquement par l'interface pour persister l'état des toggles.
> Les secrets (apikey, password, token) sont chiffrés AES-256-GCM par le serveur.

## Déploiement Ultra.cc (pm2)

```bash
# 1. Choisir un port libre
app-ports free

# 2. Mettre à jour config.json avec le port

# 3. Premier démarrage pour générer jwt_secret dans config.json
npm start   # puis Ctrl+C une fois démarré

# 4. Copier la valeur de jwt_secret depuis config.json
# 5. Ouvrir ecosystem.config.js et renseigner cette valeur dans JWT_SECRET
# 6. Supprimer jwt_secret de config.json (recommandé)

# 7. Démarrer via PM2 (injecte JWT_SECRET comme variable d'env)
pm2 delete seedash 2>/dev/null; pm2 start ecosystem.config.js
pm2 save

# 8. Configurer Nginx (proxy_pass vers le port choisi)
# 9. Recharger après modification de code
pm2 reload seedash
```

> ⚠️ `ecosystem.config.js` contient le secret JWT — **ne jamais commiter ce fichier** (déjà dans `.gitignore`)

## API (toutes les routes nécessitent un Bearer token JWT)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/login` | Authentification → token JWT |
| POST | `/api/change-password` | Changer le mot de passe |
| GET | `/api/stats` | Stats globales (qBit + Ultra.cc) |
| GET | `/api/connections` | Statut des connexions C411 / qBit / Ultra.cc |
| GET | `/api/top-leechers?n=20&cat=2000` | Top leechers C411 (avec mise en cache) |
| GET | `/api/top-leechers/cache` | Dernier résultat en cache sans refetch |
| GET | `/api/torrents` | Torrents actifs qBittorrent |
| POST | `/api/grab` | Ajouter un torrent `{url, name, infohash}` |
| DELETE | `/api/torrents/:hash` | Supprimer un torrent |
| GET | `/api/rules` | Lire règles + état toggles |
| POST | `/api/rules` | Sauvegarder règles `{valeurs, _on: {clé: bool}}` |
| GET | `/api/cleaner/status` | Statut du cleaner |
| POST | `/api/cleaner/run` | Lancer le nettoyage immédiatement |
| POST | `/api/cleaner/schedule` | Mettre à jour `{interval_hours, enabled}` |
| GET | `/api/auto-grab/status` | Statut de l'auto-grab |
| POST | `/api/auto-grab/run` | Déclencher un grab immédiat |
| POST | `/api/auto-grab/config` | Activer/désactiver l'auto-grab |
| GET | `/api/auto-refresh` | Config auto-refresh |
| POST | `/api/auto-refresh` | Mettre à jour `{enabled, interval_minutes}` |
| GET | `/api/history` | Historique des actions (500 entrées max) |
| DELETE | `/api/history` | Supprimer une entrée `{date}` (ISO string) |
| GET | `/api/config/secrets` | Lire les secrets (valeurs masquées) |
| POST | `/api/config/secrets` | Mettre à jour les connexions |

## Structure

```
seedash/
├── server.js            — API Express + auth JWT + timers auto-grab
├── cleaner.js           — logique de nettoyage + timer setInterval
├── crypto-config.js     — chiffrement AES-256-GCM des secrets
├── ecosystem.config.js  — config PM2 avec JWT_SECRET (ne pas committer)
├── config.json          — configuration (ne pas committer avec les secrets)
├── public/
│   ├── index.html       — HTML structurel pur (aucun style ni script inline)
│   ├── style.css        — tout le CSS (variables, layout, composants, thème)
│   ├── app.js           — tout le JS frontend (event delegation, zéro handler inline)
│   └── theme-init.js    — restauration du thème sombre avant rendu (évite le flash)
└── logs/
    ├── cleaner.log      — journal du cleaner
    ├── history.json     — historique grabs/suppressions
    ├── top-cache.json   — cache du dernier top leechers
    └── namemap.json     — correspondance hash qBittorrent → nom C411
```
