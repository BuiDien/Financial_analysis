"""Scheduler: the app's periodic background loops, one daemon thread each,
started and stopped together from the FastAPI lifespan.

Each scheduled job runs ``fn()`` every ``interval_s`` seconds. With
``run_immediately`` the first run happens at start, otherwise after one
interval. ``wake`` lets other code cut a wait short (the screener's
``request()`` does this). An exception from ``fn`` is printed and the loop
goes on. ``shutdown()`` stops every loop at its next wait.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class ScheduledJob:
    name: str
    fn: Callable[[], object]
    interval_s: float
    run_immediately: bool = False
    wake: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None
    stop: threading.Event | None = None  # the run this thread belongs to


class Scheduler:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, ScheduledJob] = {}
        self._stop: threading.Event | None = None

    def add(self, name: str, fn: Callable[[], object], interval_s: float, *,
            run_immediately: bool = False, wake: threading.Event | None = None) -> None:
        """Register (or redefine, when not running) a periodic job."""
        with self._lock:
            old = self._jobs.get(name)
            if old is not None and self._alive(old):
                return
            self._jobs[name] = ScheduledJob(
                name, fn, interval_s, run_immediately, wake or threading.Event())

    def start(self) -> None:
        with self._lock:
            if self._stop is None or self._stop.is_set():
                # Fresh stop event per run: threads of an earlier run keep
                # (and exit on) their own, already-set one.
                self._stop = threading.Event()
            stop = self._stop
            for job in self._jobs.values():
                if self._alive(job):
                    continue
                job.wake.clear()  # a previous shutdown() left it set
                job.stop = stop
                job.thread = threading.Thread(
                    target=self._loop, args=(job, stop), name=job.name, daemon=True)
                job.thread.start()

    def shutdown(self) -> None:
        with self._lock:
            if self._stop is not None:
                self._stop.set()
            for job in self._jobs.values():
                job.wake.set()

    def is_running(self, name: str) -> bool:
        job = self._jobs.get(name)
        return job is not None and self._alive(job)

    def names(self) -> list[str]:
        return list(self._jobs)

    @staticmethod
    def _alive(job: ScheduledJob) -> bool:
        return (job.thread is not None and job.thread.is_alive()
                and job.stop is not None and not job.stop.is_set())

    @staticmethod
    def _loop(job: ScheduledJob, stop: threading.Event) -> None:
        if not job.run_immediately:
            job.wake.wait(job.interval_s)
        while not stop.is_set():
            job.wake.clear()
            try:
                job.fn()
            except Exception as e:  # never let the thread die
                print(f"  {job.name} error: {e}")
            job.wake.wait(job.interval_s)
