from app.models.scan import ScanRun, ScanResult
from app.scanner.runner import run_scan
from tests.scanner_fixtures import good_stock, weak_stock


def test_scan_models_roundtrip(db):
    run = ScanRun(mode="manual", universe_size=2)
    db.add(run)
    db.flush()
    db.add(ScanResult(run_id=run.id, symbol="VNM",
                      scores={"fundamentals": 80, "valuation": 60, "technical": 40, "catalysts": 0},
                      total_score=62.0, lean="long", rank=1, verified=False))
    db.commit()
    row = db.query(ScanResult).one()
    assert row.symbol == "VNM" and row.lean == "long" and row.verified is False
    assert row.scores["fundamentals"] == 80


def test_run_scan_persists_ranked_results(db):
    summary = run_scan(db, mode="manual", universe=[weak_stock(), good_stock()])
    assert summary["count"] == 2

    run = db.query(ScanRun).filter(ScanRun.universe_size == 2).one()
    assert run.mode == "manual"

    results = (db.query(ScanResult).filter(ScanResult.run_id == run.id)
                 .order_by(ScanResult.rank).all())
    assert results[0].symbol == "VNM"        # good_stock ranks first
    assert results[0].rank == 1
    assert all(r.verified is False for r in results)
    assert results[0].total_score > results[1].total_score
    assert set(results[0].scores) == {"fundamentals", "valuation", "technical", "catalysts"}
