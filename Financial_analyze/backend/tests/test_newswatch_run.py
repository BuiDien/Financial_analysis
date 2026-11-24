from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.models.newswatch import NewsAlert
from app.models.portfolio import Portfolio, PositionProjection
from app.newswatch.run import Deps, run_after_close, run_morning

TODAY = date(2026, 11, 13)  # Friday
TH = {"rsi_max": 30.0, "drop_pct": 10.0, "sessions": 5, "rsi_reset": 40.0,
      "news_days": 7, "max_holding_alerts": 3, "vnindex_drop_pct": 2.0}
CFG = {
    "etf_tickers": [], "aliases": {}, "vietnam_terms": ["vietnam"],
    "topics": {"trade/tariffs": ["tariff"]}, "trusted_sources": ["reuters.com"],
    "thresholds": TH,
}


def bars(closes, last=TODAY):
    n = len(closes)
    return [{"date": (last - timedelta(days=n - 1 - i)).isoformat(), "open": c, "high": c,
             "low": c, "close": c, "volume": 1} for i, c in enumerate(closes)]


FALLING = [100 - i * 2.0 for i in range(30)]          # RSI ~0
FLAT = [100.0 + (i % 2) for i in range(30)]
RECOVER = FALLING + [60 + i * 6.0 for i in range(1, 15)]  # strong bounce -> RSI > 40
FLATVN = [1000.0] * 30


def hold(db, *tickers):
    p = Portfolio(name="P")
    db.add(p)
    db.flush()
    for t in tickers:
        db.add(PositionProjection(portfolio_id=p.id, ticker=t, currency="VND",
                                  quantity=Decimal(10), cost_basis_native=Decimal(0),
                                  cost_basis_display=Decimal(0), revision=1))
    db.commit()


class Prov:
    def list_company_names(self):
        return {}


class FakeNews:
    """NewsPort test double; counts fetches and records search queries."""

    def __init__(self, vn=None, glob=None):
        self.vn, self.glob = vn or [], glob or []
        self.calls = {"vn": 0, "g": 0}
        self.queries: list[str] = []

    def vn_items(self):
        self.calls["vn"] += 1
        return list(self.vn), []

    def global_items(self, cfg):
        self.calls["g"] += 1
        return list(self.glob), []

    def search(self, query, count=5, **kw):
        self.queries.append(query)
        return []


def deps(tmp_path, series=None, vn=FLATVN, complete=None, global_items=None):
    series = series or {}
    clock = [TODAY]  # last bar date; tests move it to simulate later sessions
    d = Deps(
        history=lambda t: bars(vn if t == "VN:VNINDEX" else series[t[3:]], last=clock[0]),
        complete=complete or (lambda *a, **k: '{"category": "no_news", "reason": "nothing", "cited": []}'),
        news=FakeNews(glob=global_items),
        vault_news_dir=str(tmp_path),
        provider_factory=Prov,
    )
    d.clock = clock
    return d


def test_holiday_is_silent(db, tmp_path):
    hold(db, "HPG")
    d = deps(tmp_path, {"HPG": FALLING})
    d.history = lambda t: bars(FLATVN, last=TODAY - timedelta(days=1)) if t == "VN:VNINDEX" else bars(FALLING)
    assert run_after_close(db, TODAY, d, CFG) == ""
    assert db.query(NewsAlert).count() == 0


def test_oversold_alerts_once_per_episode(db, tmp_path):
    hold(db, "HPG")
    d = deps(tmp_path, {"HPG": FALLING})
    assert "HPG oversold" in run_after_close(db, TODAY, d, CFG)
    d.clock[0] = TODAY + timedelta(days=1)
    assert run_after_close(db, TODAY + timedelta(days=1), d, CFG) == ""


def test_episode_reopens_after_recovery(db, tmp_path):
    hold(db, "HPG")
    run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}), CFG)
    assert run_after_close(db, TODAY, deps(tmp_path, {"HPG": RECOVER}), CFG) == ""
    assert "HPG oversold" in run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}), CFG)


def test_cap_and_overflow(db, tmp_path):
    tickers = ["AAA", "BBB", "CCC", "DDD", "EEE"]
    hold(db, *tickers)
    out = run_after_close(db, TODAY, deps(tmp_path, {t: FALLING for t in tickers}), CFG)
    assert out.count("oversold —") == 3
    assert "Also oversold:" in out
    assert db.query(NewsAlert).filter_by(kind="holding").count() == 5


def test_vnindex_drop_adds_one_global_alert(db, tmp_path):
    vn = [1000.0] * 29 + [975.0]
    d = deps(tmp_path, vn=vn)
    out = run_after_close(db, TODAY, d, CFG)
    assert "🌏" in out
    assert run_after_close(db, TODAY, d, CFG) == ""
    assert db.query(NewsAlert).filter_by(kind="global").count() == 1


REUTERS = {"id": "", "title": "US tariff threat on Vietnam exports",
           "url": "https://www.reuters.com/x", "source": "Reuters", "published": 0, "summary": ""}


def test_morning_topic_alert_once_per_url(db, tmp_path):
    d = deps(tmp_path, global_items=[REUTERS],
             complete=lambda *a, **k: '{"category": "vietnam_topic", "reason": "tariffs", "cited": ["g1"]}')
    out = run_morning(db, date(2026, 11, 13), d, CFG)
    assert "🌏 Vietnam news: trade/tariffs" in out
    assert run_morning(db, date(2026, 11, 16), d, CFG) == ""


def test_morning_weekend_silent(db, tmp_path):
    assert run_morning(db, date(2026, 11, 14), deps(tmp_path, global_items=[REUTERS]), CFG) == ""


def test_model_offline_still_sends_facts(db, tmp_path):
    hold(db, "HPG")

    def boom(*a, **k):
        raise RuntimeError("down")
    out = run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}, complete=boom), CFG)
    assert "Verdict unavailable (model not reachable)" in out
    assert "HPG oversold" in out


# --- fix round 1 ---
DROPONLY = [100.0 + 2 * i for i in range(60)] + [216, 208, 200, 194, 190]  # RSI > 40 yet -15% in 5 sessions


def test_drop_only_episode_alerts_once_across_days(db, tmp_path):
    from app.newswatch.oversold import latest_rsi
    assert latest_rsi(DROPONLY) > 40
    hold(db, "HPG")
    d = deps(tmp_path, {"HPG": DROPONLY})
    outs = []
    for i in range(3):
        d.clock[0] = TODAY + timedelta(days=i)
        outs.append(run_after_close(db, d.clock[0], d, CFG))
    assert "HPG oversold" in outs[0] and outs[1:] == ["", ""]
    assert db.query(NewsAlert).filter_by(kind="holding").count() == 1


def test_morning_all_matched_urls_recorded(db, tmp_path):
    items = [{**REUTERS, "url": f"https://www.reuters.com/{i}", "published": 100 + i} for i in range(7)]
    d = deps(tmp_path, global_items=items,
             complete=lambda *a, **k: '{"category": "vietnam_topic", "reason": "t", "cited": ["g1"]}')
    out = run_morning(db, date(2026, 11, 13), d, CFG)
    assert out.count("reuters.com") == 1  # only the cited item is shown
    row = db.query(NewsAlert).filter_by(kind="global").one()
    assert len(row.facts["urls"]) == 7
    assert run_morning(db, date(2026, 11, 16), d, CFG) == ""


def test_one_ticker_history_failure_does_not_kill_job(db, tmp_path, capsys):
    hold(db, "AAA", "BBB")
    d = deps(tmp_path, {"AAA": FALLING, "BBB": FALLING})
    orig = d.history

    def hist(t):
        if t == "VN:AAA":
            raise RuntimeError("boom")
        return orig(t)
    d.history = hist
    out = run_after_close(db, TODAY, d, CFG)
    assert "BBB oversold" in out and "AAA oversold" not in out
    assert "AAA: price data unavailable" in capsys.readouterr().err


def test_vault_failure_does_not_lose_alert(db, tmp_path, monkeypatch):
    from app.newswatch import message
    hold(db, "HPG")

    def bad(*a, **k):
        raise OSError("disk")
    monkeypatch.setattr(message, "write_alert_note", bad)
    out = run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}), CFG)
    assert "HPG oversold" in out
    assert db.query(NewsAlert).filter_by(kind="holding").count() == 1


def test_global_leg_failure_recorded_nothing_before_text(db, tmp_path):
    hold(db, "HPG")
    d = deps(tmp_path, {"HPG": FALLING}, vn=[1000.0] * 29 + [975.0])
    calls = {"n": 0}

    def complete(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise ValueError("bad")
        return '{"category": "no_news", "reason": "x", "cited": []}'
    d.complete = complete
    with pytest.raises(ValueError):
        run_after_close(db, TODAY, d, CFG)
    assert db.query(NewsAlert).count() == 0


# --- final-review fixes ---
def test_sold_then_rebought_alerts_again(db, tmp_path):
    hold(db, "HPG")
    assert "HPG oversold" in run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}), CFG)
    db.query(PositionProjection).filter_by(ticker="HPG").update({"quantity": Decimal(0)})
    db.commit()
    later = TODAY + timedelta(days=1)
    d = deps(tmp_path, {"HPG": FALLING})
    d.clock[0] = later
    assert run_after_close(db, later, d, CFG) == ""
    assert db.query(NewsAlert).filter_by(kind="holding", episode_open=True).count() == 0
    db.query(PositionProjection).filter_by(ticker="HPG").update({"quantity": Decimal(10)})
    db.commit()
    later2 = TODAY + timedelta(days=2)
    d.clock[0] = later2
    assert "HPG oversold" in run_after_close(db, later2, d, CFG)


def test_holiday_does_not_close_unheld_episodes(db, tmp_path):
    hold(db, "HPG")
    run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}), CFG)
    db.query(PositionProjection).filter_by(ticker="HPG").update({"quantity": Decimal(0)})
    db.commit()
    d = deps(tmp_path, {"HPG": FALLING})  # last bar is TODAY, run for tomorrow -> holiday
    assert run_after_close(db, TODAY + timedelta(days=1), d, CFG) == ""
    assert db.query(NewsAlert).filter_by(kind="holding", episode_open=True).count() == 1


BASE_UP = [100.0 + 2 * i for i in range(60)]
STILL_FALLING = BASE_UP + [214, 210, 206, 204, 202]   # RSI ~59, -7.3% / 5 sessions
CALM = BASE_UP + [216, 214, 212, 211, 210]            # RSI ~74, -3.7% / 5 sessions


def test_episode_not_closed_while_still_falling(db, tmp_path):
    hold(db, "HPG")
    run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}), CFG)
    assert run_after_close(db, TODAY, deps(tmp_path, {"HPG": STILL_FALLING}), CFG) == ""
    assert db.query(NewsAlert).filter_by(kind="holding", episode_open=True).count() == 1
    run_after_close(db, TODAY, deps(tmp_path, {"HPG": CALM}), CFG)
    assert db.query(NewsAlert).filter_by(kind="holding", episode_open=True).count() == 0


NO_CAUSE = '{"category": "no_clear_cause", "reason": "not material", "cited": []}'


def test_morning_no_clear_cause_is_silent_but_recorded(db, tmp_path):
    calls = {"n": 0}

    def complete(*a, **k):
        calls["n"] += 1
        return NO_CAUSE
    d = deps(tmp_path, global_items=[REUTERS], complete=complete)
    assert run_morning(db, TODAY, d, CFG) == ""
    row = db.query(NewsAlert).one()
    assert row.kind == "global_seen" and row.facts["urls"] == [REUTERS["url"]]
    assert row.verdict == "no_clear_cause" and row.message == ""
    # the same URL does not re-trigger the model next morning
    assert run_morning(db, date(2026, 11, 16), d, CFG) == ""
    assert calls["n"] == 1
    # the afternoon -2% global alert is still allowed the same day
    d2 = deps(tmp_path, vn=[1000.0] * 29 + [975.0])
    assert "🌏" in run_after_close(db, TODAY, d2, CFG)
    assert db.query(NewsAlert).filter_by(kind="global").count() == 1


def test_morning_model_unavailable_sends_facts(db, tmp_path):
    def boom(*a, **k):
        raise RuntimeError("down")
    out = run_morning(db, TODAY, deps(tmp_path, global_items=[REUTERS], complete=boom), CFG)
    assert "Verdict unavailable" in out and REUTERS["url"] in out
    assert db.query(NewsAlert).filter_by(kind="global_seen").count() == 0
    row = db.query(NewsAlert).filter_by(kind="global").one()
    assert row.verdict == "unavailable" and row.message == out


def test_morning_uses_morning_prompt(db, tmp_path):
    seen = {}

    def complete(system, *a, **k):
        seen["s"] = system
        return NO_CAUSE
    run_morning(db, TODAY, deps(tmp_path, global_items=[REUTERS], complete=complete), CFG)
    assert "material Vietnam-specific development" in seen["s"]


def test_persist_commits_once(db, tmp_path, monkeypatch):
    tickers = ["AAA", "BBB", "CCC", "DDD"]
    hold(db, *tickers)
    commits = {"n": 0}
    orig = db.commit

    def counting():
        commits["n"] += 1
        return orig()
    d = deps(tmp_path, {t: FALLING for t in tickers})
    from app.newswatch import run as runmod
    real_persist = runmod._persist

    def wrapped(*a, **k):
        commits["n"] = 0
        monkeypatch.setattr(db, "commit", counting)
        try:
            return real_persist(*a, **k)
        finally:
            monkeypatch.setattr(db, "commit", orig)
    monkeypatch.setattr(runmod, "_persist", wrapped)
    run_after_close(db, TODAY, d, CFG)
    assert commits["n"] == 1
    assert db.query(NewsAlert).filter_by(kind="holding").count() == 4


# --- test-gap round (2026-11-15) ---
def test_company_news_reaches_alert_and_record(db, tmp_path):
    hold(db, "HPG")
    item = {"id": "", "title": "HPG báo lỗ quý 3", "url": "https://cafef.vn/hpg-lo",
            "source": "cafef", "published": 0, "summary": ""}
    d = deps(tmp_path, {"HPG": FALLING},
             complete=lambda *a, **k: '{"category": "company_news", "reason": "Q3 loss", "cited": ["c1"]}')
    d.news.vn = [item]
    out = run_after_close(db, TODAY, d, CFG)
    assert "Verdict: Company news behind the drop" in out
    assert "[HPG báo lỗ quý 3](https://cafef.vn/hpg-lo) — cafef" in out
    row = db.query(NewsAlert).filter_by(kind="holding", ticker="HPG").one()
    assert row.verdict == "company_news"
    assert row.facts["urls"] == ["https://cafef.vn/hpg-lo"]


def test_global_news_older_than_a_day_is_dropped(db, tmp_path):
    old = int((datetime.now(timezone.utc) - timedelta(days=2)).timestamp())
    stale = {**REUTERS, "url": "https://www.reuters.com/old", "title": "Old story", "published": old}
    undated = {**REUTERS, "url": "https://www.reuters.com/new", "title": "Undated story"}
    prompts = []

    def complete(system, messages, **k):
        prompts.append(messages[0]["content"])
        return '{"category": "no_clear_cause", "reason": "none", "cited": []}'
    d = deps(tmp_path, vn=[1000.0] * 29 + [975.0], complete=complete, global_items=[stale, undated])
    assert "🌏" in run_after_close(db, TODAY, d, CFG)
    assert "Undated story" in prompts[0] and "Old story" not in prompts[0]


def test_news_fetched_once_per_run(db, tmp_path):
    tickers = ["AAA", "BBB", "CCC"]
    hold(db, *tickers)
    d = deps(tmp_path, {t: FALLING for t in tickers}, vn=[1000.0] * 29 + [975.0])
    out = run_after_close(db, TODAY, d, CFG)
    assert out.count("oversold —") == 3 and "🌏" in out
    assert d.news.calls == {"vn": 1, "g": 1}


def _drop(p):
    return [100.0] * 25 + [100.0 * (1 - p * k / 5) for k in range(1, 6)]


def test_biggest_drops_get_verdicts_first(db, tmp_path):
    series = {"AAA": _drop(0.12), "BBB": _drop(0.30), "CCC": _drop(0.20), "DDD": _drop(0.25)}
    hold(db, *series)
    out = run_after_close(db, TODAY, deps(tmp_path, series), CFG)
    assert out.index("BBB oversold") < out.index("DDD oversold") < out.index("CCC oversold")
    assert "Also oversold: AAA" in out
    assert "AAA oversold" not in out


def test_provider_factory_failure_does_not_block_run(db, tmp_path, capsys):
    hold(db, "HPG")
    d = deps(tmp_path, {"HPG": FALLING})

    def boom():
        raise ImportError("vnstock missing")
    d.provider_factory = boom
    out = run_after_close(db, TODAY, d, CFG)
    assert "HPG oversold" in out
    assert "official-name refresh failed: vnstock missing" in capsys.readouterr().err


def test_one_global_alert_per_day_across_jobs(db, tmp_path):
    hold(db, "HPG")
    d = deps(tmp_path, {"HPG": FALLING}, vn=[1000.0] * 29 + [975.0], global_items=[REUTERS],
             complete=lambda *a, **k: '{"category": "vietnam_topic", "reason": "tariffs", "cited": ["g1"]}')
    assert "🌏" in run_morning(db, TODAY, d, CFG)
    out = run_after_close(db, TODAY, d, CFG)
    assert "HPG oversold" in out and "🌏" not in out
    assert db.query(NewsAlert).filter_by(kind="global").count() == 1


def test_morning_after_global_alert_skips_fetch(db, tmp_path):
    from app.newswatch import store
    store.record_alert(db, kind="global", ticker=None, alert_date=TODAY, verdict="global_cause",
                       message="m", facts={"urls": []}, episode_open=False)
    d = deps(tmp_path, global_items=[REUTERS])
    assert run_morning(db, TODAY, d, CFG) == ""
    assert d.news.calls["g"] == 0


# --- deep-interface refactor ---
def test_thresholds_come_from_config(db, tmp_path):
    tickers = ["AAA", "BBB"]
    hold(db, *tickers)
    cfg = {**CFG, "thresholds": {**TH, "max_holding_alerts": 1}}
    out = run_after_close(db, TODAY, deps(tmp_path, {t: FALLING for t in tickers}), cfg)
    assert out.count("oversold —") == 1 and "Also oversold:" in out


def test_holding_search_uses_brand_alias(db, tmp_path):
    hold(db, "HPG")
    d = deps(tmp_path, {"HPG": FALLING})
    run_after_close(db, TODAY, d, {**CFG, "aliases": {"HPG": ["Hòa Phát"]}})
    assert d.news.queries == ['"Hòa Phát" cổ phiếu']


def test_failure_rolls_back_episode_changes(db, tmp_path):
    hold(db, "HPG")
    run_after_close(db, TODAY, deps(tmp_path, {"HPG": FALLING}), CFG)
    hold(db, "VNM")
    d = deps(tmp_path, {"HPG": RECOVER, "VNM": FALLING})

    def boom(*a, **k):
        raise ValueError("bad")
    d.complete = boom
    with pytest.raises(ValueError):
        run_after_close(db, TODAY, d, CFG)
    assert db.query(NewsAlert).filter_by(ticker="HPG", episode_open=True).count() == 1
