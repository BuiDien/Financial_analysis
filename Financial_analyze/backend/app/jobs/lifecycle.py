"""App-lifespan hooks for background work: one ``startup()``, one ``shutdown()``."""

from __future__ import annotations

from . import runner, scheduler


def recover() -> None:
    """Restart recovery. Generic jobs first (left queued/running → failed),
    then the domain recoveries, which may resubmit their work as new jobs."""
    from ..services.ocr_label_review import recover_interrupted_runs
    from ..services.ocr_sync_attempts import recover_interrupted_attempts
    from ..services.portfolio_imports import recover_jobs

    runner.recover()
    recover_interrupted_attempts()
    recover_interrupted_runs()
    recover_jobs()


def register_schedules(settings) -> None:
    """The periodic loops, gated exactly as before."""
    from ..screener import refresh

    if refresh.should_boot_refresh(settings):
        scheduler.add(refresh.SCHEDULE_NAME, refresh.manager.tick, refresh.CHECK_EVERY_S,
                      run_immediately=True, wake=refresh.manager.wake_event)
    if settings.enable_gmail_poller:
        from ..services import gmail_poller

        scheduler.add(gmail_poller.SCHEDULE_NAME, gmail_poller.tick, gmail_poller.TICK_SECONDS)


def startup(settings) -> None:
    recover()
    register_schedules(settings)
    scheduler.start()


def shutdown() -> None:
    scheduler.shutdown()
    runner.shutdown()
