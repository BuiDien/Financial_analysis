"""Deterministic portfolio ledger projections and valuation helpers."""

from __future__ import annotations

import json
import secrets
import threading
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

# The ledger's calendar is Vietnam's: a trade at 06:30 in Hanoi (23:30 UTC the
# previous day) belongs to the Hanoi day, which is also the HOSE trading day.
VN_TZ = timezone(timedelta(hours=7))

# Bonus shares / stock dividends: BUY at price 0 booked from an SSI statement.
BONUS_SOURCES = {"ssi_corporate"}


def local_day(dt: datetime) -> date:
    """Calendar day of a stored timestamp in Asia/Ho_Chi_Minh (naive = UTC)."""
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(VN_TZ).date()


def utc_naive(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def is_bonus(tx) -> bool:
    """A free share allocation (bonus issue / stock dividend), not a purchase.

    It does not create a zero-cost lot: the shares already held are split, so
    their total cost is spread over more shares (see rebuild / realized_fifo).
    """
    return (
        tx.type == "BUY"
        and tx.source in BONUS_SOURCES
        and dec(tx.unit_price) == 0
        and dec(tx.fees) == 0
        and dec(tx.taxes) == 0
    )


def _scale_lots(queue, bonus_qty: Decimal, qty_of, set_qty) -> bool:
    """Spread `bonus_qty` new shares over the open lots pro rata, cost unchanged.
    Returns False when nothing is held (caller books a zero-cost lot instead)."""
    held = sum((qty_of(lot) for lot in queue), ZERO)
    if held <= 0:
        return False
    target = held + bonus_qty
    ratio = target / held
    scaled = ZERO
    for index, lot in enumerate(queue):
        # the last lot absorbs rounding so the total stays exact (no phantom oversell)
        q = target - scaled if index == len(queue) - 1 else qty_of(lot) * ratio
        set_qty(lot, q)
        scaled += q
    return True


_rebuild_locks: dict[int, threading.RLock] = {}
_rebuild_locks_guard = threading.Lock()


def rebuild_lock(portfolio_id: int) -> threading.RLock:
    """One projection rebuild at a time per portfolio (SQLite write contention)."""
    with _rebuild_locks_guard:
        return _rebuild_locks.setdefault(portfolio_id, threading.RLock())


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


# vnstock/VCI quotes HOSE/HNX stocks in nghìn đồng; the ledger stores đồng.
VN_PRICE_SCALE = Decimal("1000")


def market_symbol(ticker: str, currency: str | None) -> tuple[str, Decimal]:
    """Map a ledger ticker to the market-data symbol and its price scale.

    A plain VND ticker (VCB, MBB) is a Vietnamese listing: Yahoo has no data
    for it, so it routes to vnstock via the "VN:" prefix and its prices are
    scaled from nghìn đồng to đồng. Everything else goes to Yahoo unchanged.
    """
    symbol = ticker.strip().upper()
    if symbol.startswith(market.VN_PREFIX):
        return symbol, VN_PRICE_SCALE
    plain = not any(ch in symbol for ch in ".=^-")
    if (currency or "").upper() == "VND" and plain:
        return f"{market.VN_PREFIX}{symbol}", VN_PRICE_SCALE
    return symbol, Decimal("1")


def quote(db: Session, ticker: str, currency: str | None = None) -> tuple[dict | None, dict]:
    """Today's price for a ledger ticker, in the ledger's currency units."""
    symbol, scale = market_symbol(ticker, currency)
    provider = "vnstock" if symbol.startswith(market.VN_PREFIX) else "yfinance"
    today = date.today()
    # Live first: market.get_quote already caches for 120s, and only a live
    # quote carries today's change. The stored point is the offline fallback.
    try:
        item = dict(market.get_quote(symbol))
        if item.get("price") is None:
            raise ValueError("missing price")
        for field in ("price", "previous_close", "change"):
            if item.get(field) is not None:
                item[field] = float(dec(item[field]) * scale)
        item["ticker"] = ticker
        _cache_point(db, "quote", ticker, today, dec(item["price"]))
        return item, {
            "provider": provider,
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
        return None, {"provider": provider, "as_of": None, "stale": True}


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
        return utc_naive(event["effective_at"])

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
                    f"Cannot sell {quantity} {key[0]} on {local_day(event['effective_at'])}; "
                    f"only {quantities[key]} are available"
                )
            quantities[key] -= quantity


def realized_fifo(db: Session, portfolio: Portfolio) -> dict:
    """Per-sale FIFO breakdown: which buy lots each SELL consumed.

    Mirrors rebuild(): BUY cost = qty*price + fees + taxes (per lot, converted at
    the buy date), SELL proceeds = qty*price - fees - taxes (converted at the
    sell date), lots consumed oldest first. The per-ticker totals therefore sum
    to the ledger's realized gain (minus standalone FEE/TAX entries).
    """
    currency = portfolio.display_currency
    active = (
        db.query(PortfolioTransaction)
        .filter_by(portfolio_id=portfolio.id, status="active")
        .filter(PortfolioTransaction.type.in_(["BUY", "SELL"]))
        .order_by(PortfolioTransaction.effective_at, PortfolioTransaction.id)
        .all()
    )
    lots: dict[tuple[str, str], deque] = defaultdict(deque)
    sales = []
    for tx in active:
        native = tx.currency
        qty, price = dec(tx.quantity), dec(tx.unit_price)
        fees, taxes = dec(tx.fees), dec(tx.taxes)
        rate, _ = fx_rate(db, native, currency, local_day(tx.effective_at))
        if is_bonus(tx):
            def _set(lot, q):
                lot["qty"] = q
                lot["unit_cost"] = lot["cost_native"] / q
                lot["bonus_adjusted"] = True
            if _scale_lots(lots[(tx.ticker, native)], qty, lambda lot: lot["qty"], _set):
                continue
        if tx.type == "BUY":
            cost = qty * price + fees + taxes
            lots[(tx.ticker, native)].append({
                "buy_id": tx.id, "date": tx.effective_at, "qty": qty,
                "cost_native": cost, "cost_display": cost * rate,
                "unit_cost": cost / qty, "source": tx.source, "bonus_adjusted": False,
            })
            continue
        proceeds_native = qty * price - fees - taxes
        remaining, basis_native, basis_display, used_lots = qty, ZERO, ZERO, []
        queue = lots[(tx.ticker, native)]
        while remaining > 0:
            if not queue:
                raise ValueError(f"Transaction {tx.id} oversells {tx.ticker}")
            lot = queue[0]
            used = min(remaining, lot["qty"])
            ratio = used / lot["qty"]
            part_native, part_display = lot["cost_native"] * ratio, lot["cost_display"] * ratio
            basis_native += part_native
            basis_display += part_display
            used_lots.append({
                "buy_id": lot["buy_id"], "buy_date": lot["date"].isoformat(),
                "quantity": float(used), "unit_cost": float(lot["unit_cost"]),
                "cost": float(part_native), "zero_cost_adjustment": lot["source"] == "ssi_adjust",
                "bonus_adjusted": lot["bonus_adjusted"],
            })
            if used == lot["qty"]:
                queue.popleft()
            else:
                lot["qty"] -= used
                lot["cost_native"] -= part_native
                lot["cost_display"] -= part_display
            remaining -= used
        gain_display = proceeds_native * rate - basis_display
        sales.append({
            "sell_id": tx.id, "date": tx.effective_at.isoformat(), "ticker": tx.ticker,
            "currency": native, "quantity": float(qty), "price": float(price),
            "fees": float(fees), "taxes": float(taxes),
            "proceeds": float(proceeds_native), "cost": float(basis_native),
            "gain": float(proceeds_native - basis_native),
            "gain_display": float(gain_display),
            "gain_pct": float((proceeds_native - basis_native) / basis_native * 100) if basis_native else None,
            "lots": used_lots,
        })
    by_ticker: dict[str, dict] = {}
    for sale in sales:
        t = by_ticker.setdefault(sale["ticker"], {
            "ticker": sale["ticker"], "currency": sale["currency"], "sells": 0, "quantity": 0.0,
            "proceeds": 0.0, "cost": 0.0, "gain": 0.0, "gain_display": 0.0,
            "has_zero_cost_lots": False})
        t["sells"] += 1
        for k in ("quantity", "proceeds", "cost", "gain", "gain_display"):
            t[k] += sale[k]
        t["has_zero_cost_lots"] |= any(l["zero_cost_adjustment"] for l in sale["lots"])
    for t in by_ticker.values():
        t["gain_pct"] = t["gain"] / t["cost"] * 100 if t["cost"] else None
    tickers = sorted(by_ticker.values(), key=lambda t: t["gain_display"], reverse=True)
    return {
        "method": "FIFO",
        "display_currency": currency,
        "total_gain": sum(t["gain_display"] for t in tickers),
        "tickers": tickers,
        "sales": list(reversed(sales)),  # newest first
    }


_RECEIVED_SOURCES = {"ssi_corporate"}


def ticker_breakdown(db: Session, portfolio: Portfolio) -> dict:
    """Everything per ticker: each order and share event in date order (with the
    running share count), shares bought / received / sold, money paid / received,
    cash dividends, and FIFO realized P/L. Market value is added by the caller."""
    fifo = realized_fifo(db, portfolio)
    sale_by_id = {s["sell_id"]: s for s in fifo["sales"]}
    txs = (
        db.query(PortfolioTransaction)
        .filter_by(portfolio_id=portfolio.id, status="active")
        .filter(PortfolioTransaction.ticker.isnot(None))
        .filter(PortfolioTransaction.type.in_(["BUY", "SELL", "DIVIDEND"]))
        .order_by(PortfolioTransaction.effective_at, PortfolioTransaction.id)
        .all()
    )
    out: dict[str, dict] = {}
    for tx in txs:
        t = out.setdefault(tx.ticker, {
            "ticker": tx.ticker, "currency": tx.currency, "orders_buy": 0, "orders_sell": 0,
            "shares_bought": 0.0, "shares_received": 0.0, "shares_sold": 0.0, "shares_now": 0.0,
            "paid": 0.0, "received": 0.0, "dividends": 0.0, "fees": 0.0, "taxes": 0.0,
            "realized_fifo": 0.0, "open_cost": 0.0, "first_date": tx.effective_at.isoformat(),
            "events": []})
        qty, price = dec(tx.quantity), dec(tx.unit_price)
        fees, taxes, cash = dec(tx.fees), dec(tx.taxes), dec(tx.cash_amount)
        ev = {"id": tx.id, "date": tx.effective_at.isoformat(), "source": tx.source, "note": tx.note,
              "fees": float(fees), "taxes": float(taxes)}
        if tx.type == "BUY":
            received_free = tx.source in _RECEIVED_SOURCES and price == 0
            kind = "BONUS" if received_free else ("RIGHTS" if tx.source in _RECEIVED_SOURCES else "BUY")
            amount = qty * price + fees + taxes
            t["shares_now"] += float(qty)
            if kind == "BUY":
                t["orders_buy"] += 1
                t["shares_bought"] += float(qty)
            else:
                t["shares_received"] += float(qty)
            t["paid"] += float(amount)
            ev.update(kind=kind, quantity=float(qty), price=float(price), amount=-float(amount))
        elif tx.type == "SELL":
            amount = qty * price - fees - taxes
            t["orders_sell"] += 1
            t["shares_sold"] += float(qty)
            t["shares_now"] -= float(qty)
            t["received"] += float(amount)
            sale = sale_by_id.get(tx.id)
            ev.update(kind="SELL", quantity=float(qty), price=float(price), amount=float(amount),
                      fifo_cost=sale["cost"] if sale else None, fifo_gain=sale["gain"] if sale else None,
                      lots=sale["lots"] if sale else [])
            if sale:
                t["realized_fifo"] += sale["gain"]
        else:  # DIVIDEND
            net = cash - fees - taxes
            t["dividends"] += float(net)
            ev.update(kind="DIVIDEND", quantity=None, price=None, amount=float(net), gross=float(cash))
        t["fees"] += float(fees)
        t["taxes"] += float(taxes)
        ev["shares_after"] = t["shares_now"]
        t["events"].append(ev)
    for t in out.values():
        t["events"].reverse()  # newest first
    # FIFO cost of the shares still held = total paid - FIFO cost of everything sold
    for tk, t in out.items():
        sold_cost = sum(s["cost"] for s in fifo["sales"] if s["ticker"] == tk)
        t["open_cost"] = t["paid"] - sold_cost
    return {"method": "FIFO", "display_currency": portfolio.display_currency,
            "tickers": sorted(out.values(), key=lambda t: (t["shares_now"] <= 0, t["ticker"]))}


def rebuild(db: Session, portfolio_id: int) -> None:
    with rebuild_lock(portfolio_id):
        _rebuild_locked(db, portfolio_id)


def _rebuild_locked(db: Session, portfolio_id: int) -> None:
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
        rate, _ = fx_rate(db, native, currency, local_day(tx.effective_at))
        if is_bonus(tx):
            def _set(lot, q):
                lot[0] = q
            if _scale_lots(lots[(tx.ticker, native)], qty, lambda lot: lot[0], _set):
                continue
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


def _history_series(symbol: str, scale: Decimal = Decimal("1")) -> dict[date, Decimal]:
    try:
        rows = market.get_history(symbol, period="max", interval="1d")
    except Exception:
        return {}
    out = {}
    for row in rows:
        try:
            out[date.fromisoformat(str(row["date"])[:10])] = dec(row["close"]) * scale
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
    External flows on days without a point are carried to the next point, so a
    deposit made during a price gap is never counted as return. A return is
    only chained when the previous value is positive.
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
    start, end = local_day(txs[0].effective_at), date.today()
    tickers = sorted({tx.ticker for tx in txs if tx.ticker})
    currencies = sorted({tx.currency for tx in txs})
    ticker_currency = {tx.ticker: tx.currency for tx in txs if tx.ticker}
    prices = {
        ticker: _history_series(*market_symbol(ticker, ticker_currency[ticker]))
        for ticker in tickers
    }
    rates = {
        currency: _fx_series(currency, portfolio.display_currency)
        for currency in currencies
    }
    price_last, rate_last = {}, {portfolio.display_currency: Decimal("1")}
    quantities = defaultdict(lambda: ZERO)
    cash = defaultdict(lambda: ZERO)
    by_day = defaultdict(list)
    for tx in txs:
        by_day[local_day(tx.effective_at)].append(tx)
    previous_value = None
    pending_flow = ZERO  # flows since the last written point
    cumulative_twr = ZERO
    rows = []
    day = start
    while day <= end:
        flow = pending_flow
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
        if not complete:
            pending_flow = flow
        else:
            pending_flow = ZERO
            if previous_value is not None and previous_value > 0:
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
        portfolio_id = job.portfolio_id
    finally:
        db.close()
    with rebuild_lock(portfolio_id):
        _run_job_locked(db_factory, job_id)


def _run_job_locked(db_factory, job_id: str) -> None:
    db = db_factory()
    try:
        job = db.get(PortfolioJob, job_id)
        if not job or job.status not in {"queued", "interrupted"}:
            return
        portfolio = db.get(Portfolio, job.portfolio_id)
        if (
            portfolio
            and portfolio.projection_status != "failed"
            and portfolio.projection_revision >= portfolio.ledger_revision
            and portfolio.projection_revision > 0
        ):
            # An earlier job already built this (or a later) revision.
            job.status, job.progress = "completed", 100
            job.result = json.dumps(
                {"projection_revision": portfolio.projection_revision, "coalesced": True}
            )
            job.completed_at = datetime.now(timezone.utc)
            portfolio.projection_status = "ready"
            db.commit()
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
