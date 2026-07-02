from unittest.mock import patch

from app.services import scheduler


def test_scheduled_scan_calls_run_scan():
    with patch("app.services.scheduler.run_scan", return_value={"run_id": 1, "count": 0}) as m, \
         patch("app.services.scheduler.SessionLocal"):
        scheduler.scheduled_scan()
        assert m.called
        assert m.call_args.kwargs.get("mode") == "scheduled"


def test_scheduled_scan_swallows_errors():
    with patch("app.services.scheduler.run_scan", side_effect=RuntimeError("boom")), \
         patch("app.services.scheduler.SessionLocal"):
        scheduler.scheduled_scan()  # must not raise


def test_start_registers_daily_job():
    sched = scheduler.start(run=False)
    try:
        assert sched.get_job("scheduled_scan") is not None
    finally:
        scheduler.shutdown()
