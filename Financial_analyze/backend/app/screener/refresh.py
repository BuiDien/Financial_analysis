"""Background refresh of screener data: prices daily, financials weekly, resumable."""
from __future__ import annotations

import threading
from datetime import datetime, time as dtime, timedelta, timezone

from ..db import SessionLocal
from ..models.screener import TickerMetrics
from ..marketdata import VN_TZ, drop_partial_bar, registry
from ..marketdata.ratelimit import RateLimited
from . import store

CLOSE = dtime(15, 0)
FINANCIALS_MAX_AGE = timedelta(days=7)
CHECK_EVERY_S = 600
SCHEDULE_NAME = "screener-refresh"  # its loop runs on app.jobs.scheduler
KINDS = ("prices", "financials")
# A ticker that aborts the run on a rate limit this many times in a row gets a
# per-ticker error and is skipped for the rest of that run (else every tick
# would abort on it again).
RATE_LIMIT_STRIKES = 2


def last_trading_close(now: datetime) -> datetime:
    n = now.astimezone(VN_TZ)
    d = n.date()
    if not (d.weekday() <= 4 and n.time() >= CLOSE):
        d -= timedelta(days=1)
        while d.weekday() > 4:
            d -= timedelta(days=1)
    return datetime.combine(d, CLOSE, tzinfo=VN_TZ)


def is_stale(as_of: datetime | None, now: datetime) -> bool:
    return as_of is None or as_of < last_trading_close(now)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite hands datetimes back naive; they are UTC."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _parse(v) -> datetime | None:
    return _aware(datetime.fromisoformat(v)) if v else None


def should_boot_refresh(settings) -> bool:
    """Never run the refresh thread on the fixture provider: it would write fake
    tickers into the real database."""
    return bool(settings.enable_screener_refresh) and settings.screener_provider != "fixture"


class RefreshManager:
    def __init__(self, db_factory, provider_factory, clock):
        self._db_factory = db_factory
        self._provider_factory = provider_factory
        self._clock = clock
        self._lock = threading.Lock()
        self._queue: list[str] = []
        self._running: str | None = None
        self._done = 0
        self._total = 0
        self._started_at: str | None = None
        self._last_error: str | None = None
        self._wake = threading.Event()
        self._strikes: dict[tuple[str, str], int] = {}       # (kind, symbol) -> aborts
        self._given_up: dict[tuple[str, str], set[str]] = {}  # (kind, run started) -> symbols

    # ---- public ----
    def status(self) -> dict:
        with self._db_factory() as db:
            p = store.get_state(db, "prices_as_of")
            f = store.get_state(db, "financials_as_of")
        with self._lock:
            return {"running": self._running is not None, "kind": self._running,
                    "done": self._done, "total": self._total,
                    "started_at": self._started_at, "queued": list(self._queue),
                    "prices_as_of": p, "financials_as_of": f,
                    "last_error": self._last_error}

    def is_booted(self) -> bool:
        from ..jobs import scheduler

        return scheduler.is_running(SCHEDULE_NAME)

    @property
    def wake_event(self) -> threading.Event:
        """Set by request() to cut the scheduler's wait short."""
        return self._wake

    def request(self, kind: str) -> bool:
        if kind not in KINDS:
            raise ValueError(f"unknown refresh kind: {kind!r}")
        with self._lock:
            if self._running == kind or kind in self._queue:
                return False
            self._queue.append(kind)
        self._wake.set()
        return True

    def check_and_queue(self) -> list[str]:
        now = self._clock()
        with self._db_factory() as db:
            p = _parse(store.get_state(db, "prices_as_of"))
            # A financials pass can span several evenings; age it from completion.
            f = _parse(store.get_state(db, "financials_completed_at")
                       or store.get_state(db, "financials_as_of"))
        queued = []
        if is_stale(p, now) and self.request("prices"):
            queued.append("prices")
        if (f is None or now - f > FINANCIALS_MAX_AGE) and self.request("financials"):
            queued.append("financials")
        return queued

    def run_pending(self) -> None:
        while True:
            with self._lock:
                if not self._queue or self._running:
                    return
                kind = self._queue.pop(0)
                self._running = kind
                self._done = self._total = 0
                self._started_at = None
            try:
                self._run(kind)
            except RateLimited as e:
                # Cooling down: put the kind back first and stop, so the next
                # tick resumes it (and prices are never starved behind a long
                # financials pass that would just hit the same cooldown).
                with self._lock:
                    self._last_error = f"{kind}: {e}"
                    if kind not in self._queue:
                        self._queue.insert(0, kind)
                    self._running = None
                return
            except Exception as e:  # leaves <kind>_run_started set so it resumes
                with self._lock:
                    self._last_error = f"{kind}: {e}"
            finally:
                with self._lock:
                    self._running = None

    def tick(self) -> None:
        """One pass of the background loop (run by app.jobs.scheduler every
        CHECK_EVERY_S, or sooner on request()). Never lets an error kill the
        thread: vnstock/vnai can raise SystemExit outside the limiter."""
        try:
            self.check_and_queue()
            self.run_pending()
        except KeyboardInterrupt:
            raise
        except BaseException as e:  # incl. SystemExit
            with self._lock:
                self._last_error = f"{type(e).__name__}: {e}"

    # ---- internals ----
    def _refresh_board(self, db, provider, symbols: list[str]) -> None:
        """One batched status/foreign-room fetch per price pass. Its failure must
        not cost the price pass; a rate limit still stops the run (resumable)."""
        try:
            store.save_board(db, provider.fetch_board(symbols), self._clock())
        except RateLimited:
            raise
        except Exception as e:
            db.rollback()
            with self._lock:
                self._last_error = f"board: {e}"

    def _run(self, kind: str) -> None:
        # The provider rate-limits each of its own network calls (one fetch is
        # several vnstock calls). Wrapping provider methods in the shared,
        # non-reentrant limiter here as well would deadlock on the nested call.
        provider = self._provider_factory()
        started_key = f"{kind}_run_started"
        with self._db_factory() as db:
            started = store.get_state(db, started_key)
            if started and kind == "prices" and \
                    _parse(started) < last_trading_close(self._clock()):
                started = None  # never resume a price pass across a trading close
            if not started:
                started = self._clock().isoformat()
                store.set_state(db, started_key, started)
            run_start = _parse(started)
            with self._lock:
                self._started_at = started
            if kind == "financials" or db.query(TickerMetrics).count() == 0:
                store.upsert_universe(db, provider.list_universe())
            rows = db.query(TickerMetrics).order_by(TickerMetrics.symbol).all()
            entries = {r.symbol: {"symbol": r.symbol, "exchange": r.exchange,
                                  "industry": r.industry, "is_bank": bool(r.is_bank)}
                       for r in rows}
            symbols = list(entries)
            if kind == "prices":
                first = [s for s in dict.fromkeys(store.get_state(db, "last_pass_symbols") or [])
                         if s in entries]
                seen = set(first)
                symbols = first + [s for s in symbols if s not in seen]
            else:
                # Most-traded first: a ranked list is useful within the first hour
                # of a multi-hour pass. No price data → last, by symbol.
                value = {r.symbol: (r.prices or {}).get("avg_value_bn") for r in rows}
                symbols.sort(key=lambda s: (value[s] is None, -(value[s] or 0.0), s))
            if kind == "prices":
                self._refresh_board(db, provider, symbols)
            with self._lock:
                self._total = len(symbols)
            for k in [k for k in self._given_up if k[0] == kind and k[1] != started]:
                del self._given_up[k]  # an abandoned earlier run of this kind
            given_up = self._given_up.setdefault((kind, started), set())
            for sym in symbols:
                done_at = _aware(getattr(db.get(TickerMetrics, sym), f"{kind}_at"))
                if (done_at is not None and done_at >= run_start) or sym in given_up:
                    pass
                else:
                    try:
                        if kind == "prices":
                            # Belt and braces: a provider must not hand back
                            # today's still-forming bar, but never store one.
                            bars = drop_partial_bar(provider.fetch_prices(sym), self._clock())
                            if not bars:
                                raise ValueError(f"no price bars returned for {sym}")
                            store.save_prices(db, sym, bars, self._clock())
                        else:
                            fin = provider.fetch_financials(entries[sym])
                            store.save_financials(db, sym, fin, self._clock())
                        self._strikes.pop((kind, sym), None)
                    except RateLimited as e:
                        n = self._strikes.get((kind, sym), 0) + 1
                        if n < RATE_LIMIT_STRIKES:
                            self._strikes[(kind, sym)] = n
                            raise
                        self._strikes.pop((kind, sym), None)
                        given_up.add(sym)
                        db.rollback()
                        store.save_error(db, sym, f"rate-limited {n} times in a row, "
                                                  f"skipped this pass: {e}")
                    except Exception as e:
                        self._strikes.pop((kind, sym), None)
                        db.rollback()
                        store.save_error(db, sym, str(e))
                with self._lock:
                    self._done += 1
            store.set_state(db, f"{kind}_as_of", started)
            if kind == "financials":
                store.set_state(db, "financials_completed_at", self._clock().isoformat())
            store.set_state(db, started_key, None)
            self._given_up.pop((kind, started), None)
        with self._lock:
            self._last_error = None


# get_provider is looked up per run (not bound at import) so patching
# app.marketdata.registry.get_provider takes effect.
manager = RefreshManager(SessionLocal, lambda: registry.get_provider(),
                         lambda: datetime.now(timezone.utc))
