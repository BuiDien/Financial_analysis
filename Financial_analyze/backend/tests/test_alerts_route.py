from tests.test_screener_route import client, factory  # noqa: F401


def _mk(client, **kw):
    body = {"ticker": "vcb", "type": "price_above", "value": 95000, "note": "n",
            "active": True, "channels": ["app"], "currency": "VND", **kw}
    r = client.post("/api/alerts", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_list_shape(client):
    a = _mk(client)
    assert a["id"].startswith("a_") and a["ticker"] == "VCB"
    assert a["triggered"] is False and a["triggeredAt"] is None and a["created"]
    assert set(a) == {"id", "ticker", "type", "value", "currency", "note", "channels", "active",
                      "triggered", "triggeredAt", "triggeredPrice", "created"}
    assert client.get("/api/alerts").json() == [a]


def test_create_validates(client):
    assert client.post("/api/alerts", json={"type": "price_above"}).status_code == 422
    assert client.post("/api/alerts", json={"ticker": "X"}).status_code == 422
    assert client.post("/api/alerts", json={"ticker": "X", "type": "t", "value": "abc"}).status_code == 422


def test_list_newest_first(client):
    a = _mk(client, ticker="AAA")
    b = _mk(client, ticker="BBB")
    assert [x["id"] for x in client.get("/api/alerts").json()] == [b["id"], a["id"]]


def test_patch_trigger_and_toggle(client):
    a = _mk(client)
    r = client.patch(f"/api/alerts/{a['id']}", json={"triggered": True, "triggeredAt": 1767000000000,
                                                     "triggeredPrice": 96000.5, "active": False})
    assert r.status_code == 200
    j = r.json()
    assert j["triggered"] is True and j["triggeredAt"] == 1767000000000
    assert j["triggeredPrice"] == 96000.5 and j["active"] is False and j["value"] == 95000
    assert client.patch("/api/alerts/nope", json={"active": True}).status_code == 404


def test_patch_null_type_rejected(client):
    a = _mk(client)
    assert client.patch(f"/api/alerts/{a['id']}", json={"type": None}).status_code == 422
    assert client.get("/api/alerts").json()[0]["type"] == "price_above"


def test_extra_roundtrip(client):
    a = _mk(client, foo={"x": 1})
    assert a["foo"] == {"x": 1}
    assert client.patch(f"/api/alerts/{a['id']}", json={"bar": 2}).json()["foo"] == {"x": 1}
    assert client.get("/api/alerts").json()[0]["bar"] == 2


def test_delete_and_clear(client):
    a = _mk(client)
    _mk(client, ticker="B")
    assert client.delete(f"/api/alerts/{a['id']}").status_code == 204
    assert client.delete(f"/api/alerts/{a['id']}").status_code == 404
    assert client.delete("/api/alerts").json() == {"deleted": 1}
    assert client.get("/api/alerts").json() == []


def test_import_idempotent_and_lossless(client):
    dump = [
        {"id": "a_2", "ticker": "NVDA", "type": "pct_move", "value": 5, "note": "", "active": True,
         "channels": ["app"], "created": "2026-11-02", "triggered": True, "triggeredAt": 1767000000000,
         "triggeredPrice": 120.5, "currency": "USD", "legacyField": "keep"},
        {"id": "a_1", "ticker": "fpt", "type": "rsi_above", "value": 70, "active": False, "created": "2026-11-01"},
        {"ticker": "", "type": "price_below"},
        "junk",
    ]
    r = client.post("/api/alerts/import", json=dump)
    assert r.json() == {"imported": 2, "skipped": 2}
    again = client.post("/api/alerts/import", json={"alerts": dump})
    assert again.json() == {"imported": 0, "skipped": 4}
    rows = client.get("/api/alerts").json()
    assert [x["id"] for x in rows] == ["a_2", "a_1"]
    assert rows[0]["legacyField"] == "keep" and rows[0]["triggeredAt"] == 1767000000000
    assert rows[0]["created"] == "2026-11-02" and rows[1]["ticker"] == "FPT" and rows[1]["active"] is False
    # patching an imported alert by its client id works
    assert client.patch("/api/alerts/a_1", json={"active": True}).json()["active"] is True


def test_non_finite_numbers_are_rejected(client):
    for bad in ("Infinity", "-Infinity", "NaN", "inf"):
        r = client.post("/api/alerts", json={"ticker": "X", "type": "price_above", "value": bad})
        assert r.status_code == 422, (bad, r.text)
        assert "finite" in r.json()["detail"]
    a = _mk(client)
    r = client.patch(f"/api/alerts/{a['id']}", json={"triggeredPrice": "NaN"})
    assert r.status_code == 422
    r = client.patch(f"/api/alerts/{a['id']}", json={"triggeredAt": 1e400})
    assert r.status_code == 422
    assert client.get("/api/alerts").status_code == 200


def test_list_survives_a_non_finite_row_already_in_the_db(client, factory):
    from app.models.alerts import PriceAlert
    a = _mk(client)
    with factory() as db:
        row = db.get(PriceAlert, a["id"])
        row.value = float("inf")
        row.extra = {"score": float("nan")}
        db.commit()
    r = client.get("/api/alerts")
    assert r.status_code == 200, r.text
    assert r.json()[0]["value"] is None and r.json()[0]["score"] is None
