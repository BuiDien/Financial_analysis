"""Portfolio valuation: projections priced at live quotes in the display currency."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models.portfolio import CashProjection, PositionProjection, ProjectionSummary
from . import portfolio_engine as engine
from .errors import ServiceError
from .portfolio_ledger import get_or_create


def portfolio_view(db: Session, currency: str | None = None) -> dict:
    p = get_or_create(db)
    if currency and currency.upper() != p.display_currency:
        raise ServiceError(
            409,
            f"Portfolio projection is in {p.display_currency}; update preferences before requesting {currency.upper()}",
        )
    positions = db.query(PositionProjection).filter_by(portfolio_id=p.id).all()
    cash_rows = db.query(CashProjection).filter_by(portfolio_id=p.id).all()
    summary = db.get(ProjectionSummary, p.id)
    holdings, missing, stale = [], [], []
    position_value = Decimal("0")
    today_change = Decimal("0")
    live = engine.prefetch_quotes([(row.ticker, row.currency) for row in positions])
    quotes_pending = sum(1 for v in live.values() if v is engine._PENDING)
    for row in positions:
        item, freshness = engine.quote(db, row.ticker, row.currency, live.get(row.ticker))
        if not item:
            missing.append({"kind": "quote", "key": row.ticker})
            price = value_native = value_display = None
        else:
            price = engine.dec(item["price"])
            value_native = price * engine.dec(row.quantity)
            try:
                rate, fx_meta = engine.fx_rate(db, row.currency, p.display_currency)
                value_display = value_native * rate
                if fx_meta["stale"]:
                    stale.append(
                        {
                            "kind": "fx",
                            "key": f"{row.currency}/{p.display_currency}",
                            **fx_meta,
                        }
                    )
                position_value += value_display
                today_change += (
                    engine.dec(item.get("change", 0)) * engine.dec(row.quantity) * rate
                )
            except ValueError:
                value_display = None
                missing.append(
                    {"kind": "fx", "key": f"{row.currency}/{p.display_currency}"}
                )
            if freshness["stale"]:
                stale.append({"kind": "quote", "key": row.ticker, **freshness})
        cost = engine.dec(row.cost_basis_display)
        gain = value_display - cost if value_display is not None else None
        holdings.append(
            {
                "ticker": row.ticker,
                "currency": row.currency,
                "shares": float(row.quantity),
                "avg_cost": float(
                    engine.dec(row.cost_basis_native) / engine.dec(row.quantity)
                ),
                "price": float(price) if price is not None else None,
                "value_native": float(value_native)
                if value_native is not None
                else None,
                "value": float(value_display) if value_display is not None else None,
                "cost_basis": float(cost),
                "gain": float(gain) if gain is not None else None,
                "gain_pct": float(gain / cost * 100)
                if gain is not None and cost
                else 0,
            }
        )
    cash_total = Decimal("0")
    cash = []
    for row in cash_rows:
        try:
            rate, meta = engine.fx_rate(db, row.currency, p.display_currency)
            converted = engine.dec(row.balance) * rate
            cash_total += converted
            if meta["stale"]:
                stale.append(
                    {
                        "kind": "fx",
                        "key": f"{row.currency}/{p.display_currency}",
                        **meta,
                    }
                )
        except ValueError:
            converted = None
            missing.append(
                {"kind": "fx", "key": f"{row.currency}/{p.display_currency}"}
            )
        cash.append(
            {
                "currency": row.currency,
                "balance": float(row.balance),
                "converted": float(converted) if converted is not None else None,
                "warning": "negative_cash" if row.balance < 0 else None,
            }
        )
    total = position_value + cash_total
    realized = engine.dec(summary.realized_gain) if summary else Decimal("0")
    income = engine.dec(summary.income) if summary else Decimal("0")
    contributions = engine.dec(summary.net_contributions) if summary else Decimal("0")
    # Total return includes market, income, expenses, and FX effects while
    # external deposits/withdrawals remain excluded.
    total_gain = total - contributions
    for h in holdings:
        h["weight"] = (
            (h["value"] / float(total) * 100) if h["value"] is not None and total else 0
        )
    try:
        db.commit()  # persist fresh cache points
    except IntegrityError:
        # A concurrent request cached the same (kind, key, date) first; the
        # cache is best-effort, so keep its row and still return this response.
        db.rollback()
    return {
        "id": p.id,
        "name": p.name,
        "display_currency": p.display_currency,
        "total_value": float(total),
        "position_value": float(position_value),
        "cash_value": float(cash_total),
        "today_change": float(today_change),
        "today_change_pct": float(today_change / (total - today_change) * 100)
        if total != today_change
        else 0,
        "total_gain": float(total_gain),
        "total_gain_pct": float(total_gain / abs(contributions) * 100)
        if contributions
        else 0,
        "realized_gain": float(realized),
        "income": float(income),
        "holdings": holdings,
        "cash": cash,
        "complete": not missing,
        "missing": missing,
        "stale": stale,
        "quotes_pending": quotes_pending,
        "as_of": datetime.now(timezone.utc),
        "ledger_revision": p.ledger_revision,
        "projection_revision": p.projection_revision,
        "projection_status": p.projection_status,
    }


def statement_text(db: Session) -> str:
    data = portfolio_view(db, currency=None)
    currency = data["display_currency"]
    lines = [
        "PORTFOLIO STATEMENT",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        f"Ledger revision: {data['ledger_revision']}",
        f"Valuation complete: {'yes' if data['complete'] else 'no'}",
        "",
        f"Total value ({currency}): {data['total_value']:.2f}",
        f"Cash ({currency}): {data['cash_value']:.2f}",
        f"Investment gain ({currency}): {data['total_gain']:.2f} ({data['total_gain_pct']:.2f}%)",
        "",
        "HOLDINGS",
        "Ticker,Currency,Shares,Avg FIFO Cost,Last,Converted Value,Gain,Gain %,Weight %",
    ]
    for holding in data["holdings"]:
        lines.append(
            ",".join(
                str(value if value is not None else "")
                for value in (
                    holding["ticker"],
                    holding["currency"],
                    holding["shares"],
                    holding["avg_cost"],
                    holding["price"],
                    holding["value"],
                    holding["gain"],
                    holding["gain_pct"],
                    holding["weight"],
                )
            )
        )
    return "\n".join(lines)
