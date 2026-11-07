from datetime import date

from app.services.history_facts import PointState, derive_missing_quarters, fact_key, point_states
from app.services.history_periods import Period


def F(id, ptype, start, end, value, origin="printed", status="active", item=1, line="rev"):
    return {
        "id": id, "line_key": line, "period_type": ptype, "period_start": start,
        "period_end": end, "value": value, "origin": origin, "inbox_item_id": item, "status": status,
    }


def Q(id, q, value, year=2025, **kw):
    m = (q - 1) * 3 + 1
    ends = {1: date(year, 3, 31), 2: date(year, 6, 30), 3: date(year, 9, 30), 4: date(year, 12, 31)}
    return F(id, "quarter", date(year, m, 1), ends[q], value, **kw)


def YTD(id, end, value, year=2025):
    return F(id, "ytd", date(year, 1, 1), end, value)


def YEAR(id, value, year=2025):
    return F(id, "year", date(year, 1, 1), date(year, 12, 31), value)


def key_of(f):
    return fact_key(f["line_key"], Period(f["period_type"], f["period_start"], f["period_end"]))


def test_fact_key_format():
    assert fact_key("rev", Period("instant", None, date(2025, 3, 31))) == "rev|instant||2025-03-31"


def test_single_and_agree():
    a = Q(1, 1, 10)
    s = point_states([a], {})[key_of(a)]
    assert isinstance(s, PointState) and s.status == "single" and s.value == 10
    b = Q(2, 1, 10, item=2)
    s = point_states([a, b], {})[key_of(a)]
    assert s.status == "agree" and s.value == 10 and s.source_ids == [1, 2]


def test_duplicate_upload_is_one_point():
    a, b = Q(1, 1, 10, item=1), Q(2, 1, 10, item=2)
    states = point_states([a, b], {})
    assert len(states) == 1 and states[key_of(a)].status == "agree"


def test_inactive_ignored():
    a, b = Q(1, 1, 10), Q(2, 1, 99, status="superseded")
    assert point_states([a, b], {})[key_of(a)].status == "single"


def test_conflict_has_no_value():
    a, b = Q(1, 1, 10), Q(2, 1, 11, item=2)
    s = point_states([a, b], {})[key_of(a)]
    assert s.status == "conflict" and s.value is None


def test_resolution_applies_only_while_source_unchanged():
    k = key_of(Q(7, 1, 5))
    res = {k: {"chosen_fact_id": 7, "chosen_value": 5}}
    s = point_states([Q(7, 1, 5), Q(8, 1, 6, item=2)], res)[k]
    assert s.status == "resolved" and s.value == 5
    assert point_states([Q(7, 1, 6), Q(8, 1, 7, item=2)], res)[k].status == "conflict"
    assert point_states([Q(7, 1, 5, status="superseded"), Q(8, 1, 6, item=2), Q(9, 1, 7, item=3)], res)[k].status == "conflict"


def test_derive_q4_from_year_minus_9m_ytd():
    out = derive_missing_quarters([YEAR(1, 100), YTD(2, date(2025, 9, 30), 70)])
    assert len(out) == 1
    d = out[0]
    assert d["period_type"] == "quarter" and d["period_start"] == date(2025, 10, 1)
    assert d["period_end"] == date(2025, 12, 31) and d["value"] == 30
    assert d["origin"] == "calculated" and d["id"] is None
    assert sorted(d["inputs"]) == [1, 2] and d["conflicts_with_printed"] is False


def test_derive_q2_q3():
    out = derive_missing_quarters([Q(1, 1, 10), YTD(2, date(2025, 6, 30), 25), YTD(3, date(2025, 9, 30), 45)])
    by = {d["period_start"]: d["value"] for d in out}
    assert by == {date(2025, 4, 1): 15, date(2025, 7, 1): 20}


def test_printed_quarter_equal_not_returned():
    assert derive_missing_quarters([YEAR(1, 100), YTD(2, date(2025, 9, 30), 70), Q(3, 4, 30)]) == []


def test_printed_quarter_not_overridden():
    out = derive_missing_quarters([YEAR(1, 100), YTD(2, date(2025, 9, 30), 70), Q(3, 4, 31)])
    assert len(out) == 1 and out[0]["value"] == 30 and out[0]["conflicts_with_printed"] is True


def test_balance_instants_never_derived():
    f = [F(1, "instant", None, date(2025, 12, 31), 5), F(2, "instant", None, date(2025, 9, 30), 3)]
    assert derive_missing_quarters(f) == []


def test_ignores_calculated_and_inactive_inputs():
    f = [YEAR(1, 100), F(2, "ytd", date(2025, 1, 1), date(2025, 9, 30), 70, origin="calculated")]
    assert derive_missing_quarters(f) == []
    f = [YEAR(1, 100), F(2, "ytd", date(2025, 1, 1), date(2025, 9, 30), 70, status="superseded")]
    assert derive_missing_quarters(f) == []


def test_ytd_not_from_jan1_ignored():
    f = [YEAR(1, 100), F(2, "ytd", date(2025, 2, 1), date(2025, 9, 30), 70)]
    assert derive_missing_quarters(f) == []


def test_agree_needs_two_documents():
    # Two equal facts from ONE document are one source, never "2 sources agree".
    a, b = Q(1, 1, 10, item=1), Q(2, 1, 10, item=1)
    s = point_states([a, b], {})[key_of(a)]
    assert s.status == "single" and s.value == 10
    c = Q(3, 1, 10, item=2)
    assert point_states([a, b, c], {})[key_of(a)].status == "agree"
