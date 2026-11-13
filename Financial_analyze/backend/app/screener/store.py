"""Persistence for screener data. Convention: every function COMMITS itself."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..models.screener import ScreenerState, TickerMetrics
from .metrics import compute_price_metrics
from .provider import VN_TZ, Financials, UniverseEntry

STALE_AFTER_TRADING_DAYS = 3
DEAD_AFTER_TRADING_DAYS = 10  # no bars for this long: delisted/suspended, liquidity is frozen


def _utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _row(db: Session, symbol: str) -> TickerMetrics:
    row = db.get(TickerMetrics, symbol)
    if row is None:
        row = TickerMetrics(symbol=symbol, exchange="", is_bank=False)
        db.add(row)
    return row


def upsert_universe(db: Session, entries: list[UniverseEntry]) -> None:
    for e in entries:
        row = _row(db, e["symbol"])
        row.exchange = e["exchange"]
        row.industry = e.get("industry")
        row.is_bank = bool(e.get("is_bank"))
    db.commit()


def save_financials(db: Session, symbol: str, fin: Financials, at: datetime) -> None:
    row = _row(db, symbol)
    row.financials = fin
    row.financials_at = _utc(at)
    row.last_error = None
    db.commit()


def save_prices(db: Session, symbol: str, bars: list[dict], at: datetime) -> None:
    row = _row(db, symbol)
    row.prices = compute_price_metrics(bars)
    row.prices_at = _utc(at)
    row.last_error = None
    db.commit()


def save_board(db: Session, board: dict[str, dict], at: datetime) -> None:
    """Exchange status + foreign room for known tickers; unknown symbols ignored."""
    as_of = _utc(at).isoformat()
    for sym, entry in board.items():
        row = db.get(TickerMetrics, sym)
        if row is not None:
            row.board = {**entry, "as_of": as_of}
    db.commit()


def save_error(db: Session, symbol: str, msg: str) -> None:
    _row(db, symbol).last_error = msg
    db.commit()


def get_state(db: Session, key: str, default=None):
    row = db.get(ScreenerState, key)
    return default if row is None else row.value


def set_state(db: Session, key: str, value) -> None:
    row = db.get(ScreenerState, key)
    if row is None:
        db.add(ScreenerState(key=key, value=value))
    else:
        row.value = value
    db.commit()


def _trading_days_after(last: date, today: date) -> int:
    """Mon-Fri dates strictly after `last`, up to and including `today`."""
    n, d = 0, last + timedelta(days=1)
    while d <= today:
        if d.weekday() <= 4:
            n += 1
        d += timedelta(days=1)
    return n


def load_views(db: Session, now: datetime) -> list[dict]:
    today = now.astimezone(VN_TZ).date()
    views = []
    for r in db.query(TickerMetrics).order_by(TickerMetrics.symbol).all():
        prices = r.prices
        stale = dead = False
        if prices and prices.get("last_date"):
            age = _trading_days_after(date.fromisoformat(prices["last_date"]), today)
            stale = age > STALE_AFTER_TRADING_DAYS
            dead = age > DEAD_AFTER_TRADING_DAYS
        views.append({"symbol": r.symbol, "exchange": r.exchange, "industry": r.industry,
                      "is_bank": bool(r.is_bank), "financials": r.financials,
                      "prices": prices, "prices_stale": stale, "prices_dead": dead,
                      "board": r.board})
    return views
