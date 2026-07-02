"""APScheduler background jobs. v1: the daily VN market scan."""
from apscheduler.schedulers.background import BackgroundScheduler

from ..db import SessionLocal
from ..scanner.runner import run_scan

_scheduler: BackgroundScheduler | None = None


def scheduled_scan():
    db = SessionLocal()
    try:
        summary = run_scan(db, mode="scheduled")
        print(f"✓ scheduled scan complete: {summary}")
    except Exception as e:
        print(f"  scheduled scan failed: {e}")
    finally:
        db.close()


def start(run: bool = True) -> BackgroundScheduler:
    """Create the scheduler and register jobs. run=False for tests."""
    global _scheduler
    if _scheduler is None:
        _scheduler = BackgroundScheduler()
        _scheduler.add_job(scheduled_scan, "interval", hours=24, id="scheduled_scan")
    if run and not _scheduler.running:
        _scheduler.start()
    return _scheduler


def shutdown():
    global _scheduler
    if _scheduler is not None:
        if _scheduler.running:
            _scheduler.shutdown(wait=False)
        _scheduler = None
