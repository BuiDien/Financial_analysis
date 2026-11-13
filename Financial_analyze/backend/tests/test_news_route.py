import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import market, news as news_service


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _no_real_symbol_db(monkeypatch):
    """/api/news looks up known symbols in the app DB; never the real helix.db."""
    from app.routes import news as news_route

    monkeypatch.setattr(news_route, "_known_vn_symbols", lambda: set())


def test_news_merges_vn_and_us_newest_first(monkeypatch, client):
    monkeypatch.setattr(news_service, "fetch_vn_rss", lambda limit: [
        {"title": "VN old", "url": "https://cafef.vn/a", "published": 100, "category": "market"},
    ])
    monkeypatch.setattr(market, "get_news", lambda limit: [
        {"title": "US new", "publisher": "Reuters", "url": "https://reuters.test/b",
         "published": 200, "tickers": []},
    ])

    resp = client.get("/api/news?limit=30")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 2
    assert body[0]["title"] == "US new"
    assert body[0]["region"] == "us"
    assert body[0]["category"] == "us"
    assert body[1]["title"] == "VN old"
    assert body[1]["region"] == "vn"
    assert body[1]["category"] == "market"
    assert body[1]["publisher"] == "CafeF"


def test_news_returns_us_only_when_vn_fetch_fails(monkeypatch, client):
    def _boom(limit):
        raise RuntimeError("CafeF down")
    monkeypatch.setattr(news_service, "fetch_vn_rss", _boom)
    monkeypatch.setattr(market, "get_news", lambda limit: [
        {"title": "US new", "publisher": "Reuters", "url": "https://reuters.test/b",
         "published": 200, "tickers": []},
    ])

    resp = client.get("/api/news?limit=30")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["title"] == "US new"


def test_news_search_proxies_results(monkeypatch, client):
    monkeypatch.setattr(news_service, "search_web", lambda q, count, time_range: [
        {"title": "Result", "url": "https://x.test", "content": "snippet",
         "source": "Reuters", "published": "2026-08-07T10:00:00Z"},
    ])

    resp = client.get("/api/news/search?q=fed+rates&count=5&time_range=day")

    assert resp.status_code == 200
    assert resp.json() == [{"title": "Result", "url": "https://x.test", "content": "snippet",
                            "source": "Reuters", "published": "2026-08-07T10:00:00Z"}]


def test_news_search_returns_503_when_searxng_down(monkeypatch, client):
    def _boom(q, count, time_range):
        raise RuntimeError("SearXNG unreachable at http://127.0.0.1:8888 — is it running?")
    monkeypatch.setattr(news_service, "search_web", _boom)

    resp = client.get("/api/news/search?q=fed+rates")

    assert resp.status_code == 503
    assert "SearXNG unreachable" in resp.json()["detail"]


def test_news_article_proxies_result(monkeypatch, client):
    monkeypatch.setattr(news_service, "read_article", lambda url: {
        "url": url, "title": "T", "text": "Body text.",
    })

    resp = client.get("/api/news/article?url=https://example.test/a")

    assert resp.status_code == 200
    assert resp.json() == {"url": "https://example.test/a", "title": "T", "text": "Body text."}


def test_news_article_returns_422_when_extraction_fails(monkeypatch, client):
    def _boom(url):
        raise RuntimeError(f"Could not fetch {url} (blocked, dead link, or network error)")
    monkeypatch.setattr(news_service, "read_article", _boom)

    resp = client.get("/api/news/article?url=https://example.test/dead")

    assert resp.status_code == 422
    assert "Could not fetch" in resp.json()["detail"]


def test_news_routes_validate_request_bounds(client):
    assert client.get("/api/news?limit=0").status_code == 422
    assert client.get("/api/news?limit=101").status_code == 422
    assert client.get("/api/news/search?q=x&count=5").status_code == 422
    assert client.get("/api/news/search?q=markets&count=21").status_code == 422
    assert client.get("/api/news/search?q=markets&time_range=year").status_code == 422


def test_vn_news_is_tagged_with_mentioned_tickers(monkeypatch, client):
    from app.routes import news as news_route

    monkeypatch.setattr(news_service, "fetch_vn_rss", lambda limit: [
        {"title": "VNM tăng giá, USD giảm", "url": "https://cafef.vn/a", "published": 100,
         "category": "market", "summary": "Cổ phiếu HPG và VNM dẫn dắt; GDP quý 3"},
        {"title": "Thị trường đi ngang", "url": "https://cafef.vn/b", "published": 90,
         "category": "market", "summary": ""},
    ])
    monkeypatch.setattr(market, "get_news", lambda limit: [])
    monkeypatch.setattr(news_route, "_known_vn_symbols", lambda: set())

    body = client.get("/api/news").json()
    assert body[0]["tickers"] == ["VNM", "HPG"]
    assert body[1]["tickers"] == []


def test_vn_news_tags_only_known_symbols_when_available(monkeypatch, client):
    from app.routes import news as news_route

    monkeypatch.setattr(news_service, "fetch_vn_rss", lambda limit: [
        {"title": "FPT và ABC ký hợp tác", "url": "https://cafef.vn/a", "published": 100,
         "category": "companies", "summary": ""},
    ])
    monkeypatch.setattr(market, "get_news", lambda limit: [])
    monkeypatch.setattr(news_route, "_known_vn_symbols", lambda: {"FPT", "VNM"})

    assert client.get("/api/news").json()[0]["tickers"] == ["FPT"]
