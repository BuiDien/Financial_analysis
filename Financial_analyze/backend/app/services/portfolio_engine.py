"""Deterministic portfolio ledger projections and valuation helpers."""

from __future__ import annotations

import json
import secrets
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy.orm import Session

from ..models.portfolio import (
    CashProjection,
    DailyPortfolioSnapshot,
    MarketDataPoint,
    Portfolio,
    PortfolioJob,
    PortfolioTransaction,
    PositionProjection,
    ProjectionSummary,
)
from . import market

ZERO = Decimal("0")
TX_TYPES = {"BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "FEE", "TAX"}


def dec(value) -> Decimal:
    if value is None or value == "":
        return ZERO
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid decimal value: {value}") from exc


def _cache_point(db: Session, kind: str, key: str, day: date, value: Decimal) -> None:
    row = db.query(MarketDataPoint).filter_by(kind=kind, key=key, date=day).first()
    if row:
        row.value = value
        row.fetched_at = datetime.now(timezone.utc)
    else:
        db.add(MarketDataPoint(kind=kind, key=key, date=day, value=value))


def fx_rate(
    db: Session, source: str, target: str, day: date | None = None
) -> tuple[Decimal, dict]:
    source, target = source.upper(), target.upper()
    if source == target:
        return Decimal("1"), {
            "provider": "identity",
            "as_of": (day or date.today()).isoformat(),
            "stale": False,
        }
    target_day = day or date.today()
    key = f"{source}/{target}"
    cached = (
        db.query(MarketDataPoint).filter_by(kind="fx", key=key, date=target_day).first()
    )
    if cached:
        return dec(cached.value), {
            "provider": cached.provider,
            "as_of": cached.date.isoformat(),
            "stale": day is None and cached.date < date.today(),
        }

    def direct(a: str, b: str) -> Decimal | None:
        symbol = f"{a}{b}=X"
        try:
            if day:
                rows = market.get_history(symbol, period="max", interval="1d")
                eligible = [
                    r for r in rows if str(r.get("date", ""))[:10] <= day.isoformat()
                ]
                return dec(eligible[-1]["close"]) if eligible else None
            return dec(market.get_quote(symbol).get("price"))
        except Exception:
            return None

    value = direct(source, target)
    if not value:
        inverse = direct(target, source)
        value = Decimal("1") / inverse if inverse else None
    if not value and source != "USD" and target != "USD":
        left, right = direct(source, "USD"), direct("USD", target)
        value = left * right if left and right else None
    if not value:
        fallback = (
            db.query(MarketDataPoint)
            .filter_by(kind="fx", key=key)
            .order_by(MarketDataPoint.date.desc())
            .first()
        )
        if fallback:
            return dec(fallback.value), {
                "provider": fallback.provider,
                "as_of": fallback.date.isoformat(),
                "stale": True,
            }
        raise ValueError(f"FX rate unavailable for {key} on {target_day.isoformat()}")
    _cache_point(db, "fx", key, target_day, value)
    return value, {
        "provider": "yfinance",
        "as_of": target_day.isoformat(),
        "stale": False,
    }


def quote(db: Session, ticker: str) -> tuple[dict | None, dict]:
    today = date.today()
    cached = (
        db.query(MarketDataPoint)
        .filter_by(kind="quote", key=ticker, date=today)
        .first()
    )
    if cached:
        return {"ticker": ticker, "price": float(cached.value)}, {
            "provider": cached.provider,
            "as_of": today.isoformat(),
            "stale": False,
        }
    try:
        item = market.get_quote(ticker)
        if item.get("price") is None:
            raise ValueError("missing price")
        _cache_point(db, "quote", ticker, today, dec(item["price"]))
        return item, {
            "provider": "yfinance",
            "as_of": datetime.fromtimestamp(item.get("ts", 0), timezone.utc).isoformat()
            if item.get("ts")
            else today.isoformat(),
            "stale": False,
        }
    except Exception:
        fallback = (
            db.query(MarketDataPoint)
            .filter_by(kind="quote", key=ticker)
            .order_by(MarketDataPoint.date.desc())
            .first()
        )
        if fallback:
            return {"ticker": ticker, "price": float(fallback.value)}, {
                "provider": fallback.provider,
                "as_of": fallback.date.isoformat(),
                "stale": True,
            }
        return None, {"provider": "yfinance", "as_of": None, "stale": True}


def validate_transaction(
    db: Session, portfolio: Portfolio, values: dict, exclude_id: int | None = None
) -> None:
    kind = values["type"].upper()
    if kind not in TX_TYPES:
        raise ValueError(f"Unsupported transaction type: {kind}")
    ticker = (values.get("ticker") or "").strip().upper()
    quantity, price = dec(values.get("quantity")), dec(values.get("unit_price"))
    cash = dec(values.get("cash_amount"))
    if kind in {"BUY", "SELL"} and (not ticker or quantity <= 0 or price < 0):
        raise ValueError(
            "Trades require ticker, positive quantity, and non-negative unit price"
        )
    if kind in {"DIVIDEND", "DEPOSIT", "WITHDRAWAL", "FEE", "TAX"} and cash <= 0:
        raise ValueError(f"{kind.title()} requires a positive cash amount")
    validate_ledger_sequence(db, portfolio, [values], exclude_id=exclude_id)


def validate_ledger_sequence(
    db: Session,
    portfolio: Portfolio,
    additions: list,
    exclude_id: int | None = None,
) -> None:
    events = []
    query = db.query(PortfolioTransaction).filter_by(
        portfolio_id=portfolio.id, status="active"
    )
    if exclude_id:
        query = query.filter(PortfolioTransaction.id != exclude_id)
    for tx in query.all():
        events.append(
            {
                "type": tx.type,
                "effective_at": tx.effective_at,
                "ticker": tx.ticker,
                "currency": tx.currency,
                "quantity": tx.quantity,
                "order": tx.id,
            }
        )
    for index, item in enumerate(additions):
        values = item.model_dump() if hasattr(item, "model_dump") else item
        events.append({**values, "order": 10**12 + index})

    def sort_time(event):
        value = event["effective_at"]
        return value.replace(tzinfo=None) if value.tzinfo else value

    events.sort(key=lambda event: (sort_time(event), event.get("order", 0)))
    quantities = defaultdict(lambda: ZERO)
    for event in events:
        if event["type"] not in {"BUY", "SELL"}:
            continue
        key = (event.get("ticker"), event.get("currency"))
        quantity = dec(event.get("quantity"))
        if event["type"] == "BUY":
            quantities[key] += quantity
        else:
            if quantity > quantities[key]:
                raise ValueError(
                    f"Cannot sell {quantity} {key[0]} on {event['effective_at'].date()}; "
                    f"only {quantities[key]} are available"
                )
            quantities[key] -= quantity


def rebuild(db: Session, portfolio_id: int) -> None:
    portfolio = db.get(Portfolio, portfolio_id)
    if not portfolio:
        raise ValueError("Portfolio not found")
    currency = portfolio.display_currency
    active = (
        db.query(PortfolioTransaction)
        .filter_by(portfolio_id=portfolio.id, status="active")
        .order_by(PortfolioTransaction.effective_at, PortfolioTransaction.id)
        .all()
    )
    lots: dict[tuple[str, str], deque] = defaultdict(deque)
    cash = defaultdict(lambda: ZERO)
    realized = income = contributions = ZERO

    for tx in active:
        kind, native = tx.type, tx.currency
        qty, price = dec(tx.quantity), dec(tx.unit_price)
        amount, fees, taxes = dec(tx.cash_amount), dec(tx.fees), dec(tx.taxes)
        rate, _ = fx_rate(db, native, currency, tx.effective_at.date())
        if kind == "BUY":
            gross = qty * price
            basis_native = gross + fees + taxes
            cash[native] -= basis_native
            lots[(tx.ticker, native)].append([qty, basis_native, basis_native * rate])
        elif kind == "SELL":
            gross = qty * price
            cash[native] += gross - fees - taxes
            remaining, basis_display = qty, ZERO
            queue = lots[(tx.ticker, native)]
            while remaining > 0:
                if not queue:
                    raise ValueError(f"Transaction {tx.id} oversells {tx.ticker}")
                lot_qty, lot_native, lot_display = queue[0]
                used = min(remaining, lot_qty)
                ratio = used / lot_qty
                basis_display += lot_display * ratio
                if used == lot_qty:
                    queue.popleft()
                else:
                    queue[0] = [
                        lot_qty - used,
                        lot_native * (1 - ratio),
                        lot_display * (1 - ratio),
                    ]
                remaining -= used
            realized += (gross - fees - taxes) * rate - basis_display
        elif kind == "DIVIDEND":
            cash[native] += amount - fees - taxes
            income += (amount - fees - taxes) * rate
        elif kind == "DEPOSIT":
            cash[native] += amount
            contributions += amount * rate
        elif kind == "WITHDRAWAL":
            cash[native] -= amount
            contributions -= amount * rate
        elif kind in {"FEE", "TAX"}:
            cash[native] -= amount
            realized -= amount * rate

    db.query(PositionProjection).filter_by(portfolio_id=portfolio.id).delete()
    db.query(CashProjection).filter_by(portfolio_id=portfolio.id).delete()
    for (ticker, native), queue in lots.items():
        quantity = sum((lot[0] for lot in queue), ZERO)
        if quantity:
            db.add(
                PositionProjection(
                    portfolio_id=portfolio.id,
                    ticker=ticker,
                    currency=native,
                    quantity=quantity,
                    cost_basis_native=sum((lot[1] for lot in queue), ZERO),
                    cost_basis_display=sum((lot[2] for lot in queue), ZERO),
                    revision=portfolio.ledger_revision,
                )
            )
    for native, balance in cash.items():
        db.add(
            CashProjection(
                portfolio_id=portfolio.id,
                currency=native,
                balance=balance,
                revision=portfolio.ledger_revision,
            )
        )
    summary = db.get(ProjectionSummary, portfolio.id) or ProjectionSummary(
        portfolio_id=portfolio.id
    )
    summary.display_currency = currency
    summary.realized_gain = realized
    summary.income = income
    summary.net_contributions = contributions
    summary.revision = portfolio.ledger_revision
    db.add(summary)
    portfolio.projection_revision = portfolio.ledger_revision
    portfolio.projection_status = "ready"
    db.commit()
    rebuild_snapshots(db, portfolio)


def _history_series(symbol: str) -> dict[date, Decimal]:
    try:
        rows = market.get_history(symbol, period="max", interval="1d")
    except Exception:
        return {}
    out = {}
    for row in rows:
        try:
            out[date.fromisoformat(str(row["date"])[:10])] = dec(row["close"])
        except (KeyError, ValueError, TypeError):
            continue
    return out


def _fx_series(source: str, target: str) -> dict[date, Decimal]:
    if source == target:
        return {}
    direct = _history_series(f"{source}{target}=X")
    if direct:
        return direct
    inverse = _history_series(f"{target}{source}=X")
    return (
        {day: Decimal("1") / value for day, value in inverse.items() if value}
        if inverse
        else {}
    )


def rebuild_snapshots(db: Session, portfolio: Portfolio) -> None:
    """Build daily-close value/TWR snapshots from the active ledger.

    Historical data gaps deliberately create no point; the API never fabricates
    a curve. Weekends carry the prior market close, as portfolio statements do.
    """
    txs = (
        db.query(PortfolioTransaction)
        .filter_by(portfolio_id=portfolio.id, status="active")
        .order_by(PortfolioTransaction.effective_at, PortfolioTransaction.id)
        .all()
    )
    db.query(DailyPortfolioSnapshot).filter_by(portfolio_id=portfolio.id).delete()
    if not txs:
        db.commit()
        return
    start, end = txs[0].effective_at.date(), date.today()
    tickers = sorted({tx.ticker for tx in txs if tx.ticker})
    currencies = sorted({tx.currency for tx in txs})
    prices = {ticker: _history_series(ticker) for ticker in tickers}
    rates = {
        currency: _fx_series(currency, portfolio.display_currency)
        for currency in currencies
    }
    price_last, rate_last = {}, {portfolio.display_currency: Decimal("1")}
    quantities = defaultdict(lambda: ZERO)
    cash = defaultdict(lambda: ZERO)
    by_day = defaultdict(list)
    for tx in txs:
        by_day[tx.effective_at.date()].append(tx)
    previous_value = None
    cumulative_twr = ZERO
    rows = []
    day = start
    while day <= end:
        flow = ZERO
        for tx in by_day.get(day, []):
            qty, price = dec(tx.quantity), dec(tx.unit_price)
            amount, fees, taxes = dec(tx.cash_amount), dec(tx.fees), dec(tx.taxes)
            key = (tx.ticker, tx.currency)
            if tx.type == "BUY":
                quantities[key] += qty
                cash[tx.currency] -= qty * price + fees + taxes
            elif tx.type == "SELL":
                quantities[key] -= qty
                cash[tx.currency] += qty * price - fees - taxes
            elif tx.type == "DIVIDEND":
                cash[tx.currency] += amount - fees - taxes
            elif tx.type == "DEPOSIT":
                cash[tx.currency] += amount
            elif tx.type == "WITHDRAWAL":
                cash[tx.currency] -= amount
            elif tx.type in {"FEE", "TAX"}:
                cash[tx.currency] -= amount
            if tx.type in {"DEPOSIT", "WITHDRAWAL"}:
                rate = rate_last.get(tx.currency)
                if rate is None:
                    try:
                        rate, _ = fx_rate(
                            db, tx.currency, portfolio.display_currency, day
                        )
                    except ValueError:
                        rate = None
                if rate is not None:
                    flow += amount * rate * (1 if tx.type == "DEPOSIT" else -1)
        complete = True
        for ticker in tickers:
            if day in prices[ticker]:
                price_last[ticker] = prices[ticker][day]
        for currency in currencies:
            if currency == portfolio.display_currency:
                rate_last[currency] = Decimal("1")
            elif day in rates[currency]:
                rate_last[currency] = rates[currency][day]
        value = ZERO
        for (ticker, currency), qty in quantities.items():
            if not qty:
                continue
            if ticker not in price_last or currency not in rate_last:
                complete = False
                break
            value += qty * price_last[ticker] * rate_last[currency]
        if complete:
            for currency, balance in cash.items():
                if currency not in rate_last:
                    complete = False
                    break
                value += balance * rate_last[currency]
        if complete:
            if previous_value not in {None, ZERO}:
                daily_return = (value - previous_value - flow) / previous_value
                cumulative_twr = (Decimal("1") + cumulative_twr) * (
                    Decimal("1") + daily_return
                ) - Decimal("1")
            rows.append(
                DailyPortfolioSnapshot(
                    portfolio_id=portfolio.id,
                    date=day,
                    display_currency=portfolio.display_currency,
                    value=value,
                    net_flow=flow,
                    twr=cumulative_twr * 100,
                    revision=portfolio.ledger_revision,
                )
            )
            previous_value = value
        day += timedelta(days=1)
    if rows:
        db.bulk_save_objects(rows)
    db.commit()


def new_job(
    db: Session, portfolio: Portfolio, kind: str, payload: dict | None = None
) -> PortfolioJob:
    job = PortfolioJob(
        id="pf_" + secrets.token_hex(10),
        portfolio_id=portfolio.id,
        type=kind,
        status="queued",
        payload=json.dumps(payload or {}),
    )
    db.add(job)
    portfolio.projection_status = "rebuilding"
    db.commit()
    db.refresh(job)
    return job


def run_job(db_factory, job_id: str) -> None:
    db = db_factory()
    try:
        job = db.get(PortfolioJob, job_id)
        if not job or job.status not in {"queued", "interrupted"}:
            return
        job.status, job.progress, job.started_at = (
            "running",
            5,
            datetime.now(timezone.utc),
        )
        db.commit()
        rebuild(db, job.portfolio_id)
        job = db.get(PortfolioJob, job_id)
        job.status, job.progress = "completed", 100
        job.result, job.completed_at = (
            json.dumps(
                {
                    "projection_revision": db.get(
                        Portfolio, job.portfolio_id
                    ).projection_revision
                }
            ),
            datetime.now(timezone.utc),
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        job = db.get(PortfolioJob, job_id)
        if job:
            job.status, job.error, job.completed_at = (
                "failed",
                str(exc),
                datetime.now(timezone.utc),
            )
            portfolio = db.get(Portfolio, job.portfolio_id)
            if portfolio:
                portfolio.projection_status = "failed"
            db.commit()
    finally:
        db.close()
