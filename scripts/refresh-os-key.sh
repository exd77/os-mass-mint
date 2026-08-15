#!/bin/bash
# OpenSea instant API key refresher — v2 with proxy rotation fallback
# Primary: direct IP. Fallback: proxy pool (rotate past rate-limited IPs).
# On success: updates /root/minting/.env OPENSEA_API_KEY + restarts minter

ENV_FILE="/root/minting/.env"
LOG="/root/minting/logs/key-refresh.log"
PROXY_POOL="/root/proxy-rotator/proxies_alive.json"
mkdir -p /root/minting/logs

UA="User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

try_fetch() {
  # $1 = optional proxy url
  local RESP
  if [ -n "$1" ]; then
    RESP=$(curl -s --max-time 15 --proxy "$1" -X POST "https://api.opensea.io/api/v2/auth/keys" -H "Content-Type: application/json" -H "$UA" 2>/dev/null)
  else
    RESP=$(curl -s --max-time 15 -X POST "https://api.opensea.io/api/v2/auth/keys" -H "Content-Type: application/json" -H "$UA" 2>/dev/null)
  fi
  echo "$RESP"
}

RESP=$(try_fetch "")

if ! echo "$RESP" | grep -q "api_key"; then
  # direct failed — rotate through proxy pool
  while read -r P; do
    [ -z "$P" ] && continue
    RESP=$(try_fetch "$P")
    if echo "$RESP" | grep -q "api_key"; then
      echo "[$TS] success via proxy $P" >> "$LOG"
      break
    fi
  done < <(python3 -c "
import json
try:
    d = json.load(open('$PROXY_POOL'))
    for p in d:
        u = p.get('url','')
        if u.startswith('socks5://') or u.startswith('http://'):
            print(u)
except Exception:
    pass
" 2>/dev/null | shuf)
fi

if echo "$RESP" | grep -q "api_key"; then
  KEY=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['api_key'])")
  cp "$ENV_FILE" "$ENV_FILE.bak"
  if grep -q "^OPENSEA_API_KEY=" "$ENV_FILE"; then
    sed -i "s|^OPENSEA_API_KEY=.*|OPENSEA_API_KEY=$KEY|" "$ENV_FILE"
  else
    echo "OPENSEA_API_KEY=$KEY" >> "$ENV_FILE"
  fi
  systemctl restart minter
  echo "[$TS] OK key refreshed (${KEY:0:8}…) + minter restarted" >> "$LOG"
  echo "OK"
else
  echo "[$TS] FAIL (direct+proxies): $(echo "$RESP" | tr -d '\n' | head -c 200)" >> "$LOG"
  echo "FAIL"
fi
