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
import contextlib
from datetime import datetime

from app.services import news_collector


def _build_holdings() -> dict[str, list[str]]:
    """Ticker -> search names for current VN holdings; {} if anything fails."""
    from app.db import SessionLocal, init_db
    from app.newswatch import aliases, holdings as holdings_mod
    from app.newswatch.watch_config import load_watch_config
    from app.marketdata import get_provider

    init_db()
    cfg = load_watch_config()
    db = SessionLocal()
    try:
        try:
            aliases.refresh_official_names(db, get_provider())
        except Exception as e:  # noqa: BLE001
            print(f"official-name refresh skipped: {e}", file=sys.stderr)
        tickers = holdings_mod.current_vn_holdings(db, cfg["etf_tickers"])
        return {t: aliases.resolve(db, t, cfg).terms for t in tickers}
    finally:
        db.close()


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

    # init_db() and vnstock print banners to stdout; stdout must carry only the
    # confirmation line Hermes reads, so everything else goes to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        try:
            holdings = _build_holdings()
        except Exception as e:  # noqa: BLE001
            print(f"holdings unavailable, continuing without: {e}", file=sys.stderr)
            holdings = {}
        result = news_collector.collect_all_articles(date, holdings=holdings)
        path = news_collector.write_daily_note(date, result, overwrite_processed=args.force)
    for err in result.get("source_errors", []):
        print(f"source error: {err}", file=sys.stderr)

    print(f"Collected {result['total_articles']} articles for {date} → {path} — summarize them.")


if __name__ == "__main__":
    main()
