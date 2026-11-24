"""vnstock (VCI source, pinned 4.0.4) implementation of MarketDataProvider.

This is the only module in the app that imports vnstock or knows its field
names and units (VCI quotes stocks in nghin dong; we hand out full VND). The pure `map_*` functions turn recorded frames (lists of row
dicts) into the project's canonical shapes and are tested without network.

Every network-touching vnstock call goes through the shared limiter with
priority="background"; RateLimited propagates to the caller.
"""
from __future__ import annotations

import functools
import math
from datetime import date, datetime, timedelta

from .base import (LATEST_KEYS, VN_TZ, Bar, Financials, Priority, UniverseEntry,
                   drop_partial_bar, price_unit)

EXCHANGES = {"HOSE": "HOSE", "HSX": "HOSE", "HNX": "HNX", "UPCOM": "UPCOM"}
BANK_WORDS = ("ngân hàng", "bank")
BANK_ONLY = ("npl", "nim", "cost_to_income", "car")
FISCAL_YEAR_QUARTER = 5  # ratio_summary: quarter 5 rows are fiscal-year rows (confirmed 2026-11-10)

# latest key -> ratio_summary column(s); within a row the first non-zero wins
RATIO_FIELDS: dict[str, tuple[str, ...]] = {
    "pe": ("pe",),
    "pb": ("pb",),
    "dividend_yield": ("dividend_yield",),
    "market_cap": ("market_cap",),
    "debt_to_equity": ("debt_per_equity",),  # borrowings / equity, not total liabilities
    "npl": ("npl",),
    "nim": ("net_interest_margin",),
    "cost_to_income": ("cir", "cost_to_income"),
    "car": ("car",),
}
ABS_FIELDS = ("cost_to_income",)  # VCI reports CIR with expense sign (negative)
SPARSE_FIELDS = ("car",)  # reported only in Q2/Q5 rows; see map_ratio_rows
# Quarterly rows hold only that quarter's payout; the fiscal-year row holds the
# year's yield. See map_ratio_rows.
FISCAL_FIELDS = ("dividend_yield",)


# fiscal-year (Q5) ratio_summary column -> years[y] key. Zero = not reported for
# gross margin and share count; a 0 for receivable/inventory days is real.
YEAR_RATIO_FIELDS = {"gross_margin": "gross_margin", "receivable_days": "day_sale_outstanding",
                     "inventory_days": "days_inventory_outstanding",
                     "shares": "number_of_shares_mkt_cap"}
YEAR_ZERO_MISSING = ("gross_margin", "shares")

# VCI price_board trading_status_code -> canonical flag (2026-11-11 market tally:
# 31/32/33 warning: disclosure / financial report / other violations; 34 control;
# 70/71/73 restricted; 110 suspended). 20 normal, 120 exceptional price limit,
# 130 and unknown codes are not flagged.
BOARD_FLAG_CODES = {"31": "warning", "32": "warning", "33": "warning", "34": "control",
                    "70": "restricted", "71": "restricted", "73": "restricted",
                    "110": "suspended"}
BOARD_CHUNK = 400


class ProviderError(ValueError):
    """VCI answered but had no usable data for a ticker. Not RateLimited: the
    refresh records it per ticker and keeps that ticker's previous numbers."""

# statement rows: (item_ids, item_en substring groups — all substrings of a group must match)
REVENUE = (("net_sales",), (("net sales",), ("net revenue",)))
NET_PROFIT = (("attributable_to_parent_company",
               "net_profit_attributable_to_shareholders_of_the_group"),  # insurers
              (("attributable to parent",), ("attributable to shareholders",)))
NET_PROFIT_AFTER_TAX = (("net_profit_loss_after_tax", "profit_after_tax"),
                        (("net profit", "after tax"), ("profit after tax",)))
OCF = (("net_cash_inflows_outflows_from_operating_activities",
        "net_cash_from_operating_activities"),
       (("net cash", "from operating activities"),))


def _num(v) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def _rows(df) -> list[dict]:
    """DataFrame -> list of plain dicts (NaN -> None)."""
    if df is None or getattr(df, "empty", True):
        return []
    out = []
    for r in df.to_dict("records"):
        out.append({str(k): (None if isinstance(v, float) and math.isnan(v) else v)
                    for k, v in r.items()})
    return out


def _flat_columns(df):
    """price_board has MultiIndex columns: ('listing','symbol') -> 'listing_symbol'."""
    if df is not None and not getattr(df, "empty", True):
        df = df.copy()
        df.columns = ["_".join(map(str, c)) if isinstance(c, tuple) else c for c in df.columns]
    return df


def _is_bank_name(name: str | None) -> bool:
    n = (name or "").casefold()
    return any(w in n for w in BANK_WORDS)


# ---- universe -------------------------------------------------------------

def _industry_by_symbol(industry_rows: list[dict]) -> dict[str, str]:
    """Long VCI rows (icb_level/icb_name) -> level 3, else 2, else 4, else 1.
    Wide rows -> first present of icb_name3, icb_name2, industry."""
    levels: dict[str, dict[int, str]] = {}
    wide: dict[str, str] = {}
    for r in industry_rows:
        sym = r.get("symbol")
        if not sym:
            continue
        if "icb_level" in r:
            lv, name = r.get("icb_level"), r.get("icb_name")
            if lv is not None and name:
                levels.setdefault(sym, {})[int(lv)] = name
        else:
            name = next((r[k] for k in ("icb_name3", "icb_name2", "industry") if r.get(k)), None)
            if name and sym not in wide:
                wide[sym] = name
    out = dict(wide)
    for sym, lv in levels.items():
        name = next((lv[i] for i in (3, 2, 4, 1) if lv.get(i)), None)
        if name:
            out[sym] = name
    return out


def map_universe(listing_rows: list[dict], industry_rows: list[dict]) -> list[UniverseEntry]:
    industries = _industry_by_symbol(industry_rows)
    seen: dict[str, UniverseEntry] = {}
    for r in listing_rows:
        sym = (r.get("symbol") or "").strip().upper()
        exch = EXCHANGES.get(str(r.get("exchange") or "").upper())
        if not sym or exch is None or str(r.get("type") or "").lower() != "stock":
            continue
        ind = industries.get(sym)
        seen.setdefault(sym, {"symbol": sym, "exchange": exch, "industry": ind,
                              "is_bank": _is_bank_name(ind)})
    return [seen[s] for s in sorted(seen)]


# ---- ratios ---------------------------------------------------------------

def _period(r: dict) -> tuple[int, int] | None:
    y = r.get("year_report") if r.get("year_report") is not None else r.get("year")
    q = r.get("quarter") if r.get("quarter") is not None else r.get("length_report")
    try:
        return int(y), int(q)
    except (TypeError, ValueError):
        return None


def _row_value(r: dict, cols: tuple[str, ...]) -> float | None:
    """First non-zero of `cols` in one row; 0.0 if only zeros; None if absent."""
    vals = [_num(r.get(c)) for c in cols]
    nz = next((v for v in vals if v not in (None, 0.0)), None)
    if nz is not None:
        return nz
    return 0.0 if any(v == 0.0 for v in vals) else None


def map_ratio_rows(rows: list[dict], is_bank: bool, current_year: int) -> tuple[dict, dict]:
    """(latest, years_roe). Ratios are already fractions in VCI.

    Three "latest" policies:
    - Default (pe, pb, market_cap, debt_to_equity, npl, nim, cost_to_income):
      the value in the NEWEST row by (year, quarter), zero included. A 0 pe is
      treated by the rules as missing / pe<=0 fails on merit. No fallback to
      older rows, so one definition is used for every ticker.
    - FISCAL_FIELDS (dividend_yield): VCI's quarterly rows carry only the
      dividends paid in that quarter (0 in most quarters), while the Q5 row
      carries the full fiscal year. Use the newest Q5 row (last completed year),
      zero included = paid nothing that year; newest row if there is no Q5 row.
    - SPARSE_FIELDS (car): VCI only reports CAR in Q2 and Q5 rows and writes 0
      elsewhere, so take the newest non-zero value from the newest fiscal-year
      (quarter 5) row onward (last 5 rows if there is no Q5 row). All zero means
      unreported -> None: a bank's CAR is never really 0.
    """
    dated = sorted(((p, r) for r in rows if (p := _period(r)) is not None), key=lambda t: t[0])
    years_roe: dict[str, float] = {}
    for (y, q), r in dated:
        roe = _num(r.get("roe"))
        if q == FISCAL_YEAR_QUARTER and y < current_year and roe is not None:
            years_roe[str(y)] = roe
    newest = dated[-1][1] if dated else {}
    fy_idx = [i for i, ((_, q), _) in enumerate(dated) if q == FISCAL_YEAR_QUARTER]
    window = [r for _, r in (dated[fy_idx[-1]:] if fy_idx else dated[-5:])]
    fiscal = dated[fy_idx[-1]][1] if fy_idx else newest

    latest: dict[str, float | None] = {}
    for key in LATEST_KEYS:
        if (key in BANK_ONLY and not is_bank) or (key == "debt_to_equity" and is_bank):
            latest[key] = None
            continue
        cols = RATIO_FIELDS[key]
        if key in SPARSE_FIELDS:
            val: float | None = None
            for r in reversed(window):
                v = _row_value(r, cols)
                if v not in (None, 0.0):
                    val = v
                    break
        elif key in FISCAL_FIELDS:
            val = _row_value(fiscal, cols)
        else:
            val = _row_value(newest, cols)
        if val is not None and key in ABS_FIELDS:
            val = abs(val)
        latest[key] = val
    return latest, years_roe


def map_ratio_years(rows: list[dict], current_year: int) -> dict[str, dict]:
    """Per completed fiscal year (quarter-5 rows): gross_margin (fraction),
    receivable_days, inventory_days, shares."""
    out: dict[str, dict] = {}
    for r in rows:
        p = _period(r)
        if p is None or p[1] != FISCAL_YEAR_QUARTER or p[0] >= current_year:
            continue
        y = {}
        for key, col in YEAR_RATIO_FIELDS.items():
            v = _num(r.get(col))
            y[key] = None if (v == 0.0 and key in YEAR_ZERO_MISSING) else v
        out[str(p[0])] = y
    return out


# ---- board ----------------------------------------------------------------

def _code(v) -> str | None:
    n = _num(v)
    return None if n is None else str(int(n))


def map_board(rows: list[dict]) -> dict[str, dict]:
    """Flattened price_board rows -> {symbol: {flag, status, foreign_room}}."""
    out: dict[str, dict] = {}
    for r in rows:
        sym = str(r.get("listing_symbol") or "").strip().upper()
        if not sym:
            continue
        cur, tot = _num(r.get("match_current_room")), _num(r.get("match_total_room"))
        room = None if cur is None or tot is None or tot <= 0 else max(0.0, cur / tot)
        status = r.get("listing_trading_status")
        out[sym] = {"flag": BOARD_FLAG_CODES.get(_code(r.get("listing_trading_status_code"))),
                    "status": status if isinstance(status, str) else None,
                    "foreign_room": room}
    return out


# ---- statements -----------------------------------------------------------

def _find(rows: list[dict], spec) -> dict | None:
    ids, groups = spec
    by_id = {r.get("item_id"): r for r in rows}
    for i in ids:
        if i in by_id:
            return by_id[i]
    for group in groups:
        for r in rows:
            en = str(r.get("item_en") or "").casefold()
            if all(s in en for s in group) and "before" not in en:
                return r
    return None


def _year_cols(*rows_lists: list[dict]) -> list[str]:
    cols = set()
    for rows in rows_lists:
        for r in rows:
            cols.update(k for k in r if len(k) == 4 and k.isdigit())
    return sorted(cols)


def map_statements(income_rows: list[dict], cashflow_rows: list[dict],
                   is_bank: bool) -> dict[str, dict]:
    """Per fiscal year: revenue, net_profit (attributable to parent), operating_cash_flow.
    Banks: revenue and operating_cash_flow are None."""
    rev = None if is_bank else _find(income_rows, REVENUE)
    profit = _find(income_rows, NET_PROFIT)
    after_tax = _find(income_rows, NET_PROFIT_AFTER_TAX)
    ocf = None if is_bank else _find(cashflow_rows, OCF)
    out: dict[str, dict] = {}
    for y in _year_cols(income_rows, cashflow_rows):
        p = _num(profit.get(y)) if profit else None
        if p in (None, 0.0) and after_tax:  # parent row absent/blank: use after-tax profit
            alt = _num(after_tax.get(y))
            p = p if alt is None else alt
        out[y] = {"revenue": _num(rev.get(y)) if rev else None,
                  "net_profit": p,
                  "operating_cash_flow": _num(ocf.get(y)) if ocf else None}
    return out


# ---- prices ---------------------------------------------------------------

# yfinance-style interval -> VCI token.
VCI_INTERVAL = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
                "1h": "1H", "1d": "1D", "1wk": "1W", "1mo": "1M"}


def _bar_time(t) -> str | None:
    if t is None:
        return None
    if isinstance(t, datetime):  # incl. pandas Timestamp
        return t.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(t, date):
        return f"{t.isoformat()} 00:00:00"
    return str(t)


def _period_start(stamp: str, token: str) -> str:
    """VCI labels weekly bars by the week's last day (Sunday) and monthly bars
    by the month's last day. Re-label them by their first day (Monday / the
    1st), like Yahoo does, so a trade inside the period lands on its bar."""
    if token not in ("1W", "1M"):
        return stamp
    try:
        d = datetime.fromisoformat(stamp[:10]).date()
    except ValueError:
        return stamp
    d = d - timedelta(days=d.weekday()) if token == "1W" else d.replace(day=1)
    return f"{d.isoformat()} 00:00:00"


def _scaled(v: float, unit: float) -> float:
    return v if unit == 1 else round(v * unit, 6)


def map_ohlc(history_rows: list[dict], unit: float = 1000.0, token: str = "1D",
             start: str | None = None, end: str | None = None) -> list[Bar]:
    """VCI bars -> canonical Bars (prices x `unit` = full VND), oldest first.
    Rows with a missing/non-finite price are dropped; bad volume -> 0.
    start/end (ISO dates) bound VCI's own bar label, before re-labelling."""
    bars: list[Bar] = []
    for r in history_rows:
        stamp = _bar_time(r.get("time"))
        px = {k: _num(r.get(k)) for k in ("open", "high", "low", "close")}
        if stamp is None or any(v is None for v in px.values()):
            continue
        if (start and stamp[:10] < start) or (end and stamp[:10] > end):
            continue
        bars.append({"date": _period_start(stamp, token),
                     **{k: _scaled(v, unit) for k, v in px.items()},  # type: ignore[arg-type]
                     "volume": _num(r.get("volume")) or 0.0})
    bars.sort(key=lambda b: b["date"])
    return bars


# ---- provider -------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(VN_TZ)


@functools.cache
def _vnstock() -> dict:
    """Lazy import so tests and the fixture provider never load vnstock."""
    from vnstock.explorer.vci import Company, Finance, Listing, Quote, Trading

    class LeanFinance(Finance):
        """Finance() normally downloads the whole ICB listing just to learn the
        company type, which the statements do not use. We already know it."""

        def __init__(self, symbol, is_bank=False):
            self._com_type = "NH" if is_bank else "CT"
            super().__init__(symbol, period="year", show_log=False)

        def _get_company_type(self):
            return self._com_type

    return {"Listing": Listing, "Company": Company, "Finance": LeanFinance, "Quote": Quote,
            "Trading": Trading}


class VnstockProvider:
    name = "vnstock"

    def __init__(self, limiter=None, current_year: int | None = None):
        self._limiter = limiter
        self._current_year = current_year

    def _call(self, fn, *a, priority: Priority = "background", **kw):
        lim = self._limiter
        if lim is None:
            from . import ratelimit  # looked up per call: tests swap the singleton
            lim = ratelimit.vnstock_limiter
        return lim.call(fn, *a, priority=priority, **kw)

    def _year(self) -> int:
        return self._current_year or datetime.now(VN_TZ).year

    def list_universe(self) -> list[UniverseEntry]:
        vn = _vnstock()
        listing = self._call(lambda: vn["Listing"]().symbols_by_exchange())
        industries = self._call(lambda: vn["Listing"]().symbols_by_industries())
        return map_universe(_rows(listing), _rows(industries))

    def list_company_names(self) -> dict[str, str]:
        vn = _vnstock()
        df = self._call(lambda: vn["Listing"]().all_symbols())
        return {str(r["symbol"]).upper(): str(r["organ_name"]).strip()
                for r in _rows(df) if r.get("symbol") and r.get("organ_name")}

    def fetch_financials(self, entry: UniverseEntry) -> Financials:
        vn = _vnstock()
        sym, is_bank = entry["symbol"], bool(entry.get("is_bank"))
        ratios = self._call(lambda: vn["Company"](sym).ratio_summary())
        ratio_rows = _rows(ratios)  # vnstock 4.0.4 returns an empty frame, no error
        if not ratio_rows:
            raise ProviderError(f"no ratio data from VCI for {sym}")
        latest, years_roe = map_ratio_rows(ratio_rows, is_bank, self._year())
        if not years_roe and all(v is None for v in latest.values()):
            raise ProviderError(f"empty ratio data from VCI for {sym}")
        fin = self._call(lambda: vn["Finance"](sym, is_bank))
        income = self._call(lambda: fin.income_statement(period="year"))
        cash = self._call(lambda: fin.cash_flow(period="year"))
        stmts = map_statements(_rows(income), _rows(cash), is_bank)
        extra = map_ratio_years(ratio_rows, self._year())
        years: dict[str, dict] = {}
        for y in sorted(set(years_roe) | set(stmts)):
            if int(y) >= self._year():
                continue
            s = stmts.get(y, {})
            years[y] = {"roe": years_roe.get(y), "revenue": s.get("revenue"),
                        "net_profit": s.get("net_profit"),
                        "operating_cash_flow": s.get("operating_cash_flow"),
                        **{k: (extra.get(y) or {}).get(k) for k in YEAR_RATIO_FIELDS}}
        return {"latest": latest, "years": years}

    def fetch_board(self, symbols: list[str]) -> dict[str, dict]:
        vn = _vnstock()
        out: dict[str, dict] = {}
        for i in range(0, len(symbols), BOARD_CHUNK):
            chunk = list(symbols[i:i + BOARD_CHUNK])
            df = self._call(lambda: vn["Trading"]().price_board(chunk))
            out.update(map_board(_rows(_flat_columns(df))))
        return out

    def fetch_ohlc(self, symbol: str, start: date, end: date, interval: str = "1d",
                   priority: Priority = "background") -> list[Bar]:
        if interval not in VCI_INTERVAL:
            raise ValueError(f"unsupported interval: {interval!r}")
        vn = _vnstock()
        token = VCI_INTERVAL[interval]
        df = self._call(lambda: vn["Quote"](symbol).history(
            start=start.isoformat(), end=end.isoformat(), interval=token), priority=priority)
        # VCI can ignore the start bound for intraday intervals and return weeks
        # of bars: enforce the window here.
        return map_ohlc(_rows(df), price_unit(symbol), token,
                        start=start.isoformat(), end=end.isoformat())

    def fetch_prices(self, symbol: str, days: int = 120) -> list[dict]:
        now = _now()
        end = now.date()
        bars = self.fetch_ohlc(symbol, end - timedelta(days=days), end, "1d")
        return [{"date": b["date"][:10], "close": b["close"], "volume": b["volume"]}
                for b in drop_partial_bar(bars, now)]
