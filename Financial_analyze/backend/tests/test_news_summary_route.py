from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import news_collector


@pytest.fixture
def client():
    return TestClient(app)


def test_news_summary_returns_parsed_digest_when_processed(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))
    today = datetime.now().strftime("%Y-%m-%d")
    note = f"""---
date: {today}
total_articles: 1
processed: true
---

# Daily Market Monitor — {today}

## Day Summary

Quiet session, VN30 flat, US futures mixed.

## Articles

### cafef/market
- **[Story](https://cafef.vn/1)** — Modest pullback in VN blue chips.
"""
    (tmp_path / f"{today}.md").write_text(note)

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is False
    assert "Quiet session" in body["day_summary"]
    assert body["articles"] == [{
        "source": "cafef/market", "title": "Story",
        "url": "https://cafef.vn/1", "summary": "Modest pullback in VN blue chips.",
    }]
    assert body["updated_at"] is not None


def test_news_summary_stale_when_note_missing(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {"date": body["date"], "day_summary": None, "articles": [], "updated_at": None, "stale": True}


def test_news_summary_stale_when_note_unprocessed(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))
    today = datetime.now().strftime("%Y-%m-%d")
    note = f"""---
date: {today}
total_articles: 1
processed: false
---

# Daily Market Monitor — {today}

## Day Summary

_(pending — Hermes fills this in during the daily cron run)_

## Articles

### cafef/market
- **[Story](https://cafef.vn/1)** —
"""
    (tmp_path / f"{today}.md").write_text(note)

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["day_summary"] is None


def test_news_summary_stale_when_processed_note_has_no_summary(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))
    today = datetime.now().strftime("%Y-%m-%d")
    note = f"""---
date: {today}
total_articles: 1
processed: true
---

# Daily Market Monitor — {today}

## Articles

### cafef/market
- **[Story](https://cafef.vn/1)** — Modest pullback in VN blue chips.
"""
    (tmp_path / f"{today}.md").write_text(note)

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["day_summary"] is None


def test_news_summary_stale_when_note_has_invalid_encoding(monkeypatch, client, tmp_path):
    monkeypatch.setattr(news_collector, "VAULT_NEWS_DIR", str(tmp_path))
    today = datetime.now().strftime("%Y-%m-%d")
    (tmp_path / f"{today}.md").write_bytes(b"\xff\xfe not valid utf-8 \x80\x81")

    resp = client.get("/api/news/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["day_summary"] is None
