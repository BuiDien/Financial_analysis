from datetime import date

from app.newswatch.message import (combine, format_global_alert,
                                   format_holding_alert, write_alert_note)


def _facts(**kw):
    f = {
        "ticker": "HPG",
        "signal": {"rsi": 26.4, "drop_pct": -11.2, "sessions": 5, "close": 20000.0},
        "vnindex_pct": -6.0,
        "company_news": [],
        "global_news": [{"id": "g1", "title": "Global rout", "url": "http://g/1",
                         "source": "Reuters", "published": 0, "summary": ""},
                        {"id": "g2", "title": "Other", "url": "http://g/2",
                         "source": "AP", "published": 0, "summary": ""}],
        "source_errors": [],
        "has_alias": True,
    }
    f.update(kw)
    return f


def test_spec_example_exact():
    v = {"category": "market_wide", "reason": "VN-Index fell with global selloff.", "cited": ["g1"]}
    assert format_holding_alert(_facts(), v) == (
        "🔻 HPG oversold — RSI 26, -11% in 5 sessions\n"
        "Verdict: Broad selloff, no company problem found. VN-Index fell with global selloff.\n"
        "Facts:\n"
        " • VN-Index -6.0% same period\n"
        " • No HPG news found in sources checked (7d)\n"
        " • Global: [Global rout](http://g/1) — Reuters"
    )


def test_unavailable_still_shows_facts():
    v = {"category": "unavailable", "reason": "", "cited": []}
    out = format_holding_alert(_facts(source_errors=["vietstock: timeout", "vietstock: x", "web: y"]), v)
    assert out.split("\n")[1] == "Verdict unavailable (model not reachable)"
    assert "VN-Index -6.0%" in out
    assert "⚠ Sources unavailable: vietstock, web" in out


def test_company_items_cited_first_with_date_and_no_rsi():
    items = [{"id": "c1", "title": "A", "url": "u1", "source": "S", "published": 1767222000, "summary": ""},
             {"id": "c2", "title": "B", "url": "u2", "source": "S", "published": 0, "summary": ""}]
    v = {"category": "company_news", "reason": "r", "cited": ["c2"]}
    out = format_holding_alert(_facts(company_news=items, vnindex_pct=None,
                                      signal={"rsi": None, "drop_pct": -11.2, "sessions": 5, "close": 1.0}), v)
    assert out.startswith("🔻 HPG oversold — -11% in 5 sessions")
    assert "VN-Index" not in out
    assert out.index("[B](u2) — S") < out.index("[A](u1) — S, 01/01")


def test_global_alert_headers():
    it = [{"id": "g1", "title": "T", "url": "u", "source": "S", "published": 0, "summary": "", "topic": "tariffs"}]
    a = format_global_alert(it, -2.5, {"category": "global_cause", "reason": "r", "cited": ["g1"]})
    assert a.startswith("🌏 Vietnam market alert — VN-Index -2.5% today\nVerdict: Likely global cause. r")
    assert " • [T](u) — S" in a
    b = format_global_alert(it, None, {"category": "vietnam_topic", "reason": "r", "cited": ["g1"]})
    assert b.startswith("🌏 Vietnam news: Trade/tariffs")
    assert "Vietnam-specific news" in b


def test_combine_overflow_line():
    assert combine(["a", "b"], ["X", "Y"]) == "a\n\nb\n\nAlso oversold: X, Y (no verdict; daily cap reached)"


def test_combine_empty_is_empty():
    assert combine([], []) == ""


def test_write_alert_note_appends(tmp_path):
    d = str(tmp_path / "missing" / "News")
    p1 = write_alert_note(date(2026, 11, 13), "first", d)
    p2 = write_alert_note(date(2026, 11, 13), "second", d)
    assert p1 == p2 and p1.endswith("Alerts/2026-11-13.md")
    txt = open(p1, encoding="utf-8").read()
    assert txt.count("# Alerts — 2026-11-13") == 1
    assert "first" in txt and "second" in txt
    assert write_alert_note(date(2026, 11, 13), "", d) == ""


def test_link_sanitised_in_both_formatters():
    it = {"id": "c1", "title": "[Video] HPG lãi\n ]x", "url": "https://x/a_(b) c",
          "source": "S\nrc", "published": 0, "summary": ""}
    link = "[(Video) HPG lãi )x](https://x/a_%28b%29%20c) — S rc"
    v = {"category": "company_news", "reason": "r", "cited": ["c1"]}
    out = format_holding_alert(_facts(company_news=[it]), v)
    assert f" • {link}" in out.split("\n")
    g = {**it, "id": "g1"}
    out = format_global_alert([g], -3.0, {"category": "global_cause", "reason": "r", "cited": ["g1"]})
    assert f" • {link}" in out.split("\n")


def test_unavailable_has_no_appended_reason():
    v = {"category": "unavailable", "reason": "model unavailable", "cited": []}
    out = format_holding_alert(_facts(), v)
    assert out.split("\n")[1] == "Verdict unavailable (model not reachable)"
    g = format_global_alert([], -3.0, {"category": "unavailable", "reason": "model unavailable", "cited": []})
    assert g.split("\n")[1] == "Verdict unavailable (model not reachable)"


def test_header_omits_zero_drop_and_floors_rsi():
    v = {"category": "unclear", "reason": "r", "cited": []}
    out = format_holding_alert(_facts(signal={"rsi": 29.6, "drop_pct": 0.0, "sessions": 5, "close": 1.0}), v)
    assert out.split("\n")[0] == "🔻 HPG oversold — RSI 29"


# --- final-review fixes ---
def _g(i, topic="tariffs"):
    return {"id": f"g{i}", "title": f"T{i}", "url": f"u{i}", "source": "S", "published": 0,
            "summary": "", "topic": topic}


def test_global_alert_lists_only_cited_items():
    items = [_g(1), _g(2), _g(3)]
    out = format_global_alert(items, -2.5, {"category": "global_cause", "reason": "r", "cited": ["g2"]})
    assert "[T2](u2)" in out and "[T1](u1)" not in out and "[T3](u3)" not in out


def test_global_alert_no_list_without_clear_cause():
    items = [_g(1), _g(2)]
    for cat in ("no_clear_cause", "unavailable"):
        out = format_global_alert(items, -2.5, {"category": cat, "reason": "r", "cited": ["g1"]})
        assert len(out.split("\n")) == 2 and " • " not in out


def test_morning_header_uses_first_cited_topic_readable():
    items = [_g(1, "tariffs"), _g(2, "reclassification")]
    v = {"category": "vietnam_topic", "reason": "r", "cited": ["g2"]}
    assert format_global_alert(items, None, v).startswith("🌏 Vietnam news: Market reclassification")
    for key, name in [("sbv", "SBV policy"), ("sanctions", "Sanctions"), ("other", "other")]:
        out = format_global_alert([_g(1, key)], None, {**v, "cited": ["g1"]})
        assert out.startswith(f"🌏 Vietnam news: {name}\n")


# --- test-gap round (2026-11-15) ---
def test_ddmm_uses_vietnam_time():
    from datetime import datetime, timezone
    from app.newswatch.message import _ddmm
    epoch = int(datetime(2026, 11, 13, 17, 30, tzinfo=timezone.utc).timestamp())  # 00:30 on 14/11 in VN
    assert _ddmm(epoch) == "14/11"
