#!/bin/sh
# Deletes live games from a relay for good (their streams and replays there; the recorder's own files stay):
#   sh live/delete.sh ID...                 (relay: $W2LIVE_RELAY, else the Cloudflare one)
# It asks for the relay's TOKEN (not shown as you type); or set $W2LIVE_TOKEN.
set -e
RELAY=${W2LIVE_RELAY:-https://w2live.wc2replay.workers.dev}
[ $# -gt 0 ] || { echo "usage: sh live/delete.sh ID...   (ids: $RELAY/api/live)"; exit 1; }
T=${W2LIVE_TOKEN:-}
if [ -z "$T" ]; then printf 'relay token: '; stty -echo 2>/dev/null; read -r T; stty echo 2>/dev/null; echo; fi
for id in "$@"; do
  printf '%s: ' "$id"
  curl -s -w ' (%{http_code})\n' -X DELETE -H "authorization: Bearer $T" "$RELAY/api/live/$id"
done
