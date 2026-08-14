#!/bin/bash
# OpenSea instant API key refresher
# POST /api/v2/auth/keys — free tier, no auth, 7-day expiry, max 2/day per IP
# On success: updates /root/minting/.env OPENSEA_API_KEY + restarts minter service

ENV_FILE="/root/minting/.env"
LOG="/root/minting/logs/key-refresh.log"
mkdir -p /root/minting/logs

RESP=$(curl -s --max-time 20 -X POST "https://api.opensea.io/api/v2/auth/keys" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if echo "$RESP" | grep -q "api_key"; then
  KEY=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['api_key'])")
  # backup env before edit
  cp "$ENV_FILE" "$ENV_FILE.bak"
  # replace or append
  if grep -q "^OPENSEA_API_KEY=" "$ENV_FILE"; then
    sed -i "s|^OPENSEA_API_KEY=.*|OPENSEA_API_KEY=$KEY|" "$ENV_FILE"
  else
    echo "OPENSEA_API_KEY=$KEY" >> "$ENV_FILE"
  fi
  systemctl restart minter
  echo "[$TS] OK key refreshed (${KEY:0:8}…) + minter restarted" >> "$LOG"
  echo "OK"
else
  echo "[$TS] FAIL: $(echo "$RESP" | head -c 200)" >> "$LOG"
  echo "FAIL"
fi
