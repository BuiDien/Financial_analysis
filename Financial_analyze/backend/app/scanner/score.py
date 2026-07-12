"""Deterministic scoring: weighted total, holding-horizon lean, ranking.

Pure functions. No ORM, no LLM.
"""

WEIGHTS = {"fundamentals": 0.40, "valuation": 0.30, "technical": 0.30, "catalysts": 0.0}
AVOID_THRESHOLD = 40.0


def score_stock(signals: dict) -> dict:
    total = sum(signals.get(k, 0.0) * w for k, w in WEIGHTS.items())
    long_score = signals.get("fundamentals", 0.0) * 0.5 + signals.get("valuation", 0.0) * 0.5
    short_term_score = signals.get("technical", 0.0)
    if total < AVOID_THRESHOLD:
        lean = "avoid"
    elif long_score >= short_term_score:
        lean = "long_term"
    else:
        lean = "short_term"
    return {"total_score": round(total, 2), "lean": lean}


def rank(results: list[dict]) -> list[dict]:
    ordered = sorted(results, key=lambda r: r["total_score"], reverse=True)
    for i, r in enumerate(ordered, start=1):
        r["rank"] = i
    return ordered
