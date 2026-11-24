"""app.jobs: JobRunner, Scheduler, lifecycle recovery, and /api/jobs."""

import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base, get_db, import_models
from app.jobs import CancelOutcome, JobCancelled, JobRunner, Scheduler
from app.jobs.runner import KindSpec
from app.jobs import lifecycle
from app.main import app
from app.models.jobs import Job
from app.models.portfolio import Portfolio, PortfolioJob


@pytest.fixture
def factory(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'jobs.db'}",
                        connect_args={"check_same_thread": False})
    import_models()
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def runner(factory):
    r = JobRunner(factory, max_workers=2)
    yield r
    r.shutdown()


def _row(factory, job_id) -> Job:
    with factory() as db:
        job = db.get(Job, job_id)
        db.expunge(job)
        return job


# ---- JobRunner -----------------------------------------------------------------


def test_submit_runs_job_and_stores_result(runner, factory):
    seen = {}

    def fn(ctx):
        seen["payload"] = ctx.payload
        with ctx.session() as db:  # its own session, on the runner's database
            seen["count"] = db.query(Job).count()
        return {"doubled": ctx.payload["n"] * 2}

    runner.register("double", fn)
    handle = runner.submit("double", {"n": 21})
    assert handle.wait(5) == "done"
    job = _row(factory, handle.id)
    assert (job.kind, job.status, job.progress) == ("double", "done", 100)
    assert job.payload == {"n": 21} and job.result == {"doubled": 42}
    assert job.started_at and job.finished_at and job.error is None
    assert seen == {"payload": {"n": 21}, "count": 1}


def test_unknown_kind_is_rejected(runner):
    with pytest.raises(KeyError):
        runner.submit("nope")


def test_progress_is_persisted_while_running(runner, factory):
    reported, release = threading.Event(), threading.Event()

    def fn(ctx):
        ctx.report_progress(40, "halfway-ish")
        reported.set()
        release.wait(5)

    runner.register("slow", fn)
    handle = runner.submit("slow")
    assert reported.wait(5)
    job = _row(factory, handle.id)
    assert (job.status, job.progress, job.message) == ("running", 40, "halfway-ish")
    release.set()
    assert handle.wait(5) == "done"
    assert _row(factory, handle.id).progress == 100


def test_failure_is_captured_and_worker_survives(runner, factory):
    def boom(ctx):
        raise ValueError("bad input")

    runner.register("boom", boom)
    runner.register("ok", lambda ctx: None)
    handle = runner.submit("boom")
    assert handle.wait(5) == "failed"
    job = _row(factory, handle.id)
    assert job.error == "bad input" and job.finished_at is not None
    assert runner.submit("ok").wait(5) == "done"


def test_unserialisable_result_fails_instead_of_sticking_running(runner, factory):
    runner.register("weird", lambda ctx: {"obj": object()})
    handle = runner.submit("weird")
    assert handle.wait(5) == "failed"
    assert "could not store job outcome" in _row(factory, handle.id).error


def test_cancel_running_sets_flag_and_job_decides(runner, factory):
    started = threading.Event()

    def fn(ctx):
        started.set()
        for _ in range(500):
            ctx.raise_if_cancelled()
            time.sleep(0.01)
        return {"finished": True}

    runner.register("loop", fn, cancellable=True, cancel_running=True)
    handle = runner.submit("loop")
    assert started.wait(5)
    assert runner.cancel(handle.id) == CancelOutcome.REQUESTED
    assert handle.wait(5) == "cancelled"
    job = _row(factory, handle.id)
    assert job.status == "cancelled" and job.cancel_requested


def test_cancel_queued_job_never_runs(factory):
    runner = JobRunner(factory, max_workers=1)
    release, ran = threading.Event(), []
    runner.register("block", lambda ctx: release.wait(5))
    runner.register("mark", lambda ctx: ran.append(ctx.job_id), cancellable=True)
    blocker = runner.submit("block")
    queued = runner.submit("mark")
    assert runner.cancel(queued.id) == CancelOutcome.CANCELLED
    assert runner.cancel(queued.id) == CancelOutcome.FINISHED  # re-cancel refused
    release.set()
    assert blocker.wait(5) == "done"
    assert queued.wait(5) == "cancelled"
    assert ran == []
    runner.shutdown()


def test_cancel_flag_is_ignorable(runner):
    started, release = threading.Event(), threading.Event()

    def fn(ctx):
        started.set()
        release.wait(5)
        return {"cancelled_seen": ctx.is_cancelled()}

    runner.register("stubborn", fn, cancellable=True, cancel_running=True)
    handle = runner.submit("stubborn")
    assert started.wait(5)
    runner.cancel(handle.id)
    release.set()
    assert handle.wait(5) == "done"


def test_slow_ocr_lane_does_not_delay_default_lane(factory):
    """A long label review (own "ocr" lane) must not hold up portfolio work,
    even with a single default-lane worker; same jobs table either way."""
    runner = JobRunner(factory, max_workers=1, lanes={"ocr": 1})
    started, release = threading.Event(), threading.Event()

    def slow(ctx):
        started.set()
        release.wait(10)

    runner.register("t.slow_review", slow, lane="ocr")
    runner.register("t.portfolio", lambda ctx: {"ok": True})
    try:
        review = runner.submit("t.slow_review")
        assert started.wait(5)
        second_review = runner.submit("t.slow_review")  # queued behind it on "ocr"
        portfolio = runner.submit("t.portfolio")
        assert portfolio.wait(5) == "done"  # while the review still runs
        assert _row(factory, review.id).status == "running"
        assert _row(factory, second_review.id).status == "queued"  # ocr lane = 1 worker
    finally:
        release.set()
    assert review.wait(5) == "done" and second_review.wait(5) == "done"
    runner.shutdown()


def test_registered_kinds_use_their_lanes():
    import app.jobs.ocr  # noqa: F401 (registers ocr_label_review)
    import app.jobs.portfolio  # noqa: F401
    from app.jobs import runner as app_runner

    kinds = app_runner._kinds
    assert kinds["ocr_label_review"].lane == "ocr"
    assert kinds["portfolio.import"].lane == "default"
    assert kinds["portfolio.rebuild"].lane == "default"
    from app.config import get_settings

    settings = get_settings()
    assert app_runner._lane_workers == {"default": settings.job_workers,
                                        "ocr": settings.job_ocr_workers}


def test_job_failed_marks_failed_with_one_line_warning(runner, factory, caplog):
    from app.jobs import JobFailed

    def fn(ctx):
        raise JobFailed("Ollama timed out")

    runner.register("t.expected_failure", fn)
    with caplog.at_level("WARNING", logger="app.jobs.runner"):
        handle = runner.submit("t.expected_failure")
        assert handle.wait(5) == "failed"
    job = _row(factory, handle.id)
    assert job.error == "Ollama timed out"
    records = [r for r in caplog.records if r.name == "app.jobs.runner"]
    assert [r.levelname for r in records] == ["WARNING"]
    assert records[0].exc_info is None


def test_job_cancelled_raised_directly(runner):
    def fn(ctx):
        raise JobCancelled("user stop")

    runner.register("stop", fn)
    assert runner.submit("stop").wait(5) == "cancelled"


def test_cancel_policy_refusals(factory):
    runner = JobRunner(factory, max_workers=1)
    started, release = threading.Event(), threading.Event()
    hooks = []

    def block(ctx):
        started.set()
        release.wait(5)

    runner.register("block", block, cancellable=True,
                    on_cancel=lambda db, job: hooks.append(job.id))
    runner.register("plain", lambda ctx: None)  # default: not cancellable
    running = runner.submit("block")
    assert started.wait(5)
    plain = runner.submit("plain")
    assert runner.cancel(plain.id) == CancelOutcome.NOT_CANCELLABLE
    # cancellable while queued only: a running job of this kind is refused
    assert runner.cancel(running.id) == CancelOutcome.RUNNING
    assert hooks == []
    release.set()
    assert running.wait(5) == "done" and plain.wait(5) == "done"
    assert runner.cancel(running.id) == CancelOutcome.FINISHED
    assert runner.cancel(999) == CancelOutcome.NOT_FOUND
    runner.shutdown()


def test_on_cancel_hook_runs_in_cancel_transaction(factory):
    runner = JobRunner(factory, max_workers=1)
    release, hooks = threading.Event(), []
    runner.register("block", lambda ctx: release.wait(5))
    runner.register("hooked", lambda ctx: None, cancellable=True,
                    on_cancel=lambda db, job: hooks.append((job.id, job.payload)))
    blocker = runner.submit("block")
    queued = runner.submit("hooked", {"x": 1})
    assert runner.cancel(queued.id) == CancelOutcome.CANCELLED
    assert hooks == [(queued.id, {"x": 1})]
    release.set()
    assert blocker.wait(5) == "done" and queued.wait(5) == "cancelled"
    runner.shutdown()


@pytest.mark.parametrize("exc", [SystemExit(1), KeyboardInterrupt()])
def test_base_exception_marks_failed_and_resolves_wait(runner, factory, exc):
    def fn(ctx):
        raise exc

    runner.register("exit", fn)
    handle = runner.submit("exit")
    assert handle.wait(5) == "failed"
    job = _row(factory, handle.id)
    assert job.status == "failed" and job.error.startswith(type(exc).__name__)
    assert job.finished_at is not None
    runner.register("ok", lambda ctx: None)
    assert runner.submit("ok").wait(5) == "done"  # worker survived


def test_shutdown_resolves_queued_futures(factory):
    runner = JobRunner(factory, max_workers=1)
    started, release = threading.Event(), threading.Event()

    def block(ctx):
        started.set()
        release.wait(5)

    runner.register("block", block)
    runner.register("ok", lambda ctx: None)
    first = runner.submit("block")
    assert started.wait(5)
    pending = [runner.submit("ok") for _ in range(3)]
    runner.shutdown()
    release.set()
    assert first.wait(5) == "done"
    assert [h.wait(5) for h in pending] == ["queued"] * 3
    assert _row(factory, pending[0].id).status == "queued"  # left for recover()


def test_submit_racing_shutdown_never_hangs(factory):
    runner = JobRunner(factory, max_workers=2)
    runner.register("ok", lambda ctx: None)
    handles, stop = [], threading.Event()

    def submitter():
        while not stop.is_set():
            handles.append(runner.submit("ok"))

    t = threading.Thread(target=submitter)
    t.start()
    for _ in range(20):
        runner.shutdown()
        time.sleep(0.002)
    stop.set()
    t.join(5)
    runner.shutdown()
    assert handles
    assert all(h.wait(5) in ("done", "queued") for h in handles)


def test_recover_marks_leftover_jobs_failed(runner, factory):
    with factory() as db:
        db.add_all([Job(kind="k", status=s, progress=0) for s in
                    ("queued", "running", "done", "failed", "cancelled")])
        db.commit()
    assert runner.recover() == 2
    with factory() as db:
        rows = {j.id: j for j in db.query(Job).all()}
    assert [rows[i].status for i in sorted(rows)] == ["failed", "failed", "done", "failed",
                                                      "cancelled"]
    assert rows[1].error == rows[2].error == "interrupted by restart"
    assert rows[4].error is None


def test_runner_restarts_after_shutdown(runner):
    runner.register("ok", lambda ctx: None)
    assert runner.submit("ok").wait(5) == "done"
    runner.shutdown()
    assert runner.submit("ok").wait(5) == "done"


# ---- Scheduler -----------------------------------------------------------------


def test_scheduler_runs_immediately_and_on_wake_then_stops():
    s = Scheduler()
    calls, wake = [], threading.Event()
    s.add("t", lambda: calls.append(1), 60, run_immediately=True, wake=wake)
    s.start()
    _until(lambda: len(calls) == 1)
    assert s.is_running("t")
    wake.set()  # e.g. RefreshManager.request()
    _until(lambda: len(calls) == 2)
    s.shutdown()
    assert not s.is_running("t")
    time.sleep(0.05)
    assert len(calls) == 2


def test_scheduler_waits_one_interval_first_and_survives_errors():
    s = Scheduler()
    calls = []

    def fn():
        calls.append(1)
        raise RuntimeError("flaky")

    first = threading.Event()
    stamps = []

    def stamped():
        stamps.append(time.monotonic())
        first.set()
        fn()

    s.add("t", stamped, 0.2)
    t0 = time.monotonic()
    s.start()
    assert first.wait(5)
    assert stamps[0] - t0 >= 0.19  # not run at start: one interval first
    _until(lambda: len(calls) >= 2)  # an error did not stop the loop
    s.shutdown()


def test_scheduler_can_start_again_after_shutdown():
    s = Scheduler()
    calls = []
    s.add("t", lambda: calls.append(1), 60, run_immediately=True)
    s.start()
    _until(lambda: len(calls) == 1)
    s.shutdown()
    s.start()
    _until(lambda: len(calls) == 2)
    assert s.is_running("t")
    s.shutdown()


def _until(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > end:
            raise AssertionError("condition not met in time")
        time.sleep(0.005)


# ---- lifecycle -----------------------------------------------------------------


def test_lifecycle_recover_runs_generic_then_domain(monkeypatch):
    order = []
    from app.services import ocr_label_review, ocr_sync_attempts, portfolio_imports

    monkeypatch.setattr(lifecycle.runner, "recover", lambda: order.append("jobs"))
    monkeypatch.setattr(ocr_sync_attempts, "recover_interrupted_attempts",
                        lambda: order.append("sync"))
    monkeypatch.setattr(ocr_label_review, "recover_interrupted_runs",
                        lambda: order.append("label_review"))
    monkeypatch.setattr(portfolio_imports, "recover_jobs", lambda: order.append("portfolio"))
    lifecycle.recover()
    assert order == ["jobs", "sync", "label_review", "portfolio"]


def test_register_schedules_honours_gating(monkeypatch):
    from types import SimpleNamespace as NS

    added = []
    monkeypatch.setattr(lifecycle.scheduler, "add", lambda name, *a, **k: added.append(name))
    lifecycle.register_schedules(NS(enable_screener_refresh=True, screener_provider="fixture",
                                    enable_gmail_poller=False))
    assert added == []
    lifecycle.register_schedules(NS(enable_screener_refresh=True, screener_provider="vnstock",
                                    enable_gmail_poller=True))
    assert added == ["screener-refresh", "gmail-poller"]


def test_portfolio_recover_jobs_resubmits_on_runner(factory, monkeypatch):
    from app import db as db_module
    from app.jobs import portfolio as portfolio_jobs
    from app.services import portfolio_imports

    with factory() as db:
        p = Portfolio(name="Main", display_currency="VND")
        db.add(p)
        db.flush()
        db.add(PortfolioJob(id="pf_1", portfolio_id=p.id, type="rebuild", status="running"))
        db.commit()
    monkeypatch.setattr(db_module, "SessionLocal", factory)
    submitted = []
    monkeypatch.setattr(portfolio_imports, "submit_portfolio_job",
                        lambda f, jid, jtype: submitted.append((f, jid, jtype)))
    portfolio_imports.recover_jobs()
    assert submitted == [(factory, "pf_1", "rebuild")]
    with factory() as db:
        assert db.get(PortfolioJob, "pf_1").status == "interrupted"
    assert portfolio_jobs.submit_portfolio_job  # module import side effect: kinds registered
    assert lifecycle.runner.is_registered("portfolio.rebuild")


# ---- /api/jobs -----------------------------------------------------------------


@pytest.fixture
def client(factory):
    def override():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = override
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(factory, *rows):
    with factory() as db:
        objs = [Job(progress=0, **r) for r in rows]
        db.add_all(objs)
        db.commit()
        return [o.id for o in objs]


def test_api_lists_newest_first_with_filters_and_limit(client, factory):
    _seed(factory, {"kind": "a", "status": "done"}, {"kind": "b", "status": "failed"},
          {"kind": "a", "status": "running"})
    items = client.get("/api/jobs").json()["items"]
    assert [j["id"] for j in items] == [3, 2, 1]
    assert [j["id"] for j in client.get("/api/jobs?kind=a").json()["items"]] == [3, 1]
    assert [j["id"] for j in client.get("/api/jobs?status=failed").json()["items"]] == [2]
    assert [j["id"] for j in client.get("/api/jobs?limit=1").json()["items"]] == [3]
    assert client.get("/api/jobs?status=bogus").status_code == 422
    assert client.get("/api/jobs?limit=0").status_code == 422


def test_api_get_job_shape_and_404(client, factory):
    (jid,) = _seed(factory, {"kind": "portfolio.import", "status": "done",
                             "payload": {"portfolio_job_id": "imp_x"},
                             "result": {"status": "completed"}})
    body = client.get(f"/api/jobs/{jid}").json()
    assert set(body) == {"id", "kind", "status", "progress", "message", "payload", "result",
                         "error", "cancel_requested", "cancellable", "created_at",
                         "started_at", "finished_at"}
    assert body["cancellable"] is False  # finished (and not a registered kind here)
    assert body["payload"] == {"portfolio_job_id": "imp_x"}
    assert body["created_at"].endswith("+00:00")
    assert client.get("/api/jobs/999").status_code == 404


@pytest.fixture
def api_kinds(monkeypatch):
    """Kinds with each cancel policy on the app's runner (removed afterwards)."""
    from app.jobs import runner as app_runner

    for kind, spec in {
        "t.flag": KindSpec(lambda ctx: None, cancellable=True, cancel_running=True),
        "t.queued_only": KindSpec(lambda ctx: None, cancellable=True),
        "t.never": KindSpec(lambda ctx: None),
    }.items():
        monkeypatch.setitem(app_runner._kinds, kind, spec)


def test_api_cancel(client, factory, api_kinds):
    queued, running, done, q_only_running, never = _seed(
        factory, {"kind": "t.flag", "status": "queued"},
        {"kind": "t.flag", "status": "running"}, {"kind": "t.flag", "status": "done"},
        {"kind": "t.queued_only", "status": "running"}, {"kind": "t.never", "status": "queued"})
    r = client.post(f"/api/jobs/{queued}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    r = client.post(f"/api/jobs/{queued}/cancel")  # re-cancel
    assert r.status_code == 409 and r.json()["detail"] == "Job is already cancelled"
    r = client.post(f"/api/jobs/{running}/cancel")
    assert r.status_code == 200
    assert (r.json()["status"], r.json()["cancel_requested"]) == ("running", True)
    assert client.post(f"/api/jobs/{done}/cancel").status_code == 409
    r = client.post(f"/api/jobs/{q_only_running}/cancel")
    assert r.status_code == 409
    assert r.json()["detail"] == "Job is running and cannot be cancelled"
    r = client.post(f"/api/jobs/{never}/cancel")
    assert r.status_code == 409
    assert r.json()["detail"] == "This kind of job cannot be cancelled"
    assert client.post("/api/jobs/999/cancel").status_code == 404


def test_api_exposes_cancellable_per_policy(client, factory, api_kinds):
    ids = _seed(factory, {"kind": "t.flag", "status": "queued"},
                {"kind": "t.flag", "status": "running"},
                {"kind": "t.queued_only", "status": "queued"},
                {"kind": "t.queued_only", "status": "running"},
                {"kind": "t.never", "status": "queued"},
                {"kind": "t.flag", "status": "done"},
                {"kind": "unregistered", "status": "queued"})
    got = {j["id"]: j["cancellable"] for j in client.get("/api/jobs").json()["items"]}
    assert [got[i] for i in ids] == [True, True, True, False, False, False, False]


def _portfolio_job(factory, job_id, job_type, status="queued", progress=10):
    with factory() as db:
        p = db.query(Portfolio).first()
        if p is None:
            p = Portfolio(name="Main", display_currency="VND")
            db.add(p)
            db.flush()
        p.projection_status = "rebuilding" if job_type != "import" else "ready"
        db.add(PortfolioJob(id=job_id, portfolio_id=p.id, type=job_type, status=status,
                            progress=progress))
        db.commit()


@pytest.mark.parametrize("kind, job_type, progress, projection", [
    ("portfolio.import", "import", 10, "ready"),      # ledger untouched
    ("portfolio.import", "import", 60, "failed"),     # ledger written, not rebuilt
    ("portfolio.rebuild", "rebuild", 0, "failed"),    # SSI import / ledger rebuilds
])
def test_api_cancel_queued_portfolio_job_closes_domain_row(
        client, factory, monkeypatch, kind, job_type, progress, projection):
    import app.jobs.portfolio  # noqa: F401 — registers the portfolio kinds
    from app.services import portfolio_imports

    _portfolio_job(factory, "pf_q", job_type, progress=progress)
    (jid,) = _seed(factory, {"kind": kind, "status": "queued",
                             "payload": {"portfolio_job_id": "pf_q"}})
    r = client.post(f"/api/jobs/{jid}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    with factory() as db:
        domain = db.get(PortfolioJob, "pf_q")
        assert (domain.status, domain.error) == ("failed", "cancelled before start")
        assert domain.completed_at is not None
        assert db.get(Portfolio, domain.portfolio_id).projection_status == projection
    # The UI poll ends ...
    assert client.get("/api/portfolio/jobs/pf_q").json()["status"] == "failed"
    # ... and restart recovery does not resubmit it.
    from app import db as db_module

    submitted = []
    monkeypatch.setattr(db_module, "SessionLocal", factory)
    monkeypatch.setattr(portfolio_imports, "submit_portfolio_job",
                        lambda *a: submitted.append(a))
    portfolio_imports.recover_jobs()
    assert submitted == []


@pytest.mark.parametrize("kind, job_type", [("portfolio.import", "import"),
                                            ("portfolio.rebuild", "rebuild")])
def test_api_cancel_running_portfolio_job_is_refused(client, factory, kind, job_type):
    import app.jobs.portfolio  # noqa: F401

    _portfolio_job(factory, "pf_r", job_type, status="running")
    (jid,) = _seed(factory, {"kind": kind, "status": "running",
                             "payload": {"portfolio_job_id": "pf_r"}})
    r = client.post(f"/api/jobs/{jid}/cancel")
    assert r.status_code == 409
    assert r.json()["detail"] == "Job is running and cannot be cancelled"
    with factory() as db:
        assert db.get(Job, jid).cancel_requested is False
        assert db.get(PortfolioJob, "pf_r").status == "running"


def test_portfolio_import_commit_is_tracked_as_generic_job(client, factory, monkeypatch):
    import io

    from app.services import portfolio_engine as engine

    monkeypatch.setattr(engine.market, "get_quote",
                        lambda t: {"ticker": t, "price": 10, "change": 0, "ts": 0})
    monkeypatch.setattr(engine.market, "get_history", lambda *a, **k: [])
    csv_text = "kind,when,ccy,amount\nDEPOSIT,2026-01-02T03:00:00Z,USD,100\n"
    iid = client.post("/api/portfolio/imports/preview", files={
        "file": ("a.csv", io.BytesIO(csv_text.encode()), "text/csv")}).json()["import_id"]
    client.post(f"/api/portfolio/imports/{iid}/validate", json={"mapping": {
        "kind": "type", "when": "effective_at", "ccy": "currency", "amount": "cash_amount"}})
    assert client.post(f"/api/portfolio/imports/{iid}/commit").status_code == 200
    items = client.get("/api/jobs?kind=portfolio.import").json()["items"]
    assert len(items) == 1
    assert items[0]["status"] == "done"
    assert items[0]["payload"]["portfolio_job_id"] == iid
    assert items[0]["result"] == {"portfolio_job_id": iid, "status": "completed"}
