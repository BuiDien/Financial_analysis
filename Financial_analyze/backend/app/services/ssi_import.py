"""Import parsed SSI trade reports into the portfolio ledger.

- One ledger transaction per matched order, source="ssi_email",
  external_id="<account>:<trade_date>:<row no>" -> re-imports are no-ops.
- A hand-entered trade with the same ticker/side/qty/price within 3 days is
  marked "replaced" by the SSI one (which carries the real fees/taxes).
- SSI also sells shares that never appear as a buy (stock dividends, shares
  held before the email history). The ledger refuses oversells, so the
  shortfall is added as a BUY at price 0 with source="ssi_adjust" and a note
  saying so. These are easy to find and replace with the real cost later.
"""
from __future__ import annotations

import threading
from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy.orm import Session, sessionmaker

from ..models.gmail import GmailReport
from ..models.portfolio import Portfolio, PortfolioTransaction
from . import portfolio_engine as engine
from .ssi_trade_report import Trade, parse_report

SOURCE = "ssi_email"
ADJUST_SOURCE = "ssi_adjust"
VN_TZ = timezone(timedelta(hours=7))
CLOSE = time(15, 0)  # HOSE close; rows keep report order via +N seconds

_lock = threading.Lock()


def _portfolio(db: Session) -> Portfolio:
    p = db.query(Portfolio).first()
    if not p:
        p = Portfolio(name="Main", display_currency="VND")
        db.add(p)
        db.flush()
    return p


def _effective(t: Trade) -> datetime:
    local = datetime.combine(t.trade_date, CLOSE, tzinfo=VN_TZ) + timedelta(seconds=t.no)
    return local.astimezone(timezone.utc)


def _note(account: str, t: Trade) -> str:
    parts = [f"SSI {account}", f"settle {t.settle_date.isoformat() if t.settle_date else '?'}"]
    if t.sell_tax:
        parts.append(f"sell tax {t.sell_tax:,.0f}")
    if t.pit_tax:
        parts.append(f"5% PIT {t.pit_tax:,.0f} on {t.pit_quantity:,.0f} dividend shares")
    return " · ".join(parts)


def _naive(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def import_reports(db: Session, reports: list[GmailReport]) -> dict:
    """Parse and import the given reports. Commits. Returns a summary."""
    with _lock:
        return _import_locked(db, reports)


def _import_locked(db: Session, reports: list[GmailReport]) -> dict:
    p = _portfolio(db)
    parsed: list[tuple[str, Trade]] = []
    failed: list[dict] = []
    ok_reports = []
    for rep in reports:
        errors = []
        for a in rep.attachments or []:
            path = a.get("path")
            if not path or not Path(path).exists():
                errors.append(f"file missing: {a.get('filename')}")
                continue
            r = parse_report(path)
            if r.errors:
                errors += r.errors
            else:
                parsed += [(r.account or "SSI", t) for t in r.trades]
        if errors:
            rep.status, rep.error = "parse_error", "; ".join(errors)[:1000]
            failed.append({"id": rep.id, "subject": rep.subject, "errors": errors[:3]})
        else:
            ok_reports.append(rep)

    active = db.query(PortfolioTransaction).filter_by(portfolio_id=p.id, status="active").all()
    known = {(tx.source, tx.external_id) for tx in active if tx.external_id}
    from_statements = _Counter(
        _trade_key(_local_day(tx.effective_at), tx.ticker, tx.type, tx.quantity, tx.unit_price)
        for tx in active if tx.source == "ssi_statement")
    manual = [tx for tx in active if tx.source == "manual" and tx.type in {"BUY", "SELL"}]

    new: list[PortfolioTransaction] = []
    replaced = 0
    for account, t in sorted(parsed, key=lambda x: (x[1].trade_date, x[1].no)):
        ext = f"{account}:{t.trade_date.isoformat()}:{t.no}"
        if (SOURCE, ext) in known:
            continue
        known.add((SOURCE, ext))
        k = _trade_key(t.trade_date, t.ticker, t.side, t.quantity, t.price)
        if from_statements[k] > 0:  # already present via a monthly statement
            from_statements[k] -= 1
            continue
        tx = PortfolioTransaction(
            portfolio_id=p.id, type=t.side, effective_at=_effective(t), ticker=t.ticker,
            quantity=t.quantity, unit_price=t.price, currency="VND", fees=t.fee,
            taxes=t.taxes, note=_note(account, t), source=SOURCE, external_id=ext,
        )
        dup = next((m for m in manual if m.ticker == t.ticker and m.type == t.side
                    and Decimal(m.quantity) == t.quantity and Decimal(m.unit_price) == t.price
                    and abs((_naive(m.effective_at).date() - t.trade_date).days) <= 3), None)
        if dup is not None:
            manual.remove(dup)
            dup.status, dup.voided_at = "replaced", datetime.now(timezone.utc)
            tx.note += f" · replaces manual entry #{dup.id}"
            replaced += 1
        new.append(tx)

    adjustments = _shortfall_adjustments(
        [tx for tx in active if tx.status == "active"] + new, p.id)
    new += adjustments

    events = [{"type": tx.type, "effective_at": tx.effective_at, "ticker": tx.ticker,
               "currency": tx.currency, "quantity": tx.quantity} for tx in new]
    engine.validate_ledger_sequence(db, p, events)  # raises on any remaining oversell
    for tx in new:
        db.add(tx)
    if new:
        p.ledger_revision += 1
    for rep in ok_reports:
        rep.status, rep.error = "imported", None
    db.commit()
    summary = {
        "reports": len(reports), "imported_reports": len(ok_reports), "failed_reports": failed,
        "trades": len(new) - len(adjustments), "adjustments": [
            {"ticker": a.ticker, "quantity": float(a.quantity), "date": a.effective_at.date().isoformat()}
            for a in adjustments],
        "replaced_manual": replaced,
    }
    if new or replaced:
        _rebuild_async(db, p)
    return summary


def _shortfall_adjustments(txs: list[PortfolioTransaction], portfolio_id: int) -> list[PortfolioTransaction]:
    held: dict[tuple, Decimal] = defaultdict(Decimal)
    out = []
    for tx in sorted(txs, key=lambda x: (_naive(x.effective_at), x.id or 0)):
        if tx.type not in {"BUY", "SELL"}:
            continue
        key = (tx.ticker, tx.currency)
        qty = Decimal(tx.quantity)
        if tx.type == "BUY":
            held[key] += qty
            continue
        if qty > held[key]:
            short = qty - held[key]
            out.append(PortfolioTransaction(
                portfolio_id=portfolio_id, type="BUY",
                effective_at=tx.effective_at - timedelta(seconds=1), ticker=tx.ticker,
                quantity=short, unit_price=Decimal(0), currency=tx.currency,
                note=(f"Share adjustment: SSI sold {qty:,.0f} {tx.ticker} but only {held[key]:,.0f} "
                      "were bought in the email history (stock dividend or earlier holding). "
                      "Cost set to 0 — replace with the real cost if known."),
                source=ADJUST_SOURCE, external_id=f"adjust:{tx.external_id or tx.id}",
            ))
            held[key] += short
        held[key] -= qty
    return out


def _rebuild_async(db: Session, p: Portfolio) -> None:
    job = engine.new_job(db, p, "rebuild")
    factory = sessionmaker(bind=db.get_bind())
    threading.Thread(target=engine.run_job, args=(factory, job.id), daemon=True).start()


def import_pending(db: Session) -> dict:
    pending = db.query(GmailReport).filter(GmailReport.status == "downloaded").all()
    stmts = [r for r in pending if any(is_statement(a.get("filename", "")) for a in r.attachments or [])]
    daily = [r for r in pending if r not in stmts and any(
        "ket_qua_giao_dich" in a.get("filename", "").lower() for a in r.attachments or [])]
    for r in pending:  # e.g. fund-certificate (CCQ) reports: kept on disk, not a stock trade
        if r not in stmts and r not in daily:
            r.status, r.error = "ignored", "not an SSI stock trade report or statement"
    db.commit()
    out = {"reports": 0, "imported_reports": 0, "failed_reports": [], "trades": 0,
           "adjustments": [], "replaced_manual": 0}
    if daily:  # daily first: statements dedupe against them
        out = import_reports(db, daily)
    if stmts:
        out["statements"] = import_statements(db, stmts)
    return out


# ── Monthly statements (authoritative) ─────────────────────────────────
#
# Statements add what daily reports cannot: trades whose email never came,
# bonus/stock-dividend shares (BUY at 0), rights-issue shares (BUY at the
# rights price, on the payment date), cash dividends, interest, deposits,
# withdrawals and fees. Trades already imported from a daily report are
# matched on (trade date, ticker, side, qty, price) and not duplicated.

import re as _re
from collections import Counter as _Counter

from .ssi_statement import Statement, parse_statement

STMT_SOURCE = "ssi_statement"      # trades found only in statements
CORP_SOURCE = "ssi_corporate"      # bonus / stock-dividend / rights shares
CASH_SOURCE = "ssi_cash"           # deposits, withdrawals, dividends, interest, fees


def _at(day, hour=16, seconds=0) -> datetime:
    return (datetime.combine(day, time(hour, 0), tzinfo=VN_TZ) + timedelta(seconds=seconds)).astimezone(timezone.utc)


def _trade_key(d, ticker, side, qty, price):
    return (d.isoformat(), ticker, side, Decimal(qty).normalize(), Decimal(price).normalize())


def statement_transactions(statements: list[Statement], daily_keys: _Counter, account: str,
                           gap_trades: list[Trade]) -> tuple[list[dict], list[str]]:
    """Ledger rows (as dicts) derived from statements. Returns (rows, notes)."""
    rows: list[dict] = []
    notes: list[str] = []
    stmts = sorted([s for s in statements if s.period_from], key=lambda s: s.period_from)
    remaining = _Counter(daily_keys)
    for s in stmts:
        seen = _Counter()
        for o in s.orders:
            k = _trade_key(o.trade_date, o.ticker, o.side, o.quantity, o.price)
            seen[k] += 1
            if remaining[k] > 0:
                remaining[k] -= 1
                continue  # already imported from the daily report
            rows.append(dict(type=o.side, effective_at=_at(o.trade_date, 15, o.no), ticker=o.ticker,
                             quantity=o.quantity, unit_price=o.price, fees=o.fee, taxes=o.tax,
                             currency="VND", source=STMT_SOURCE,
                             external_id=f"{account}:{k[0]}:{o.ticker}:{o.side}:{o.quantity}:{o.price}:{seen[k]}",
                             note=f"From SSI statement {s.period_to:%m/%Y} (no daily email) · settle {o.settle_date.isoformat()}"))
        taxes_by = {}
        for ev in s.cash:
            if ev.kind in ("Thuế cổ tức", "Thuế lãi tiền gửi"):
                tk = _div_ticker(ev.content) if ev.kind == "Thuế cổ tức" else None
                taxes_by[(ev.day, ev.kind, tk)] = taxes_by.get((ev.day, ev.kind, tk), Decimal(0)) + ev.decrease
        n = _Counter()
        for ev in s.cash:
            n[(ev.day, ev.kind)] += 1
            idx = n[(ev.day, ev.kind)]
            base = dict(currency="VND", note=f"SSI: {ev.kind} — {ev.content}"[:2000])
            ext = f"{account}:{ev.day.isoformat()}:{ev.kind}:{idx}"
            if ev.kind == "Nộp tiền" and ev.increase > 0:
                rows.append({**base, "type": "DEPOSIT", "effective_at": _at(ev.day, 9), "cash_amount": ev.increase,
                             "source": CASH_SOURCE, "external_id": ext})
            elif ev.kind == "Rút tiền" and ev.decrease > 0:
                rows.append({**base, "type": "WITHDRAWAL", "effective_at": _at(ev.day, 16, idx), "cash_amount": ev.decrease,
                             "source": CASH_SOURCE, "external_id": ext})
            elif ev.kind == "Cổ tức" and ev.increase > 0:
                tk = _div_ticker(ev.content)
                rows.append({**base, "type": "DIVIDEND", "effective_at": _at(ev.day, 16, idx), "ticker": tk,
                             "cash_amount": ev.increase, "taxes": taxes_by.pop((ev.day, "Thuế cổ tức", tk), Decimal(0)),
                             "source": CASH_SOURCE, "external_id": ext})
            elif ev.kind == "Lãi tiền gửi" and ev.increase > 0:
                rows.append({**base, "type": "DIVIDEND", "effective_at": _at(ev.day, 16, idx), "ticker": None,
                             "cash_amount": ev.increase, "taxes": taxes_by.pop((ev.day, "Thuế lãi tiền gửi", None), Decimal(0)),
                             "source": CASH_SOURCE, "external_id": ext, "note": f"Interest on cash: {ev.content}"})
            elif ev.kind == "Thanh toán phí" and ev.decrease > 0:
                rows.append({**base, "type": "FEE", "effective_at": _at(ev.day, 16, idx), "cash_amount": ev.decrease,
                             "source": CASH_SOURCE, "external_id": ext})
            elif ev.kind == "Phân bổ quyền" and ev.ticker and ev.quantity > 0 and "QUYỀN" not in ev.content.upper().split("ĐỂ")[0]:
                rows.append({**base, "type": "BUY", "effective_at": _at(ev.day, 8), "ticker": ev.ticker,
                             "quantity": ev.quantity, "unit_price": Decimal(0), "source": CORP_SOURCE,
                             "external_id": f"{account}:{ev.day.isoformat()}:bonus:{ev.ticker}:{ev.quantity}",
                             "note": f"Shares received (cost 0): {ev.content}"[:2000]})
            elif ev.kind == "Thanh toán quyền" and ev.decrease > 0:
                m = _re.search(r"MUA\s+\d+\s+CP\s+([A-Z0-9]{3,10}),?\s+GIÁ\s+([\d.]+)", ev.content.upper())
                if not m:
                    notes.append(f"rights payment not understood: {ev.day} {ev.content[:80]}")
                    continue
                tk, price = m.group(1), Decimal(m.group(2).replace(".", ""))
                qty = (ev.decrease / price).quantize(Decimal(1))
                rows.append({**base, "type": "BUY", "effective_at": _at(ev.day, 8), "ticker": tk, "quantity": qty,
                             "unit_price": price, "source": CORP_SOURCE,
                             "external_id": f"{account}:{ev.day.isoformat()}:rights:{tk}:{qty}",
                             "note": f"Rights issue: bought {qty:,} {tk} @ {price:,} — {ev.content}"[:2000]})
        for (day, kind, tk), amt in taxes_by.items():
            if amt:
                rows.append(dict(type="TAX", effective_at=_at(day, 17), cash_amount=amt, currency="VND",
                                 source=CASH_SOURCE, external_id=f"{account}:{day.isoformat()}:{kind}:{tk}",
                                 note=f"SSI: {kind} {tk or ''}"))
    # A month with no statement (e.g. 12/2022): infer its net deposits from the
    # balances around it, after the trades of that month (from daily reports).
    for prev, nxt in zip(stmts, stmts[1:]):
        if (nxt.period_from - prev.period_to).days > 1:
            gap_from, gap_to = prev.period_to + timedelta(days=1), nxt.period_from - timedelta(days=1)
            net_trades = sum(((t.amount if t.side == "SELL" else -t.amount) for t in gap_trades
                              if t.settle_date and gap_from <= t.settle_date <= gap_to), Decimal(0))
            inferred = (nxt.opening or 0) - (prev.closing or 0) - net_trades
            if inferred:
                rows.append(dict(type="DEPOSIT" if inferred > 0 else "WITHDRAWAL", effective_at=_at(gap_from, 9),
                                 cash_amount=abs(inferred), currency="VND", source=CASH_SOURCE,
                                 external_id=f"{account}:{gap_from.isoformat()}:inferred",
                                 note=f"No statement for {gap_from:%m/%Y}: net deposits inferred from balances"))
                notes.append(f"inferred {inferred:,} net deposit for {gap_from:%m/%Y} (statement missing)")
    return rows, notes


def _div_ticker(content: str) -> str | None:
    m = _re.search(r"cổ tức\s+([A-Z0-9]{3,10})", content, flags=_re.IGNORECASE)
    return m.group(1) if m else None


def _local_day(dt: datetime):
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(VN_TZ).date()


def _active_trade_keys(db: Session, p: Portfolio, sources: set[str]) -> _Counter:
    c = _Counter()
    for tx in db.query(PortfolioTransaction).filter_by(portfolio_id=p.id, status="active").filter(
            PortfolioTransaction.source.in_(sources), PortfolioTransaction.type.in_(["BUY", "SELL"])).all():
        c[_trade_key(_local_day(tx.effective_at), tx.ticker, tx.type, tx.quantity, tx.unit_price)] += 1
    return c


def _subaccount(path: str) -> str:
    m = _re.search(r"TK(\d+)_", Path(path).name)
    return m.group(1) if m else "SSI"


def is_statement(filename: str) -> bool:
    return "sao_ke" in filename.lower()


def import_statements(db: Session, reports: list[GmailReport]) -> dict:
    with _lock:
        return _import_statements_locked(db, reports)


def _import_statements_locked(db: Session, reports: list[GmailReport]) -> dict:
    p = _portfolio(db)
    by_sub: dict[str, list[Statement]] = defaultdict(list)
    failed = []
    for rep in reports:
        errs = []
        for a in rep.attachments or []:
            if not a.get("path") or not Path(a["path"]).exists():
                errs.append(f"file missing: {a.get('filename')}")
                continue
            st = parse_statement(a["path"])
            if st.errors and not st.cash and not st.orders:
                errs += st.errors
            else:
                by_sub[_subaccount(a["path"])].append(st)
        rep.status, rep.error = ("parse_error", "; ".join(errs)[:1000]) if errs else ("imported", None)
        if errs:
            failed.append({"id": rep.id, "subject": rep.subject, "errors": errs[:3]})
    # Include every statement already on disk for gap inference / dedupe context.
    for rep in db.query(GmailReport).filter(GmailReport.status == "imported").all():
        if rep in reports:
            continue
        for a in rep.attachments or []:
            if is_statement(a.get("filename", "")) and a.get("path") and Path(a["path"]).exists():
                by_sub[_subaccount(a["path"])].append(parse_statement(a["path"]))

    daily_keys = _active_trade_keys(db, p, {SOURCE})
    gap_trades = _daily_trades(db)
    known = {(tx.source, tx.external_id) for tx in
             db.query(PortfolioTransaction).filter_by(portfolio_id=p.id, status="active").all() if tx.external_id}
    new, notes = [], []
    for sub, stmts in by_sub.items():
        seen = {}
        for s in stmts:  # same statement may appear twice (new + already imported)
            seen[(s.period_from, s.period_to)] = s
        rows, n = statement_transactions(list(seen.values()), daily_keys, f"{sub}", gap_trades.get(sub, []))
        notes += n
        for r in rows:
            if (r["source"], r["external_id"]) in known:
                continue
            known.add((r["source"], r["external_id"]))
            new.append(PortfolioTransaction(portfolio_id=p.id, **{k: v for k, v in r.items()}))

    # Zero-cost placeholders are obsolete once statements supply the real events.
    stale_adj = db.query(PortfolioTransaction).filter_by(portfolio_id=p.id, status="active",
                                                          source=ADJUST_SOURCE).all()
    for tx in stale_adj:
        tx.status, tx.voided_at = "void", datetime.now(timezone.utc)
    active = [tx for tx in db.query(PortfolioTransaction).filter_by(portfolio_id=p.id).all()
              if tx.status == "active" and tx not in stale_adj]
    adjustments = _shortfall_adjustments(active + new, p.id)
    new += adjustments
    events = [{"type": tx.type, "effective_at": tx.effective_at, "ticker": tx.ticker,
               "currency": tx.currency, "quantity": tx.quantity} for tx in new]
    db.flush()
    engine.validate_ledger_sequence(db, p, events)
    for tx in new:
        db.add(tx)
    if new or stale_adj:
        p.ledger_revision += 1
    db.commit()
    by_type = _Counter(f"{tx.source}:{tx.type}" for tx in new)
    if new or stale_adj:
        _rebuild_async(db, p)
    return {"statements": len(reports), "failed_reports": failed, "added": dict(by_type),
            "voided_adjustments": len(stale_adj),
            "adjustments": [{"ticker": a.ticker, "quantity": float(a.quantity)} for a in adjustments],
            "notes": notes}


def _daily_trades(db: Session) -> dict[str, list[Trade]]:
    """Daily-report trades per sub-account (TK1786441 -> '1786441')."""
    out: dict[str, list[Trade]] = defaultdict(list)
    for rep in db.query(GmailReport).filter(GmailReport.status == "imported").all():
        for a in rep.attachments or []:
            if not is_statement(a.get("filename", "")) and a.get("path") and Path(a["path"]).exists():
                r = parse_report(a["path"])
                if not r.errors:
                    out[_subaccount(a["path"])] += r.trades
    return out
