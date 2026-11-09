"""Background thread: every minute, run a Gmail check if auto-check is on and due."""
from __future__ import annotations

import threading
from datetime import datetime, timezone

from ..db import SessionLocal
from . import gmail_pull

TICK_SECONDS = 60

_thread: threading.Thread | None = None
_stop = threading.Event()


def tick() -> dict | None:
    """One poll step. Returns the check summary, or None if nothing ran."""
    db = SessionLocal()
    try:
        cfg = gmail_pull.get_config(db)
        if not gmail_pull.is_due(cfg, datetime.now(timezone.utc)):
            return None
        try:
            summary = gmail_pull.run_check(db)
            if summary.get("new"):
                print(f"✓ gmail check: {summary}")
            return summary
        except gmail_pull.GmailBusy:
            return None
        except gmail_pull.GmailError as e:
            print(f"  gmail check failed: {e}")
            return None
    finally:
        db.close()


def _loop():
    while not _stop.wait(TICK_SECONDS):
        try:
            tick()
        except Exception as e:  # never let the thread die
            print(f"  gmail poller error: {e}")


def start() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="gmail-poller", daemon=True)
    _thread.start()


def shutdown() -> None:
    _stop.set()
