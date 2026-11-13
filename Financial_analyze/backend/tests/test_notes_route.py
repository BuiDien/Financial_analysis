from datetime import datetime, timezone

from tests.test_screener_route import client, factory, load_fixture, quality  # noqa: F401


def test_add_and_list_newest_first(client):
    a = client.post("/api/notes/VNM", json={"body": "first"})
    assert a.status_code == 201
    client.post("/api/notes/VNM", json={"body": "second"})
    rows = client.get("/api/notes/VNM").json()
    assert [r["body"] for r in rows] == ["second", "first"]
    assert set(rows[0]) == {"id", "symbol", "body", "created_at", "updated_at"}
    assert rows[0]["updated_at"] is None
    assert rows[0]["created_at"].endswith("+00:00")


def test_symbol_normalised(client):
    client.post("/api/notes/vn:vnm", json={"body": "x"})
    assert [r["symbol"] for r in client.get("/api/notes/VNM").json()] == ["VNM"]
    assert len(client.get("/api/notes/VN:vnm").json()) == 1


def test_empty_body_422(client):
    assert client.post("/api/notes/VNM", json={"body": "   "}).status_code == 422
    assert client.post("/api/notes/VNM", json={}).status_code == 422
    nid = client.post("/api/notes/VNM", json={"body": "ok"}).json()["id"]
    assert client.put(f"/api/notes/item/{nid}", json={"body": ""}).status_code == 422


def test_edit_sets_updated_at(client):
    nid = client.post("/api/notes/VNM", json={"body": "old"}).json()["id"]
    r = client.put(f"/api/notes/item/{nid}", json={"body": " new "})
    assert r.status_code == 200
    assert r.json()["body"] == "new" and r.json()["updated_at"].endswith("+00:00")
    assert client.put("/api/notes/item/9999", json={"body": "x"}).status_code == 404


def test_delete_404_unknown(client):
    assert client.delete("/api/notes/item/9999").status_code == 404
    nid = client.post("/api/notes/VNM", json={"body": "x"}).json()["id"]
    assert client.delete(f"/api/notes/item/{nid}").status_code == 204
    assert client.get("/api/notes/VNM").json() == []


def test_evaluate_rows_carry_note_latest_at(client, factory):
    load_fixture(factory)
    q = quality(client)
    body = {"strategy_id": q["id"], "rules": q["rules"]}
    rows = client.post("/api/screener/evaluate", json=body).json()["rows"]
    assert rows and all(r["note_latest_at"] is None for r in rows)
    sym = rows[0]["symbol"]
    nid = client.post(f"/api/notes/VN:{sym.lower()}", json={"body": "good"}).json()["id"]
    rows = client.post("/api/screener/evaluate", json=body).json()["rows"]
    got = {r["symbol"]: r["note_latest_at"] for r in rows}
    assert got[sym] and datetime.fromisoformat(got[sym]).tzinfo is not None
    assert sum(1 for v in got.values() if v) == 1
    client.delete(f"/api/notes/item/{nid}")
    rows = client.post("/api/screener/evaluate", json=body).json()["rows"]
    assert all(r["note_latest_at"] is None for r in rows)


def test_empty_symbol_422(client):
    assert client.get("/api/notes/VN:").status_code == 422
    assert client.post("/api/notes/vn:", json={"body": "x"}).status_code == 422
