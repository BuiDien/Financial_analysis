#!/usr/bin/env bash
# Run — daily news collector. Writes today's raw article dump into the
# Obsidian vault (Projects/Financial_Automation/News/<date>.md) for Hermes
# to later read and summarize in place.
#
# Runs the backend venv's python DIRECTLY (absolute path) instead of relying
# on whatever `python`/`python3` is first on the caller's PATH — Hermes's own
# agent shell has its own venv with its own numpy/pandas build, and if that
# leaks in ahead of this project's venv (via PATH order or an inherited
# PYTHONPATH/PYTHONHOME), you get numpy C-extension ABI mismatches and silent
# wrong results instead of a clean error. This script sidesteps that by
# never asking the shell to resolve `python` at all, and by explicitly
# unsetting the env vars that could still leak into a child process.
#
# Usage:
#   ./scripts/collect_news.sh                # today
#   ./scripts/collect_news.sh --date 2026-07-08
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
VENV_PYTHON="$BACKEND/.venv/bin/python"
COLLECTOR="$ROOT/scripts/collect_daily_news.py"

if [ ! -x "$VENV_PYTHON" ]; then
  echo "ERROR: backend/.venv missing. Run ./scripts/setup_mac.sh first." >&2
  exit 1
fi

# Belt-and-suspenders: collect_daily_news.py already clears these itself
# once it's running, but unsetting them here means a caller's environment
# never gets the chance to influence process startup or any subprocess this
# script itself might spawn before Python even starts.
unset PYTHONPATH PYTHONHOME VIRTUAL_ENV 2>/dev/null || true

echo "-- Collecting daily news via $VENV_PYTHON --"
exec "$VENV_PYTHON" "$COLLECTOR" "$@"
