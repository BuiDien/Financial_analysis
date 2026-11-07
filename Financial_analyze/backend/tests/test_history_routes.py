"""'Add to history' routes: preview, write, remove, resolutions, label lock."""

from app.db import get_db
from app.main import app
from app.models.ocr import FactResolution, OCRPageResult, StatementFact
from app.services.history_facts import point_states

from tests.test_ocr_inbox import (  # noqa: F401 — client is a fixture
    _BASE_LABELS,
    client,
    create_markdown_review,
)

BALANCE = """# BÁO CÁO TÌNH HÌNH TÀI CHÍNH HỢP NHẤT

Đơn vị tính: triệu đồng

<table><tr><td>Chỉ tiêu</td><td>Mã số</td><td>30/09/2026</td><td>31/12/2025</td></tr>
<tr><td>Tiền mặt</td><td>110</td><td>1.000</td><td>900</td></tr>
<tr><td>Tiền gửi tại NHNN</td><td>120</td><td>2.500</td><td>2.000</td></tr>
<tr><td>Lãi cơ bản trên cổ phiếu</td><td>130</td><td>1.234</td><td>1.100</td></tr></table>
"""
AMOUNT_ROWS = (2, 3)

MISREAD = """# BÁO CÁO TÌNH HÌNH TÀI CHÍNH HỢP NHẤT

Đơn vị tính: triệu đồng

<table><tr><td>Chỉ tiêu</td><td>30/09/2026</td><td>31/12/2025</td></tr>
<tr><td>Bất động sản đầu tư</td><td>213.258</td><td>222.313</td></tr>
<tr><td>Nguyên giá</td><td>250.155</td><td>255.126</td></tr>
<tr><td>Hao mòn</td><td>(36.897)</td><td>(32.313)</td></tr></table>
"""

Q3_LABELS = _BASE_LABELS | {"scope": "consolidated", "fiscal_year": 2026, "period_code": "Q3"}


def _session():
    return next(app.dependency_overrides[get_db]())


def verified_review(client, markdown, labels=Q3_LABELS, allow_duplicate=False):
    item, review = create_markdown_review(client, markdown, allow_duplicate=allow_duplicate)
    assert client.patch(f"/api/ocr-inbox/{item['id']}/labels", json=labels).status_code == 200
    review = client.get(f"/api/ocr-inbox/reviews/{review['id']}").json()
    for page in review["pages"]:
        review = client.post(
            f"/api/ocr-inbox/reviews/{review['id']}/pages/{page['page']}/approve",
            json={"revision": review["revision"]},
        ).json()
    response = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/verify",
        json={"revision": review["revision"]},
    )
    assert response.status_code == 200, response.text
    return item, response.json()


def preview(client, review, **answers):
    response = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/history-preview",
        json={"revision": review["revision"]} | answers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def write(client, review, **answers):
    return client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/history",
        json={"revision": review["revision"]} | answers,
    )


def new_lines(rows=AMOUNT_ROWS, page=1, table=1):
    return [
        {"page": page, "table": table, "row": row, "line_key": None, "new_line_name": f"Line {row}"}
        for row in rows
    ]


def codes(result):
    return [problem["code"] for problem in result["blocking"]]


def active_facts(item_id=None):
    db = _session()
    try:
        query = db.query(StatementFact).filter_by(status="active")
        if item_id is not None:
            query = query.filter_by(inbox_item_id=item_id)
        return query.all()
    finally:
        db.close()


def fact_dicts(db):
    return [
        {
            "id": f.id, "line_key": f.line_key, "period_type": f.period_type,
            "period_start": f.period_start, "period_end": f.period_end,
            "value": f.value, "origin": f.origin, "status": f.status,
            "inbox_item_id": f.inbox_item_id,
        }
        for f in db.query(StatementFact).all()
    ]


def test_preview_blocks_until_answers_complete(client):
    _item, review = verified_review(client, BALANCE)

    first = preview(client, review)
    unanswered = [p for p in first["blocking"] if p["code"] == "line_unanswered"]
    assert sorted(p["row"] for p in unanswered) == list(AMOUNT_ROWS)
    assert set(codes(first)) == {"line_unanswered"}
    [table] = first["tables"]
    assert table["kind"] == "balance" and table["unit_multiplier"] == 1_000_000
    assert [c["period_source"] for c in table["columns"]] == ["header", "header"]
    by_row = {row["row"]: row for row in table["rows"]}
    assert by_row[2]["status"] == "unknown"
    assert by_row[4]["status"] == "skipped" and by_row[4]["skip_reason"] == "not an amount"

    answered = preview(client, review, lines=new_lines())
    assert answered["blocking"] == []
    assert answered["conflicts"] == []


def test_write_then_series_has_points(client):
    item, review = verified_review(client, BALANCE)
    response = write(client, review, lines=new_lines())
    assert response.status_code == 200, response.text
    assert response.json() == {"written": 4, "superseded": 0, "conflicts_open": 0}

    facts = active_facts(item["id"])
    assert len(facts) == 2 * len(AMOUNT_ROWS)
    values = {(f.row_number, f.period_end.isoformat()): f for f in facts}
    cash = values[(2, "2026-09-30")]
    assert cash.value == 1_000 * 1_000_000
    assert cash.raw_text == "1.000" and cash.origin == "printed"
    assert cash.row_label == "Tiền mặt" and cash.ticker == "MBB"
    assert cash.scope == "consolidated" and cash.statement_kind == "balance"
    assert cash.period_type == "instant" and cash.review_id == review["id"]
    assert values[(3, "2025-12-31")].value == 2_000 * 1_000_000

    # The new lines are now in the catalogue: a fresh preview matches them.
    again = preview(client, review)
    assert again["blocking"] == []
    statuses = {row["row"]: row["status"] for row in again["tables"][0]["rows"]}
    assert statuses == {2: "matched", 3: "matched", 4: "skipped"}


def test_rewrite_same_pdf_supersedes(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    first_ids = {f.id for f in active_facts(item["id"])}

    response = write(client, review)
    assert response.status_code == 200, response.text
    assert response.json()["superseded"] == 4

    current = active_facts(item["id"])
    assert len(current) == 4
    assert not first_ids & {f.id for f in current}
    db = _session()
    try:
        old = db.query(StatementFact).filter(StatementFact.id.in_(first_ids)).all()
        assert {f.status for f in old} == {"superseded"}
    finally:
        db.close()


def test_period_mismatch_blocks(client):
    _item, review = verified_review(
        client, BALANCE, labels=Q3_LABELS | {"period_code": "Q2"},
    )
    result = preview(client, review, lines=new_lines())
    assert codes(result) == ["period_mismatch"]
    assert write(client, review, lines=new_lines()).status_code == 409


def test_unaccepted_misread_blocks(client):
    _item, review = verified_review(client, MISREAD)
    lines = new_lines(rows=(2, 3, 4))
    result = preview(client, review, lines=lines)
    assert codes(result) == ["misread_unaccepted"]
    [misread] = result["misreads"]
    assert misread["page"] == 1 and misread["parent"] == "222.313"
    accepted = [{
        "page": 1, "content_sha256": misread["content_sha256"],
        "table": misread["table"], "parent_row": misread["parent_row"],
        "column_label": misread["column_label"],
    }]
    assert preview(client, review, lines=lines, accepted_misreads=accepted)["blocking"] == []

    # Changing the page text clears the acceptance (it was tied to the hash).
    db = _session()
    try:
        page = db.query(OCRPageResult).filter_by(page_number=1).one()
        page.reviewed_markdown = MISREAD.replace("Hao mòn", "Hao mòn lũy kế")
        db.commit()
    finally:
        db.close()
    result = preview(client, review, lines=lines, accepted_misreads=accepted)
    assert "misread_unaccepted" in codes(result)


def test_labels_locked_while_in_history(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    response = client.patch(f"/api/ocr-inbox/{item['id']}/labels", json=Q3_LABELS)
    assert response.status_code == 409
    assert response.json()["detail"] == "Remove this document from history first"


def test_remove_from_history_unlocks(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    response = client.delete(f"/api/ocr-inbox/{item['id']}/history")
    assert response.status_code == 200
    assert response.json() == {"superseded": 4}
    assert active_facts(item["id"]) == []
    assert client.patch(
        f"/api/ocr-inbox/{item['id']}/labels", json=Q3_LABELS,
    ).status_code == 200


def test_delete_inbox_item_deletes_its_facts_and_resolutions(client):
    item_a, review_a = verified_review(client, BALANCE)
    assert write(client, review_a, lines=new_lines()).status_code == 200
    item_b, review_b = verified_review(
        client, BALANCE.replace("1.000", "1.100"), allow_duplicate=True,
    )
    assert write(client, review_b).json()["conflicts_open"] == 1
    fact_b = next(f for f in active_facts(item_b["id"]) if f.value == 1_100_000_000)
    response = client.post(
        "/api/history/MBB/consolidated/resolutions",
        json={"statement_kind": "balance", "fact_key": fact_b.fact_key, "chosen_fact_id": fact_b.id},
    )
    assert response.status_code == 200, response.text

    assert client.delete(f"/api/ocr-inbox/{item_b['id']}").status_code == 200
    db = _session()
    try:
        assert db.query(StatementFact).filter_by(inbox_item_id=item_b["id"]).count() == 0
        assert db.query(FactResolution).count() == 0
        assert db.query(StatementFact).filter_by(inbox_item_id=item_a["id"]).count() == 4
    finally:
        db.close()


def test_resolution_reopens_after_source_changes(client):
    item_a, review_a = verified_review(client, BALANCE)
    assert write(client, review_a, lines=new_lines()).status_code == 200
    _item_b, review_b = verified_review(
        client, BALANCE.replace("1.000", "1.100"), allow_duplicate=True,
    )
    conflict_preview = preview(client, review_b)
    [conflict] = conflict_preview["conflicts"]
    assert conflict["incoming"]["value"] == 1_100_000_000
    assert [e["value"] for e in conflict["existing"]] == [1_000_000_000]
    assert write(client, review_b).json()["conflicts_open"] == 1

    chosen_id = conflict["existing"][0]["fact_id"]
    response = client.post(
        "/api/history/MBB/consolidated/resolutions",
        json={"statement_kind": "balance", "fact_key": conflict["fact_key"], "chosen_fact_id": chosen_id},
    )
    assert response.status_code == 200, response.text
    assert response.json()["state"]["status"] == "resolved"

    # Review A's page is corrected (as a newer review would be) and re-added.
    db = _session()
    try:
        page = next(
            p for p in db.query(OCRPageResult).filter_by(page_number=1).all()
            if p.attempt.review.id == review_a["id"]
        )
        page.reviewed_markdown = BALANCE.replace("1.000", "1.200")
        db.commit()
    finally:
        db.close()
    result = write(client, review_a)
    assert result.status_code == 200, result.text
    assert result.json()["conflicts_open"] == 1

    db = _session()
    try:
        resolutions = {
            r.fact_key: {"chosen_fact_id": r.chosen_fact_id, "chosen_value": r.chosen_value}
            for r in db.query(FactResolution).all()
        }
        states = point_states(fact_dicts(db), resolutions)
        assert states[conflict["fact_key"]].status == "conflict"
    finally:
        db.close()


def test_unverified_review_rejected(client):
    _item, review = create_markdown_review(client, BALANCE)
    result = preview(client, review)
    assert codes(result) == ["review_not_verified"]
    assert write(client, review).status_code == 409


def test_stale_revision_rejected(client):
    _item, review = verified_review(client, BALANCE)
    response = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/history",
        json={"revision": review["revision"] - 1, "lines": new_lines()},
    )
    assert response.status_code == 409


# --- read API ------------------------------------------------------------------


def _add_fact(item_id, line_key, ptype, start, end, value, kind="balance", origin="printed", inputs=None):
    from datetime import date as _d
    db = _session()
    try:
        fact = StatementFact(
            inbox_item_id=item_id, ticker="MBB", scope="consolidated", statement_kind=kind,
            line_key=line_key, fact_key=f"{line_key}|{ptype}|{start or ''}|{end}",
            period_type=ptype, period_start=_d.fromisoformat(start) if start else None,
            period_end=_d.fromisoformat(end), value=value, origin=origin, inputs=inputs,
            row_label="Label", status="active",
        )
        db.add(fact)
        db.commit()
        return fact.id
    finally:
        db.close()


def _first_line_key(item_id):
    return sorted({f.line_key for f in active_facts(item_id)})[0]


def test_series_quarter_grain_excludes_ytd(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    key = _first_line_key(item["id"])
    _add_fact(item["id"], key, "ytd", "2026-01-01", "2026-09-30", 5)
    _add_fact(item["id"], key, "quarter", "2026-07-01", "2026-09-30", 7)
    body = client.get(f"/api/history/MBB/consolidated/series?lines={key},nope").json()
    [line] = body["lines"]
    types = {p["period_type"] for p in line["points"]}
    assert types == {"instant", "quarter"}
    ends = [p["period_end"] for p in line["points"]]
    assert ends == sorted(ends)
    inst = next(p for p in line["points"] if p["period_type"] == "instant" and p["period_end"] == "2026-09-30")
    [src] = inst["sources"]
    assert src["reviewed"] is True and src["filename"] and src["page"] == 1 and src["row_label"]
    ranged = client.get(
        f"/api/history/MBB/consolidated/series?lines={key}&from=2026-01-01&to=2026-12-31"
    ).json()["lines"][0]["points"]
    assert all(p["period_end"].startswith("2026") for p in ranged)


def test_series_year_grain_uses_year_and_dec31_instants(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    key = _first_line_key(item["id"])
    _add_fact(item["id"], key, "year", "2025-01-01", "2025-12-31", 9)
    _add_fact(item["id"], key, "quarter", "2026-07-01", "2026-09-30", 7)
    [line] = client.get(
        f"/api/history/MBB/consolidated/series?lines={key}&grain=year"
    ).json()["lines"]
    got = {(p["period_type"], p["period_end"]) for p in line["points"]}
    assert got == {("instant", "2025-12-31"), ("year", "2025-12-31")} or len(got) == 2
    assert all(p["period_end"] == "2025-12-31" for p in line["points"])


def test_series_conflict_point_has_null_value_and_both_sources(client):
    item_a, review_a = verified_review(client, BALANCE)
    assert write(client, review_a, lines=new_lines()).status_code == 200
    item_b, review_b = verified_review(
        client, BALANCE.replace("1.000", "1.100"), allow_duplicate=True,
    )
    assert write(client, review_b).json()["conflicts_open"] == 1
    cash = next(f for f in active_facts(item_a["id"]) if f.value == 1_000_000_000)
    [line] = client.get(
        f"/api/history/MBB/consolidated/series?lines={cash.line_key}"
    ).json()["lines"]
    point = next(p for p in line["points"] if p["period_end"] == "2026-09-30")
    assert point["value"] is None and point["status"] == "conflict"
    assert {s["inbox_item_id"] for s in point["sources"]} == {item_a["id"], item_b["id"]}


def test_series_calculated_point_lists_inputs(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    key = _first_line_key(item["id"])
    fid = _add_fact(
        item["id"], key, "quarter", "2026-04-01", "2026-06-30", 3,
        kind="balance", origin="calculated", inputs=[1, 2],
    )
    [line] = client.get(f"/api/history/MBB/consolidated/series?lines={key}").json()["lines"]
    point = next(p for p in line["points"] if p["period_type"] == "quarter")
    assert point["origin"] == "calculated" and point["inputs"] == [1, 2]
    [src] = point["sources"]
    assert src["fact_id"] == fid and src["filename"] is None
    assert src["page"] is None and src["row"] is None


def test_companies_and_lines_list_only_active(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    assert client.get("/api/history/companies").json() == [{
        "ticker": "MBB", "scope": "consolidated", "kinds": ["balance"],
        "documents": 1, "last_period_end": "2026-09-30",
    }]
    lines = client.get("/api/history/MBB/consolidated/lines").json()
    assert {l["name"] for l in lines} == {"Line 2", "Line 3"}
    assert all(l["kind"] == "balance" and "parent_key" in l for l in lines)
    assert client.get("/api/history/XXX/consolidated/lines").json() == []
    assert client.get("/api/history/XXX/consolidated/series?lines=a").json() == {"lines": []}

    assert write(client, review).status_code == 200  # supersede: still one doc
    assert len(client.get("/api/history/MBB/consolidated/lines").json()) == 2
    assert client.delete(f"/api/ocr-inbox/{item['id']}").status_code == 200
    assert client.get("/api/history/companies").json() == []


# --- final review M1 / M3 ------------------------------------------------------


def test_history_routes_reject_a_review_that_is_not_the_latest(client):
    from app.models.ocr import OCRAttempt, OCRReviewJob
    from app.ocr_page_contract import OCR_PAGE_RESULT_FORMAT

    item, review = verified_review(client, BALANCE)
    db = _session()
    try:
        newer_attempt = OCRAttempt(
            inbox_item_id=item["id"], status="completed", result_format=OCR_PAGE_RESULT_FORMAT,
        )
        db.add(newer_attempt)
        db.flush()
        db.add(OCRReviewJob(
            inbox_item_id=item["id"], attempt_id=newer_attempt.id, status="ready_for_review",
            revision=1, result_format=OCR_PAGE_RESULT_FORMAT,
        ))
        db.commit()
    finally:
        db.close()
    response = client.post(
        f"/api/ocr-inbox/reviews/{review['id']}/history-preview",
        json={"revision": review["revision"]},
    )
    assert response.status_code == 409
    assert write(client, review, lines=new_lines()).status_code == 409
    assert active_facts() == []


def test_history_companies_route_does_not_shadow_market_history(client, monkeypatch):
    from app.services import market

    calls = []
    monkeypatch.setattr(
        market, "get_history",
        lambda ticker, period="1mo", interval="1d": calls.append(ticker) or {"ticker": ticker, "bars": []},
    )
    assert client.get("/api/history/companies").json() == []
    response = client.get("/api/history/MBB")
    assert response.status_code == 200 and response.json() == {"ticker": "MBB", "bars": []}
    assert calls == ["MBB"]


def test_series_agree_counts_documents_not_facts(client):
    item, review = verified_review(client, BALANCE)
    assert write(client, review, lines=new_lines()).status_code == 200
    cash = next(f for f in active_facts(item["id"]) if f.value == 1_000_000_000)
    # A legacy duplicate from the SAME document with the same value.
    _add_fact(item["id"], cash.line_key, "instant", None, "2026-09-30", 1_000_000_000)
    [line] = client.get(f"/api/history/MBB/consolidated/series?lines={cash.line_key}").json()["lines"]
    point = next(p for p in line["points"] if p["period_end"] == "2026-09-30")
    assert point["status"] == "single" and point["value"] == 1_000_000_000

    item_b, review_b = verified_review(client, BALANCE, allow_duplicate=True)
    assert write(client, review_b).status_code == 200
    [line] = client.get(f"/api/history/MBB/consolidated/series?lines={cash.line_key}").json()["lines"]
    point = next(p for p in line["points"] if p["period_end"] == "2026-09-30")
    assert point["status"] == "agree"
    assert {s["inbox_item_id"] for s in point["sources"]} == {item["id"], item_b["id"]}
