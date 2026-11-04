#!/usr/bin/env bash
# Run — starts the backend (FastAPI) + serves the frontend, on the Mac.
# Requires ./scripts/setup_mac.sh to have been run first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5500}"

if [ ! -x "$BACKEND/.venv/bin/uvicorn" ]; then
  echo "ERROR: backend/.venv missing. Run ./scripts/setup_mac.sh first." >&2
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  echo "ERROR: lsof is required to clean up project ports before startup." >&2
  exit 1
fi

stop_port_listeners() {
  local port="$1"
  local label="$2"
  local pids=()
  local pid

  while IFS= read -r pid; do
    [ -n "$pid" ] && pids+=("$pid")
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  if [ "${#pids[@]}" -eq 0 ]; then
    return 0
  fi

  echo "-- Stopping stale $label listener(s) on :$port (${pids[*]}) --"
  kill -TERM "${pids[@]}" 2>/dev/null || true

  for _ in {1..20}; do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  pids=()
  while IFS= read -r pid; do
    [ -n "$pid" ] && pids+=("$pid")
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  if [ "${#pids[@]}" -gt 0 ]; then
    echo "-- Force stopping stale $label listener(s): ${pids[*]} --"
    kill -KILL "${pids[@]}" 2>/dev/null || true
  fi

  sleep 0.1
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERROR: could not free $label port $port." >&2
    exit 1
  fi
}

# A second coordinator has a different in-memory pairing code. Clear only this
# project's listener ports so the UI and OCR worker always share one instance.
stop_port_listeners "$BACKEND_PORT" "backend"
stop_port_listeners "$FRONTEND_PORT" "frontend"

PIDS=()
STARTED_SEARXNG=0
cleanup() {
  echo
  echo "-- Shutting down --"
  for pid in "${PIDS[@]:-}"; do
    # kill the whole process group: uvicorn --reload forks a worker child
    # that a plain `kill $pid` on the reloader parent can leave orphaned.
    kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  sleep 0.3
  if [ "$STARTED_SEARXNG" = "1" ]; then
    pkill -f "searx.webapp" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Hermes is managed as its own gateway service because it owns long-running
# sessions, memory, and MCP connections. Helix does not silently start or stop
# that user-level service, but reports clearly when it is unavailable.
#
# For local development, reuse the authenticated loopback key already stored
# by Hermes when HERMES_API_KEY was not explicitly supplied. This avoids
# maintaining a second plaintext copy in backend/.env while still allowing an
# environment override for deployments and tests.
if [ -z "${HERMES_API_KEY:-}" ] && command -v hermes >/dev/null 2>&1; then
  HERMES_LOCAL_KEY="$(hermes config get gateway.api_server.key 2>/dev/null || true)"
  if [ -n "$HERMES_LOCAL_KEY" ] && [ "$HERMES_LOCAL_KEY" != "null" ]; then
    export HERMES_API_KEY="$HERMES_LOCAL_KEY"
  fi
  unset HERMES_LOCAL_KEY
fi

HERMES_PORT="${HERMES_PORT:-8642}"
HERMES_API_URL="${HERMES_API_URL:-http://127.0.0.1:$HERMES_PORT}"
HERMES_HEALTH_ARGS=(-s -o /dev/null -m 2)
if [ -n "${HERMES_API_KEY:-}" ]; then
  HERMES_HEALTH_ARGS+=(-H "Authorization: Bearer $HERMES_API_KEY")
fi
if curl "${HERMES_HEALTH_ARGS[@]}" "$HERMES_API_URL/v1/models"; then
  echo "-- Hermes Agent gateway is running on :$HERMES_PORT --"
else
  echo "-- Hermes Agent is unavailable or unauthenticated — AI review needs: hermes gateway start --"
fi
unset HERMES_HEALTH_ARGS

# ── SearXNG (self-hosted search, backs /api/news/search) ──────────────
# Skip if something's already listening on 8888 — the user may have started
# it by hand with ./scripts/run_searxng.sh. The backend's /api/news/search
# degrades gracefully (503 + clear message) if SearXNG isn't reachable, so
# this is a convenience, not a hard dependency for the rest of the app.
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
if curl -s -o /dev/null -m 1 "http://127.0.0.1:$SEARXNG_PORT"; then
  echo "-- SearXNG already running on :$SEARXNG_PORT --"
elif [ -x "$ROOT/searxng/.venv/bin/python" ]; then
  echo "-- Starting SearXNG on :$SEARXNG_PORT --"
  "$ROOT/scripts/run_searxng.sh" >/tmp/helix_searxng.log 2>&1 &
  PIDS+=("$!")
  STARTED_SEARXNG=1
else
  echo "-- SearXNG not set up (run ./scripts/setup_searxng.sh) — news search will be unavailable --"
fi

# ── Backend (FastAPI/uvicorn) ─────────────────────────────────────────
# No --reload here: its watcher forks a worker subprocess that can outlive a
# plain `kill` on the parent (reparents to init). Use --reload by hand
# (BACKEND_PORT=... .venv/bin/uvicorn app.main:app --reload) during active
# backend development.
echo "-- Starting backend on :$BACKEND_PORT --"
(cd "$BACKEND" && ".venv/bin/uvicorn" app.main:app --host 0.0.0.0 --port "$BACKEND_PORT") &
PIDS+=("$!")

# ── Frontend (static file server — no build step, Babel-in-browser) ───
echo "-- Serving frontend on :$FRONTEND_PORT --"
(cd "$ROOT" && python3 -m http.server "$FRONTEND_PORT" >/tmp/helix_frontend.log 2>&1) &
PIDS+=("$!")

# Wait for the backend to actually answer before opening the browser — a
# flat `sleep 1` used to race uvicorn's cold-start (pandas/yfinance/anthropic
# imports can exceed 1s), so the page's one-shot HelixAPI.detect() would lose
# the race and get stuck showing mock/offline data for the whole session.
echo -n "-- Waiting for backend to be ready "
for i in $(seq 1 50); do
  if curl -s -o /dev/null "http://localhost:$BACKEND_PORT/health"; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 0.3
  if [ "$i" -eq 50 ]; then
    echo " timed out after 15s — check the backend didn't crash on startup"
  fi
done

UI_VERSION="20260723-hermes-label-review"
URL="http://localhost:$FRONTEND_PORT/Financial%20Analyze.html?v=$UI_VERSION"
echo
echo "== Running =="
echo "  Backend:  http://localhost:$BACKEND_PORT  (docs: /docs)"
echo "  Frontend: $URL"
if command -v open >/dev/null 2>&1; then
  open "$URL"
fi
echo
echo "Ctrl-C to stop both."
wait
