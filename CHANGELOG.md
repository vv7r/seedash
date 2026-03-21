# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Format basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versionnement selon [Semantic Versioning](https://semver.org/lang/fr/).

---

## [Non publié]

---

## [1.5.2] - 2026-03-21

### Corrigé
- `top.js` : `fetch()` → `fetchT()` sur `loadTopCache` et `loadTop` (timeout 10s manquant)

### Modifié
- `.gitignore` : ajout `.env` et `.env.local`
- Compteur de tests corrigé (44 → 63) dans README, CONTRIBUTING.md et CLAUDE.md
- Cache Ultra.cc : durée corrigée (120s → 5 min) dans README pour cohérence avec le code

---

## [1.5.1] - 2026-03-21

### Ajouté
- `logs/auto.log` — journal unifié cleaner + grab (remplace `cleaner.log`) ; préfixes `[auto-cleaner]`, `[manuel-cleaner]`, `[auto-grab]`, `[manuel-grab]`

### Modifié
- `grab.js` : toutes les traces écrites dans `auto.log` via `log()` (plus de console.log isolé)
- `'use strict'` ajouté en tête de tous les fichiers frontend
- `doLogout` : catch silencieux remplacé par `console.warn`

### Corrigé
- **XSS** : `he()` appliqué sur le hash dans `actifs.js` et l'URL dans `rules.js` (interpolation innerHTML)

### Sécurité
- **loginAttempts** : cap à 10 000 entrées pour résister aux attaques DDoS distribuées
- **token_expiry** : valeur validée côté serveur contre une liste blanche (1h→168h), fallback `24h`
- **fetch() timeout** : `fetchT()` ajouté dans `utils.js` (AbortController 10s) — tous les appels frontend migrent vers cette fonction

---

## [1.5.0] - 2026-03-21

### Ajouté
- **Card Timer** — cycle automatique unique remplaçant les deux timers indépendants : enchaîne Auto clean puis Auto grab avec un délai de 10s entre les deux
- **Règle `network_max_pct`** — bloque le grab si le trafic mensuel Ultra.cc dépasse N% (condition stricte, interface configurable)
- **Vérification espace disque** — avant le grab, si la taille totale des candidats dépasse l'espace libre Ultra.cc, le grab est annulé silencieusement
- Bouton thème (☀/☽) sur les écrans de setup et de login
- `CONTRIBUTING.md` — guide de contribution (bugs, features, workflow, conventions, architecture, tests)
- Section "Contribuer" dans le README avec lien vers `CONTRIBUTING.md`
- `log_date_format` dans `ecosystem.config.js` pour horodater les logs PM2

### Modifié
- Cards Auto grab et Auto clean : timer supprimé, deviennent toggle + règles + bouton Exécuter uniquement
- Le bouton "Actualiser" (top leechers) ne modifie plus les infos d'horodatage ni le compteur de grabs dans la card Auto grab

---

## [1.4.0] - 2026-03-21

### Ajouté
- **Boutons "Test"** par service (qBittorrent, C411, Ultra.cc) avec toast de retour détaillé (erreur HTTP, timeout, connexion refusée)
- **URL C411 configurable** via l'interface — champ dédié dans Connexions & API, validé côté serveur ; `c411Base` propagé au frontend via `/api/stats`
- **Toasts empilables** — nouveau conteneur dynamique, les toasts s'accumulent en bas à droite sans se remplacer, durée différenciée succès (3,5s) / erreur (7s)

### Corrigé
- Logout : cookie supprimé à `/` et `baseurl+/` pour éviter l'auto-reconnexion en cas de cookie résiduel sans path
- `/api/connections` : retourne un message d'erreur détaillé au lieu de la chaîne générique `'error'`

---

## [1.3.0] - 2026-03-20

### Ajouté
- **Page de premier démarrage** (setup first-run) — création du compte admin (username + password libres) avant tout accès ; auto-login immédiat après setup
- **Tests unitaires** (`node:test` natif) — `cleaner-logic.test.js` (23 tests sur `shouldDelete`) et `grab-logic.test.js` (21 tests sur `filterCandidates`)

### Modifié
- `public/app.js` (~1870L) découpé en 6 modules : `utils.js`, `stats.js`, `charts.js`, `top.js`, `actifs.js`, `rules.js`
- `cleaner.js` déplacé dans `lib/` pour cohérence avec `grab.js` ; `shouldDelete()` exportée comme fonction pure testable
- `jwt_secret` stocké uniquement dans `connections.json` (suppression de la variable d'environnement `JWT_SECRET`)
- `ecosystem.config.js` généré sans `JWT_SECRET` — secrets dissociés de la config PM2
- `connections.json` toujours écrit en `chmod 600`
- `decryptSecrets()` résilient : si une valeur ne peut pas être déchiffrée, elle est mise à `''` et le serveur démarre quand même

---

## [1.2.1] - 2026-03-19

### Corrigé
- **Logique Auto clean** : conditions minimales (`ratio_min`, `age_min_hours`, `upload_min_mb`) évaluées en **ET** — toutes les conditions actives doivent être vraies simultanément pour déclencher une suppression (comportement précédent : OU)
- **Condition `upload_min_mb`** : éligible uniquement si l'historique couvre toute la fenêtre (`upload_window_hours`) — les torrents dont le suivi vient de démarrer ne sont pas éligibles ; suppression du fallback sur l'historique total
- `upload_condition` pré-calculée côté serveur dans `GET /api/torrents` et transmise au frontend ; badge "prêt à supprimer" masqué si l'Auto clean est désactivé

---

## [1.2.0] - 2026-03-18

### Ajouté
- **Manifest PWA** — icône, `theme-color`, `display: standalone` pour installation sur mobile
- Séparation `config.json` (config versionnée) / `connections.json` (secrets chiffrés + auth, ignoré par git)
- Restructuration `auto_grab` / `auto_clean` : deux blocs indépendants dans `config.json` avec leurs règles et états de toggles séparés

### Modifié
- Upgrade dépendances : `bcrypt` → 6.0.0, `axios` → 1.13.6

### Sécurité
- **CSP Helmet** renforcée : `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'` ; `useDefaults: false` pour exclure `upgrade-insecure-requests`
- `Cache-Control: no-store` sur toutes les routes `/api`
- Suppression des styles inline (remplacés par `element.style.width` post-insertion pour respecter la CSP)

---

## [1.1.0] - 2026-03-16

### Modifié
- Séparation complète HTML / CSS / JS : `index.html` structurel pur, tout le style dans `style.css`, logique dans les fichiers JS
- Intégration **Helmet** pour les en-têtes de sécurité HTTP
- Aucun handler inline (`onclick=`, `onchange=`) — event delegation sur conteneurs stables

---

## [1.0.0] - 2026-03-15

### Ajouté
- **Top leechers** — top C411 par leechers, filtrage par catégorie, tri par colonne, grab direct vers qBittorrent
- **Torrents actifs** — suivi ratio/âge/upload en temps réel, courbe d'upload inline, suppression manuelle
- **Stats globales** — torrents actifs, ratio moyen, vitesses DL/UP, espace disque, trafic réseau mensuel Ultra.cc
- **Auto clean** — suppression planifiée selon ratio, âge, upload minimum sur fenêtre glissante
- **Auto grab** — grab automatique périodique avec règles configurables (limite/jour, taille max, actifs max, leechers/seeders min)
- **Historique** — journal grabs et suppressions, suppression individuelle d'entrées
- **LEDs de statut** — indicateurs de connexion C411 / qBittorrent / Ultra.cc
- **Authentification JWT** — login, protection brute-force (5 tentatives → blocage 15 min), changement de mot de passe
- **Secrets chiffrés AES-256-GCM** — API keys et mots de passe chiffrés sur disque
- **Thème clair/sombre** — persisté en localStorage, sans flash au chargement
- **`install.sh`** — installation automatisée pour Ultra.cc (détection port, config Nginx, PM2)

---

[Non publié]: https://github.com/vv7r/seedash/compare/v1.5.2...HEAD
[1.5.2]: https://github.com/vv7r/seedash/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/vv7r/seedash/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/vv7r/seedash/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/vv7r/seedash/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/vv7r/seedash/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/vv7r/seedash/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/vv7r/seedash/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/vv7r/seedash/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/vv7r/seedash/releases/tag/v1.0.0
