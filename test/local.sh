#!/usr/bin/env bash
# Test locale senza secret: mock Spaggiari + wrangler dev + e2e OAuth.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MOCK_PID=""
WRANGLER_PID=""
cleanup() {
  [[ -n "${WRANGLER_PID}" ]] && kill "${WRANGLER_PID}" 2>/dev/null || true
  [[ -n "${MOCK_PID}" ]] && kill "${MOCK_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

if [[ ! -f .dev.vars ]]; then
  cp .dev.vars.example .dev.vars
fi

node test/mock-spaggiari.mjs >/tmp/cv-mock.log 2>&1 &
MOCK_PID=$!
sleep 0.4

npx wrangler dev --ip 127.0.0.1 --port 8787 --local >/tmp/cv-wrangler.log 2>&1 &
WRANGLER_PID=$!

# Attendi che il worker risponda (max ~60s)
for i in $(seq 1 60); do
  if curl -sf -o /dev/null -w '' http://127.0.0.1:8787/ 2>/dev/null \
    || curl -sf -o /dev/null http://127.0.0.1:8787/.well-known/oauth-authorization-server 2>/dev/null; then
    break
  fi
  if ! kill -0 "${WRANGLER_PID}" 2>/dev/null; then
    echo "wrangler uscito prima di essere pronto:" >&2
    cat /tmp/cv-wrangler.log >&2 || true
    exit 1
  fi
  sleep 1
done

CLASSEVIVA_USER=S1234567X CLASSEVIVA_PASS=prova npm run test:e2e -- http://127.0.0.1:8787
