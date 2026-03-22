# Guide de contribution — SeeDash

Merci de l'intérêt porté à SeeDash. Ce document décrit les règles de contribution au projet.

## Sommaire

1. [Signaler un bug](#1-signaler-un-bug)
2. [Proposer une fonctionnalité](#2-proposer-une-fonctionnalité)
3. [Contribuer du code](#3-contribuer-du-code)
4. [Conventions de code](#4-conventions-de-code)
5. [Architecture du projet](#5-architecture-du-projet)
6. [Tests](#6-tests)

---

## 1. Signaler un bug

Avant d'ouvrir une issue, vérifiez qu'elle n'existe pas déjà.

Un bon rapport de bug inclut :

- Version Node.js (`node --version`)
- Système d'exploitation
- Message d'erreur complet (logs PM2 : `pm2 logs seedash`)
- Étapes pour reproduire
- Comportement attendu vs observé

**Template :**

```
**Environnement**
- Node.js :
- OS :

**Description**
[description claire du problème]

**Étapes pour reproduire**
1.
2.
3.

**Comportement attendu**
[ce qui devrait se passer]

**Comportement observé**
[ce qui se passe réellement]

**Logs**
[sortie de `pm2 logs seedash` ou de la console navigateur]
```

---

## 2. Proposer une fonctionnalité

Ouvrez une issue avec le label `enhancement` en décrivant :

- Le problème que la fonctionnalité résout
- La solution proposée
- Les alternatives envisagées
- Des exemples d'utilisation si applicable

---

## 3. Contribuer du code

```bash
# 1. Forker le dépôt puis cloner votre fork
git clone https://github.com/VOTRE_PSEUDO/seedash.git
cd seedash

# 2. Installer les dépendances
npm install

# 3. Créer une branche descriptive
git checkout -b feat/ma-fonctionnalite

# 4. Développer, commiter
git commit -m "feat(grab): ajouter filtrage par taille minimale"

# 5. Pousser et ouvrir une Pull Request
git push origin feat/ma-fonctionnalite
```

### Convention de nommage des branches

| Préfixe | Usage |
|---------|-------|
| `feat/` | Nouvelle fonctionnalité |
| `fix/` | Correction de bug |
| `docs/` | Documentation |
| `refactor/` | Restructuration sans changement de comportement |
| `test/` | Ajout ou modification de tests |
| `chore/` | Maintenance (dépendances, config…) |

### Convention des messages de commit

Format : `type(scope): description courte`

Types valides : `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`

Exemples :
- `feat(grab): ajouter règle network_max_pct`
- `fix(cleaner): corriger calcul fenêtre upload`
- `docs(readme): mettre à jour la section configuration`

---

## 4. Conventions de code

**Général**
- Messages d'interface et logs serveur en **français**
- Pas de framework CSS — variables CSS custom dans `:root` / `[data-theme="dark"]`
- Pas de framework frontend — vanilla JS/CSS dans `public/`
- Aucun handler inline (`onclick=`, `onchange=`) — bloqués par la CSP `script-src 'self'`
- Toujours échapper les valeurs interpolées dans le HTML avec `he()` (défini dans `public/utils.js`)

**Sécurité**
- Valider les entrées utilisateur côté serveur avant toute écriture dans `config.json` / `connections.json`
- Ne jamais exposer de secrets en clair dans les réponses API
- Respecter la CSP : pas d'`eval()`, pas de scripts inline

**Structure**
- La logique métier testable doit être isolée dans `lib/` sous forme de fonctions pures exportées
- Les fonctions pures (`shouldDelete`, `filterCandidates`) ne doivent pas effectuer d'I/O
- `connections.json` est ignoré par git (secrets chiffrés)

---

## 5. Architecture du projet

```
server.js                   — Express, routes API, timers, wiring des modules
lib/
  auth.js                   — JWT, protection brute-force, middleware requireAuth
  cleaner.js                — Auto clean, exporte shouldDelete() (fonction pure testable)
  grab.js                   — Auto grab, exporte filterCandidates() (fonction pure testable)
  qbit.js                   — Client qBittorrent (session, requêtes)
  ultracc.js                — Client Ultra.cc (stats, cache TTL 5 min)
  helpers.js                — Fonctions pures utilitaires (getIn, setIn, maskSecret…)
public/
  utils.js                  — Helpers frontend (he, fmt*, toast, BASE)
  stats.js / charts.js      — Stats globales et graphiques upload
  top.js                    — Top leechers, auto-refresh, grab
  actifs.js                 — Torrents actifs, badge suppression
  rules.js                  — Règles auto-grab/clean, timer, historique
  app.js                    — Auth, tabs, event listeners, init
tests/
  cleaner-logic.test.js     — 23 tests sur shouldDelete()
  grab-logic.test.js        — 21 tests sur filterCandidates()
```

**Principes :**
- Chaque source externe (qBittorrent, C411, Ultra.cc) est encapsulée dans son propre module `lib/`
- Les routes API sont protégées par `requireAuth` sauf `POST /api/login` et `GET|POST /api/setup`
- Pas d'import circulaire entre modules `lib/`
- La logique métier testable est isolée dans des fonctions pures exportées, sans I/O

---

## 6. Tests

Le projet utilise le runner natif Node.js (`node:test`), sans dépendance externe.

```bash
npm test        # 63 tests (cleaner-logic + grab-logic)
```

Toute contribution touchant `lib/cleaner.js` ou `lib/grab.js` doit :
- Maintenir la couverture des 63 tests existants
- Ajouter des tests pour les nouveaux cas de figure

Les tests portent uniquement sur les fonctions pures exportées — pas de mock réseau, pas de mock base de données.

---

## Questions

Pour toute question, ouvrez une **Discussion** plutôt qu'une issue.
