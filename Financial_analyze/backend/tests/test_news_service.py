import json
import urllib.request

import pytest

from app.services import news

MARKET_RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>CafeF - Thi truong</title>
<item>
  <title>VNM tang gia phien sang</title>
  <link>https://cafef.vn/vnm-tang-gia.html</link>
  <description>VNM tang 2% trong phien sang nay</description>
  <pubDate>Mon, 06 Jul 2026 03:00:00 GMT</pubDate>
</item>
</channel></rss>"""

COMPANIES_RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>CafeF - Doanh nghiep</title>
<item>
  <title>Hoa Phat mo rong nha may</title>
  <link>https://cafef.vn/hoa-phat-mo-rong.html</link>
  <description>HPG cong bo ke hoach mo rong</description>
  <pubDate>Sun, 05 Jul 2026 10:00:00 GMT</pubDate>
</item>
</channel></rss>"""


class _FakeResponse:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_urlopen(feeds):
    def _opener(req, timeout=10):
        return _FakeResponse(feeds[req.full_url])
    return _opener


def test_fetch_vn_rss_returns_items_from_both_feeds_newest_first(monkeypatch):
    feeds = {
        "https://cafef.vn/thi-truong-chung-khoan.rss": MARKET_RSS,
        "https://cafef.vn/doanh-nghiep.rss": COMPANIES_RSS,
    }
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen(feeds))

    items = news.fetch_vn_rss(limit=10)

    assert len(items) == 2
    titles = {i["title"] for i in items}
    assert "VNM tang gia phien sang" in titles
    assert "Hoa Phat mo rong nha may" in titles
    assert items[0]["title"] == "VNM tang gia phien sang"  # Jul 6 > Jul 5
    assert items[0]["published"] > items[1]["published"]
    assert items[0]["category"] == "market"
    assert items[1]["category"] == "companies"


def test_fetch_vn_rss_filters_by_query(monkeypatch):
    feeds = {
        "https://cafef.vn/thi-truong-chung-khoan.rss": MARKET_RSS,
        "https://cafef.vn/doanh-nghiep.rss": COMPANIES_RSS,
    }
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen(feeds))

    items = news.fetch_vn_rss(query="Hoa Phat", limit=10)

    assert len(items) == 1
    assert items[0]["title"] == "Hoa Phat mo rong nha may"


def test_fetch_vn_rss_raises_on_fetch_failure(monkeypatch):
    def _boom(req, timeout=10):
        raise OSError("network down")
    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    with pytest.raises(RuntimeError, match="Could not fetch"):
        news.fetch_vn_rss()


class _FakeSearchResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_search_web_returns_results(monkeypatch):
    payload = {"results": [
        {"title": "A", "url": "https://a.test", "content": "snippet a"},
        {"title": "B", "url": "https://b.test", "content": "snippet b"},
    ]}

    def _opener(req, timeout=10):
        assert "q=test" in req.full_url
        return _FakeSearchResponse(payload)
    monkeypatch.setattr(urllib.request, "urlopen", _opener)

    results = news.search_web("test", count=5)

    assert results == payload["results"]


def test_search_web_raises_when_unreachable(monkeypatch):
    def _boom(req, timeout=10):
        raise OSError("connection refused")
    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    with pytest.raises(RuntimeError, match="SearXNG unreachable"):
        news.search_web("test")


def test_read_article_extracts_text(monkeypatch):
    monkeypatch.setattr(news, "_resolved_addresses", lambda hostname: {"93.184.216.34"})
    monkeypatch.setattr(news.trafilatura, "fetch_url", lambda url: "<html>raw</html>")
    monkeypatch.setattr(news.trafilatura, "extract", lambda html: "Article body text.")

    class _Meta:
        title = "Some Title"
    monkeypatch.setattr(news.trafilatura, "extract_metadata", lambda html: _Meta())

    result = news.read_article("https://example.test/a")

    assert result == {"url": "https://example.test/a", "title": "Some Title", "text": "Article body text."}


def test_read_article_raises_when_fetch_fails(monkeypatch):
    monkeypatch.setattr(news, "_resolved_addresses", lambda hostname: {"93.184.216.34"})
    monkeypatch.setattr(news.trafilatura, "fetch_url", lambda url: None)

    with pytest.raises(RuntimeError, match="Could not fetch"):
        news.read_article("https://example.test/dead")


def test_read_article_raises_when_no_text_extracted(monkeypatch):
    monkeypatch.setattr(news, "_resolved_addresses", lambda hostname: {"93.184.216.34"})
    monkeypatch.setattr(news.trafilatura, "fetch_url", lambda url: "<html>raw</html>")
    monkeypatch.setattr(news.trafilatura, "extract", lambda html: None)

    with pytest.raises(RuntimeError, match="no extractable"):
        news.read_article("https://example.test/blocked")


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "http://localhost:8000/docs",
    "http://127.0.0.1:8888/search",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
])
def test_read_article_rejects_non_public_targets(monkeypatch, url):
    def fetch(target):
        pytest.fail(f"unexpected fetch: {target}")

    monkeypatch.setattr(news.trafilatura, "fetch_url", fetch)

    with pytest.raises(RuntimeError, match="public|http or https"):
        news.read_article(url)


def test_read_article_rejects_hostname_resolving_to_private_ip(monkeypatch):
    monkeypatch.setattr(news, "_resolved_addresses", lambda hostname: {"10.0.0.4"})
    monkeypatch.setattr(
        news.trafilatura,
        "fetch_url",
        lambda target: pytest.fail(f"unexpected fetch: {target}"),
    )

    with pytest.raises(RuntimeError, match="public"):
        news.read_article("https://internal.example/report")
