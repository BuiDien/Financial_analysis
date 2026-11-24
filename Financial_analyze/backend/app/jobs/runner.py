"""JobRunner: a small pool of daemon worker threads executing registered job
kinds, each tracked by a row in the generic ``jobs`` table.

A job function has the signature ``fn(ctx: JobContext) -> dict | None``. It
opens its own sessions through ``ctx.session()`` (never a request session),
reports progress with ``ctx.report_progress(pct, message)`` and polls
``ctx.is_cancelled()`` / ``ctx.raise_if_cancelled()``: cancellation is only a
flag, the job decides when to stop. The return value is stored as ``result``;
an exception marks the job failed with the error text; ``JobCancelled`` marks
it cancelled.

Workers are daemon threads (like the ad-hoc threads they replace), so a long
job never blocks interpreter exit; work cut short by a restart is handled by
``recover()`` on the next startup.
"""

from __future__ import annotations

import logging
import queue
import threading
from concurrent.futures import Future
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import update

from ..models.jobs import Job

logger = logging.getLogger(__name__)

ACTIVE = ("queued", "running")
TERMINAL = ("done", "failed", "cancelled")
INTERRUPTED_MESSAGE = "interrupted by restart"


DEFAULT_LANE = "default"


class JobCancelled(Exception):
    """Raised by a job function (or ctx.raise_if_cancelled) to stop as cancelled."""


class JobFailed(Exception):
    """An expected failure (already explained by the job's domain row): the job
    is marked failed with this text, logged as a one-line warning, no traceback."""


@dataclass(frozen=True)
class KindSpec:
    """How a job kind runs and whether it may be cancelled.

    - ``cancellable``: a *queued* job of this kind may be cancelled.
    - ``cancel_running``: a *running* job may get the cancel flag; only for
      kinds whose fn really polls ``ctx.is_cancelled()``.
    - ``on_cancel(db, job)``: called in the same transaction that flips a queued
      job to cancelled, e.g. to close the matching domain row.
    - ``lane``: the worker pool the kind runs on. Each lane has its own worker
      threads (``JobRunner(lanes=...)``), so slow kinds (Ollama label reviews)
      never hold up the default lane (portfolio work).
    """

    fn: Callable[[JobContext], Any]
    cancellable: bool = False
    cancel_running: bool = False
    on_cancel: Callable[[Any, Job], None] | None = None
    lane: str = DEFAULT_LANE


class CancelOutcome:
    """Results of ``JobRunner.cancel_in_session``."""

    NOT_FOUND = "not_found"
    CANCELLED = "cancelled"            # was queued, now cancelled
    REQUESTED = "requested"            # running, cancel flag set
    NOT_CANCELLABLE = "not_cancellable"
    RUNNING = "running_not_cancellable"
    FINISHED = "finished"              # done/failed/cancelled already


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class JobContext:
    job_id: int
    kind: str
    payload: dict
    db_factory: Callable[[], Any]

    def session(self):
        """A new session for this job; the caller closes it (``with ctx.session() as db``)."""
        return self.db_factory()

    def report_progress(self, pct: int | float, message: str | None = None) -> None:
        pct = max(0, min(100, int(pct)))
        values: dict[str, Any] = {"progress": pct}
        if message is not None:
            values["message"] = message
        with self.db_factory() as db:
            db.execute(update(Job).where(Job.id == self.job_id).values(**values))
            db.commit()

    def is_cancelled(self) -> bool:
        with self.db_factory() as db:
            job = db.get(Job, self.job_id)
            return bool(job and job.cancel_requested)

    def raise_if_cancelled(self) -> None:
        if self.is_cancelled():
            raise JobCancelled()


@dataclass
class JobHandle:
    id: int
    future: Future = field(repr=False)

    def wait(self, timeout: float | None = None) -> str:
        """Block until the job finished; returns its final status."""
        return self.future.result(timeout)


class _Lane:
    """A queue and its worker threads (started on first use)."""

    def __init__(self) -> None:
        self.queue: queue.Queue = queue.Queue()
        self.threads: list[threading.Thread] = []


class _Generation:
    """One set of worker threads, per lane. ``shutdown()`` retires a generation;
    the next ``submit()`` starts a fresh one, so the runner survives repeated
    app lifespans (tests) without leaking work between them."""

    def __init__(self) -> None:
        self.lanes: dict[str, _Lane] = {}
        self.stopped = threading.Event()


class JobRunner:
    def __init__(self, db_factory: Callable[[], Any], max_workers: int = 2,
                 lanes: dict[str, int] | None = None):
        """``max_workers`` sizes the default lane; ``lanes`` sizes the others
        (a lane not listed gets one worker)."""
        self._db_factory = db_factory
        self._lane_workers = {name: max(1, int(n)) for name, n in (lanes or {}).items()}
        self._lane_workers[DEFAULT_LANE] = max(1, int(max_workers))
        self._kinds: dict[str, KindSpec] = {}
        self._lock = threading.Lock()
        self._gen: _Generation | None = None

    # ---- registry ----
    def register(self, kind: str, fn: Callable[[JobContext], Any], *,
                 cancellable: bool = False, cancel_running: bool = False,
                 on_cancel: Callable[[Any, Job], None] | None = None,
                 lane: str = DEFAULT_LANE) -> None:
        """Register a job kind. Kinds are not cancellable unless they say so
        (see ``KindSpec``)."""
        self._kinds[kind] = KindSpec(fn, cancellable, cancel_running, on_cancel, lane)

    def is_registered(self, kind: str) -> bool:
        return kind in self._kinds

    # ---- submit / execute ----
    def submit(self, kind: str, payload: dict | None = None, *, db_factory=None) -> JobHandle:
        """Record a queued ``jobs`` row and hand it to a worker.

        ``db_factory`` overrides the runner's session factory for this job (the
        jobs row and every ``ctx.session()``), e.g. to stay on the database the
        submitting request was bound to."""
        if kind not in self._kinds:
            raise KeyError(f"unknown job kind: {kind!r}")
        factory = db_factory or self._db_factory
        payload = dict(payload or {})
        with factory() as db:
            job = Job(kind=kind, status="queued", progress=0, payload=payload,
                      cancel_requested=False, created_at=_now())
            db.add(job)
            db.commit()
            job_id = job.id
        future: Future = Future()
        # Enqueue under the lock shutdown() takes: an item can never land
        # behind a retired generation's stop sentinels (its Future would never
        # resolve). A submit after shutdown() starts a fresh generation; that
        # is what lets the app lifespan run again in the same process.
        with self._lock:
            lane = self._lane_locked(self._kinds[kind].lane)
            lane.queue.put((job_id, kind, payload, factory, future))
        return JobHandle(job_id, future)

    def _lane_locked(self, name: str) -> _Lane:
        gen = self._gen
        if gen is None or gen.stopped.is_set():
            gen = self._gen = _Generation()
        lane = gen.lanes.get(name)
        if lane is None:
            lane = gen.lanes[name] = _Lane()
            prefix = "job-worker" if name == DEFAULT_LANE else f"job-worker-{name}"
            for n in range(self._lane_workers.get(name, 1)):
                t = threading.Thread(target=self._work, args=(gen, lane),
                                     name=f"{prefix}-{n}", daemon=True)
                lane.threads.append(t)
                t.start()
        return lane

    def _work(self, gen: _Generation, lane: _Lane) -> None:
        while True:
            item = lane.queue.get()
            if item is None:
                return
            job_id, kind, payload, factory, future = item
            if gen.stopped.is_set():
                # Left queued in the DB; recover() deals with it on next start.
                future.set_result("queued")
                continue
            try:
                future.set_result(self._execute(job_id, kind, payload, factory))
            except BaseException as exc:  # never let a worker die
                logger.exception("job %s (%s): runner error", job_id, kind)
                if not future.done():
                    future.set_exception(exc if isinstance(exc, Exception)
                                         else RuntimeError(f"{type(exc).__name__}: {exc}"))

    def _execute(self, job_id: int, kind: str, payload: dict, factory) -> str:
        with factory() as db:
            claimed = db.execute(
                update(Job).where(Job.id == job_id, Job.status == "queued")
                .values(status="running", started_at=_now())
            ).rowcount
            db.commit()
        if not claimed:  # cancelled while queued
            with factory() as db:
                job = db.get(Job, job_id)
                return job.status if job else "cancelled"
        ctx = JobContext(job_id=job_id, kind=kind, payload=payload, db_factory=factory)
        values: dict[str, Any]
        try:
            result = self._kinds[kind].fn(ctx)
            values = {"status": "done", "progress": 100, "result": result}
        except JobCancelled as exc:
            values = {"status": "cancelled", "message": str(exc) or "cancelled"}
        except JobFailed as exc:
            logger.warning("job %s (%s) failed: %s", job_id, kind, exc)
            values = {"status": "failed", "error": str(exc) or "failed"}
        except Exception as exc:
            logger.exception("job %s (%s) failed", job_id, kind)
            values = {"status": "failed", "error": str(exc) or type(exc).__name__}
        except BaseException as exc:
            # SystemExit (vnstock/vnai raise it outside their limiter) and the
            # like. Contained here so the row is finished and waiters get
            # "failed" instead of SystemExit re-raised in a server thread.
            # KeyboardInterrupt included: signals are delivered to the main
            # thread only, so on a worker it can only be an explicit raise and
            # swallowing it cannot block process shutdown.
            logger.exception("job %s (%s) aborted", job_id, kind)
            values = {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}
        values["finished_at"] = _now()
        try:
            self._finish(factory, job_id, values)
        except Exception as exc:  # e.g. a result that is not JSON-serialisable
            logger.exception("job %s (%s): could not store outcome", job_id, kind)
            values = {"status": "failed", "result": None, "finished_at": _now(),
                      "error": f"could not store job outcome: {exc}"}
            try:
                self._finish(factory, job_id, values)
            except Exception:  # DB unusable: recover() fixes the row on next start
                logger.exception("job %s (%s): could not store failure", job_id, kind)
        return values["status"]

    @staticmethod
    def _finish(factory, job_id: int, values: dict) -> None:
        with factory() as db:
            db.execute(update(Job).where(Job.id == job_id).values(**values))
            db.commit()

    # ---- control ----
    def cancel(self, job_id: int, *, db_factory=None) -> str:
        """Request cancellation; returns a ``CancelOutcome`` value."""
        factory = db_factory or self._db_factory
        with factory() as db:
            return self.cancel_in_session(db, job_id)

    def can_cancel(self, job: Job) -> bool:
        """Whether ``cancel_in_session`` would accept this job right now
        (mirrors its policy; used to show/hide the Cancel action)."""
        spec = self._kinds.get(job.kind)
        if spec is None or not spec.cancellable:
            return False
        if job.status == "queued":
            return True
        return job.status == "running" and spec.cancel_running

    def cancel_in_session(self, db, job_id: int) -> str:
        """Apply the kind's cancel policy (``KindSpec``) on ``db``.

        Queued + cancellable → cancelled now (plus ``on_cancel``, same
        transaction). Running + ``cancel_running`` → flag set, the job decides.
        Everything else is refused. Kinds not registered in this process are
        never cancellable."""
        job = db.get(Job, job_id)
        if job is None:
            return CancelOutcome.NOT_FOUND
        if job.status in TERMINAL:
            return CancelOutcome.FINISHED
        spec = self._kinds.get(job.kind)
        if spec is None or not spec.cancellable:
            return CancelOutcome.NOT_CANCELLABLE
        if job.status == "queued":
            claimed = db.execute(
                update(Job).where(Job.id == job_id, Job.status == "queued").values(
                    status="cancelled", cancel_requested=True, finished_at=_now(),
                    message="cancelled before start")
            ).rowcount
            if claimed:
                if spec.on_cancel is not None:
                    spec.on_cancel(db, job)
                db.commit()
                return CancelOutcome.CANCELLED
            db.rollback()
            db.refresh(job)  # a worker claimed it meanwhile
            if job.status in TERMINAL:
                return CancelOutcome.FINISHED
        if not spec.cancel_running:
            return CancelOutcome.RUNNING
        job.cancel_requested = True
        db.commit()
        return CancelOutcome.REQUESTED

    def recover(self, *, db_factory=None) -> int:
        """Startup: jobs a previous process left queued/running can never
        finish; mark them failed. Domain recovery (which may resubmit) runs
        afterwards. Returns the number of rows marked."""
        factory = db_factory or self._db_factory
        with factory() as db:
            n = db.execute(
                update(Job).where(Job.status.in_(ACTIVE)).values(
                    status="failed", error=INTERRUPTED_MESSAGE,
                    message=INTERRUPTED_MESSAGE, finished_at=_now())
            ).rowcount
            db.commit()
        return n

    def shutdown(self) -> None:
        """Retire the current workers. A running job finishes on its daemon
        thread (or dies with the process). Jobs still in the queue are not
        started: their rows stay queued (recover() fails them on next start)
        and their Futures resolve to "queued" as the workers drain the queue
        ahead of the stop sentinels."""
        with self._lock:
            gen, self._gen = self._gen, None
            if gen is None:
                return
            gen.stopped.set()
            for lane in gen.lanes.values():
                for _ in lane.threads:
                    lane.queue.put(None)
