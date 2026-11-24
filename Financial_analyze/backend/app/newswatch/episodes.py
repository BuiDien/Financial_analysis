"""Oversold-episode lifecycle for held tickers.

An episode opens when a held ticker first turns oversold (the caller records the
alert row with ``episode_open=True``) and stays open — suppressing repeat alerts —
until the stock has recovered: RSI(14) above the reset level AND the drop window
has eased to less than half the trigger drop (flap guard: a drop-only episode can
show RSI > reset while still sliding). Selling the ticker also closes it, so a
sold-then-rebought holding alerts again.

``sweep`` is the only entry point. It never commits; the caller commits once,
together with the alert rows it records for the returned candidates.
"""
from __future__ import annotations

from typing import Literal, TypedDict

from ..models.newswatch import NewsAlert
from . import oversold
from .oversold import OversoldSignal


class Thresholds(TypedDict):
    rsi_max: float
    drop_pct: float
    sessions: int
    rsi_reset: float


Action = Literal["candidate", "skip", "close", "keep"]


def _decide(closes: list[float], has_open: bool, th: Thresholds
            ) -> tuple[Action, OversoldSignal | None]:
    """Pure decision for one ticker. May raise on malformed price data."""
    sig = oversold.check_oversold(closes, rsi_max=th["rsi_max"], drop_pct=th["drop_pct"],
                                  sessions=th["sessions"])
    if sig is not None:
        return ("skip" if has_open else "candidate"), sig
    if not has_open:
        return "keep", None
    rsi_now = oversold.latest_rsi(closes)
    chg = oversold.pct_change(closes, th["sessions"])
    eased = chg is None or chg > -th["drop_pct"] / 2
    recovered = rsi_now is not None and rsi_now > th["rsi_reset"]
    return ("close" if eased and recovered else "keep"), None


def _open_rows(db, ticker: str | None = None) -> list[NewsAlert]:
    q = db.query(NewsAlert).filter(NewsAlert.kind == "holding",
                                   NewsAlert.episode_open.is_(True))
    if ticker is not None:
        q = q.filter(NewsAlert.ticker == ticker)
    return q.order_by(NewsAlert.id.desc()).all()


def _close_unheld(db, held: set[str]) -> int:
    n = 0
    for row in _open_rows(db):
        if row.ticker not in held:
            row.episode_open = False
            n += 1
    return n


def _close_latest(db, ticker: str) -> bool:
    rows = _open_rows(db, ticker)
    if not rows:
        return False
    rows[0].episode_open = False
    return True


def sweep(db, held: list[str], closes_by_ticker: dict[str, list[float]], th: Thresholds
          ) -> list[tuple[str, OversoldSignal]]:
    """One call per after-close run. Closes episodes of tickers not in `held`; for each
    ticker in closes_by_ticker: oversold & no open episode -> candidate; oversold & open ->
    skip; not oversold -> close the open episode if recovered (RSI>reset and flap guard).
    Tickers in `held` but missing from closes_by_ticker (no price data) are left untouched.
    Returns new-episode candidates sorted by drop_pct ascending (worst first).
    Never commits: the caller commits once (together with the alert rows)."""
    _close_unheld(db, set(held))
    candidates: list[tuple[str, OversoldSignal]] = []
    for ticker, closes in closes_by_ticker.items():
        has_open = bool(_open_rows(db, ticker))
        try:
            action, sig = _decide(closes, has_open, th)
        except Exception:  # noqa: BLE001 — malformed series: treat as no data
            continue
        if action == "candidate":
            candidates.append((ticker, sig))
        elif action == "close":
            _close_latest(db, ticker)
    candidates.sort(key=lambda c: c[1]["drop_pct"])
    return candidates
