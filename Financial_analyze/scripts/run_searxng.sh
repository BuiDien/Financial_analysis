#!/usr/bin/env bash
# Run — starts the local SearXNG dev server on 127.0.0.1:8888.
# Requires ./scripts/setup_searxng.sh to have been run first.
# scripts/run.sh calls this automatically (skips if something's already
# listening on the port) — run it by hand only for standalone testing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SX="$ROOT/searxng"
SRC="$SX/searxng-src"
VENV="$SX/.venv"
CONFIG="$SX/config"

if [ ! -x "$VENV/bin/python" ] || [ ! -f "$CONFIG/settings.yml" ]; then
  echo "ERROR: SearXNG not set up. Run ./scripts/setup_searxng.sh first." >&2
  exit 1
fi

echo "-- Starting SearXNG on http://127.0.0.1:8888 (Ctrl-C to stop) --"
cd "$SRC" && SEARXNG_SETTINGS_PATH="$CONFIG/settings.yml" exec "$VENV/bin/python" -m searx.webapp
