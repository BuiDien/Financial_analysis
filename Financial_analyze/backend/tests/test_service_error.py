"""ServiceError renders exactly like FastAPI's HTTPException."""
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.main import service_error_handler
from app.services.errors import ServiceError


def _client() -> TestClient:
    app = FastAPI()
    app.add_exception_handler(ServiceError, service_error_handler)
    cases = {
        "svc-detail": ServiceError(409, "Review changed"),
        "http-detail": HTTPException(409, "Review changed"),
        "svc-none": ServiceError(404),
        "http-none": HTTPException(404),
        "svc-headers": ServiceError(429, "slow down", headers={"Retry-After": "5"}),
        "http-headers": HTTPException(429, "slow down", headers={"Retry-After": "5"}),
        "svc-304": ServiceError(304),
        "http-304": HTTPException(304),
    }

    @app.get("/{case}")
    def raise_case(case: str):
        raise cases[case]

    return TestClient(app)


def test_service_error_matches_http_exception():
    client = _client()
    for case in ("detail", "none", "headers", "304"):
        svc, ref = client.get(f"/svc-{case}"), client.get(f"/http-{case}")
        assert svc.status_code == ref.status_code
        assert svc.content == ref.content
        assert svc.headers.get("retry-after") == ref.headers.get("retry-after")
    assert client.get("/svc-none").json() == {"detail": "Not Found"}
    assert client.get("/svc-headers").headers["retry-after"] == "5"
    assert client.get("/svc-304").content == b""


def test_service_error_str_and_default_detail():
    assert ServiceError(404).detail == "Not Found"
    assert str(ServiceError(409, "x")) == "409: x"
    assert ServiceError(400, headers={"A": "b"}).headers == {"A": "b"}
