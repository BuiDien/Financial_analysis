from app.scanner import signals as s
from tests.scanner_fixtures import good_stock, weak_stock


def test_scores_are_0_to_100():
    for fn in (s.fundamentals_score, s.valuation_score, s.technical_score, s.catalysts_score):
        assert 0.0 <= fn(good_stock()) <= 100.0
        assert 0.0 <= fn(weak_stock()) <= 100.0


def test_good_beats_weak_each_dimension():
    g, w = good_stock(), weak_stock()
    assert s.fundamentals_score(g) > s.fundamentals_score(w)
    assert s.valuation_score(g) > s.valuation_score(w)   # cheaper P/E vs sector
    assert s.technical_score(g) > s.technical_score(w)    # uptrend vs downtrend


def test_catalysts_zero_in_v1():
    assert s.catalysts_score(good_stock()) == 0.0


def test_none_fields_do_not_crash():
    # real universe rows may miss revenue_growth (unavailable in v1) or any ratio
    stock = good_stock()
    stock["revenue_growth"] = None
    stock["pe"] = None
    for fn in (s.fundamentals_score, s.valuation_score, s.technical_score):
        assert 0.0 <= fn(stock) <= 100.0


def test_compute_signals_keys():
    out = s.compute_signals(good_stock())
    assert set(out) == {"fundamentals", "valuation", "technical", "catalysts"}
