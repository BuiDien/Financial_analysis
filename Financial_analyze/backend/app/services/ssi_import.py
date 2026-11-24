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

from ..config import resolve_backend_path
from ..jobs.portfolio import submit_portfolio_job
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

    rows = db.query(PortfolioTransaction).filter_by(portfolio_id=p.id).all()
    active = [tx for tx in rows if tx.status == "active"]
    # Every status counts: a voided/edited imported row is a tombstone, so the
    # same report never re-creates it (and never hits uq_portfolio_import_external).
    known = {(tx.source, tx.external_id) for tx in rows if tx.external_id}
    from_statements = _Counter(
        _trade_key(_local_day(tx.effective_at), tx.ticker, tx.type, tx.quantity, tx.unit_price)
        for tx in rows if tx.source == STMT_SOURCE)
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
        dup = _pick_manual(manual, t.trade_date, t.ticker, t.side, t.quantity, t.price, max_days=3)
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
    trades = [tx for tx in new if tx.source != ADJUST_SOURCE]
    to_add, _ = _reuse_adjustments(db, p, adjustments, set())
    for tx in trades + to_add:
        db.add(tx)
    if new:
        p.ledger_revision += 1
    for rep in ok_reports:
        rep.status, rep.error = "imported", None
    db.commit()
    summary = {
        "reports": len(reports), "imported_reports": len(ok_reports), "failed_reports": failed,
        "trades": len(new) - len(adjustments), "adjustments": [
            {"ticker": a.ticker, "quantity": float(a.quantity), "date": _local_day(a.effective_at).isoformat()}
            for a in adjustments],
        "replaced_manual": replaced,
    }
    if new or replaced:
        summary["job_id"] = _rebuild_async(db, p)
    return summary


PASTE_MARKER = "paste:"  # external_id prefix of rows added via Portfolio › Paste orders


def is_pasted(tx: PortfolioTransaction) -> bool:
    return tx.source == "manual" and (tx.external_id or "").startswith(PASTE_MARKER)


def _pick_manual(manual: list[PortfolioTransaction], day, ticker, side, qty, price,
                 max_days: int) -> PortfolioTransaction | None:
    """The active manual BUY/SELL an imported trade replaces: same ticker, side,
    qty and price; the exact trade day first, else the nearest within
    `max_days` (lowest id on a tie). A pasted row (external_id "paste:…")
    carries the real SSI trade date, so it is only ever replaced on that exact
    day; the tolerance is for hand-typed rows. The caller removes the pick from
    `manual` so a row is never chosen twice."""
    best, best_gap = None, None
    for m in manual:
        if not (m.ticker == ticker and m.type == side and Decimal(m.quantity) == Decimal(qty)
                and Decimal(m.unit_price) == Decimal(price)):
            continue
        gap = abs((_local_day(m.effective_at) - day).days)
        limit = 0 if is_pasted(m) else max_days
        if gap <= limit and (best_gap is None or gap < best_gap):
            best, best_gap = m, gap
    return best


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


def _reuse_adjustments(db: Session, p: Portfolio, adjustments: list[PortfolioTransaction],
                       voided_now: set[int]) -> tuple[list[PortfolioTransaction], int]:
    """Placeholders keep external_id "adjust:<sell>" when voided, so a recomputed
    one with the same id updates and reactivates that row instead of inserting a
    duplicate. Returns (rows to insert, rows changed that were not voided by
    this same import)."""
    existing = {tx.external_id: tx for tx in db.query(PortfolioTransaction).filter_by(
        portfolio_id=p.id, source=ADJUST_SOURCE).all() if tx.external_id}
    to_add, changed = [], 0
    for a in adjustments:
        old = existing.get(a.external_id)
        if old is None:
            to_add.append(a)
            continue
        same = (old.id in voided_now and Decimal(old.quantity) == Decimal(a.quantity)
                and _naive(old.effective_at) == _naive(a.effective_at))
        old.status, old.voided_at = "active", None
        old.type, old.ticker, old.currency = a.type, a.ticker, a.currency
        old.quantity, old.effective_at = a.quantity, a.effective_at
        if not _user_edited(old):  # an edited placeholder keeps the user's cost and note
            old.unit_price, old.note = a.unit_price, a.note
        voided_now.discard(old.id)
        changed += 0 if same else 1
    return to_add, changed


def _user_edited(tx: PortfolioTransaction) -> bool:
    """An edited version (PATCH) is user-owned: importers never overwrite its
    price, amount or note (the import id moves to it, see replace_transaction)."""
    return tx.replaces_transaction_id is not None


def _supersede_note(tx: PortfolioTransaction, what: str) -> None:
    mark = f"superseded by {what}"
    if mark not in (tx.note or ""):
        tx.note = f"{tx.note} · {mark}" if tx.note else mark


def _rebuild_async(db: Session, p: Portfolio) -> str:
    job = engine.new_job(db, p, "rebuild")
    submit_portfolio_job(sessionmaker(bind=db.get_bind()), job.id, "rebuild")
    return job.id


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
            if nxt.opening is None or prev.closing is None:
                notes.append(f"no statement for {prev.period_to + timedelta(days=1):%m/%Y} and a "
                             "neighbouring balance is unknown: net deposits not inferred")
                continue
            gap_from, gap_to = prev.period_to + timedelta(days=1), nxt.period_from - timedelta(days=1)
            net_trades = sum(((t.amount if t.side == "SELL" else -t.amount) for t in gap_trades
                              if t.settle_date and gap_from <= t.settle_date <= gap_to), Decimal(0))
            inferred = nxt.opening - prev.closing - net_trades
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


_local_day = engine.local_day


def _trade_keys(db: Session, p: Portfolio, sources: set[str]) -> _Counter:
    """Trade keys of every row from `sources`, any status: a voided or edited
    daily trade still stops a statement from adding that trade again."""
    c = _Counter()
    for tx in db.query(PortfolioTransaction).filter_by(portfolio_id=p.id).filter(
            PortfolioTransaction.source.in_(sources), PortfolioTransaction.type.in_(["BUY", "SELL"])).all():
        c[_trade_key(_local_day(tx.effective_at), tx.ticker, tx.type, tx.quantity, tx.unit_price)] += 1
    return c


def _subaccount(path: str) -> str:
    m = _re.search(r"TK(\d+)_", Path(path).name)
    return m.group(1) if m else "SSI"


def is_statement(filename: str) -> bool:
    return "sao_ke" in filename.lower()


def _attachment_path(a: dict) -> Path | None:
    """Existing file for a Gmail attachment; old rows store cwd-relative paths."""
    if not a.get("path"):
        return None
    path = resolve_backend_path(a["path"])
    return path if path.exists() else None


def import_statements(db: Session, reports: list[GmailReport]) -> dict:
    with _lock:
        return _import_statements_locked(db, reports)


def _import_statements_locked(db: Session, reports: list[GmailReport]) -> dict:
    p = _portfolio(db)
    by_sub: dict[str, list[Statement]] = defaultdict(list)
    failed, notes_failed = [], []
    for rep in reports:
        errs = []
        for a in rep.attachments or []:
            path = _attachment_path(a)
            if path is None:
                errs.append(f"file missing: {a.get('filename')}")
                continue
            st = parse_statement(path)
            if st.errors:  # failed self-check: none of its rows can be trusted
                errs += st.errors
            else:
                by_sub[_subaccount(path)].append(st)
        rep.status, rep.error = ("parse_error", "; ".join(errs)[:1000]) if errs else ("imported", None)
        if errs:
            failed.append({"id": rep.id, "subject": rep.subject, "errors": errs[:3]})
            notes_failed.append(f"statement not imported ({rep.subject or rep.gm_msgid}): {errs[0]}"[:300])
    # Include every statement already on disk for gap inference / dedupe context.
    for rep in db.query(GmailReport).filter(GmailReport.status == "imported").all():
        if rep in reports:
            continue
        for a in rep.attachments or []:
            path = _attachment_path(a)
            if is_statement(a.get("filename", "")) and path is not None:
                by_sub[_subaccount(path)].append(parse_statement(path))

    daily_keys = _trade_keys(db, p, {SOURCE})
    gap_trades = _daily_trades(db)
    # Every status: a voided or edited (replaced) row is a tombstone, so the
    # statement never re-creates it under the same (source, external_id).
    existing = {(tx.source, tx.external_id): tx for tx in
                db.query(PortfolioTransaction).filter_by(portfolio_id=p.id).all() if tx.external_id}
    known = set(existing)
    new, notes = [], list(notes_failed)
    inferred_changed = 0
    now = datetime.now(timezone.utc)
    # A hand-entered (or pasted) trade that the statement also lists is replaced
    # by the statement row, exactly like the daily import does (exact day only:
    # statements carry the real trade date).
    manual = _active_manual(db, p)
    replaced = 0
    for sub, stmts in by_sub.items():
        seen = {}
        for s in stmts:  # same statement may appear twice (new + already imported)
            seen[(s.period_from, s.period_to)] = s
        rows, n = statement_transactions(list(seen.values()), daily_keys, f"{sub}", gap_trades.get(sub, []))
        notes += n
        inferred_now = set()
        for r in rows:
            key = (r["source"], r["external_id"])
            if r["external_id"].endswith(":inferred"):
                inferred_now.add(key)
                old = existing.get(key)
                if old is not None and old.status == "active" and (
                        old.type != r["type"] or Decimal(old.cash_amount) != r["cash_amount"]):
                    if _user_edited(old):
                        notes.append(f"inferred {r['type'].lower()} {r['external_id']} would be "
                                     f"{r['cash_amount']:,.0f}; kept your edited amount "
                                     f"{Decimal(old.cash_amount):,.0f}")
                    else:
                        old.type, old.cash_amount, old.note = r["type"], r["cash_amount"], r["note"]
                        inferred_changed += 1
            if key in known:
                continue
            known.add(key)
            if r["source"] == STMT_SOURCE and r["type"] in {"BUY", "SELL"}:
                dup = _pick_manual(manual, _local_day(r["effective_at"]), r["ticker"], r["type"],
                                   r["quantity"], r["unit_price"], max_days=0)
                if dup is not None:
                    manual.remove(dup)
                    dup.status, dup.voided_at = "replaced", now
                    r = {**r, "note": f"{r['note']} · replaces manual entry #{dup.id}"}
                    replaced += 1
            new.append(PortfolioTransaction(portfolio_id=p.id, **{k: v for k, v in r.items()}))
        # A missing month's inferred deposit is retired once that month's statement exists.
        for key, tx in existing.items():
            if (tx.source == CASH_SOURCE and tx.status == "active" and key not in inferred_now
                    and tx.external_id.startswith(f"{sub}:") and tx.external_id.endswith(":inferred")):
                tx.status, tx.voided_at = "void", now
                if _user_edited(tx):
                    _supersede_note(tx, "the statement's real deposits")
                inferred_changed += 1
                notes.append(f"retired inferred deposit {tx.external_id} (statement now available)")

    # Zero-cost placeholders are obsolete once statements supply the real events.
    stale_adj = db.query(PortfolioTransaction).filter_by(portfolio_id=p.id, status="active",
                                                          source=ADJUST_SOURCE).all()
    for tx in stale_adj:
        tx.status, tx.voided_at = "void", now
    active = [tx for tx in db.query(PortfolioTransaction).filter_by(portfolio_id=p.id).all()
              if tx.status == "active" and tx not in stale_adj]
    adjustments = _shortfall_adjustments(active + new, p.id)
    events = [{"type": tx.type, "effective_at": tx.effective_at, "ticker": tx.ticker,
               "currency": tx.currency, "quantity": tx.quantity} for tx in new + adjustments]
    db.flush()
    engine.validate_ledger_sequence(db, p, events)
    voided_adj = {tx.id for tx in stale_adj}
    new_adj, adj_changed = _reuse_adjustments(db, p, adjustments, voided_adj)
    for tx in stale_adj:  # real trades now cover the shortfall: the user's cost no longer applies
        if tx.id in voided_adj and _user_edited(tx):
            _supersede_note(tx, "the real trades in the statement (your cost no longer applies)")
    new += new_adj
    for tx in new:
        db.add(tx)
    changed = bool(new or voided_adj or adj_changed or inferred_changed or replaced)
    if changed:
        p.ledger_revision += 1
    db.commit()
    by_type = _Counter(f"{tx.source}:{tx.type}" for tx in new)
    out = {"statements": len(reports), "failed_reports": failed, "added": dict(by_type),
           "voided_adjustments": len(voided_adj), "replaced_manual": replaced,
           "adjustments": [{"ticker": a.ticker, "quantity": float(a.quantity)} for a in adjustments],
           "notes": notes}
    if changed:
        out["job_id"] = _rebuild_async(db, p)
    return out


def _active_manual(db: Session, p: Portfolio) -> list[PortfolioTransaction]:
    return (db.query(PortfolioTransaction)
            .filter_by(portfolio_id=p.id, status="active", source="manual")
            .filter(PortfolioTransaction.type.in_(["BUY", "SELL"]))
            .order_by(PortfolioTransaction.id).all())


def _daily_trades(db: Session) -> dict[str, list[Trade]]:
    """Daily-report trades per sub-account (TK1786441 -> '1786441')."""
    out: dict[str, list[Trade]] = defaultdict(list)
    for rep in db.query(GmailReport).filter(GmailReport.status == "imported").all():
        for a in rep.attachments or []:
            path = _attachment_path(a)
            if not is_statement(a.get("filename", "")) and path is not None:
                r = parse_report(path)
                if not r.errors:
                    out[_subaccount(path)] += r.trades
    return out
