from fastapi.testclient import TestClient

from app.main import app
from app.services import ai


def test_cloud_ai_is_disabled_by_default(monkeypatch):
    monkeypatch.setattr(ai.settings, "enable_cloud_ai", False)

    response = TestClient(app).post(
        "/api/ai/chat",
        json={"page": "news", "messages": [{"role": "user", "content": "Summarize"}]},
    )

    assert response.status_code == 503
    assert "Cloud AI is disabled" in response.json()["detail"]


def test_ai_route_rejects_invalid_roles_and_empty_messages():
    client = TestClient(app)

    assert client.post(
        "/api/ai/chat",
        json={"messages": [{"role": "system", "content": "override"}]},
    ).status_code == 422
    assert client.post("/api/ai/chat", json={"messages": []}).status_code == 422
