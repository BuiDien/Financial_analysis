#!/usr/bin/env python3
"""Daily news collector — cron entrypoint for Hermes.

Runs under backend/.venv (yfinance/pandas/numpy live there, not necessarily
in whatever python Hermes's cron scheduler invokes this with) — re-execs
itself under that interpreter if it isn't already running under it, so
`hermes cron --script` works regardless of which python3 it calls.

Registered as ~/.hermes/scripts/collect_daily_news.py (a symlink to this
file — see docs/superpowers/plans/2026-07-07-daily-news-digest.md Task 6).
"""
import os
import sys

# Clear PYTHONPATH/PYTHONHOME before anything else. Whoever invokes this
# script (Hermes's agent shell, a cron scheduler, a manual terminal) may
# have its own venv's site-packages on PYTHONPATH — if so it rides along
# even after the re-exec below switches the interpreter *binary*, and a
# numpy C-extension built for a different Python ends up shadowing the
# venv's own numpy (ImportError / ABI mismatch). Same fix the standalone
# root-level news_collector.py already had; carried over here.
os.environ.pop("PYTHONPATH", None)
os.environ.pop("PYTHONHOME", None)

_REPO_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.abspath(os.path.join(_REPO_SCRIPTS_DIR, "..", "backend"))
_VENV_PYTHON = os.path.join(_BACKEND_DIR, ".venv", "bin", "python")

if os.path.exists(_VENV_PYTHON) and os.path.realpath(sys.executable) != os.path.realpath(_VENV_PYTHON):
    os.execve(_VENV_PYTHON, [_VENV_PYTHON, os.path.abspath(__file__)] + sys.argv[1:], os.environ)

sys.path.insert(0, _BACKEND_DIR)

import argparse
from datetime import datetime

from app.services import news_collector


def main():
    parser = argparse.ArgumentParser(description="Daily news collector — writes today's raw vault note")
    parser.add_argument("--date", default="today", help="YYYY-MM-DD or 'today'")
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an already processed note (destroys its existing summaries)",
    )
    args = parser.parse_args()

    date = datetime.now().strftime("%Y-%m-%d") if args.date == "today" else args.date

    result = news_collector.collect_all_articles(date)
    path = news_collector.write_daily_note(date, result, overwrite_processed=args.force)

    print(f"Collected {result['total_articles']} articles for {date} → {path} — summarize them.")


if __name__ == "__main__":
    main()
