#!/bin/sh
# Deploys the relay (worker.js) and the viewer to Cloudflare from what this repo has COMMITTED (git archive HEAD:
# the same files as GitHub), never from the working folder, so nothing uncommitted goes public. The Warcraft II
# files come from this computer's game/ folder (GAME_DIR; never in git) and are served only behind the login
# (worker.js; secrets GAME_USER / GAME_PASS); a file over the 25 MB asset limit is split into .part0, .part1, ...
#   sh live/deploy.sh        (needs "npx wrangler login" once)
set -e
cd "$(dirname "$0")/.."
git rev-parse --git-dir >/dev/null
[ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are NOT deployed (deploying $(git rev-parse --short HEAD))"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git archive HEAD | tar -x -C "$T"
rm -rf "$T/game"   # game files only as below (split, behind the login), whatever git holds
G=${GAME_DIR:-game}
if [ -f "$G/Warcraft II BNE.exe" ] && [ -f "$G/War2Dat.mpq" ]; then
  mkdir -p "$T/game"
  for f in "Warcraft II BNE.exe" War2Dat.mpq War2Patch.mpq; do
    [ -f "$G/$f" ] || continue
    n=$(wc -c < "$G/$f")
    if [ "$n" -le 24000000 ]; then cp "$G/$f" "$T/game/$f"
    else k=0; while [ $((k * 20)) -lt $(( (n + 1048575) / 1048576 )) ]; do
      dd if="$G/$f" of="$T/game/$f.part$k" bs=1048576 skip=$((k * 20)) count=20 2>/dev/null; k=$((k + 1)); done
    fi
  done
  echo "game files from $G: $(ls "$T/game" | tr '\n' ' ')(behind the login)"
else echo "no game files in $G: /game/ stays empty"; fi
cd "$T/live" && npx wrangler deploy "$@"
