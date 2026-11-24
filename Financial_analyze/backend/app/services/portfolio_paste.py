"""Paste SSI order rows ("Thông báo kết quả giao dịch") into the ledger.

preview: parse the pasted text with the SSI row parser (arithmetic-verified)
and flag rows already in the ledger (any active BUY/SELL, same VN day /
ticker / side / qty / price) or repeated in the text; a same-day trade with
another qty or price is only a "similar" warning. No writes.
commit: parse the same text again on the server (client numbers are never
trusted) and insert only the selected non-duplicate rows as source="manual"
with external_id="paste:<row key>" - a durable marker, since notes are
user-editable.

A later SSI import of the same trade replaces the pasted row, so it is never
counted twice: the daily email import and the monthly statement import both
replace a manual row with the same ticker / side / qty / price. For a pasted
row that only happens on the exact same trade day (it carries the real SSI
date); hand-typed manual rows keep the daily import's nearest-within-3-days
tolerance (see ssi_import._pick_manual).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.orm import Session

from ..models.portfolio import Portfolio, PortfolioTransaction
from . import portfolio_engine as engine
from . import portfolio_ledger as ledger
from . import ssi_import
from .errors import ServiceError
from .ssi_trade_report import Report, Trade, parse_text


def _key(account: str | None, t: Trade) -> str:
    """Stable id of a pasted row: same text -> same key on preview and commit.
    The account keeps rows of two sub-account reports apart."""
    return (f"{account or '-'}:{t.trade_date.isoformat()}:{t.no}:{t.ticker}:{t.side}:"
            f"{t.quantity:f}:{t.price:f}")


@dataclass
class _Match:
    trade: Trade
    key: str
    dup: PortfolioTransaction | None = None   # ledger row this trade already is
    reason: str | None = None                 # why it can't be added
    similar: PortfolioTransaction | None = None  # same day/ticker/side, other qty or price

    @property
    def duplicate(self) -> bool:
        return self.reason is not None


def _match(db: Session, p: Portfolio, rep: Report) -> list[_Match]:
    """Pair each parsed trade with the active ledger row it duplicates, if any.
    A ledger row is used once, so two identical fills (different row numbers)
    with one in the ledger leave the second one addable. The same row pasted
    twice (same key) is a duplicate the second time."""
    pool: dict[tuple, list[PortfolioTransaction]] = defaultdict(list)
    near: dict[tuple, list[PortfolioTransaction]] = defaultdict(list)
    rows = (db.query(PortfolioTransaction)
            .filter_by(portfolio_id=p.id, status="active")
            .filter(PortfolioTransaction.type.in_(["BUY", "SELL"]))
            .order_by(PortfolioTransaction.id).all())
    for tx in rows:
        day = engine.local_day(tx.effective_at)
        pool[ssi_import._trade_key(day, tx.ticker, tx.type, tx.quantity, tx.unit_price)].append(tx)
        near[(day, tx.ticker, tx.type)].append(tx)
    out: list[_Match] = []
    seen: set[str] = set()
    for t in rep.trades:
        m = _Match(t, _key(rep.account, t))
        hits = pool[ssi_import._trade_key(t.trade_date, t.ticker, t.side, t.quantity, t.price)]
        if m.key in seen:
            m.reason = "repeated in pasted text"
        elif hits:
            m.dup, m.reason = hits.pop(0), "already in ledger"
        seen.add(m.key)
        out.append(m)
    # Near misses only among ledger rows no pasted row is an exact copy of:
    # warn (still addable) - e.g. a hand-typed row with a rounded price.
    taken = {m.dup.id for m in out if m.dup is not None}
    for m in out:
        if not m.duplicate:
            t = m.trade
            m.similar = next((tx for tx in near[(t.trade_date, t.ticker, t.side)]
                              if tx.id not in taken), None)
    return out


def _row(m: _Match) -> dict:
    t, dup, sim = m.trade, m.dup, m.similar
    return {
        "key": m.key, "no": t.no, "trade_date": t.trade_date.isoformat(),
        "settle_date": t.settle_date.isoformat() if t.settle_date else None,
        "side": t.side, "ticker": t.ticker, "quantity": float(t.quantity),
        "price": float(t.price), "value": float(t.value), "fee": float(t.fee),
        "taxes": float(t.taxes), "amount": float(t.amount),
        "duplicate": m.duplicate, "duplicate_reason": m.reason,
        "duplicate_of": {"id": dup.id, "source": dup.source} if dup is not None else None,
        "similar": ({"id": sim.id, "source": sim.source, "quantity": float(sim.quantity),
                     "price": float(sim.unit_price)} if sim is not None else None),
    }


def _free_marker(key: str, taken: set[str]) -> str:
    ext, n = f"{ssi_import.PASTE_MARKER}{key}", 1
    while ext in taken:
        n += 1
        ext = f"{ssi_import.PASTE_MARKER}{key}:{n}"
    taken.add(ext)
    return ext


def preview(db: Session, text: str) -> dict:
    p = ledger.get_or_create(db)
    rep = parse_text(text)
    return {"account": rep.account, "trades": [_row(m) for m in _match(db, p, rep)],
            "errors": rep.errors}


def commit(db: Session, background, text: str, keys: list[str]) -> dict:
    with ssi_import._lock:  # never interleave with an email/statement import
        return _commit_locked(db, background, text, keys)


def _commit_locked(db: Session, background, text: str, keys: list[str]) -> dict:
    p = ledger.get_or_create(db)
    rep = parse_text(text)
    wanted = list(dict.fromkeys(keys))
    if not wanted:
        raise ServiceError(422, "No trades selected.")
    by_key: dict[str, _Match] = {}
    for m in _match(db, p, rep):
        by_key.setdefault(m.key, m)  # first occurrence; a repeat is never added
    unknown = [k for k in wanted if k not in by_key]
    if unknown:
        raise ServiceError(422, "Selected rows are not in the pasted text any more; "
                                "preview again. (" + ", ".join(unknown[:3]) + ")")
    account = rep.account or "no account"
    # Durable "pasted" marker (the note is user-editable). A voided or replaced
    # earlier paste keeps its id as a tombstone, so a re-paste takes a suffix.
    taken = {ext for (ext,) in db.query(PortfolioTransaction.external_id).filter(
        PortfolioTransaction.portfolio_id == p.id, PortfolioTransaction.source == "manual",
        PortfolioTransaction.external_id.like(f"{ssi_import.PASTE_MARKER}%"))}
    new, skipped = [], []
    for k in wanted:
        m = by_key[k]
        t = m.trade
        if m.duplicate:
            skipped.append({"key": k, "reason": m.reason})
            continue
        new.append(PortfolioTransaction(
            portfolio_id=p.id, type=t.side, effective_at=ssi_import._effective(t),
            ticker=t.ticker, quantity=t.quantity, unit_price=t.price, currency="VND",
            fees=t.fee, taxes=t.taxes, source="manual",
            external_id=_free_marker(k, taken),
            note=f"Pasted SSI order · {account} · row {t.no}"))
    if not new:
        return {"added": 0, "skipped": skipped, "job_id": None}
    events = [{"type": tx.type, "effective_at": tx.effective_at, "ticker": tx.ticker,
               "currency": tx.currency, "quantity": tx.quantity} for tx in new]
    try:
        engine.validate_ledger_sequence(db, p, events)
    except ValueError as exc:
        db.rollback()
        raise ServiceError(422, str(exc)) from exc
    db.add_all(new)
    p.ledger_revision += 1
    db.commit()
    job = ledger.schedule_rebuild(db, background, p)
    return {"added": len(new), "skipped": skipped, "job_id": job.id}
