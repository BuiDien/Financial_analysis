"""Funnel evaluation: scope -> good rules -> oversold highlight, ranked.

Pure functions over views from store.load_views. No DB, no network.
"""
from __future__ import annotations

from statistics import median

from .rules import CATALOG, NOT_APPLICABLE, evaluate_rule, validate_rules
from .rules import in_scope as rule_in_scope

MIN_INDUSTRY_PE = 5


def _build_ctx(views: list[dict]) -> dict:
    by_ind: dict[str, list[float]] = {}
    all_pe: list[float] = []
    for v in views:
        pe = ((v.get("financials") or {}).get("latest") or {}).get("pe")
        if pe is None or pe <= 0:
            continue
        all_pe.append(pe)
        if v.get("industry"):
            by_ind.setdefault(v["industry"], []).append(pe)
    return {"industry_pe": {k: median(p) for k, p in by_ind.items() if len(p) >= MIN_INDUSTRY_PE},
            "universe_pe": median(all_pe) if all_pe else None}


def _in_scope(scope: dict | None, v: dict) -> bool:
    return True if scope is None else rule_in_scope(scope, v)


def evaluate_universe(views: list[dict], rules: list[dict]) -> dict:
    rules = [r for r in validate_rules(rules) if r["on"]]
    scope = next((r for r in rules if r["id"] == "scope"), None)
    good = [r for r in rules if CATALOG[r["id"]]["stage"] == "good"]
    over = [r for r in rules if CATALOG[r["id"]]["stage"] == "oversold"]
    ctx = _build_ctx(views)

    rows, skipped, in_scope = [], [], 0
    for v in views:
        if not _in_scope(scope, v):
            continue
        in_scope += 1
        res = {r["id"]: evaluate_rule(r, v, ctx) for r in good}
        if any(x["status"] == "fail" for x in res.values()):
            continue
        # "n/a" (rule does not apply to this company type) neither fails nor
        # skips; it just does not count toward strength (its score is None).
        miss = [rid for rid, x in res.items() if x["status"] == "missing"]
        if miss:
            skipped.append({"symbol": v["symbol"], "missing": miss})
            continue
        scores = [x["score"] for x in res.values() if x["score"] is not None]
        strength = round(sum(scores) / len(scores), 1) if scores else 0.0
        ores = {r["id"]: evaluate_rule(r, v, ctx) for r in over}
        statuses = [x["status"] for x in ores.values() if x["status"] != NOT_APPLICABLE]
        if not statuses or "fail" in statuses:
            flag = "no"
        elif "missing" in statuses:
            flag = "missing"
        else:
            flag = "yes"
        rows.append({"symbol": v["symbol"], "exchange": v.get("exchange"),
                     "industry": v.get("industry"), "strength": strength,
                     "not_applicable": [rid for rid, x in {**res, **ores}.items()
                                        if x["status"] == NOT_APPLICABLE],
                     "flag": (v.get("board") or {}).get("flag"),
                     "oversold": flag, "rules": {**res, **ores}})

    rows.sort(key=lambda r: (r["oversold"] != "yes", -r["strength"], r["symbol"]))
    return {"counts": {"universe": len(views), "in_scope": in_scope, "passed": len(rows),
                       "oversold": sum(r["oversold"] == "yes" for r in rows),
                       "skipped": len(skipped)},
            "rows": rows, "skipped": skipped}
