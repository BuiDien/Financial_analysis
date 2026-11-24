from datetime import date

from app.models.newswatch import NewsAlert
from app.newswatch.episodes import sweep

TODAY = date(2026, 11, 13)
TH = {"rsi_max": 30.0, "drop_pct": 10.0, "sessions": 5, "rsi_reset": 40.0}

FALLING = [100 - i * 2.0 for i in range(30)]               # RSI ~0, -10%+ over 5
STEEP = [100 - i * 3.0 for i in range(30)]                 # worse 5-session drop
RECOVER = FALLING + [60 + i * 6.0 for i in range(1, 15)]   # RSI > 40, rising
_UP = [100 + i * 2.0 for i in range(40)]
SLIDE = _UP + [_UP[-1] * (1 - 0.016 * j) for j in range(1, 6)]  # RSI ~61, -8% over 5


def open_ep(db, ticker):
    db.add(NewsAlert(kind="holding", ticker=ticker, alert_date=TODAY, verdict="no_news",
                     message="m", facts={}, episode_open=True))
    db.commit()


def is_open(db, ticker):
    return db.query(NewsAlert).filter_by(kind="holding", ticker=ticker,
                                         episode_open=True).count() > 0


def test_new_episode_is_candidate(db):
    out = sweep(db, ["HPG"], {"HPG": FALLING}, TH)
    assert [t for t, _ in out] == ["HPG"]
    assert out[0][1]["drop_pct"] < -10


def test_ongoing_episode_skipped(db):
    open_ep(db, "HPG")
    assert sweep(db, ["HPG"], {"HPG": FALLING}, TH) == []
    assert is_open(db, "HPG")


def test_recovery_closes_episode(db):
    open_ep(db, "HPG")
    assert sweep(db, ["HPG"], {"HPG": RECOVER}, TH) == []
    assert not is_open(db, "HPG")


def test_flap_guard_keeps_episode_open_while_still_sliding(db):
    open_ep(db, "HPG")
    assert sweep(db, ["HPG"], {"HPG": SLIDE}, TH) == []
    assert is_open(db, "HPG")


def test_unheld_ticker_episode_closed(db):
    open_ep(db, "VNM")
    sweep(db, ["HPG"], {"HPG": FALLING}, TH)
    assert not is_open(db, "VNM")


def test_held_ticker_without_price_data_untouched(db):
    open_ep(db, "VNM")
    assert sweep(db, ["VNM", "HPG"], {"HPG": RECOVER}, TH) == []
    assert is_open(db, "VNM")


def test_sweep_never_commits(db):
    open_ep(db, "VNM")   # unheld -> would close
    open_ep(db, "HPG")   # recovered -> would close
    sweep(db, ["HPG"], {"HPG": RECOVER}, TH)
    db.rollback()
    assert is_open(db, "VNM") and is_open(db, "HPG")


def test_candidates_sorted_worst_drop_first(db):
    out = sweep(db, ["A", "B"], {"A": FALLING, "B": STEEP}, TH)
    assert [t for t, _ in out] == ["B", "A"]
