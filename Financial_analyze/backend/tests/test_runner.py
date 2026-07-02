from app.models.scan import ScanRun, ScanResult


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
