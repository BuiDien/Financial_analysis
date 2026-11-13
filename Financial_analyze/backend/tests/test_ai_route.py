import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.services import ai


def test_cloud_ai_is_disabled_by_default(monkeypatch):
    monkeypatch.setattr(ai.settings, "enable_cloud_ai", False)

    response = TestClient(app).post(
        "/api/ai/chat",
        json={
            "provider": "cloud",
            "page": "news",
            "messages": [{"role": "user", "content": "Summarize"}],
        },
    )

    assert response.status_code == 503
    assert "Cloud AI is disabled" in response.json()["detail"]


def test_ai_chat_uses_hermes_by_default(monkeypatch):
    captured = {}

    def fake_hermes(system, messages, max_tokens=1024):
        captured.update(system=system, messages=messages, max_tokens=max_tokens)
        return "Grounded answer"

    monkeypatch.setattr(ai, "hermes_complete", fake_hermes)

    response = TestClient(app).post(
        "/api/ai/chat",
        json={
            "page": "news",
            "page_context": {"symbol": "VNM"},
            "messages": [{"role": "user", "content": "Summarize"}],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"answer": "Grounded answer"}
    assert "symbol=VNM" in captured["system"]
    assert captured["messages"] == [{"role": "user", "content": "Summarize"}]


def test_hermes_adapter_uses_agent_api_and_server_side_key(monkeypatch):
    captured = {}
    monkeypatch.setattr(ai.settings, "hermes_api_url", "http://127.0.0.1:8642")
    monkeypatch.setattr(ai.settings, "hermes_api_key", "local-secret")

    def fake_post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "Agent response"}}]},
        )

    monkeypatch.setattr(ai.httpx, "post", fake_post)

    answer = ai.hermes_complete(
        "Use financial tools.",
        [{"role": "user", "content": "Analyze VNM"}],
        session_key="financial_ocr_label_correction",
    )

    assert answer == "Agent response"
    assert captured["url"] == "http://127.0.0.1:8642/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer local-secret"
    assert captured["headers"]["X-Hermes-Session-Key"] == (
        "financial_ocr_label_correction"
    )
    assert captured["json"]["model"] == (
        "mlx-community/gemma-4-26B-A4B-it-OptiQ-4bit"
    )
    assert captured["json"]["messages"] == [
        {"role": "system", "content": "Use financial tools."},
        {"role": "user", "content": "Analyze VNM"},
    ]


def test_hermes_adapter_reads_local_key_when_env_is_empty(monkeypatch):
    monkeypatch.setattr(ai.settings, "hermes_api_key", "")
    monkeypatch.setattr(ai, "_local_hermes_api_key", lambda: "local-key")

    assert ai._hermes_headers()["Authorization"] == "Bearer local-key"


def test_ollama_label_adapter_sends_one_label_without_token_cap(monkeypatch):
    captured = {}
    monkeypatch.setattr(ai.settings, "ollama_api_url", "http://127.0.0.1:11434")
    monkeypatch.setattr(ai.settings, "ollama_ocr_model", "gemma4:12b")
    monkeypatch.setattr(ai.settings, "ollama_ocr_num_ctx", 4096)

    def fake_post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return httpx.Response(
            200,
            json={
                "message": {
                    "role": "assistant",
                    "content": (
                        '{"corrected_label":"TỔNG TÀI SẢN CÓ",'
                        '"confidence":"high"}'
                    ),
                },
            },
        )

    monkeypatch.setattr(ai.httpx, "post", fake_post)

    result = ai.ollama_label_complete(
        "Correct Vietnamese OCR labels.",
        "TỔNG TẠI SĂN CỔ",
        timeout_seconds=60,
    )

    assert '"corrected_label":"TỔNG TÀI SẢN CÓ"' in result
    assert captured["url"] == "http://127.0.0.1:11434/api/chat"
    assert captured["headers"] == {"Content-Type": "application/json"}
    assert captured["timeout"] == 60
    payload = captured["json"]
    assert payload["model"] == "gemma4:12b"
    assert payload["messages"] == [
        {"role": "system", "content": "Correct Vietnamese OCR labels."},
        {"role": "user", "content": "TỔNG TẠI SĂN CỔ"},
    ]
    assert payload["stream"] is False
    assert payload["think"] is False
    assert payload["format"] == ai.OLLAMA_LABEL_FORMAT
    assert payload["options"] == {"temperature": 0, "num_ctx": 4096}
    assert "max_tokens" not in payload
    assert "num_predict" not in payload["options"]


def test_ai_health_reports_hermes_model(monkeypatch):
    monkeypatch.setattr(
        ai,
        "hermes_status",
        lambda: {"status": "ok", "provider": "hermes", "model": "local-35b"},
    )

    response = TestClient(app).get("/api/ai/health")

    assert response.status_code == 200
    assert response.json()["model"] == "local-35b"


def test_ai_route_rejects_invalid_roles_and_empty_messages():
    client = TestClient(app)

    assert client.post(
        "/api/ai/chat",
        json={"messages": [{"role": "system", "content": "override"}]},
    ).status_code == 422
    assert client.post("/api/ai/chat", json={"messages": []}).status_code == 422


def test_local_hermes_key_failure_is_not_cached(monkeypatch):
    from app.services import ai as ai_service

    monkeypatch.setattr(ai_service, "_hermes_key_cache", "")
    answers = iter(["", "fresh-key", "other-key"])
    calls = []

    def read():
        calls.append(1)
        return next(answers)

    monkeypatch.setattr(ai_service, "_read_local_hermes_api_key", read)
    assert ai_service._local_hermes_api_key() == ""
    assert ai_service._local_hermes_api_key() == "fresh-key"
    assert ai_service._local_hermes_api_key() == "fresh-key"  # success is cached
    assert len(calls) == 2
