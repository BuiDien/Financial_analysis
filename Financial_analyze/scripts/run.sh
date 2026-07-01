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

PIDS=()
cleanup() {
  echo
  echo "-- Shutting down --"
  for pid in "${PIDS[@]:-}"; do
    # kill the whole process group: uvicorn --reload forks a worker child
    # that a plain `kill $pid` on the reloader parent can leave orphaned.
    kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  sleep 0.3
  # belt-and-suspenders — catch anything the group kill missed.
  pkill -f "uvicorn app.main:app" 2>/dev/null || true
  pkill -f "http.server $FRONTEND_PORT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Ollama (Hermes brain), if installed — best-effort, non-blocking ──────
if command -v ollama >/dev/null 2>&1; then
  if ! curl -s "http://localhost:11434/api/version" >/dev/null 2>&1; then
    echo "-- Starting Ollama --"
    ollama serve >/tmp/ollama.log 2>&1 &
    PIDS+=("$!")
    sleep 1
  else
    echo "-- Ollama already running --"
  fi
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

sleep 1
URL="http://localhost:$FRONTEND_PORT/Financial%20Analyze.html"
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
