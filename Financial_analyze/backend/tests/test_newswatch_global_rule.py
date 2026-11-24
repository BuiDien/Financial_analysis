import pytest

from app.newswatch import global_rule as g
from app.services import news_feeds

CFG = {
    "etf_tickers": [], "aliases": {},
    "vietnam_terms": ["vietnam", "việt nam"],
    "topics": {"tariffs": ["tariff"], "sbv": ["sbv"]},
    "trusted_sources": ["reuters.com", "sbv.gov.vn"],
}


def _item(title, source, url="https://www.reuters.com/a", summary=""):
    return {"id": url, "title": title, "url": url, "source": source,
            "published": 0, "summary": summary}


def test_topic_match_requires_vietnam_topic_and_trusted():
    ok = _item("US raises tariffs on Vietnam goods", "reuters")
    blog = _item("US raises tariffs on Vietnam goods", "searxng/randomblog.com",
                 "https://randomblog.com/x")
    other = _item("US tariffs on Canada", "reuters", "https://www.reuters.com/b")
    res = g.match_vietnam_topics([ok, blog, other], CFG)
    assert [r["url"] for r in res] == [ok["url"]]
    assert res[0]["topic"] == "tariffs"


def test_short_term_not_inside_word():
    it = _item("Vietnam crossbvs rally", "reuters")
    assert g.match_vietnam_topics([it], CFG) == []
    it2 = _item("Vietnam: SBV cuts rate", "reuters")
    assert g.match_vietnam_topics([it2], CFG)[0]["topic"] == "sbv"


def test_exclude_already_alerted_urls():
    ok = _item("US raises tariffs on Vietnam goods", "reuters")
    assert g.match_vietnam_topics([ok], CFG, {ok["url"]}) == []


FEEDS = [("Feed A", "http://a/rss"), ("Feed B", "http://b/rss")]
RSS_A = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>A1</title><link>http://a/1</link><description>d</description>
<pubDate>Fri, 13 Nov 2026 10:00:00 +0000</pubDate></item>
<item><title>A2</title><link>http://a/2</link><description>d</description></item>
</channel></rss>"""


def test_fetch_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("down")
    monkeypatch.setattr(g.news_collector, "RSS_FEEDS", FEEDS)
    monkeypatch.setattr(news_feeds, "http_get", boom)
    items, errors = g.fetch_global_candidates(CFG, search=boom)
    assert items == [] and len(errors) == 4  # one per feed + one per topic
    assert errors[0].startswith("rss/Feed A: ")


def test_fetch_collects_with_rss_dates(monkeypatch):
    import calendar
    import datetime
    monkeypatch.setattr(g.news_collector, "RSS_FEEDS", FEEDS[:1])
    monkeypatch.setattr(news_feeds, "http_get", lambda url: RSS_A)

    def search(q, n=5, time_range="week"):
        assert time_range == "day"
        return [{"title": q, "url": "u2", "content": "c", "published": "2026-11-13T08:00:00Z"}]
    items, errors = g.fetch_global_candidates(CFG, search=search)
    assert errors == [] and len(items) == 4
    a1 = items[0]
    assert a1["source"] == "rss/Feed A" and a1["id"] == "http://a/1"
    assert a1["published"] == calendar.timegm(datetime.datetime(2026, 11, 13, 10).timetuple())
    assert items[1]["published"] == 0
    assert items[2]["source"].startswith("searxng/")
    assert items[2]["published"] == calendar.timegm(datetime.datetime(2026, 11, 13, 8).timetuple())


def test_fetch_skips_searxng_general_fallback(monkeypatch):
    monkeypatch.setattr(g.news_collector, "RSS_FEEDS", [])
    def search(q, n=5, time_range="week"):
        return [{"title": q, "url": "u2", "content": "c", "fallback": True}]
    items, errors = g.fetch_global_candidates(CFG, search=search)
    assert items == [] and errors == ["search tariffs: no news results", "search sbv: no news results"]


def test_vnindex_day_change():
    bars = [{"date": "2026-11-12", "close": 1300}, {"date": "2026-11-13", "close": 1270}]
    d, pct = g.vnindex_day_change(bars)
    assert d == "2026-11-13"
    assert pct == pytest.approx(-2.3077, rel=1e-3)
    assert g.vnindex_day_change(bars[:1]) is None


def test_trust_is_host_based():
    t = ["reuters.com", "sbv.gov.vn"]
    mk = lambda url, src="x": _item("t", src, url)
    for url in ["https://www.reuters.com/a", "https://uk.reuters.com/a", "https://www.sbv.gov.vn/a"]:
        assert g.is_trusted(mk(url), t)
    for url in ["https://notreuters.example.com/a", "https://reuters.com.evil.io/a", "https://reuters.ev.io/a", "https://fake.reuters.ev.io/a", "https://x.com/reuters/a"]:
        assert not g.is_trusted(mk(url), t)
    assert g.is_trusted(mk("https://x.com/a", "Reuters"), t)
    assert not g.is_trusted(mk("https://x.com/a", "notreuters"), t)


def test_vietnam_must_be_in_title():
    s_only = _item("US tariffs hit exporters", "reuters", summary="Vietnam is affected")
    assert g.match_vietnam_topics([s_only], CFG) == []
    t = _item("Vietnam hit by tariffs", "reuters", "https://www.reuters.com/z")
    assert len(g.match_vietnam_topics([t], CFG)) == 1


def test_vnindex_zero_close():
    assert g.vnindex_day_change([{"date": "d1", "close": 1300}, {"date": "d2", "close": 0}]) is None
    assert g.vnindex_day_change([{"date": "d1", "close": 0}, {"date": "d2", "close": 5}]) is None


def test_topic_keyword_only_in_summary():
    it = _item("Vietnam exporters brace", "reuters", "https://www.reuters.com/s", "new tariff announced")
    assert g.match_vietnam_topics([it], CFG)[0]["topic"] == "tariffs"


# --- test-gap round (2026-11-15) ---
def test_trust_subdomain_yes_lookalike_no():
    assert g.is_trusted(_item("t", "", "https://www.reuters.com/a"), ["reuters.com"])
    assert not g.is_trusted(_item("t", "", "https://notreuters.com/a"), ["reuters.com"])
    assert not g.is_trusted(_item("t", "", "https://reuters.com.evil.io/a"), ["reuters.com"])


def test_vnindex_missing_close_is_none():
    assert g.vnindex_day_change([{"date": "2026-11-12", "close": 1000}, {"date": "2026-11-13"}]) is None


def test_fetch_rss_caps_at_20(monkeypatch):
    entries = "".join(f"<item><title>T{i}</title><link>https://r/{i}</link></item>" for i in range(25))
    rss = f'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>{entries}</channel></rss>'
    monkeypatch.setattr(g.news_collector, "RSS_FEEDS", [("Feed", "https://r/feed")])
    monkeypatch.setattr(news_feeds, "http_get", lambda url: rss.encode())
    got, errors = g.fetch_global_candidates({**CFG, "topics": {}})
    assert errors == [] and len(got) == 20 and got[0]["url"] == "https://r/0"
