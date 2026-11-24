#!/usr/bin/env python3
"""Morning Vietnam-topic news watch (08:30 Hermes cron).

Runs under backend/.venv (re-execs itself under that interpreter). Prints the
alert text to stdout only when there is something to report; on any failure it
writes to stderr and exits 1 so Hermes reports an error instead of delivering
a traceback as an alert.
"""
import os
import sys

os.environ.pop("PYTHONPATH", None)
os.environ.pop("PYTHONHOME", None)

_REPO_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.abspath(os.path.join(_REPO_SCRIPTS_DIR, "..", "backend"))
_VENV_PYTHON = os.path.join(_BACKEND_DIR, ".venv", "bin", "python")

if os.path.exists(_VENV_PYTHON) and os.path.realpath(sys.executable) != os.path.realpath(_VENV_PYTHON):
    os.execve(_VENV_PYTHON, [_VENV_PYTHON, os.path.abspath(__file__)] + sys.argv[1:], os.environ)

sys.path.insert(0, _BACKEND_DIR)


def main() -> int:
    import contextlib

    try:
        # init_db() and vnstock print banners to stdout; stdout must carry the
        # alert text only, so everything else goes to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            text = _run()
    except Exception as e:  # noqa: BLE001
        print(f"newswatch_morning failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    if text:
        print(text, end="")
    return 0


def _run() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from app.db import SessionLocal, init_db
    from app.newswatch.run import run_morning

    init_db()
    today = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date()
    db = SessionLocal()
    try:
        text = run_morning(db, today)
    finally:
        db.close()
    return text


if __name__ == "__main__":
    sys.exit(main())
