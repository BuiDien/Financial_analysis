"""Rule catalog and deterministic per-rule evaluation for the screener.

Views hold ratios as fractions; thresholds and displayed values are percent
for percent rules, so conversion happens here. No network, no DB.
"""
from __future__ import annotations

import math

NA = "missing"          # data needed for the rule is not there: ticker is skipped
NOT_APPLICABLE = "n/a"  # rule does not apply to this company type: neither pass nor fail


class RuleConfigError(ValueError):
    pass


def _p(default, lo, hi, unit=""):
    return {"default": default, "min": lo, "max": hi, "unit": unit}


def _rule(rid, stage, label, kind, applies_to, params):
    return {"id": rid, "stage": stage, "label": label, "kind": kind,
            "applies_to": applies_to, "params": params}


_RULES = [
    _rule("roe_years", "good", "ROE at least X% for N years", "at_least", "all",
          {"x": _p(15, 0, 100, "%"), "n": _p(3, 1, 8, "years")}),
    _rule("profit_growth", "good", "Net profit growth at least X% a year", "at_least", "all",
          {"x": _p(10, -50, 200, "%"), "n": _p(3, 1, 3, "years")}),
    _rule("revenue_growth", "good", "Revenue growth at least X% a year", "at_least", "nonbank",
          {"x": _p(10, -50, 200, "%"), "n": _p(3, 1, 3, "years")}),
    _rule("debt_to_equity", "good", "Debt/equity below X", "at_most", "nonbank",
          {"x": _p(1.0, 0, 10)}),
    _rule("ocf_to_profit", "good", "Operating cash flow at least X% of net profit", "at_least", "nonbank",
          {"x": _p(80, 0, 300, "%"), "n": _p(3, 1, 4, "years")}),
    _rule("profit_growth_min", "good", "Net profit growth at least X% in every one of the last N years",
          "at_least", "all", {"x": _p(0, -50, 200, "%"), "n": _p(3, 1, 3, "years")}),
    _rule("receivable_days_change", "good", "Receivable days up at most X days over N years",
          "at_most", "nonbank", {"x": _p(15, 0, 365, "days"), "n": _p(3, 1, 3, "years")}),
    _rule("inventory_days_change", "good", "Inventory days up at most X days over N years",
          "at_most", "nonbank", {"x": _p(30, 0, 365, "days"), "n": _p(3, 1, 3, "years")}),
    _rule("gross_margin_change", "good", "Gross margin change at least X pts over N years",
          "at_least", "nonbank", {"x": _p(-2, -50, 50, "pts"), "n": _p(3, 1, 3, "years")}),
    _rule("share_dilution", "good", "Share count growth at most X% a year over N years",
          "at_most", "all", {"x": _p(5, 0, 100, "%"), "n": _p(3, 1, 3, "years")}),
    _rule("foreign_room", "good", "Foreign room left at least X% of the foreign cap",
          "at_least", "all", {"x": _p(5, 0, 100, "%")}),
    _rule("pe_vs_industry", "good", "P/E at most X% of industry median", "at_most", "all",
          {"x": _p(100, 10, 300, "%")}),
    _rule("pb", "good", "P/B at most X", "at_most", "all", {"x": _p(2.0, 0.1, 20)}),
    _rule("dividend_yield", "good", "Dividend yield at least X%", "at_least", "all",
          {"x": _p(5, 0, 30, "%")}),
    _rule("traded_value", "good", "Average daily traded value at least X bn VND", "at_least", "all",
          {"x": _p(5, 0, 1000, "bn VND")}),
    _rule("market_cap", "good", "Market cap at least X bn VND", "at_least", "all",
          {"x": _p(1000, 0, 2_000_000, "bn VND")}),
    _rule("bank_npl", "good", "Bank: NPL at most X%", "at_most", "bank", {"x": _p(2, 0, 20, "%")}),
    _rule("bank_nim", "good", "Bank: net interest margin at least X%", "at_least", "bank",
          {"x": _p(3, 0, 15, "%")}),
    _rule("bank_cir", "good", "Bank: cost-to-income at most X%", "at_most", "bank",
          {"x": _p(40, 0, 100, "%")}),
    _rule("bank_car", "good", "Bank: CAR at least X%", "at_least", "bank", {"x": _p(8, 0, 30, "%")}),
    _rule("rsi", "oversold", "RSI-14 below X", "at_most", "all", {"x": _p(30, 1, 99)}),
    _rule("price_drop", "oversold", "Price change over last D days at most -X%", "drop", "all",
          {"x": _p(10, 0, 80, "%"), "d": _p(5, 1, 20, "days")}),
    _rule("volume_spike", "oversold", "Latest volume at least X x 20-day average", "at_least", "all",
          {"x": _p(1.5, 1, 20, "x")}),
    _rule("scope", "scope", "Industry scope", "scope", "all",
          {"banks": {"default": "any", "options": ["any", "exclude", "no_financials", "only"]},
           "industries": {"default": []},
           "exchanges": {"default": [], "options": ["HOSE", "HNX", "UPCOM"]},
           "flagged": {"default": "exclude", "options": ["exclude", "include"]}}),
]
CATALOG: dict[str, dict] = {r["id"]: r for r in _RULES}

# Fields where VCI uses 0 for "not reported".
_ZERO_MISSING = {"pe", "pb", "market_cap"}
# Non-bank financials by industry name (brokers, insurers, funds).
_FIN_WORDS = ("tài chính", "bảo hiểm", "quỹ đầu tư", "financial", "insurance")
_ND = 6  # deliberate float-noise tolerance: CAGR 10.0000000001 must still meet x=10


# ----- validation ---------------------------------------------------------

def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _fmt(n):
    return str(int(n)) if float(n).is_integer() else str(n)


def validate_rules(rules: list[dict]) -> list[dict]:
    out, seen = [], set()
    for cfg in rules:
        if not isinstance(cfg, dict) or not isinstance(cfg.get("id"), str):
            raise RuleConfigError("rule must be an object with a string id")
        rid = cfg["id"]
        spec = CATALOG.get(rid)
        if spec is None:
            raise RuleConfigError(f"unknown rule id '{rid}'")
        if rid in seen:
            raise RuleConfigError(f"{rid}: duplicate rule id")
        seen.add(rid)
        extra = set(cfg) - {"id", "on"} - set(spec["params"])
        if extra:
            raise RuleConfigError(f"{rid}: unknown key(s) {sorted(extra)}")
        on = cfg.get("on", True)
        if not isinstance(on, bool):
            raise RuleConfigError(f"{rid}: on must be true or false")
        norm = {"id": rid, "on": on}
        for name, p in spec["params"].items():
            val = cfg.get(name, p["default"])
            if rid == "scope":
                if name in ("banks", "flagged"):
                    if val not in p["options"]:
                        raise RuleConfigError(
                            f"{rid}: {name} must be one of {', '.join(p['options'])}")
                elif name == "exchanges":
                    if not isinstance(val, list) or not all(e in p["options"] for e in val):
                        raise RuleConfigError(f"{rid}: exchanges must be a list of HOSE, HNX, UPCOM")
                    val = list(val)
                else:
                    if not isinstance(val, list) or not all(isinstance(i, str) for i in val):
                        raise RuleConfigError(f"{rid}: industries must be a list of strings")
                    val = list(val)
            else:
                if not _is_num(val):
                    raise RuleConfigError(f"{rid}: {name} must be a number")
                if name in ("n", "d"):
                    if float(val) != int(val):
                        raise RuleConfigError(f"{rid}: {name} must be a whole number")
                    val = int(val)
                if not p["min"] <= val <= p["max"]:
                    raise RuleConfigError(
                        f"{rid}: {name} must be between {_fmt(p['min'])} and {_fmt(p['max'])}")
            norm[name] = val
        out.append(norm)
    return out


# ----- value extractors: (cfg, view, ctx) -> float | None | (value, "fail") --
# None means missing; a (value, "fail") tuple is a merit failure whose value
# (possibly None) is still reported.

def _latest(view, key):
    fin = view.get("financials")
    if not fin:
        return None
    v = (fin.get("latest") or {}).get(key)
    if v is None:
        return None
    if v == 0 and key in _ZERO_MISSING:
        return None
    return v


def _consecutive(first: str, last: str, span: int) -> bool:
    """Year keys `first`..`last` are exactly `span` years apart (no gap)."""
    try:
        return int(last) - int(first) == span
    except (TypeError, ValueError):
        return False


def _years(view, field, n, extra=(), consecutive=False):
    """Newest n completed years (sorted by key) with all fields present, else None.
    consecutive=True also requires them to be n back-to-back years."""
    fin = view.get("financials")
    if not fin:
        return None
    ys = fin.get("years") or {}
    keys = sorted(ys)[-n:]
    if len(keys) < n:
        return None
    if consecutive and not _consecutive(keys[0], keys[-1], n - 1):
        return None
    rows = [ys[k] for k in keys]
    for r in rows:
        if r.get(field) is None or any(r.get(e) is None for e in extra):
            return None
    return rows


def _pct(key):
    def f(cfg, view, ctx):
        v = _latest(view, key)
        return None if v is None else v * 100
    return f


def _plain(key, negative_fails=False):
    def f(cfg, view, ctx):
        v = _latest(view, key)
        if negative_fails and v is not None and v < 0:
            return (v, "fail")  # negative equity: fails on merit, keep real value
        return v
    return f


def _roe(cfg, view, ctx):
    rows = _years(view, "roe", cfg["n"])
    return None if rows is None else min(r["roe"] for r in rows) * 100


def _growth(field):
    def f(cfg, view, ctx):
        n = cfg["n"]
        fin = view.get("financials")
        if not fin:
            return None
        ys = fin.get("years") or {}
        keys = sorted(ys)
        if not keys or ys[keys[-1]].get(field) is None or len(keys) < n + 1:
            return None
        if not _consecutive(keys[-n - 1], keys[-1], n):  # a gap would inflate the CAGR
            return None
        start, end = ys[keys[-n - 1]].get(field), ys[keys[-1]][field]
        if start is None:
            return None
        if start <= 0:
            return (None, "fail")
        if end <= 0:
            return (-100.0, "fail")
        return ((end / start) ** (1.0 / n) - 1) * 100
    return f


def _ocf(cfg, view, ctx):
    rows = _years(view, "operating_cash_flow", cfg["n"], extra=("net_profit",))
    if rows is None:
        return None
    profit = sum(r["net_profit"] for r in rows)
    if profit <= 0:
        return (None, "fail")
    return sum(r["operating_cash_flow"] for r in rows) / profit * 100


def _span(view, field, n):
    """(start, end) of `field` n years apart over the newest completed years, else None."""
    fin = view.get("financials")
    if not fin:
        return None
    ys = fin.get("years") or {}
    keys = sorted(ys)
    if len(keys) < n + 1 or not _consecutive(keys[-n - 1], keys[-1], n):
        return None
    start, end = ys[keys[-n - 1]].get(field), ys[keys[-1]].get(field)
    return None if start is None or end is None else (start, end)


def _growth_min(cfg, view, ctx):
    rows = _years(view, "net_profit", cfg["n"] + 1, consecutive=True)
    if rows is None:
        return None
    worst = None
    for prev, cur in zip(rows, rows[1:]):
        if prev["net_profit"] <= 0:
            return (None, "fail")
        g = (cur["net_profit"] / prev["net_profit"] - 1) * 100
        worst = g if worst is None else min(worst, g)
    return worst


def _days_change(field):
    def f(cfg, view, ctx):
        s = _span(view, field, cfg["n"])
        return None if s is None else s[1] - s[0]
    return f


def _margin_change(cfg, view, ctx):
    s = _span(view, "gross_margin", cfg["n"])
    return None if s is None else (s[1] - s[0]) * 100


def _dilution(cfg, view, ctx):
    s = _span(view, "shares", cfg["n"])
    if s is None or s[0] <= 0 or s[1] <= 0:
        return None
    return ((s[1] / s[0]) ** (1.0 / cfg["n"]) - 1) * 100


def _foreign_room(cfg, view, ctx):
    v = (view.get("board") or {}).get("foreign_room")
    return None if v is None else v * 100


def _pe(cfg, view, ctx):
    pe = _latest(view, "pe")
    if pe is None:
        return None
    med = (ctx.get("industry_pe") or {}).get(view.get("industry"))
    if med is None or med <= 0:
        med = ctx.get("universe_pe")
    if med is None or med <= 0:
        med = None
    if pe < 0:  # loss-maker fails on merit; still show the ratio if a median exists
        return (None if med is None else pe / med * 100, "fail")
    return None if med is None else pe / med * 100


def _mcap(cfg, view, ctx):
    v = _latest(view, "market_cap")
    return None if v is None else v / 1e9


def _traded(cfg, view, ctx):
    # Ignores ordinary staleness, but a ticker with no bars for >10 trading
    # days (delisted/suspended) must not pass forever on frozen liquidity.
    p = view.get("prices")
    return None if not p or view.get("prices_dead") else p.get("avg_value_bn")


def _oversold(field):
    def f(cfg, view, ctx):
        p = view.get("prices")
        if not p or view.get("prices_stale"):
            return None
        return p.get(field)
    return f


def _drop(cfg, view, ctx):
    p = view.get("prices")
    if not p or view.get("prices_stale"):
        return None
    tail, d = p.get("closes_tail") or [], cfg["d"]
    if len(tail) < d + 1:
        return None
    base, last = tail[-1 - d], tail[-1]
    if base is None or last is None or base <= 0:
        return None
    return (last / base - 1) * 100


_EXTRACT = {
    "roe_years": _roe,
    "profit_growth": _growth("net_profit"),
    "revenue_growth": _growth("revenue"),
    "debt_to_equity": _plain("debt_to_equity", negative_fails=True),
    "ocf_to_profit": _ocf,
    "profit_growth_min": _growth_min,
    "receivable_days_change": _days_change("receivable_days"),
    "inventory_days_change": _days_change("inventory_days"),
    "gross_margin_change": _margin_change,
    "share_dilution": _dilution,
    "foreign_room": _foreign_room,
    "pe_vs_industry": _pe,
    "pb": _plain("pb", negative_fails=True),
    "dividend_yield": _pct("dividend_yield"),
    "traded_value": _traded,
    "market_cap": _mcap,
    "bank_npl": _pct("npl"),
    "bank_nim": _pct("nim"),
    "bank_cir": _pct("cost_to_income"),
    "bank_car": _pct("car"),
    "rsi": _oversold("rsi14"),
    "price_drop": _drop,
    "volume_spike": _oversold("vol_multiple"),
}


# ----- evaluation ----------------------------------------------------------

def _res(status, value=None, score=None):
    return {"status": status, "value": value, "score": score}


def _score(kind, value, x):
    if kind == "at_least":
        span = abs(x) if x != 0 else 10
        s = (value - x) / span * 100
    else:
        span = abs(x) / 2 if x != 0 else 10
        s = (x - value) / span * 100
    return float(min(100.0, max(0.0, s)))


def is_nonbank_financial(view: dict) -> bool:
    ind = (view.get("industry") or "").casefold()
    return not view.get("is_bank") and any(w in ind for w in _FIN_WORDS)


def in_scope(cfg: dict, view: dict) -> bool:
    banks = cfg.get("banks", "any")
    if banks in ("exclude", "no_financials") and view.get("is_bank"):
        return False
    if banks == "no_financials" and is_nonbank_financial(view):
        return False
    if banks == "only" and not view.get("is_bank"):
        return False
    inds = cfg.get("industries") or []
    if inds and view.get("industry") not in inds:
        return False
    exch = cfg.get("exchanges") or []
    if exch and view.get("exchange") not in exch:
        return False
    # Missing status data never hides a ticker.
    if cfg.get("flagged", "exclude") == "exclude" and (view.get("board") or {}).get("flag"):
        return False
    return True


def _eval_scope(cfg, view):
    return _res("pass" if in_scope(cfg, view) else "fail")


def evaluate_rule(cfg: dict, view: dict, ctx: dict) -> dict:
    rid = cfg["id"]
    spec = CATALOG[rid]
    if rid == "scope":
        return _eval_scope(cfg, view)
    applies = spec["applies_to"]
    if (applies == "bank" and not view.get("is_bank")) or \
            (applies == "nonbank" and view.get("is_bank")):
        return _res(NOT_APPLICABLE)
    raw = _EXTRACT[rid](cfg, view, ctx or {})
    if isinstance(raw, tuple):  # merit failure
        v = raw[0]
        return _res("fail", None if v is None else round(v, _ND))
    if raw is None:
        return _res(NA)
    value = round(float(raw), _ND)
    x, kind = cfg["x"], spec["kind"]
    if kind == "drop":
        ok = value <= -x
    elif kind == "at_least":
        ok = value >= x
    elif rid == "rsi":
        ok = value < x
    else:
        ok = value <= x
    if not ok:
        return _res("fail", value)
    score = _score(kind, value, x) if spec["stage"] == "good" else None
    return _res("pass", value, score)
