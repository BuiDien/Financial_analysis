from app.screener.evaluate import evaluate_universe
from app.marketdata.fixture import (SAMPLE_FINANCIALS, SAMPLE_UNIVERSE, FixtureProvider)
from app.screener.metrics import compute_price_metrics
from datetime import date


def view(sym, ind="Ind", bank=False, roe=None, pe=None, prices="none", stale=False, **latest):
    lat = {"pe": pe, **latest}
    years = {} if roe is None else {"2024": {"roe": roe}}
    return {"symbol": sym, "exchange": "HOSE", "industry": ind, "is_bank": bank,
            "financials": {"latest": lat, "years": years},
            "prices": None if prices == "none" else prices, "prices_stale": stale}


ROE = {"id": "roe_years", "x": 15, "n": 1}
PE = {"id": "pe_vs_industry", "x": 100}
PB = {"id": "pb", "x": 2.0}
RSI = {"id": "rsi", "x": 30}
OVER = {"rsi14": 20, "vol_multiple": 3, "closes_tail": [100, 95, 90, 88, 86, 85]}


def ids(out):
    return [r["symbol"] for r in out["rows"]]


def test_fail_beats_missing():
    out = evaluate_universe([view("A", roe=0.05, pe=None)], [ROE, PE])
    assert out["counts"]["skipped"] == 0 and out["rows"] == []


def test_missing_only_is_skipped():
    out = evaluate_universe([view("A", roe=0.2, pe=None)], [ROE, PE])
    assert out["skipped"] == [{"symbol": "A", "missing": ["pe_vs_industry"]}]


def test_oversold_requires_good_pass():
    out = evaluate_universe([view("W", roe=0.05, prices=OVER)], [ROE, RSI])
    assert out["rows"] == []


def test_oversold_block_first():
    a = view("A", roe=0.16, pb=1.9, prices=OVER)  # barely passes
    b = view("B", roe=0.5, pb=0.5, prices={**OVER, "rsi14": 60})
    out = evaluate_universe([b, a], [ROE, PB, RSI])
    assert ids(out) == ["A", "B"]
    assert out["rows"][0]["strength"] < out["rows"][1]["strength"]
    assert [r["oversold"] for r in out["rows"]] == ["yes", "no"]


def test_missing_oversold_input_listed_not_highlighted():
    out = evaluate_universe([view("A", roe=0.2, prices=None)], [ROE, RSI])
    assert out["rows"][0]["oversold"] == "missing"
    assert out["counts"]["oversold"] == 0


def test_stale_prices_never_highlight():
    rules = [ROE, RSI, {"id": "price_drop", "x": 10, "d": 5},
             {"id": "volume_spike", "x": 1.5}]
    out = evaluate_universe([view("A", roe=0.2, prices=OVER, stale=True)], rules)
    assert out["rows"][0]["oversold"] == "missing"


def test_scope_banks_only():
    vs = [view("B", bank=True, roe=0.2), view("N", roe=0.2)]
    out = evaluate_universe(vs, [ROE, {"id": "scope", "banks": "only"}])
    assert ids(out) == ["B"] and out["counts"]["in_scope"] == 1


def test_scope_industries_and_off_flag():
    vs = [view("A", ind="X", roe=0.2), view("B", ind="Y", roe=0.2)]
    out = evaluate_universe(vs, [ROE, {"id": "scope", "industries": ["X"]}])
    assert ids(out) == ["A"]
    out = evaluate_universe(vs, [ROE, {"id": "scope", "industries": ["X"], "on": False}])
    assert ids(out) == ["A", "B"]


def test_industry_median_needs_5():
    # 4 P/Es in "Small" -> falls back to universe median (of all 9 = 10 ... see below)
    small = [view(f"S{i}", ind="Small", pe=p) for i, p in enumerate([20, 20, 20, 20])]
    big = [view(f"G{i}", ind="Big", pe=p) for i, p in enumerate([5, 5, 5, 5, 5])]
    # universe median of [20x4, 5x5] = 5; industry median Big = 5
    out = evaluate_universe(small + big, [{"id": "pe_vs_industry", "x": 100}])
    # Small falls back to universe median 5 -> 20/5=400% fails; Big 100% passes
    assert sorted(ids(out)) == sorted(f"G{i}" for i in range(5))
    # had Small used its own median (20) it would pass at 100%


def test_strength_mean():
    # roe 0.30 vs x=15 -> score 100; pb 1.5 vs x=2 (at_most, span 1) -> 50
    out = evaluate_universe([view("A", roe=0.30, pb=1.5)], [ROE, PB])
    assert out["rows"][0]["strength"] == 75.0


def test_no_good_rules_strength_zero():
    out = evaluate_universe([view("A", prices=OVER)], [RSI])
    assert out["rows"][0]["strength"] == 0.0 and out["rows"][0]["oversold"] == "yes"


def test_counts_sample_fixture():
    p = FixtureProvider(end_date=date.today())
    views = []
    for e in SAMPLE_UNIVERSE:
        fin = p.fetch_financials(e)
        bars = p.fetch_prices(e["symbol"])
        views.append({**e, "financials": fin, "prices": compute_price_metrics(bars),
                      "prices_stale": False})
    rules = [{"id": "roe_years", "x": 15, "n": 3}, {"id": "profit_growth", "x": 10, "n": 3},
             {"id": "rsi", "x": 30}, {"id": "price_drop", "x": 10, "d": 5},
             {"id": "volume_spike", "x": 1.5}]
    out = evaluate_universe(views, rules)
    assert out["counts"] == {"universe": 6, "in_scope": 6, "passed": 3, "oversold": 1,
                             "skipped": 1}
    assert ids(out)[0] == "DIPCO"
    assert out["skipped"][0]["symbol"] == "NOFINCO"


def test_rows_carry_board_flag_and_flagged_hidden_by_default():
    a = view("A", roe=0.2); a["board"] = {"flag": "warning"}
    b = view("B", roe=0.2); b["board"] = {"flag": None}
    c = view("C", roe=0.2)
    out = evaluate_universe([a, b, c], [ROE, {"id": "scope"}])
    assert ids(out) == ["B", "C"] and out["counts"]["in_scope"] == 2
    out = evaluate_universe([a, b, c], [ROE, {"id": "scope", "flagged": "include"}])
    assert {r["symbol"]: r["flag"] for r in out["rows"]} == {"A": "warning", "B": None, "C": None}


# ---- rules that do not apply to a company type ("n/a") ---------------------

DE = {"id": "debt_to_equity", "x": 1.0}
NPL = {"id": "bank_npl", "x": 2}


def test_not_applicable_rule_neither_fails_nor_skips():
    bank = view("BANK", bank=True, roe=0.2, npl=0.01)            # no debt_to_equity: n/a
    corp = view("CORP", roe=0.2, debt_to_equity=0.5)             # no npl: n/a
    out = evaluate_universe([bank, corp], [ROE, DE, NPL])
    assert out["skipped"] == [] and out["counts"]["skipped"] == 0
    assert sorted(ids(out)) == ["BANK", "CORP"]
    rows = {r["symbol"]: r for r in out["rows"]}
    assert rows["BANK"]["rules"]["debt_to_equity"]["status"] == "n/a"
    assert rows["BANK"]["not_applicable"] == ["debt_to_equity"]
    assert rows["CORP"]["rules"]["bank_npl"] == {"status": "n/a", "value": None, "score": None}
    assert rows["CORP"]["not_applicable"] == ["bank_npl"]


def test_not_applicable_does_not_dilute_strength():
    alone = evaluate_universe([view("CORP", roe=0.3)], [ROE])["rows"][0]["strength"]
    with_na = evaluate_universe([view("CORP", roe=0.3)], [ROE, NPL])["rows"][0]["strength"]
    assert alone == with_na


def test_genuinely_missing_still_skips_even_with_na():
    corp = view("CORP", roe=0.2)  # non-bank, debt_to_equity missing
    out = evaluate_universe([corp], [ROE, DE, NPL])
    assert out["skipped"] == [{"symbol": "CORP", "missing": ["debt_to_equity"]}]
