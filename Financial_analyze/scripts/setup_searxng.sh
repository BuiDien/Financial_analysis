#!/usr/bin/env bash
# Setup — SearXNG (self-hosted metasearch), native install, no Docker.
#
# This is the "search framework" behind the future Hermes MCP tool
# `search_news` (docs/design/HERMES_BRAIN.md, docs/design/DISCUSSION_BACKLOG.md).
# It is Stage 8 in docs/PLAN.md — unscheduled, and NOT wired to anything yet:
# Hermes Agent isn't installed, the MCP server doesn't exist, and the
# deterministic scanner deliberately never touches search results (keeps
# scoring reproducible). Setting this up now just gets the service itself
# ready; wiring happens when Stage 6/8 are actually built.
#
# Run once: ./scripts/setup_searxng.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SX="$ROOT/searxng"
SRC="$SX/searxng-src"
VENV="$SX/.venv"
CONFIG="$SX/config"

echo "== SearXNG native setup =="

# ── 1. Prereqs ─────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git not found." >&2
  exit 1
fi
PY="${PYTHON_BIN:-}"
if [ -z "$PY" ]; then
  if command -v python3.11 >/dev/null 2>&1; then PY=python3.11
  elif command -v python3 >/dev/null 2>&1; then PY=python3
  else echo "ERROR: no python3 found." >&2; exit 1
  fi
fi
echo "-- Using $($PY --version) --"

# ── 2. Clone (or update) ──────────────────────────────────────────────
mkdir -p "$SX"
if [ ! -d "$SRC/.git" ]; then
  echo "-- Cloning searxng/searxng --"
  git clone --depth 1 https://github.com/searxng/searxng "$SRC"
else
  echo "-- searxng-src already cloned, leaving as-is (rm -rf to force a fresh clone) --"
fi

# ── 3. venv + build deps ──────────────────────────────────────────────
if [ ! -d "$VENV" ]; then
  echo "-- Creating $VENV --"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/pip" install -q -U pip setuptools wheel
"$VENV/bin/pip" install -q -U pyyaml msgspec typing-extensions pybind11

# ── 4. Editable install of SearXNG itself ─────────────────────────────
echo "-- Installing SearXNG (this runs the package's own build code) --"
(cd "$SRC" && "$VENV/bin/pip" install -q --use-pep517 --no-build-isolation -e .)

# ── 5. Config: settings.yml + secret key + enable JSON output ────────
mkdir -p "$CONFIG"
if [ ! -f "$CONFIG/settings.yml" ]; then
  cp "$SRC/utils/templates/etc/searxng/settings.yml" "$CONFIG/settings.yml"
  SECRET=$(openssl rand -hex 16)
  sed -i '' -e "s/ultrasecretkey/$SECRET/g" "$CONFIG/settings.yml"
  # JSON output is off by default (security default) — the future MCP
  # search_news tool needs it; HTML stays enabled for manual browsing.
  sed -i '' -e 's/^    - html$/    - html\n    - json/' "$CONFIG/settings.yml"
  echo "-- Wrote $CONFIG/settings.yml (secret key generated, JSON format enabled) --"
else
  echo "-- $CONFIG/settings.yml already exists, leaving as-is --"
fi

echo
echo "== SearXNG setup done =="
echo "Start it:   ./scripts/run_searxng.sh"
echo "Then test:  curl 'http://127.0.0.1:8888/search?q=test&format=json'"
echo
echo "Note: the rate limiter wants Valkey/Redis (optional for single-user local"
echo "use — you'll see a harmless 'limiter requires Valkey' warning without it)."
