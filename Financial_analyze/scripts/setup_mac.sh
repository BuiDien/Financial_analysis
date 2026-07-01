#!/usr/bin/env bash
# Setup — Mac (Core: FastAPI backend + frontend host + Hermes/Ollama brain).
# Run once per machine: ./scripts/setup_mac.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"

echo "== Helix / Financial Analyze — Mac setup =="
echo "Root: $ROOT"

# ── 1. Python 3.11 ────────────────────────────────────────────────────
if command -v python3.11 >/dev/null 2>&1; then
  PY=python3.11
elif command -v brew >/dev/null 2>&1; then
  echo "-- python3.11 not found, installing via Homebrew --"
  brew install python@3.11
  PY="$(brew --prefix python@3.11)/bin/python3.11"
else
  echo "ERROR: need python3.11 and no Homebrew found. Install Homebrew (https://brew.sh) or python3.11 manually." >&2
  exit 1
fi
echo "-- Using $($PY --version) --"

# ── 2. Backend venv + deps ────────────────────────────────────────────
if [ ! -d "$BACKEND/.venv" ]; then
  echo "-- Creating backend/.venv --"
  "$PY" -m venv "$BACKEND/.venv"
fi
"$BACKEND/.venv/bin/pip" install -q --upgrade pip
echo "-- Installing backend/requirements.txt --"
"$BACKEND/.venv/bin/pip" install -q -r "$BACKEND/requirements.txt"

# ── 3. .env ────────────────────────────────────────────────────────────
if [ ! -f "$BACKEND/.env" ]; then
  echo "-- Creating backend/.env from .env.example (fill in ANTHROPIC_API_KEY etc.) --"
  cp "$BACKEND/.env.example" "$BACKEND/.env"
fi

# ── 4. DB init ─────────────────────────────────────────────────────────
echo "-- Initializing SQLite DB --"
(cd "$BACKEND" && ".venv/bin/python" -m app.db init)

# ── 5. Backend smoke test ────────────────────────────────────────────
echo "-- Running backend tests --"
(cd "$BACKEND" && ".venv/bin/pytest" -q)

# ── 6. Ollama + Hermes brain model (Stage 6, optional but pre-pulled here) ──
if command -v ollama >/dev/null 2>&1; then
  echo "-- Ollama found --"
else
  if command -v brew >/dev/null 2>&1; then
    echo "-- Installing Ollama via Homebrew --"
    brew install ollama
  else
    echo "WARNING: Ollama not found and no Homebrew. Install manually from https://ollama.com — skipping model pull." >&2
  fi
fi
if command -v ollama >/dev/null 2>&1; then
  # PLAN.md/HERMES_BRAIN.md call for "Qwen3 35B". No dense 35B build ships on
  # Ollama's public library (checked 2026-07-01) — closest real tag is
  # qwen3:32b (20GB). Swap this if a 35B build shows up at
  # https://ollama.com/library/qwen3/tags, or use qwen3.5:35b / qwen3.6:35b
  # (newer series, larger download) if you specifically want a 35B checkpoint.
  HERMES_MODEL="${HERMES_MODEL:-qwen3:32b}"
  # Hermes/Ollama wiring is Stage 6 (unbuilt) — the pull is a convenience,
  # not a hard requirement, so failures here warn instead of aborting setup.
  if ! curl -s "http://localhost:11434/api/version" >/dev/null 2>&1; then
    echo "WARNING: Ollama isn't running (open the Ollama app, or run 'ollama serve'), skipping model pull."
    echo "         Once it's running: ollama pull $HERMES_MODEL"
  elif ollama list 2>/dev/null | grep -q "^${HERMES_MODEL%%:*}"; then
    echo "-- $HERMES_MODEL already pulled --"
  else
    echo "-- Pulling Hermes brain model: $HERMES_MODEL (this is large, be patient) --"
    ollama pull "$HERMES_MODEL" || echo "WARNING: model pull failed — retry later with: ollama pull $HERMES_MODEL"
  fi
fi

echo
echo "== Mac setup done =="
echo "Next: ./scripts/run.sh to start the backend + frontend."
