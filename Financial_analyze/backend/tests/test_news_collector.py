import json
import subprocess

import pytest
import yfinance

from app.services import news, news_collector


def test_deduplicate_articles_removes_case_and_punctuation_duplicates():
    articles = [
        {"title": "VN30 rallies!", "source": "a", "url": "https://x/1", "summary": ""},
        {"title": "vn30 rallies", "source": "b", "url": "https://x/2", "summary": ""},
        {"title": "Different story", "source": "a", "url": "https://x/3", "summary": ""},
    ]

    unique = news_collector.deduplicate_articles(articles)

    assert len(unique) == 2
    assert unique[0]["url"] == "https://x/1"
    assert unique[1]["url"] == "https://x/3"


def test_fetch_reddit_rss_raises_rate_limited_immediately_on_429_no_retry(monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(req, timeout=10):
        calls["n"] += 1
        raise Exception("HTTP Error 429: Too Many Requests")

    monkeypatch.setattr(news_collector, "urlopen", fake_urlopen)
    monkeypatch.setattr(news_collector.time, "sleep",
                         lambda s: (_ for _ in ()).throw(AssertionError("must not sleep/retry on 429")))

    with pytest.raises(news_collector.RedditRateLimited):
        news_collector.fetch_reddit_rss("VNM", "stocks", limit=5)

    assert calls["n"] == 1


def test_fetch_reddit_rss_returns_posts_on_success(monkeypatch):
    atom_ok = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>VNM discussion</title><content>Bulls are back</content></entry>
</feed>"""

    def fake_urlopen(req, timeout=10):
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return atom_ok
        return _Resp()

    monkeypatch.setattr(news_collector, "urlopen", fake_urlopen)

    posts = news_collector.fetch_reddit_rss("VNM", "stocks", limit=5)

    assert posts == [{
        "title": "VNM discussion",
        "summary": "Bulls are back",
        "source": "reddit/r/stocks",
        "url": "https://www.reddit.com/r/stocks/search?q=VNM",
    }]


def test_fetch_stocktwits_handles_missing_entities_gracefully(monkeypatch):
    def fake_urlopen(req, timeout=10):
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps({
                "messages": [{"id": 1, "body": "AAPL breaking out", "entities": None}]
            }).encode()
        return _Resp()

    monkeypatch.setattr(news_collector, "urlopen", fake_urlopen)

    posts = news_collector.fetch_stocktwits("AAPL", limit=5)

    assert posts == [{
        "title": "$AAPL: AAPL breaking out",
        "summary": "AAPL breaking out",
        "source": "stocktwits/$AAPL",
        "sentiment": "neutral",
        "url": "https://stocktwits.com/message/1",
    }]


def test_fetch_yfinance_news_parses_content_envelope(monkeypatch):
    def fake_get_news(self, count):
        return [{"content": {
            "title": "Apple hits new high",
            "summary": "AAPL rallied 3%",
            "provider": {"displayName": "Yahoo Finance"},
            "canonicalUrl": {"url": "https://finance.yahoo.com/aapl-high"},
        }}]

    monkeypatch.setattr(yfinance.Ticker, "get_news", fake_get_news)

    articles = news_collector.fetch_yfinance_news("AAPL")

    assert articles == [{
        "title": "Apple hits new high",
        "summary": "AAPL rallied 3%",
        "source": "yfinance/Yahoo Finance",
        "url": "https://finance.yahoo.com/aapl-high",
        "ticker": "AAPL",
    }]


def test_fetch_yfinance_global_news_stops_once_limit_hit(monkeypatch):
    call_count = {"n": 0}

    class FakeSearch:
        def __init__(self, query, news_count):
            call_count["n"] += 1
            self.news = [{"content": {
                "title": "Fed holds rates steady",
                "summary": "No change this meeting",
                "provider": {"displayName": "Reuters"},
                "canonicalUrl": {"url": "https://reuters.com/fed"},
            }}]

    monkeypatch.setattr(yfinance, "Search", FakeSearch)
    monkeypatch.setattr(news_collector, "YFINANCE_GLOBAL_LIMIT", 1)

    articles = news_collector.fetch_yfinance_global_news()

    assert call_count["n"] == 1
    assert articles == [{
        "title": "Fed holds rates steady",
        "summary": "No change this meeting",
        "source": "yfinance/global/Reuters",
        "url": "https://reuters.com/fed",
    }]


def test_fetch_global_rss_feeds_skips_dead_feed_keeps_others(monkeypatch):
    ok_feed = b"""<?xml version="1.0"?>
<rss><channel><item>
  <title>Markets steady</title>
  <description>Quiet session</description>
  <link>https://mw.test/1</link>
</item></channel></rss>"""

    def fake_urlopen(req, timeout=15):
        if "dead" in req.full_url:
            raise Exception("HTTP Error 404: Not Found")
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return ok_feed
        return _Resp()

    monkeypatch.setattr(news_collector, "urlopen", fake_urlopen)
    monkeypatch.setattr(news_collector, "RSS_FEEDS", [
        ("Dead Feed", "https://dead.test/rss"),
        ("MarketWatch", "https://mw.test/rss"),
    ])

    articles = news_collector.fetch_global_rss_feeds()

    assert articles == [{
        "title": "Markets steady",
        "summary": "Quiet session",
        "source": "rss/MarketWatch",
        "url": "https://mw.test/1",
    }]


def test_fetch_exa_search_parses_mcporter_json_and_sets_source_tag(monkeypatch):
    class FakeResult:
        returncode = 0
        stderr = ""
        stdout = json.dumps({"content": [{
            "type": "text",
            "text": "Title: VN Index rallies\nURL: https://example.com/vn\nPublished: 2026-07-07\nHighlights:\nStrong session for VN30.",
        }]})

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeResult())
    monkeypatch.setattr(news_collector.time, "sleep", lambda s: None)

    articles = news_collector.fetch_exa_search(["Vietnam stock market today"], limit=1)

    assert len(articles) == 1
    assert articles[0]["title"] == "VN Index rallies"
    assert articles[0]["source"] == "exa/search"
    assert articles[0]["url"] == "https://example.com/vn"


def test_fetch_searxng_search_wraps_news_search_web(monkeypatch):
    monkeypatch.setattr(news, "search_web", lambda q, count: [
        {"title": "VN market up", "url": "https://x.com", "content": "brief"},
    ])

    articles = news_collector.fetch_searxng_search(["Vietnam stock market today"], count=1)

    assert articles == [{
        "title": "VN market up",
        "summary": "brief",
        "source": "searxng/search",
        "url": "https://x.com",
    }]


def test_fetch_youtube_world_news_uses_curated_channels(monkeypatch):
    class FakeResult:
        returncode = 0
        stderr = ""
        stdout = json.dumps({"entries": [
            {"id": "abc123", "title": "Fed decision rattles markets", "description": "Macro update", "duration": 420},
            {"id": "short1", "title": "Short clip", "description": "", "duration": 30},
        ]})

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return FakeResult()

    monkeypatch.setattr(subprocess, "run", fake_run)

    articles = news_collector.fetch_youtube_world_news(
        [{"name": "Bloomberg Markets", "url": "https://www.youtube.com/@markets/videos"}],
        per_channel=2,
    )

    assert calls[0][:3] == [news_collector.sys.executable, "-m", "yt_dlp"]
    assert articles == [{
        "title": "Fed decision rattles markets",
        "summary": "Macro update",
        "source": "youtube/world/Bloomberg Markets",
        "url": "https://www.youtube.com/watch?v=abc123",
    }]


def test_world_youtube_title_filter_rejects_lifestyle_items():
    assert news_collector.is_world_youtube_title("Macro Matters: AI boom pressures the US economy")
    assert not news_collector.is_world_youtube_title("Why Americans Pay $170K for This British SUV")
    assert not news_collector.is_world_youtube_title("Britain appoints a new chairman")


def test_daily_source_policy_rejects_social_and_low_quality_yfinance():
    articles = [
        {"title": "CafeF story", "summary": "", "source": "cafef/market", "url": "https://cafef.vn/1"},
        {"title": "Fed story", "summary": "", "source": "yfinance/global/Reuters", "url": "https://reuters.test/1"},
        {"title": "SEO pick", "summary": "", "source": "yfinance/24/7 Wall St.", "url": "https://seo.test/1"},
        {"title": "Stocktwits pump", "summary": "", "source": "stocktwits/$AAPL", "url": "https://st.test/1"},
        {"title": "Reddit thread", "summary": "", "source": "reddit/r/stocks", "url": "https://reddit.test/1"},
    ]

    kept = news_collector.apply_daily_source_policy(articles)

    assert [a["source"] for a in kept] == ["cafef/market", "yfinance/global/Reuters"]


def test_daily_source_policy_caps_broad_search_sources():
    articles = [
        {"title": f"Search story {i}", "summary": "", "source": "searxng/search", "url": f"https://s.test/{i}"}
        for i in range(20)
    ]

    kept = news_collector.apply_daily_source_policy(articles)

    assert len(kept) == news_collector.SOURCE_LIMITS["searxng/search"]


def test_collect_all_articles_merges_dedupes_and_counts_by_source(monkeypatch):
    monkeypatch.setattr(news_collector.time, "sleep", lambda s: None)
    monkeypatch.setattr(news_collector, "fetch_yfinance_news", lambda ticker: [
        {"title": "AAPL news", "summary": "", "source": "yfinance/Yahoo Finance", "url": "https://y.com/1", "ticker": ticker},
    ])
    monkeypatch.setattr(news_collector, "fetch_yfinance_global_news", lambda: [
        {"title": "Fed news", "summary": "", "source": "yfinance/global/Reuters", "url": "https://y.com/2"},
    ])
    monkeypatch.setattr(news_collector, "fetch_global_rss_feeds", lambda: [
        {"title": "RSS story", "summary": "", "source": "rss/Bloomberg Markets", "url": "https://b.com/1"},
    ])
    monkeypatch.setattr(news_collector, "fetch_exa_search", lambda queries, limit=5: [
        {"title": "Exa story", "summary": "", "source": "exa/search", "url": "https://e.com/1"},
    ])
    monkeypatch.setattr(news_collector, "fetch_searxng_search", lambda queries, count=5: [
        {"title": "Searxng story", "summary": "", "source": "searxng/search", "url": "https://s.com/1"},
    ])
    monkeypatch.setattr(news_collector, "fetch_youtube_world_news", lambda: [
        {"title": "Fed video", "summary": "", "source": "youtube/world/Bloomberg Markets", "url": "https://youtube.com/1"},
    ])
    monkeypatch.setattr(news, "fetch_vn_rss", lambda limit=30: [
        {"title": "CafeF story", "url": "https://cafef.vn/1", "published": 0, "category": "market"},
    ])
    monkeypatch.setattr(news, "read_article", lambda url: (_ for _ in ()).throw(RuntimeError("no network in tests")))

    result = news_collector.collect_all_articles("2026-07-07")

    assert result["collection_date"] == "2026-07-07"
    assert result["total_articles"] == 7
    assert result["sources"] == {
        "reddit": 0, "stocktwits": 0, "yfinance_stock": 1, "yfinance_global": 1,
        "rss": 1, "exa": 1, "cafef": 1, "searxng": 1, "youtube": 1,
    }


def test_collect_all_articles_excludes_raw_social_sources(monkeypatch):
    monkeypatch.setattr(news_collector.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        news_collector,
        "fetch_reddit_rss",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("daily digest must not fetch Reddit")),
    )
    monkeypatch.setattr(
        news_collector,
        "fetch_stocktwits",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("daily digest must not fetch StockTwits")),
    )
    monkeypatch.setattr(news_collector, "fetch_yfinance_news", lambda ticker: [])
    monkeypatch.setattr(news_collector, "fetch_yfinance_global_news", lambda: [])
    monkeypatch.setattr(news_collector, "fetch_global_rss_feeds", lambda: [])
    monkeypatch.setattr(news_collector, "fetch_exa_search", lambda queries, limit=5: [])
    monkeypatch.setattr(news_collector, "fetch_searxng_search", lambda queries, count=5: [])
    monkeypatch.setattr(news_collector, "fetch_youtube_world_news", lambda: [])
    monkeypatch.setattr(news, "fetch_vn_rss", lambda limit=30: [])

    result = news_collector.collect_all_articles("2026-07-07")

    assert result["sources"]["reddit"] == 0
    assert result["sources"]["stocktwits"] == 0


def test_write_daily_note_writes_expected_structure(tmp_path):
    result = {
        "total_articles": 2,
        "articles": [
            {"title": "First story", "summary": "Summary one", "source": "cafef/market", "url": "https://cafef.vn/1"},
            {"title": "Second story", "summary": "Summary two", "source": "reddit/r/stocks", "url": "https://reddit.com/2"},
        ],
    }

    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    assert path == str(tmp_path / "2026-07-07.md")
    text = (tmp_path / "2026-07-07.md").read_text()
    assert "processed: false" in text
    assert "## Day Summary" in text
    assert "### cafef/market" in text
    assert "- **[First story](https://cafef.vn/1)** — Summary one" in text


def test_write_daily_note_handles_zero_articles(tmp_path):
    result = {"total_articles": 0, "articles": []}

    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    assert "_No articles collected today._" in open(path).read()


def test_parse_daily_note_raw_note_is_stale(tmp_path):
    result = {"total_articles": 1, "articles": [
        {"title": "Story", "summary": "Brief", "source": "cafef/market", "url": "https://cafef.vn/1"},
    ]}
    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    parsed = news_collector.parse_daily_note(path)

    assert parsed["processed"] is False
    assert parsed["day_summary"] is None
    assert parsed["articles"] == [{
        "source": "cafef/market", "title": "Story",
        "url": "https://cafef.vn/1", "summary": "Brief",
    }]


def test_parse_daily_note_processed_note_returns_summary_and_articles(tmp_path):
    note = """---
date: 2026-07-07
total_articles: 1
processed: true
---

# Daily Market Monitor — 2026-07-07

## Day Summary

Markets were mixed today as VN30 dipped slightly while US futures held steady.

## Articles

### cafef/market
- **[Story](https://cafef.vn/1)** — Modest pullback in VN blue chips.
"""
    path = tmp_path / "2026-07-07.md"
    path.write_text(note)

    parsed = news_collector.parse_daily_note(str(path))

    assert parsed["processed"] is True
    assert "mixed today" in parsed["day_summary"]
    assert parsed["articles"] == [{
        "source": "cafef/market", "title": "Story",
        "url": "https://cafef.vn/1", "summary": "Modest pullback in VN blue chips.",
    }]


def test_parse_daily_note_handles_url_with_parenthesis(tmp_path):
    result = {"total_articles": 1, "articles": [
        {"title": "Story", "summary": "Brief", "source": "cafef/market", "url": "https://cafef.vn/story_(2026)"},
    ]}
    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    parsed = news_collector.parse_daily_note(path)

    assert parsed["articles"][0]["url"] == "https://cafef.vn/story_(2026)"


def test_parse_daily_note_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        news_collector.parse_daily_note(str(tmp_path / "missing.md"))


def test_fetch_full_text_returns_article_body_on_success(monkeypatch):
    monkeypatch.setattr(news, "read_article", lambda url: {
        "url": url, "title": "T", "text": "Full body paragraph one.\n\nParagraph two.",
    })

    text = news_collector.fetch_full_text("https://example.test/a")

    assert text == "Full body paragraph one.\n\nParagraph two."


def test_fetch_full_text_returns_empty_string_on_failure(monkeypatch):
    def _boom(url):
        raise RuntimeError("blocked")
    monkeypatch.setattr(news, "read_article", _boom)

    assert news_collector.fetch_full_text("https://example.test/dead") == ""


def test_attach_full_text_populates_each_article_and_tolerates_failures(monkeypatch):
    def fake_read_article(url):
        if url == "https://example.test/ok":
            return {"url": url, "title": "T", "text": "Real content."}
        raise RuntimeError("blocked")
    monkeypatch.setattr(news, "read_article", fake_read_article)

    articles = [
        {"title": "A", "url": "https://example.test/ok", "summary": "", "source": "rss/X"},
        {"title": "B", "url": "https://example.test/blocked", "summary": "", "source": "rss/X"},
    ]

    news_collector.attach_full_text(articles)

    assert articles[0]["full_text"] == "Real content."
    assert articles[1]["full_text"] == ""


def test_attach_full_text_enforces_per_article_and_total_budgets(monkeypatch):
    monkeypatch.setattr(news, "read_article", lambda url: {
        "url": url,
        "title": "T",
        "text": "x" * 20,
    })
    monkeypatch.setattr(news_collector, "MAX_FULL_TEXT_CHARS", 8)
    monkeypatch.setattr(news_collector, "MAX_DIGEST_FULL_TEXT_CHARS", 12)
    articles = [
        {"title": str(i), "url": f"https://example.test/{i}", "summary": "", "source": "rss/X"}
        for i in range(3)
    ]

    news_collector.attach_full_text(articles)

    assert [len(article["full_text"]) for article in articles] == [8, 4, 0]


def test_write_daily_note_includes_full_text_as_blockquote(tmp_path):
    result = {"total_articles": 1, "articles": [
        {"title": "Story", "summary": "Brief", "source": "cafef/market",
         "url": "https://cafef.vn/1", "full_text": "Line one.\nLine two."},
    ]}

    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    text = open(path).read()
    assert "- **[Story](https://cafef.vn/1)** — Brief" in text
    assert "> Line one." in text
    assert "> Line two." in text


def test_write_daily_note_omits_blockquote_when_full_text_missing(tmp_path):
    result = {"total_articles": 1, "articles": [
        {"title": "Story", "summary": "Brief", "source": "cafef/market", "url": "https://cafef.vn/1"},
    ]}

    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    assert ">" not in open(path).read()


def test_parse_daily_note_ignores_full_text_blockquote_lines(tmp_path):
    result = {"total_articles": 1, "articles": [
        {"title": "Story", "summary": "Brief", "source": "cafef/market",
         "url": "https://cafef.vn/1", "full_text": "Some long article body.\nSecond line."},
    ]}
    path = news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    parsed = news_collector.parse_daily_note(path)

    assert parsed["articles"] == [{
        "source": "cafef/market", "title": "Story",
        "url": "https://cafef.vn/1", "summary": "Brief",
    }]


def test_write_daily_note_protects_processed_summary_from_rerun(tmp_path):
    path = tmp_path / "2026-07-07.md"
    path.write_text("""---
date: 2026-07-07
processed: true
---

## Day Summary

Keep this summary.

## Articles
""")
    result = {"total_articles": 0, "articles": []}

    with pytest.raises(FileExistsError, match="Refusing to overwrite"):
        news_collector.write_daily_note("2026-07-07", result, vault_dir=str(tmp_path))

    news_collector.write_daily_note(
        "2026-07-07",
        result,
        vault_dir=str(tmp_path),
        overwrite_processed=True,
    )
    assert "processed: false" in path.read_text()


def _holding_item():
    return {"id": "x", "title": "HPG lãi lớn", "url": "https://v.vn/hpg", "source": "cafef",
            "published": int(__import__("time").time()), "summary": ""}


def test_tracked_tickers_has_no_vn_names():
    for t in ("VNM", "VIC", "FPT", "HPG", "MBB"):
        assert t not in news_collector.TRACKED_TICKERS
    assert "VN30" in news_collector.TRACKED_TICKERS


def test_daily_note_has_holdings_section(tmp_path):
    result = {"collection_date": "2026-11-13", "total_articles": 0, "articles": [],
              "holdings": {"HPG": [_holding_item()], "FPT": []}, "source_errors": []}
    path = news_collector.write_daily_note("2026-11-13", result, vault_dir=str(tmp_path))
    text = open(path, encoding="utf-8").read()
    assert "## Holdings" in text
    assert "### HPG" in text
    assert "- [HPG lãi lớn](https://v.vn/hpg) — cafef" in text
    assert "### FPT\n\n_No news._" in text
    assert text.index("## Day Summary") < text.index("## Holdings") < text.index("## Articles")


def test_parse_daily_note_ignores_holdings_lines(tmp_path):
    arts = [{"title": "Story", "summary": "s", "source": "rss/x", "url": "https://x/1"}]
    base = {"collection_date": "2026-11-13", "total_articles": 1, "articles": arts}
    p1 = news_collector.write_daily_note("2026-11-13", base, vault_dir=str(tmp_path / "a"))
    p2 = news_collector.write_daily_note(
        "2026-11-13", {**base, "holdings": {"HPG": [_holding_item()]}}, vault_dir=str(tmp_path / "b"))
    assert news_collector.parse_daily_note(p2) == news_collector.parse_daily_note(p1)
    assert len(news_collector.parse_daily_note(p2)["articles"]) == 1


def test_collect_all_articles_matches_holdings(monkeypatch):
    for fn in ("fetch_yfinance_news", "fetch_yfinance_global_news", "fetch_global_rss_feeds",
               "fetch_exa_search", "fetch_searxng_search", "fetch_youtube_world_news"):
        monkeypatch.setattr(news_collector, fn, lambda *a, **k: [])
    monkeypatch.setattr(news_collector.news, "fetch_vn_rss", lambda limit=30: [])
    monkeypatch.setattr(news_collector, "fetch_all_vn", lambda: ([_holding_item()], ["vietstock: boom"]))
    monkeypatch.setattr(news_collector.news, "search_web", lambda q, n: [])
    result = news_collector.collect_all_articles("2026-11-13", holdings={"HPG": ["HPG"], "FPT": ["FPT"]})
    assert [i["url"] for i in result["holdings"]["HPG"]] == ["https://v.vn/hpg"]
    assert result["holdings"]["FPT"] == []
    assert result["source_errors"] == ["vietstock: boom"]
