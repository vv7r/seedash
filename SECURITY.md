## Signaler une vulnérabilité

**Ne pas ouvrir une issue publique pour un problème de sécurité.**

Si vous découvrez une vulnérabilité (ex : fuite de clé API, injection, exécution de code arbitraire), ouvrez un rapport privé via l'onglet **Security** du dépôt GitHub.

Indiquez :
- La nature du problème
- Les étapes pour le reproduire
- L'impact potentiel


## Bonnes pratiques pour les utilisateurs

- **Ne versionnez jamais `connections.json`** — il contient vos secrets chiffrés (clé API C411, identifiants qBittorrent, token Ultra.cc) et le hash du mot de passe admin. Le `.gitignore` fourni l'exclut par défaut.
- Utilisez des clés API avec les permissions minimales nécessaires.
- Ne partagez pas votre clé API C411 — elle est personnelle et liée à votre compte.
- N'exposez pas SeeDash sur Internet sans reverse proxy HTTPS et sans audit préalable.
