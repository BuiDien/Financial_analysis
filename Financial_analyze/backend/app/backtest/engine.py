"""Backtest engine: bars + 0/1 target list -> fills, trades, equity curve.

Fills happen at the next bar's open, made less optimistic by:
- slippage_rate: buys pay open * (1 + s), sells get open * (1 - s);
- lock_check: no fill on a bar locked at one price (open == high == low), nor a
  buy opening at the ceiling / a sell opening at the floor when `limit_pct`
  (the exchange's daily band, relative to the previous close) is known;
- max_volume_frac: at most this fraction of the bar's volume is traded; a sell
  that does not fit is finished on the following bars.
"""
import math

_EPS = 1e-9

# VN daily price bands (fraction of the reference = previous close).
VN_LIMIT_PCT = {"HOSE": 0.07, "HNX": 0.10, "UPCOM": 0.15}


def vn_tick(price_vnd: float, exchange: str | None) -> float:
    """VN price step in VND: HOSE 10/50/100 by price level, HNX/UPCOM 100."""
    if exchange == "HOSE":
        return 10.0 if price_vnd < 10_000 else 50.0 if price_vnd < 50_000 else 100.0
    return 100.0


def _lots(cash: float, unit_cost: float, lot_size: int) -> int:
    """Largest multiple of lot_size affordable with cash (float-safe, never overspends)."""
    if unit_cost <= 0 or cash <= 0:
        return 0
    shares = int(math.floor(cash / unit_cost / lot_size + _EPS)) * lot_size
    while shares > 0 and shares * unit_cost > cash * (1 + 1e-12):
        shares -= lot_size
    return max(shares, 0)


def _blocked(bar, prev_close, side, limit_pct, price_scale, tick_fn) -> bool:
    o, h, lo = bar["open"], bar["high"], bar["low"]
    if o == h == lo:
        return True
    if not limit_pct or not prev_close or prev_close <= 0:
        return False
    ref = prev_close * price_scale
    o_vnd = o * price_scale
    if side == "buy":
        raw = ref * (1 + limit_pct)
        tick = tick_fn(raw)
        ceiling = math.floor(raw / tick + _EPS) * tick
        return o_vnd >= ceiling - _EPS
    raw = ref * (1 - limit_pct)
    tick = tick_fn(raw)
    floor_ = math.ceil(raw / tick - _EPS) * tick
    return o_vnd <= floor_ + _EPS


def _volume_cap(bar, max_volume_frac, lot_size) -> int | None:
    """Shares tradable on this bar, or None for no cap (off / volume unknown)."""
    if not max_volume_frac:
        return None
    vol = bar.get("volume") or 0
    if vol <= 0:
        return None
    return int(math.floor(vol * max_volume_frac / lot_size + _EPS)) * lot_size


def run_backtest(bars, targets, *, initial_capital, fee_rate, sell_tax_rate, lot_size,
                 price_scale, min_hold_bars, start_index=0, slippage_rate=0.0,
                 lock_check=False, limit_pct=None, tick_fn=None, max_volume_frac=None):
    tick_fn = tick_fn or (lambda p: 1e-9)
    n = len(bars)
    cash = float(initial_capital)
    shares = 0
    entry_index = -1
    trade = None
    entry_cost = 0.0
    exit_proceeds = exit_value = 0.0
    exit_shares = 0
    trades, equity = [], []
    exposure = 0
    skipped_buys = 0
    blocked_fills = 0

    for i in range(start_index, n):
        bar = bars[i]
        # Act on the previous bar's signal at this bar's open.
        if i > start_index:
            want = targets[i - 1]
            prev_close = bars[i - 1]["close"]
            if want == 1 and shares == 0:
                buy_px = bar["open"] * (1 + slippage_rate)
                unit = buy_px * price_scale * (1 + fee_rate)
                affordable = _lots(cash, unit, lot_size)
                cap = _volume_cap(bar, max_volume_frac, lot_size)
                if affordable == 0:
                    skipped_buys += 1
                elif lock_check and _blocked(bar, prev_close, "buy", limit_pct,
                                             price_scale, tick_fn):
                    blocked_fills += 1
                elif cap == 0:
                    blocked_fills += 1
                else:
                    qty = affordable if cap is None else min(affordable, cap)
                    entry_cost = qty * unit
                    cash -= entry_cost
                    shares = qty
                    entry_index = i
                    exit_proceeds = exit_value = 0.0
                    exit_shares = 0
                    trade = {"entry_date": bar["date"], "entry_price": buy_px, "shares": qty}
            elif want == 0 and shares > 0 and i - entry_index >= min_hold_bars:
                cap = _volume_cap(bar, max_volume_frac, lot_size)
                if (lock_check and _blocked(bar, prev_close, "sell", limit_pct,
                                            price_scale, tick_fn)) or cap == 0:
                    blocked_fills += 1
                else:
                    qty = shares if cap is None else min(shares, cap)
                    sell_px = bar["open"] * (1 - slippage_rate)
                    proceeds = qty * sell_px * price_scale * (1 - fee_rate - sell_tax_rate)
                    cash += proceeds
                    exit_proceeds += proceeds
                    exit_value += qty * sell_px
                    exit_shares += qty
                    shares -= qty
                    if shares == 0:
                        pnl = exit_proceeds - entry_cost
                        trades.append({**trade, "exit_date": bar["date"],
                                       "exit_price": exit_value / exit_shares,
                                       "pnl": pnl, "return_pct": pnl / entry_cost * 100,
                                       "bars_held": i - entry_index, "open": False})
                        trade = None
        if shares > 0:
            exposure += 1
        equity.append({"date": bar["date"], "value": cash + shares * bar["close"] * price_scale})

    if shares > 0:
        last = bars[n - 1]
        pnl = (exit_proceeds + shares * last["close"] * price_scale
               * (1 - fee_rate - sell_tax_rate) - entry_cost)
        trades.append({**trade, "exit_date": None, "exit_price": None, "pnl": pnl,
                       "return_pct": pnl / entry_cost * 100,
                       "bars_held": n - 1 - entry_index, "open": True})

    return {"equity": equity, "trades": trades, "exposure_bars": exposure,
            "skipped_buys": skipped_buys, "blocked_fills": blocked_fills}
