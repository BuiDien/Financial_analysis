"""Gmail auto-check: every minute, run a check if auto-check is on and due.
The loop runs on app.jobs.scheduler (registered in app.jobs.lifecycle)."""
from __future__ import annotations

from datetime import datetime, timezone

from ..db import SessionLocal
from . import gmail_pull

TICK_SECONDS = 60
SCHEDULE_NAME = "gmail-poller"


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
