#!/usr/bin/env bash
# install.sh — Installation automatique de SeeDash sur Ultra.cc
set -euo pipefail

# ─── Couleurs ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC}  $*" >&2; exit 1; }
info() { echo -e "${CYAN}→${NC}  $*"; }
ask()  { echo -e "${BOLD}?${NC}  $*"; }
sep()  { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${CYAN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║   SeeDash — Installation automatique   ║${NC}"
echo -e "${CYAN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""

# ─── 1. Prérequis ────────────────────────────────────────────────────────────
sep "Vérification des prérequis"
command -v node >/dev/null 2>&1 || err "node introuvable — Node.js requis"
command -v npm  >/dev/null 2>&1 || err "npm introuvable"
command -v pm2  >/dev/null 2>&1 || err "pm2 introuvable — installez-le : npm install -g pm2"
command -v curl >/dev/null 2>&1 || err "curl introuvable"
ok "Node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null | head -1)"

# ─── 2. Dépendances npm ──────────────────────────────────────────────────────
sep "Installation des dépendances"
npm install --omit=dev --silent
ok "Dépendances installées"

# ─── 3. Port ─────────────────────────────────────────────────────────────────
sep "Configuration du port"
FREE_PORT=""
port_is_free() { python3 -c "import socket,sys; s=socket.socket(); s.bind(('',int(sys.argv[1]))); s.close()" "$1" 2>/dev/null; }
if command -v app-ports >/dev/null 2>&1; then
  while IFS= read -r candidate; do
    [[ "$candidate" =~ ^[0-9]{4,5}$ ]] || continue
    if port_is_free "$candidate"; then
      FREE_PORT="$candidate"
      info "Port détecté automatiquement : $FREE_PORT"
      break
    else
      info "Port $candidate déjà utilisé — essai suivant..."
    fi
  done < <(app-ports free 2>/dev/null | grep -oE '[0-9]{4,5}')
fi
if [ -z "$FREE_PORT" ]; then
  ask "Port à utiliser (consultez : app-ports free) :"
  read -r FREE_PORT
  port_is_free "$FREE_PORT" || warn "Port $FREE_PORT semble déjà utilisé — continuez à vos risques"
fi
[[ "$FREE_PORT" =~ ^[0-9]+$ ]] || err "Port invalide : $FREE_PORT"
ok "Port : $FREE_PORT"

# ─── 4. Base URL ─────────────────────────────────────────────────────────────
ask "Base URL [/seedash] :"
read -r BASEURL
BASEURL="${BASEURL:-/seedash}"
ok "Base URL : $BASEURL"

# ─── 5. config.json ──────────────────────────────────────────────────────────
sep "Mise à jour de config.json"
PORT="$FREE_PORT" BURL="$BASEURL" node -e "
  const fs  = require('fs');
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  cfg.port    = parseInt(process.env.PORT);
  cfg.baseurl = process.env.BURL;
  fs.writeFileSync('config.json', JSON.stringify(cfg, null, 2));
"
ok "config.json mis à jour (port=$FREE_PORT, baseurl=$BASEURL)"

# ─── 6. Démarrage PM2 ────────────────────────────────────────────────────────
sep "Démarrage via PM2"
pm2 delete seedash 2>/dev/null || true
pm2 start server.js --name seedash
pm2 save --force
ok "SeeDash démarré"

# ─── 7. Attente du serveur ───────────────────────────────────────────────────
BASE="http://127.0.0.1:${FREE_PORT}${BASEURL}"
info "Attente du serveur ($BASE)..."
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/setup/status" 2>/dev/null || true)
  if [ "$STATUS" = "200" ]; then
    ok "Serveur prêt (${i}s)"
    break
  fi
  if [ "$i" = "20" ]; then
    err "Serveur non accessible après 20s — vérifiez : pm2 logs seedash"
  fi
  sleep 1
done

# ─── 8. Détection des connexions ─────────────────────────────────────────────
sep "Détection des connexions"

# ── Ultra.cc : installation du script Ultra API si absent ────────────────────
UC_DB="$HOME/scripts/Ultra-API/auth_tokens.db"
if [ ! -f "$UC_DB" ]; then
  info "Installation du script Ultra API..."
  echo "1" | bash <(wget -qO- https://scripts.ultra.cc/util-v2/Ultra-API/main.sh)
  ok "Script Ultra API installé"
fi

# ── Ultra.cc : URL depuis hostname ───────────────────────────────────────────
UC_URL=""
DETECTED_HOST=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "")
if echo "$DETECTED_HOST" | grep -qi "usbx.me"; then
  UC_URL="https://${USER}.${DETECTED_HOST}/ultra-api/total-stats"
  ok "URL Ultra.cc : $UC_URL"
fi

# ── Ultra.cc : token depuis SQLite ───────────────────────────────────────────
UC_TOKEN=""
if [ -f "$UC_DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  UC_TOKEN=$(sqlite3 "$UC_DB" "SELECT auth_token FROM tokens LIMIT 1;" 2>/dev/null | tr -d '[:space:]' || true)
  [ -n "$UC_TOKEN" ] && ok "Token Ultra.cc récupéré"
fi

# ── qBittorrent : port + username depuis le fichier de config ────────────────
QBIT_CONF="$HOME/.config/qBittorrent/qBittorrent.conf"
QBIT_PORT=""; QBIT_USER=""; QBIT_URL=""
if [ -f "$QBIT_CONF" ]; then
  QBIT_PORT=$(grep -oP '(?<=WebUI\\Port=)\d+' "$QBIT_CONF" 2>/dev/null || true)
  QBIT_USER=$(grep -oP '(?<=WebUI\\Username=).+' "$QBIT_CONF" 2>/dev/null || true)
  [ -n "$QBIT_PORT" ] && QBIT_URL="http://127.0.0.1:${QBIT_PORT}" && ok "qBittorrent : $QBIT_URL (user: ${QBIT_USER:-admin})"
else
  warn "qBittorrent non détecté — installez-le via https://cp.ultra.cc"
fi

# ─── 9. Écriture directe dans connections.json ───────────────────────────────
sep "Enregistrement des connexions"
QBIT_URL="$QBIT_URL" QBIT_USER="$QBIT_USER" UC_URL="$UC_URL" UC_TOKEN="$UC_TOKEN" node -e "
  const fs = require('fs');
  const { encrypt } = require('./crypto-config');

  const conn = JSON.parse(fs.readFileSync('connections.json', 'utf8'));
  const key  = conn.auth?.jwt_secret;
  if (!key) { console.error('jwt_secret absent'); process.exit(1); }

  const e = process.env;
  const enc = v => v ? encrypt(v, key) : undefined;

  if (e.QBIT_URL)   conn.qbittorrent.url      = e.QBIT_URL;
  if (e.QBIT_USER)  conn.qbittorrent.username  = enc(e.QBIT_USER);
  if (e.UC_URL)     conn.ultracc_api.url        = e.UC_URL;
  if (e.UC_TOKEN)   conn.ultracc_api.token      = enc(e.UC_TOKEN);

  fs.writeFileSync('connections.json', JSON.stringify(conn, null, 2), { mode: 0o600 });
  console.log('ok');
" && ok "Connexions écrites dans connections.json" || warn "Erreur écriture connexions"

pm2 reload seedash --silent

# ─── 10. Proxy Nginx ─────────────────────────────────────────────────────────
sep "Configuration du proxy Nginx"
NGINX_PROXY_DIR="$HOME/.apps/nginx/proxy.d"
PROXY_NAME="${BASEURL#/}"   # supprime le slash initial → ex: "seedash"
NGINX_CONF="$NGINX_PROXY_DIR/${PROXY_NAME}.conf"
NGINX_OK=false

if [ -d "$NGINX_PROXY_DIR" ]; then
  cat > "$NGINX_CONF" <<NGINXEOF
location ${BASEURL}/ {
    proxy_pass http://127.0.0.1:${FREE_PORT};
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-Host \$http_host;
}
NGINXEOF
  ok "Fichier proxy créé : $NGINX_CONF"
  if command -v app-nginx >/dev/null 2>&1; then
    app-nginx restart >/dev/null 2>&1 && ok "Nginx redémarré" || warn "app-nginx restart a échoué — redémarrez manuellement"
    NGINX_OK=true
  else
    warn "app-nginx introuvable — rechargez Nginx manuellement"
  fi
else
  warn "Dossier $NGINX_PROXY_DIR absent — proxy Nginx non configuré automatiquement"
fi

# ─── 11. Résumé ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║       Installation terminée !          ║${NC}"
echo -e "${GREEN}${BOLD}╚════════════════════════════════════════╝${NC}"
echo ""
if [ "$NGINX_OK" = true ]; then
  echo -e "  ${BOLD}Ouvrez l'application dans votre navigateur :${NC}"
  echo -e "    ${CYAN}https://${USER}.${DETECTED_HOST}${BASEURL}${NC}"
else
  echo -e "  ${BOLD}Ouvrez l'application dans votre navigateur :${NC}"
  echo -e "    http://127.0.0.1:${FREE_PORT}${BASEURL}"
fi
echo ""
echo -e "  ${BOLD}Page de premier démarrage — créez votre compte, puis dans Configuration → Connexions & API :${NC}"
echo -e "    Clé API C411             →  ${YELLOW}à saisir manuellement${NC}"
echo -e "    Mot de passe qBittorrent →  ${YELLOW}à saisir manuellement${NC}"
if [ -z "$QBIT_URL" ]; then
  echo -e "    qBittorrent              →  ${YELLOW}non détecté — installez-le sur https://cp.ultra.cc${NC}"
fi
echo ""
echo -e "  ${BOLD}Commandes utiles :${NC}"
echo -e "    pm2 logs seedash       # logs en temps réel"
echo -e "    pm2 reload seedash     # rechargement après mise à jour"
echo -e "    pm2 status             # état du processus"
echo ""
