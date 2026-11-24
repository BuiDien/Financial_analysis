from app.marketdata import yfinance_provider as yp
from app.services import market


class _FakeTicker:
    def __init__(self, symbol):
        self.symbol = symbol

    @property
    def news(self):
        return [
            {
                "id": "abc123",
                "content": {
                    "title": "Fed holds rates steady",
                    "pubDate": "2026-07-06T21:24:38Z",
                    "provider": {"displayName": "Reuters"},
                    "canonicalUrl": {"url": "https://reuters.test/fed-holds"},
                    "clickThroughUrl": {"url": "https://finance.yahoo.com/fed-holds"},
                },
            },
            {
                "id": "def456",
                "content": {
                    "title": "No canonical url here",
                    "pubDate": "2026-07-06T20:00:00Z",
                    "provider": {"displayName": "Bloomberg"},
                    "canonicalUrl": None,
                    "clickThroughUrl": {"url": "https://finance.yahoo.com/fallback"},
                },
            },
        ]


def test_get_news_reads_new_content_envelope(monkeypatch):
    monkeypatch.setattr(yp.yf, "Ticker", lambda t: _FakeTicker(t))

    items = market.get_news(limit=10)

    assert len(items) == 2
    assert items[0] == {
        "title": "Fed holds rates steady",
        "publisher": "Reuters",
        "url": "https://reuters.test/fed-holds",
        "published": 1783373078,
        "tickers": [],
    }


def test_get_news_falls_back_to_clickthrough_url(monkeypatch):
    monkeypatch.setattr(yp.yf, "Ticker", lambda t: _FakeTicker(t))

    items = market.get_news(limit=10)

    assert items[1]["url"] == "https://finance.yahoo.com/fallback"


def test_get_news_returns_empty_list_on_error(monkeypatch):
    def _boom(t):
        raise RuntimeError("yfinance down")
    monkeypatch.setattr(yp.yf, "Ticker", _boom)

    assert market.get_news() == []
