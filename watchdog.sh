#!/usr/bin/env bash
# watchdog.sh — Relance les services SeeDash si nécessaires
# À exécuter toutes les 5 min via cron

set -euo pipefail

# Charge NVM pour trouver node/pm2 dynamiquement
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

NODE=$(command -v node)
PM2=$(command -v pm2)
SEEDASH_DIR="$HOME/seedash"
LOG="$SEEDASH_DIR/logs/watchdog.log"
LOCK="$SEEDASH_DIR/logs/watchdog.lock"
ULTRACC_DIR="$HOME/scripts/Ultra-API"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog — $*" >> "$LOG"; }

# Rotation si >50 Ko : garde les 200 dernières lignes
rotate_log() {
  [ -f "$LOG" ] || return 0
  local sz
  sz=$(stat -c%s "$LOG" 2>/dev/null) || return 0
  [ "$sz" -gt 51200 ] || return 0
  tail -n 200 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
}

# Dépendances
if [ -z "$NODE" ] || [ -z "$PM2" ]; then
  echo "[watchdog] node ou pm2 introuvable (PATH=$PATH)" >&2
  exit 1
fi

# Lock pour éviter les exécutions concurrentes
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[watchdog] lock déjà posé — skip"
  exit 0
fi
trap 'rm -f "$LOCK"; exec 9>&-' EXIT

rotate_log

# ── Vérifie que PM2 est vivant ─────────────────────────────────────────────
if ! $PM2 ping >/dev/null 2>&1; then
  log "PM2 mort — redémarrage complet"
  $PM2 resurrect 2>/dev/null || true
  if ! $PM2 describe seedash >/dev/null 2>&1; then
    $PM2 start "$SEEDASH_DIR/server.js" --name seedash 2>&1 | while IFS= read -r line; do log "$line"; done
  fi
  if ! $PM2 describe ultra-api >/dev/null 2>&1; then
    $PM2 start "$ULTRACC_DIR/stats_request.py" \
      --name ultra-api --interpreter "$ULTRACC_DIR/bin/python" --cwd "$ULTRACC_DIR" 2>&1 | while IFS= read -r line; do log "$line"; done
  fi
  $PM2 save --force >/dev/null 2>&1
  exit 0
fi

# ── Vérifie seedash ────────────────────────────────────────────────────────
CFG="$SEEDASH_DIR/config.json"
PORT=; BURL=
if [ -f "$CFG" ]; then
  PORT=$($NODE -e "console.log(JSON.parse(require('fs').readFileSync('$CFG','utf8')).port)" 2>/dev/null)
  BURL=$($NODE -e "console.log(JSON.parse(require('fs').readFileSync('$CFG','utf8')).baseurl||'')" 2>/dev/null)
fi
PORT="${PORT:-44962}"
BURL="${BURL:-/seedash}"
if [ ! -f "$CFG" ]; then
  log "config.json introuvable — fallback port=$PORT baseurl=$BURL"
elif [ -z "${PORT:-}" ] || [ -z "${BURL:-}" ]; then
  log "config.json invalide — fallback port=$PORT baseurl=$BURL"
fi

if ! $NODE -e "
  const h = require('http');
  h.get('http://127.0.0.1:' + $PORT + '$BURL' + '/api/stats', r => {
    r.on('data', () => {});
    r.on('end', () => process.exit(0));
  }).on('error', () => process.exit(1));
" 2>/dev/null; then
  log "seedash injoignable — restart"
  $PM2 restart seedash --update-env 2>&1 | while IFS= read -r line; do log "$line"; done
fi

# ── Vérifie ultra-api (URL + token lus depuis connections.json) ───────────
CONN="$SEEDASH_DIR/connections.json"
UA_URL=; TOKEN=
if [ -f "$CONN" ]; then
  UA_URL=$($NODE -e "
    const j = JSON.parse(require('fs').readFileSync('$CONN','utf8'));
    console.log(j.ultracc_api?.url||'');
  " 2>/dev/null)
  TOKEN=$($NODE -e "
    const c = require('$SEEDASH_DIR/crypto-config');
    const f = require('fs');
    const j = JSON.parse(f.readFileSync('$CONN','utf8'));
    const t = c.decrypt(j.ultracc_api?.token||'', j.auth?.jwt_secret||'');
    if (t) console.log(t); else process.exit(1);
  " 2>/dev/null) || TOKEN=''
fi

if [ -z "$UA_URL" ]; then
  log "connections.json introuvable ou ultracc_api.url absent — skip"
elif [ -z "$TOKEN" ]; then
  log "token ultra-api non déchiffrable — skip"
elif ! curl -sf -H "Authorization: Bearer $TOKEN" "$UA_URL" >/dev/null 2>&1; then
  log "ultra-api injoignable ($UA_URL) — restart"
  $PM2 restart ultra-api 2>&1 | while IFS= read -r line; do log "$line"; done
fi