import pytest

from app.screener import strategies as st
from app.screener.store import get_state, set_state


def _by_key(db, key):
    return next(s for s in st.list_strategies(db) if s["starter_key"] == key)


def test_seed_is_idempotent(db):
    st.seed_starters(db)
    st.seed_starters(db)
    rows = st.list_strategies(db)
    assert len(rows) == 4
    assert [r["starter_key"] for r in rows] == ["quality", "deep_value", "dividend", "banks"]


def test_starter_rules_validate():
    from app.screener.rules import validate_rules
    for s in st.STARTERS.values():
        validate_rules(s["rules"])


def test_quality_values(db):
    st.seed_starters(db)
    rules = {r["id"]: r for r in _by_key(db, "quality")["rules"]}
    assert rules["roe_years"]["x"] == 12
    assert rules["scope"]["banks"] == "no_financials"
    assert rules["scope"]["flagged"] == "exclude"


def test_create_duplicate_name_409(db):
    st.create_strategy(db, "Mine", [])
    with pytest.raises(st.StrategyError) as e:
        st.create_strategy(db, "Mine", [])
    assert e.value.status == 409


def test_delete_starter_409(db):
    st.seed_starters(db)
    with pytest.raises(st.StrategyError) as e:
        st.delete_strategy(db, _by_key(db, "quality")["id"])
    assert e.value.status == 409


def test_reset_restores_defaults(db):
    st.seed_starters(db)
    q = _by_key(db, "quality")
    rules = [dict(r, x=20) if r["id"] == "roe_years" else r for r in q["rules"]]
    st.update_strategy(db, q["id"], None, rules)
    assert {r["id"]: r for r in _by_key(db, "quality")["rules"]}["roe_years"]["x"] == 20
    out = st.reset_strategy(db, q["id"])
    assert {r["id"]: r for r in out["rules"]}["roe_years"]["x"] == 12


def test_reset_user_strategy_409(db):
    s = st.create_strategy(db, "Mine", [])
    with pytest.raises(st.StrategyError) as e:
        st.reset_strategy(db, s["id"])
    assert e.value.status == 409


def test_delete_clears_last_strategy(db):
    s = st.create_strategy(db, "Mine", [])
    set_state(db, "last_strategy_id", s["id"])
    st.delete_strategy(db, s["id"])
    assert get_state(db, "last_strategy_id") is None


def test_update_bad_rules_422(db):
    s = st.create_strategy(db, "Mine", [])
    with pytest.raises(st.StrategyError) as e:
        st.update_strategy(db, s["id"], None, [{"id": "nope"}])
    assert e.value.status == 422
    assert "nope" in str(e.value)


def test_unknown_id_404_and_order(db):
    with pytest.raises(st.StrategyError) as e:
        st.delete_strategy(db, 999)
    assert e.value.status == 404
    st.create_strategy(db, "Zed", [])
    st.create_strategy(db, "Alpha", [])
    st.seed_starters(db)
    names = [r["name"] for r in st.list_strategies(db)]
    assert names[-2:] == ["Alpha", "Zed"]
    assert st.list_strategies(db)[0]["updated_at"].endswith("+00:00")


def test_quality_has_quality_of_earnings_checks(db):
    st.seed_starters(db)
    rules = {r["id"]: r for r in _by_key(db, "quality")["rules"]}
    assert rules["profit_growth_min"]["x"] == -10
    assert rules["receivable_days_change"]["x"] == 15
    assert rules["gross_margin_change"]["x"] == -5
    assert "share_dilution" not in rules  # bonus shares would wrongly fail FPT/SAB
