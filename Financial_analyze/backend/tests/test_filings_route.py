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


def test_portfolio_and_scan_reject_invalid_financial_inputs(client):
    test_client, _ = client

    assert test_client.post(
        "/api/portfolio/holdings",
        json={"ticker": "VNM", "shares": -1, "cost_basis": 1000},
    ).status_code == 422
    assert test_client.post(
        "/api/portfolio/holdings",
        json={"ticker": "VNM", "shares": 1, "cost_basis": -1},
    ).status_code == 422
    assert test_client.post("/api/scan", json={"limit": -1}).status_code == 422
    assert test_client.post("/api/scan", json={"limit": 201}).status_code == 422
