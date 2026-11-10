"""Backtest engine: bars + 0/1 target list -> fills, trades, equity curve."""
import math

_EPS = 1e-9


def _lots(cash: float, unit_cost: float, lot_size: int) -> int:
    """Largest multiple of lot_size affordable with cash (float-safe, never overspends)."""
    if unit_cost <= 0 or cash <= 0:
        return 0
    shares = int(math.floor(cash / unit_cost / lot_size + _EPS)) * lot_size
    while shares > 0 and shares * unit_cost > cash * (1 + 1e-12):
        shares -= lot_size
    return max(shares, 0)


def run_backtest(bars, targets, *, initial_capital, fee_rate, sell_tax_rate, lot_size,
                 price_scale, min_hold_bars, start_index=0):
    n = len(bars)
    cash = float(initial_capital)
    shares = 0
    entry_index = -1
    trade = None
    entry_cost = 0.0
    trades, equity = [], []
    exposure = 0
    skipped_buys = 0

    for i in range(start_index, n):
        bar = bars[i]
        # Act on the previous bar's signal at this bar's open.
        if i > start_index:
            want = targets[i - 1]
            px = bar["open"] * price_scale
            if want == 1 and shares == 0:
                unit = px * (1 + fee_rate)
                qty = _lots(cash, unit, lot_size)
                if qty == 0:
                    skipped_buys += 1
                if qty > 0:
                    entry_cost = qty * unit
                    cash -= entry_cost
                    shares = qty
                    entry_index = i
                    trade = {"entry_date": bar["date"], "entry_price": bar["open"], "shares": qty}
            elif want == 0 and shares > 0 and i - entry_index >= min_hold_bars:
                cash += shares * px * (1 - fee_rate - sell_tax_rate)
                pnl = shares * px * (1 - fee_rate - sell_tax_rate) - entry_cost
                trades.append({**trade, "exit_date": bar["date"], "exit_price": bar["open"],
                               "pnl": pnl, "return_pct": pnl / entry_cost * 100,
                               "bars_held": i - entry_index, "open": False})
                shares, trade = 0, None
        if shares > 0:
            exposure += 1
        equity.append({"date": bar["date"], "value": cash + shares * bar["close"] * price_scale})

    if shares > 0:
        last = bars[n - 1]
        pnl = shares * last["close"] * price_scale * (1 - fee_rate - sell_tax_rate) - entry_cost
        trades.append({**trade, "exit_date": None, "exit_price": None, "pnl": pnl,
                       "return_pct": pnl / entry_cost * 100,
                       "bars_held": n - 1 - entry_index, "open": True})

    return {"equity": equity, "trades": trades, "exposure_bars": exposure,
            "skipped_buys": skipped_buys}
