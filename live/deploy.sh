#!/bin/sh
# Deploys the relay (worker.js) and the viewer to Cloudflare from what this repo has COMMITTED (git archive HEAD:
# the same files as GitHub), never from the working folder, so nothing uncommitted goes public.
#   sh live/deploy.sh        (needs "npx wrangler login" once)
set -e
cd "$(dirname "$0")/.."
git rev-parse --git-dir >/dev/null
[ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are NOT deployed (deploying $(git rev-parse --short HEAD))"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git archive HEAD | tar -x -C "$T"
cd "$T/live" && npx wrangler deploy "$@"
