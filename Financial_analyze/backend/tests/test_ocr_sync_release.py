"""release_worker_jobs must persist even when its handler task is cancelled.

Regression for the flaky test_worker_disconnect_while_holding_or_stopping_*:
the disconnect cleanup awaited ``asyncio.to_thread(persist_released_jobs)``.
Cancelling that await (server shutdown; the test client cancels the socket
handler right after the disconnect) cancels the executor future, and when no
thread has picked the work up yet it never runs: the DB kept "processing".
Here the executor's only thread is kept busy so the work is certainly still
queued when the cancel lands.
"""
import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from app.services import ocr_sync_attempts, ocr_sync_coordinator
from app.services.ocr_sync_coordinator import coordinator


def test_cancelled_release_still_persists(monkeypatch):
    persisted = []
    done = threading.Event()

    def record(entries):
        persisted.extend(entries)
        done.set()

    monkeypatch.setattr(ocr_sync_coordinator, "persist_released_jobs", record)
    monkeypatch.setattr(coordinator, "jobs", {
        "j1": {"id": "j1", "workerId": "w1", "status": "stopping", "kind": "inbox",
               "db_bind": "bind", "attemptId": 7},
    })
    gate = threading.Event()
    executor = ThreadPoolExecutor(max_workers=1)

    async def scenario():
        asyncio.get_running_loop().set_default_executor(executor)
        executor.submit(gate.wait)  # occupy the only worker thread
        task = asyncio.create_task(ocr_sync_coordinator.release_worker_jobs("w1"))
        await asyncio.sleep(0)  # task runs up to its executor await
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # Not asyncio.run(): closing it would wait on the gated executor.
    try:
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(scenario())
        finally:
            gate.set()  # free the thread; the queued release may now run
            assert done.wait(5), "cancelled release dropped its DB write"
            loop.close()
    finally:
        gate.set()
        executor.shutdown(wait=True)

    assert coordinator.jobs["j1"]["status"] == "stopped"
    assert persisted == [("bind", 7, "stop")]


def _cancel_while_queued(make_coro):
    """Run make_coro() with the executor's only thread busy, cancel it while its
    work is still queued, then free the thread."""
    gate = threading.Event()
    executor = ThreadPoolExecutor(max_workers=1)

    async def scenario():
        asyncio.get_running_loop().set_default_executor(executor)
        executor.submit(gate.wait)
        task = asyncio.create_task(make_coro())
        await asyncio.sleep(0)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return "cancelled"
        return "finished"

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(scenario())
    finally:
        gate.set()
        # Like asyncio.run's close: wait for the executor while the loop runs,
        # so callbacks from work finishing after the cancel are delivered.
        loop.run_until_complete(loop.shutdown_default_executor())
        loop.run_until_complete(asyncio.sleep(0))
        loop.close()


def test_cancelled_run_db_still_writes():
    """run_db (every OCR sync DB write) is shielded the same way."""
    done = threading.Event()
    assert _cancel_while_queued(
        lambda: ocr_sync_attempts.run_db(None, lambda db: done.set())) == "cancelled"
    assert done.wait(5), "cancelled run_db dropped its write"


def test_failure_after_cancel_is_logged(caplog):
    def boom():
        raise RuntimeError("disk full")

    with caplog.at_level(logging.ERROR, logger=ocr_sync_attempts.__name__):
        assert _cancel_while_queued(lambda: ocr_sync_attempts.run_shielded(boom)) == "cancelled"
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(errors) == 1 and "disk full" in str(errors[0].exc_info[1])


def test_one_bad_release_entry_does_not_abort_the_rest(monkeypatch, caplog):
    calls = []

    def fail_by_id(db, attempt_id, error):
        calls.append(attempt_id)
        if attempt_id == 1:
            raise RuntimeError("locked")

    monkeypatch.setattr(ocr_sync_attempts, "fail_attempt_by_id", fail_by_id)
    with caplog.at_level(logging.ERROR, logger=ocr_sync_attempts.__name__):
        ocr_sync_attempts.persist_released_jobs([(None, 1, None), (None, 2, None)])
    assert calls == [1, 2]
    assert any("attempt 1" in r.getMessage() for r in caplog.records)
