from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app
from app.routes import filings


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    def override():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override
    monkeypatch.setattr(filings.settings, "upload_dir", str(tmp_path))
    monkeypatch.setattr(filings.settings, "allow_unverified_filing_ai", False)
    monkeypatch.setattr(filings.pdf, "quick_meta", lambda path: {"pages": 3, "extracted": {}})
    yield TestClient(app), tmp_path
    app.dependency_overrides.clear()


def _upload(client, filename="report.pdf", content=b"%PDF-1.4\nmock"):
    return client.post(
        "/api/filings/upload",
        data={"ticker": "vnm", "filing_type": "Annual Report", "period": "FY 2025"},
        files={"file": (filename, content, "application/pdf")},
    )


def test_upload_streams_pdf_and_sanitizes_filename(client):
    test_client, upload_dir = client

    response = _upload(test_client, filename="../../VNM-report.pdf")

    assert response.status_code == 200
    body = response.json()
    assert body["ticker"] == "VNM"
    assert body["filename"] == "VNM-report.pdf"
    assert body["size_bytes"] == len(b"%PDF-1.4\nmock")
    paths = list(Path(upload_dir).iterdir())
    assert len(paths) == 1
    assert paths[0].parent == Path(upload_dir)


def test_upload_rejects_non_pdf_content_and_removes_partial_file(client):
    test_client, upload_dir = client

    response = _upload(test_client, content=b"not really a PDF")

    assert response.status_code == 400
    assert list(Path(upload_dir).iterdir()) == []


def test_upload_rejects_unsupported_ticker(client):
    test_client, upload_dir = client
    response = test_client.post(
        "/api/filings/upload",
        data={"ticker": "../../bad", "filing_type": "Annual", "period": "FY 2025"},
        files={"file": ("report.pdf", b"%PDF-1.4\nmock", "application/pdf")},
    )

    assert response.status_code == 422
    assert list(Path(upload_dir).iterdir()) == []


def test_filing_ai_is_blocked_until_reconciliation(client):
    test_client, _ = client
    filing_id = _upload(test_client).json()["id"]

    analyze = test_client.post(f"/api/filings/{filing_id}/analyze")
    ask = test_client.post(
        f"/api/filings/{filing_id}/ask",
        json={"question": "What was revenue?"},
    )

    assert analyze.status_code == 409
    assert ask.status_code == 409
    assert "reconciliation" in analyze.json()["detail"]


def test_portfolio_rejects_invalid_financial_inputs(client):
    test_client, _ = client

    assert test_client.post(
        "/api/portfolio/holdings",
        json={"ticker": "VNM", "shares": -1, "cost_basis": 1000},
    ).status_code == 422
    assert test_client.post(
        "/api/portfolio/holdings",
        json={"ticker": "VNM", "shares": 1, "cost_basis": -1},
    ).status_code == 422


def test_upload_stores_backend_relative_path_and_serves_it(client, monkeypatch):
    from app import config
    from app.models.filing import Filing

    test_client, tmp_path = client
    backend = tmp_path / "backend"
    monkeypatch.setattr(config, "BACKEND_DIR", backend)
    monkeypatch.setattr(filings.settings, "upload_dir", str(backend / "uploads"))

    body = _upload(test_client).json()
    session = next(app.dependency_overrides[get_db]())
    stored = session.get(Filing, body["id"]).storage_path
    session.close()
    assert stored.startswith("uploads/") and not Path(stored).is_absolute()

    response = test_client.get(f"/api/filings/{body['id']}/file")
    assert response.status_code == 200
    assert response.content == b"%PDF-1.4\nmock"


def test_upload_parses_pdf_off_the_event_loop(client, monkeypatch):
    import asyncio

    test_client, _ = client
    seen = []

    def quick_meta(path):
        try:
            asyncio.get_running_loop()
            seen.append(True)  # called on the event loop thread
        except RuntimeError:
            seen.append(False)
        return {"pages": 1, "extracted": {}}

    monkeypatch.setattr(filings.pdf, "quick_meta", quick_meta)
    assert _upload(test_client).status_code == 200
    assert seen == [False]
