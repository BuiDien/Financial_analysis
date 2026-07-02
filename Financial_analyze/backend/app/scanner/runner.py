"""Orchestrate one scan run: fetch -> signals -> score -> rank -> persist.

Deterministic except for the universe fetch (network), which is injectable for tests.
"""
from . import signals, score
from .universe import fetch_universe
from ..models.scan import ScanRun, ScanResult


def run_scan(db, mode: str = "manual", universe: list[dict] | None = None,
             limit: int | None = None) -> dict:
    stocks = universe if universe is not None else fetch_universe(limit=limit)

    run = ScanRun(mode=mode, universe_size=len(stocks))
    db.add(run)
    db.flush()

    scored = []
    for stock in stocks:
        sig = signals.compute_signals(stock)
        sc = score.score_stock(sig)
        scored.append({"symbol": stock["symbol"], "scores": sig,
                       "total_score": sc["total_score"], "lean": sc["lean"]})

    for r in score.rank(scored):
        db.add(ScanResult(run_id=run.id, symbol=r["symbol"], scores=r["scores"],
                          total_score=r["total_score"], lean=r["lean"], rank=r["rank"],
                          verified=False))
    db.commit()
    return {"run_id": run.id, "count": len(scored)}
