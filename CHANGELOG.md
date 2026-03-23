# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Format basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versionnement selon [Semantic Versioning](https://semver.org/lang/fr/).

---

## [Non publié]

---

## [1.6.1] - 2026-03-23

### Modifié
- `style.css` : modal graphique adaptée au mode paysage mobile — `max-height: 90vh`, padding safe-area pour Dynamic Island, brush réduit à 35px
- `charts.js` : canvas modal réduit à 200px en paysage (au lieu de 360px) ; re-dessin automatique lors d'un changement d'orientation
- `style.css` : padding historique réduit sur mobile (6px au lieu de 12px) pour éviter le débordement à droite

### Corrigé
- `charts.js` : label « 23h 59min » affiché au lieu de « 24h » — seuil arrondi à ≥ 23h 55min
- `style.css` : modal graphique dépassait l'écran en mobile portrait — ajout `max-height: 90vh` + `overflow-y: auto`
- `style.css` : tableau historique coupé à droite sur mobile — ajout `overflow-x: auto` sur le conteneur
- `style.css` : bouton agrandir le graphique masqué sur mobile — suppression de la règle `pointer: coarse`

### Sécurité
- `server.js` : `POST /api/change-password` — ajout limite max 72 caractères (aligné sur setup, requis par bcrypt)
- `server.js` : `POST /api/grab` — validation du champ `name` (type string, trim, max 1024 caractères)
- `server.js` : `POST /api/config/secrets` — validation longueur max sur clés API, tokens et credentials
- `server.js` : `POST /api/setup` — ajout brute-force guard (même mécanisme que login)

---

## [1.6.0] - 2026-03-23

### Ajouté
- **Option suppression des fichiers sur le disque** — checkbox dans la modale de suppression manuelle (torrents actifs) et toggle global dans les réglages Auto clean ; `deleteFiles` transmis à qBittorrent selon le choix utilisateur
- **Persistance de l'historique d'upload** — les données de courbe d'upload sont conservées après suppression manuelle ou auto-clean (cap : 8640 points/hash ≈ 30 jours, 500 hashes max)
- **Timeline brush** — sélection interactive de la plage temporelle sur les graphiques (remplace les boutons 1h/6h/24h/48h/7j/30j), drag des poignées, pan, double-clic/clic droit pour réinitialiser
- **Graphique dans l'historique** — bouton SVG sur chaque entrée pour ouvrir la courbe d'upload d'un torrent supprimé
- **Raison de suppression dans les logs** — auto-clean affiche la raison dans `auto.log` (ex : `ratio_max (≥2.0)`, `ratio≥1.0 + âge≥48h`)
- **Infos enrichies dans les logs de grab** — taille, leechers et seeders affichés pour chaque torrent grabé (ex : `4.2 GB, 45L/3S`)
- **Date dans l'infobulle des graphiques** — affiche `JJ/MM HH:MM` sur deux lignes au lieu de `HH:MM` seul
- **Footer GitHub** — lien discret vers le dépôt en bas de l'application
- **Variables CSS pour les graphiques** — 18 variables custom (chart + brush) dans `:root` et `[data-theme="dark"]`

### Modifié
- `charts.js` : couleurs des graphiques lues depuis les variables CSS au lieu de ternaires `isDark` en dur
- `charts.js` : timestamps d'échantillonnage upload arrondis au multiple de 5 minutes
- `actifs.js` / `rules.js` : flèches de tri unifiées sur tous les tableaux (système CSS `::after` avec `↕ ↑ ↓`)
- `style.css` : `font-size: 12px` sur `.cell-seedtime`, `.cell-dl`, `.cell-up` ciblé sur `td` uniquement (ne s'applique plus aux `th`)
- `lib/cleaner.js` : nouvelle fonction `deleteReason()` — retourne la raison de suppression pour le log
- `lib/cleaner.js` : client qBittorrent dédupliqué — utilise `lib/qbit.js` via injection au lieu d'un client interne
- `lib/grab.js` : log enrichi avec taille/leechers/seeders pour chaque torrent grabé
- `server.js` : `pruneUploadHistory()` réécrit — cap à 500 hashes, ne purge que les inactifs triés par ancienneté
- `app.js` : polling `loadStats` corrigé de 5s à 60s

### Supprimé
- Boutons de plage temporelle (`btn-range`, `chart-range-btns`) — remplacés par le brush
- Fonction `filterByRange()` dans `charts.js` — remplacée par `sliceByBrush()`
- CSS des sélecteurs `th[data-action="sort-actifs"]` et `th[data-sort]` — remplacés par `.sortable`

### Corrigé
- `charts.js` : label « uploadés sur 24h » affichait toujours 24h même si le torrent avait moins de données — affiche désormais la durée réelle (ex : `2h 30min`)
- `app.js` : `startPolling()` appelé plusieurs fois (login, setup, checkAuth) — ajout d'un garde `pollingStarted`

### Sécurité
- `server.js` : timing attack sur le login — `bcrypt.compare` exécuté systématiquement même si le username est incorrect
- `server.js` / `lib/grab.js` : validation `page_url` — seuls les schémas `http(s)://` sont acceptés (bloque `javascript:`, `data:`, etc.)

---

## [1.5.4] - 2026-03-22

### Ajouté
- `stats.js` : dispatch du CustomEvent `timer-status` depuis `loadStats()` toutes les 5s — les onglets Top et Config écoutent cet événement pour piloter leur countdown
- `server.js` : champs `timer_enabled` et `timer_next_at` ajoutés à `GET /api/stats`
- `app.js` : `visibilitychange` déclenche un `loadStats()` immédiat au retour sur l'onglet pour resynchroniser le timer sans drift

### Modifié
- `top.js` : timer refactorisé — écoute `timer-status` au lieu de calculer localement ; `setTimeout` unique remplace l'ancien `setInterval` de polling ; plus de `localStorage`
- `rules.js` : timer refactorisé — écoute `timer-status` ; suppression de `applyTimerCountdown()` et des références `localStorage` timer
- `server.js` : `POST /api/timer/config` réinitialise `last_run` à maintenant lors de la réactivation du timer
- `server.js` : `DELETE /api/torrents/:hash` — validation `typeof` précise sur `req.query.name`
- `server.js` : cookie `maxAge` aligné dynamiquement sur `token_expiry` (`1h`–`168h`)
- `server.js` : `GET /api/auto-refresh` — retrait des champs `timer_enabled` et `timer_interval_hours` jamais lus par le client
- `stats.js` : `loadConnections()` redirige vers le login sur réponse 401
- `theme-init.js` : ajout de `'use strict'`
- `ecosystem.config.js` : fichier statique versionné, plus généré dynamiquement au setup

### Supprimé
- `server.js` : endpoints morts retirés — `GET/POST /api/auto-grab/status|config`, `GET/DELETE /api/grabbed-torrents`
- `server.js` : génération dynamique de `ecosystem.config.js` dans `POST /api/setup`
- `server.js` : import `CLEAN_RULE_KEYS` (jamais utilisé)
- `lib/cleaner.js` : fonction `reschedule()` et variable `currentTask` (dead code, jamais appelé depuis server.js)
- `lib/grab.js` : fonction `scheduleAutoGrab()` et variable `autoGrabTimer` (dead code)
- `lib/qbit.js` : `qbitLogin` retiré des exports (usage interne uniquement)
- `top.js` : branche morte référençant `autograb-error-msg` (élément absent du HTML)
- `top.js` / `rules.js` : toutes les références `localStorage` liées aux timers
- `app.js` : variable `rulesOrig` (déclarée et jamais lue)
- `config.json` : champs obsolètes `auto_grab.interval_minutes` et `auto_clean.interval_hours` (vestiges des anciens timers séparés)
- `.gitignore` : `ecosystem.config.js` retiré (fichier désormais versionné)

### Corrigé
- Timer désynchronisé après absence sur l'onglet — résolu par resync via `visibilitychange` + source de vérité serveur
- Countdown qui continuait à tourner avec le toggle désactivé — résolu par `timer-status` avec `enabled: false`
- `server.js` : `DEFAULT_CLEAN_RULES_ON` — `upload_min_mb` corrigé à `false` pour s'aligner sur le frontend
- `server.js` : `initConfig()` ne crée plus les champs `interval_hours`/`interval_minutes` obsolètes dans les blocs auto_clean/auto_grab

---

## [1.5.3] - 2026-03-21

### Corrigé
- `server.js` : cast `String()` sur `req.query.name` dans `DELETE /api/torrents/:hash` pour éviter une confusion de type si le paramètre est un tableau

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

[Non publié]: https://github.com/vv7r/seedash/compare/v1.6.1...HEAD
[1.6.1]: https://github.com/vv7r/seedash/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/vv7r/seedash/compare/v1.5.4...v1.6.0
[1.5.4]: https://github.com/vv7r/seedash/compare/v1.5.3...v1.5.4
[1.5.3]: https://github.com/vv7r/seedash/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/vv7r/seedash/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/vv7r/seedash/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/vv7r/seedash/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/vv7r/seedash/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/vv7r/seedash/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/vv7r/seedash/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/vv7r/seedash/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/vv7r/seedash/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/vv7r/seedash/releases/tag/v1.0.0
