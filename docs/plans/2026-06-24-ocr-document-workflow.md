# OCR Document Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mac/Core-side workflow that turns the external OCR engine's flat rows into 3 clean Vietnamese statements (CĐKT/KQKD/LCTT) with correct TT200 Mã số line items, quarantining unplaceable rows and handling failures.

**Architecture:** A pure TT200 placement module (`tt200.py` — reference dictionary + `place_row`/`normalize_label`, no ORM, fully unit-testable) + an orchestration service (`ingest.py` — owns the document status machine, calls ocr_client, splits via tt200, persists statements/line_items, triggers reconcile, retries once on failure) + a multipart upload route. Spec: `docs/specs/2026-06-24-ocr-document-workflow-design.md`.

**Tech Stack:** Python 3.x (stdlib `unicodedata`, `difflib`), FastAPI, SQLAlchemy 2.x, SQLite, pytest, FastAPI `TestClient`.

## Global Constraints

- Backend root: `Financial analyze/backend` (note the space). Paths below are relative to it; run from there.
- **Trust boundary:** the laptop's rows are UNTRUSTED. Placement/structuring/verification is Core-side. The OCR's own `section` field is a **hint/tiebreaker only** — the TT200 dictionary is authoritative.
- Reporting unit: **triệu đồng**. Mock company **VNM**. Stub returns canned VNM rows incl. the planted Mã số 270 error (52,800,000 vs true 52,000,000 @ conf 73).
- OCR row shape (from `ocr_client.poll` result, per `OCR_PROTOCOL.md`): `{"section","code","metric","curr","prev","page","confidence"}`. `curr`/`prev` are strings (raw digits, may be `-`-prefixed).
- Document `status` machine: `queued → submitted → extracting → placing → done` | `failed`. On failure: set `fail_reason`, **auto-retry submit once**, then surface.
- Statement `kind` ∈ `CDKT | KQKD | LCTT`. Line-item `status` starts `unverified` (reconcile sets the rest).
- Period + fiscal_year are **user-entered at upload**, applied to all 3 statements. `value`=curr (kỳ này), `prev_value`=prev (kỳ trước).
- **Fuzzy label match constant:** `LABEL_MATCH_THRESHOLD = 0.72` (difflib ratio over diacritic-stripped, lowercased, whitespace-collapsed strings).
- Depends on: Stage 2 Core (`db`, `get_db`, `models/core.py`, `tests/conftest.py` db fixture), Stage 3 (`services/ocr_client.py` submit/poll + `services/ocr_stub.py`), Stage 4 (`services/recon.py::reconcile_statement`). Where a dependency is absent at execution time, the task notes a minimal shim.
- EXCLUDE the OCR engine internals (external machine).
- Repo IS git-initialized (`main`, 7+ commits) — commit steps work as written. Commit any dirty sync-coordinator work first (PLAN.md Stage 0.1).
- Run tests: `cd "Financial analyze/backend" && pytest`.

## File Structure

- Create `app/services/tt200.py` — TT200 reference dictionary (`TT200`), `normalize_label(s)`, `place_row(row) -> kind|"unmatched"`. Pure, no ORM.
- Create `app/services/ingest.py` — `ingest_document(db, doc_id)` orchestration (status machine, ocr_client, split, persist, reconcile, retry-once) + `split_rows(rows)` helper.
- Modify `app/models/core.py` — add `Document.period`, `Document.fiscal_year`, `Document.fail_reason`, `Document.unmatched`.
- Create `app/routes/documents.py` — `POST /api/documents` (multipart: file + period + fiscal_year).
- Modify `app/main.py` — register the `documents` router.
- Create `tests/test_tt200.py`, `tests/test_ingest.py`, `tests/test_documents_route.py`.
- Create/extend `tests/ocr_fixtures.py` — canned VNM rows (if `ocr_stub` not yet present).

---

### Task 1: TT200 dictionary + `normalize_label`

**Files:**
- Create: `app/services/tt200.py`
- Test: `tests/test_tt200.py`

**Interfaces:**
- Consumes: nothing (stdlib only).
- Produces:
  - `TT200: list[dict]` — entries `{"kind": "CDKT"|"KQKD"|"LCTT", "code": str, "label": str}` (canonical labels).
  - `normalize_label(s: str) -> str` — lowercase, strip Vietnamese diacritics, collapse whitespace.
  - `LABEL_MATCH_THRESHOLD = 0.72`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_tt200.py
from app.services import tt200 as t


def test_normalize_strips_diacritics_and_case():
    assert t.normalize_label("Lợi nhuận gộp") == "loi nhuan gop"
    assert t.normalize_label("  TỔNG  CỘNG   TÀI SẢN ") == "tong cong tai san"


def test_dictionary_has_the_core_codes():
    codes = {(e["kind"], e["code"]) for e in t.TT200}
    assert ("CDKT", "270") in codes      # tổng tài sản
    assert ("CDKT", "100") in codes and ("CDKT", "200") in codes
    assert ("CDKT", "440") in codes
    assert ("KQKD", "20") in codes       # lợi nhuận gộp
    assert ("LCTT", "20") in codes       # lưu chuyển tiền thuần từ HĐKD
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_tt200.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.tt200`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/services/tt200.py
"""TT200 chart-of-accounts reference + pure row placement.

place_row() decides which statement (CĐKT/KQKD/LCTT) an OCR row belongs to,
using the Mã số and — where codes overlap between KQKD and LCTT — a fuzzy match
of the row's label against the canonical TT200 label. Pure: no ORM, no I/O.
"""
import unicodedata
from difflib import SequenceMatcher

LABEL_MATCH_THRESHOLD = 0.72

# Canonical lines (start with what the VNM fixture exercises; expand over time).
# Balance-sheet codes are unique; KQKD and LCTT deliberately share 20/30/40/50/60/70.
TT200 = [
    # CĐKT (balance sheet)
    {"kind": "CDKT", "code": "110", "label": "Tiền và tương đương tiền"},
    {"kind": "CDKT", "code": "100", "label": "TÀI SẢN NGẮN HẠN"},
    {"kind": "CDKT", "code": "200", "label": "TÀI SẢN DÀI HẠN"},
    {"kind": "CDKT", "code": "270", "label": "TỔNG CỘNG TÀI SẢN"},
    {"kind": "CDKT", "code": "300", "label": "NỢ PHẢI TRẢ"},
    {"kind": "CDKT", "code": "400", "label": "VỐN CHỦ SỞ HỮU"},
    {"kind": "CDKT", "code": "440", "label": "TỔNG CỘNG NGUỒN VỐN"},
    # KQKD (income statement)
    {"kind": "KQKD", "code": "10", "label": "Doanh thu thuần"},
    {"kind": "KQKD", "code": "20", "label": "Lợi nhuận gộp"},
    {"kind": "KQKD", "code": "30", "label": "Lợi nhuận thuần từ hoạt động kinh doanh"},
    {"kind": "KQKD", "code": "60", "label": "Lợi nhuận sau thuế thu nhập doanh nghiệp"},
    {"kind": "KQKD", "code": "70", "label": "Lãi cơ bản trên cổ phiếu"},
    # LCTT (cash flow)
    {"kind": "LCTT", "code": "20", "label": "Lưu chuyển tiền thuần từ hoạt động kinh doanh"},
    {"kind": "LCTT", "code": "30", "label": "Lưu chuyển tiền thuần từ hoạt động đầu tư"},
    {"kind": "LCTT", "code": "40", "label": "Lưu chuyển tiền thuần từ hoạt động tài chính"},
    {"kind": "LCTT", "code": "50", "label": "Lưu chuyển tiền thuần trong kỳ"},
    {"kind": "LCTT", "code": "60", "label": "Tiền và tương đương tiền đầu kỳ"},
    {"kind": "LCTT", "code": "70", "label": "Tiền và tương đương tiền cuối kỳ"},
]


def normalize_label(s: str) -> str:
    s = (s or "").strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # drop combining marks
    s = s.replace("đ", "d")
    return " ".join(s.split())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_tt200.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/tt200.py" "Financial analyze/backend/tests/test_tt200.py"
git commit -m "feat(ocr): TT200 reference dictionary + diacritic-insensitive normalize_label"
```

---

### Task 2: `place_row` — statement placement with fuzzy disambiguation

**Files:**
- Modify: `app/services/tt200.py`
- Test: `tests/test_tt200.py`

**Interfaces:**
- Consumes: `TT200`, `normalize_label`, `LABEL_MATCH_THRESHOLD` (Task 1).
- Produces: `place_row(row: dict) -> str` returning `"CDKT" | "KQKD" | "LCTT" | "unmatched"`. `row` keys used: `code` (str), `metric` (label str), optional `section` (OCR hint).

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_tt200.py

def test_balance_sheet_placed_by_code():
    assert t.place_row({"code": "270", "metric": "TỔNG CỘNG TÀI SẢN"}) == "CDKT"
    assert t.place_row({"code": "100", "metric": "tài sản ngắn hạn"}) == "CDKT"


def test_overlapping_code_disambiguated_by_label():
    # code 20 exists in BOTH KQKD and LCTT — label decides
    assert t.place_row({"code": "20", "metric": "Lợi nhuận gộp"}) == "KQKD"
    assert t.place_row({"code": "20", "metric": "Lưu chuyển tiền thuần từ HĐKD"}) == "LCTT"


def test_noisy_diacritics_still_match():
    # OCR dropped diacritics — fuzzy normalized match still places it
    assert t.place_row({"code": "20", "metric": "Loi nhuan gop"}) == "KQKD"


def test_unknown_code_is_unmatched():
    assert t.place_row({"code": "999", "metric": "Chỉ tiêu lạ"}) == "unmatched"


def test_overlapping_code_unmatched_when_label_too_weak():
    # code 20, label matches neither canonical above threshold, no usable hint
    assert t.place_row({"code": "20", "metric": "zzz qqq"}) == "unmatched"


def test_section_hint_breaks_tie_when_labels_weak():
    # weak label but OCR hint says cashflow
    assert t.place_row({"code": "20", "metric": "zzz", "section": "cashflow"}) == "LCTT"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_tt200.py -k place_row -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'place_row'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to app/services/tt200.py

_SECTION_HINT = {"balance": "CDKT", "income": "KQKD", "cashflow": "LCTT"}


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_label(a), normalize_label(b)).ratio()


def place_row(row: dict) -> str:
    code = str(row.get("code", "")).strip()
    label = row.get("metric", "")
    candidates = [e for e in TT200 if e["code"] == code]

    if not candidates:
        return "unmatched"
    if len(candidates) == 1:
        return candidates[0]["kind"]

    # overlapping code (KQKD vs LCTT): pick the best label match above threshold
    scored = sorted(((e, _similarity(label, e["label"])) for e in candidates),
                    key=lambda x: x[1], reverse=True)
    best, best_score = scored[0]
    if best_score >= LABEL_MATCH_THRESHOLD:
        return best["kind"]

    # label too weak — fall back to the OCR section hint as tiebreaker
    hint = _SECTION_HINT.get(row.get("section"))
    if hint in {c["kind"] for c in candidates}:
        return hint
    return "unmatched"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_tt200.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/tt200.py" "Financial analyze/backend/tests/test_tt200.py"
git commit -m "feat(ocr): place_row statement placement with fuzzy label disambiguation"
```

---

### Task 3: Document model fields

**Files:**
- Modify: `app/models/core.py` (the `Document` class, ~lines 40-56)
- Test: `tests/test_ingest.py` (new — model round-trip first)

**Interfaces:**
- Consumes: `Base`, existing `Document`.
- Produces: `Document.period` (String), `Document.fiscal_year` (Integer, nullable), `Document.fail_reason` (String, nullable), `Document.unmatched` (JSON, default list). Requires the `tests/conftest.py` `db` fixture (from Stage 2 / reconciliation plan; recreate if absent — code shown below).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_ingest.py
from app.models.core import Document


def test_document_has_workflow_fields(db):
    doc = Document(path="/x.pdf", kind="BCTC", status="queued",
                   period="Q4 2024", fiscal_year=2024, fail_reason=None,
                   unmatched=[{"code": "999", "metric": "lạ"}])
    db.add(doc); db.commit()
    got = db.query(Document).one()
    assert got.period == "Q4 2024" and got.fiscal_year == 2024
    assert got.unmatched[0]["code"] == "999"
    assert got.fail_reason is None
```

If `tests/conftest.py` is missing, create it:
```python
# tests/conftest.py
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.db import Base
from app.models import core  # noqa: F401


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_ingest.py::test_document_has_workflow_fields -v`
Expected: FAIL — `TypeError: 'period' is an invalid keyword argument for Document`.

- [ ] **Step 3: Write minimal implementation**

In `app/models/core.py`, add to the `Document` class (after the `pages` column, before the `uploaded_at` line):
```python
    period = Column(String, default="")              # e.g. "Q4 2024" (user-entered)
    fiscal_year = Column(Integer, nullable=True)
    fail_reason = Column(String, nullable=True)      # set when status == "failed"
    unmatched = Column(JSON, default=list)           # OCR rows that placed nowhere
```
(`String`, `Integer`, `JSON` are already imported in `core.py`.)

Note: dev DB is created via `Base.metadata.create_all`. For an existing `helix.db`, delete it and re-run `python -m app.db init` (dev only). Tests use a fresh in-memory DB.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_ingest.py::test_document_has_workflow_fields -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/models/core.py" "Financial analyze/backend/tests/test_ingest.py" "Financial analyze/backend/tests/conftest.py"
git commit -m "feat(ocr): add period/fiscal_year/fail_reason/unmatched to Document"
```

---

### Task 4: `split_rows` — group placed rows + collect unmatched

**Files:**
- Create: `app/services/ingest.py`
- Create: `tests/ocr_fixtures.py`
- Test: `tests/test_ingest.py`

**Interfaces:**
- Consumes: `tt200.place_row` (Tasks 1-2).
- Produces:
  - `split_rows(rows: list[dict]) -> tuple[dict[str, list[dict]], list[dict]]` → `(grouped, unmatched)` where `grouped` maps `kind → [rows]` (only kinds present) and `unmatched` is the leftover rows.
  - `tests/ocr_fixtures.py :: vnm_ocr_rows()` — canned VNM rows incl. the planted 270 error + one unknown-code row.

- [ ] **Step 1: Write the failing test**

```python
# tests/ocr_fixtures.py
def vnm_ocr_rows():
    """Canned OCR output for a VNM BCTC (triệu đồng). Mirrors the ocr_stub fixture.
    Includes the planted Mã số 270 error (52,800,000 vs true 52,000,000 @ conf 73)
    and one unknown-code row to exercise quarantine."""
    return [
        {"section": "balance", "code": "100", "metric": "TÀI SẢN NGẮN HẠN",   "curr": "36500000", "prev": "35000000", "page": 3, "confidence": 94},
        {"section": "balance", "code": "200", "metric": "TÀI SẢN DÀI HẠN",    "curr": "15500000", "prev": "16000000", "page": 3, "confidence": 93},
        {"section": "balance", "code": "270", "metric": "TỔNG CỘNG TÀI SẢN",  "curr": "52800000", "prev": "51000000", "page": 3, "confidence": 73},
        {"section": "balance", "code": "300", "metric": "NỢ PHẢI TRẢ",        "curr": "17000000", "prev": "16500000", "page": 4, "confidence": 95},
        {"section": "balance", "code": "400", "metric": "VỐN CHỦ SỞ HỮU",     "curr": "35000000", "prev": "34500000", "page": 4, "confidence": 96},
        {"section": "balance", "code": "440", "metric": "TỔNG CỘNG NGUỒN VỐN","curr": "52000000", "prev": "51000000", "page": 4, "confidence": 95},
        {"section": "income",  "code": "10",  "metric": "Doanh thu thuần",     "curr": "60479000", "prev": "59956000", "page": 5, "confidence": 98},
        {"section": "income",  "code": "20",  "metric": "Lợi nhuận gộp",       "curr": "24420000", "prev": "23890000", "page": 5, "confidence": 97},
        {"section": "cashflow","code": "20",  "metric": "Lưu chuyển tiền thuần từ HĐKD", "curr": "11200000", "prev": "10800000", "page": 7, "confidence": 71},
        {"section": "income",  "code": "999", "metric": "Chỉ tiêu lạ",         "curr": "123", "prev": "0", "page": 9, "confidence": 40},
    ]
```

```python
# append to tests/test_ingest.py
from app.services.ingest import split_rows
from tests.ocr_fixtures import vnm_ocr_rows


def test_split_groups_by_statement_and_quarantines_unknown():
    grouped, unmatched = split_rows(vnm_ocr_rows())
    assert set(grouped) == {"CDKT", "KQKD", "LCTT"}
    assert {r["code"] for r in grouped["CDKT"]} == {"100", "200", "270", "300", "400", "440"}
    assert [r["code"] for r in grouped["KQKD"]] == ["10", "20"]
    assert [r["code"] for r in grouped["LCTT"]] == ["20"]            # the cashflow "20"
    assert [r["code"] for r in unmatched] == ["999"]                 # unknown -> quarantined
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_ingest.py::test_split_groups_by_statement_and_quarantines_unknown -v`
Expected: FAIL — `ModuleNotFoundError: app.services.ingest`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/services/ingest.py
"""Core-side OCR document workflow: orchestrate the external OCR engine and turn
its rows into 3 statements. The laptop reads pixels; THIS is where the Mac
structures + verifies. See docs/specs/2026-06-24-ocr-document-workflow-design.md.
"""
from .tt200 import place_row


def split_rows(rows: list[dict]) -> tuple[dict[str, list[dict]], list[dict]]:
    """Place each OCR row into CĐKT/KQKD/LCTT; collect the rest as unmatched."""
    grouped: dict[str, list[dict]] = {}
    unmatched: list[dict] = []
    for row in rows:
        kind = place_row(row)
        if kind == "unmatched":
            unmatched.append(row)
        else:
            grouped.setdefault(kind, []).append(row)
    return grouped, unmatched
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_ingest.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/ingest.py" "Financial analyze/backend/tests/ocr_fixtures.py" "Financial analyze/backend/tests/test_ingest.py"
git commit -m "feat(ocr): split_rows groups statements + quarantines unmatched"
```

---

### Task 5: `ingest_document` — orchestrate, persist, status machine, retry-once

**Files:**
- Modify: `app/services/ingest.py`
- Test: `tests/test_ingest.py`

**Interfaces:**
- Consumes: `split_rows` (Task 4); `Document`/`Statement`/`LineItem` models; `ocr_client.submit`/`poll` (Stage 3); `recon.reconcile_statement` (Stage 4). Both externals are imported lazily and shimmed in tests via monkeypatch.
- Produces: `ingest_document(db, doc_id: int) -> dict` → `{"status": str, "statements": int, "unmatched": int}`. Drives the status machine `submitted → extracting → placing → done|failed`, persists statements+line_items (`value`=curr, `prev_value`=prev, status `unverified`), stores `unmatched` on the document, calls `reconcile_statement` per statement, and on OCR failure sets `fail_reason` + retries the submit **once**.
- `_to_float(s)` helper: parse OCR string amounts ("52800000", "-1800000", "") → float|None.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_ingest.py
import app.services.ingest as ingest_mod
from app.models.core import Document, Statement, LineItem


def _make_doc(db):
    doc = Document(path="/vnm.pdf", kind="BCTC", status="queued",
                   period="Q4 2024", fiscal_year=2024)
    db.add(doc); db.commit()
    return doc


def test_ingest_places_persists_and_reconciles(db, monkeypatch):
    doc = _make_doc(db)

    # shim Stage-3 ocr_client: submit -> job id, poll -> done with VNM rows
    monkeypatch.setattr(ingest_mod, "_ocr_submit", lambda path: "job-1")
    monkeypatch.setattr(ingest_mod, "_ocr_poll",
                        lambda job: {"status": "done", "result": {"rows": vnm_ocr_rows()}})
    # shim Stage-4 reconcile: record calls, no-op
    calls = []
    monkeypatch.setattr(ingest_mod, "_reconcile", lambda db, sid: calls.append(sid))

    out = ingest_document(db, doc.id)

    assert out["status"] == "done"
    assert out["statements"] == 3
    assert out["unmatched"] == 1

    db.refresh(doc)
    assert doc.status == "done"
    assert len(doc.unmatched) == 1 and doc.unmatched[0]["code"] == "999"

    kinds = {s.kind for s in db.query(Statement).filter_by(document_id=doc.id)}
    assert kinds == {"CDKT", "KQKD", "LCTT"}
    li_270 = (db.query(LineItem).join(Statement)
                .filter(Statement.document_id == doc.id, LineItem.code == "270").one())
    assert li_270.value == 52800000.0 and li_270.status == "unverified"
    assert li_270.prev_value == 51000000.0
    assert len(calls) == 3                      # reconcile run per statement


def test_ingest_retries_once_then_fails(db, monkeypatch):
    doc = _make_doc(db)
    monkeypatch.setattr(ingest_mod, "_ocr_submit", lambda path: "job-x")
    attempts = {"n": 0}

    def failing_poll(job):
        attempts["n"] += 1
        return {"status": "failed", "error": "no tables found"}

    monkeypatch.setattr(ingest_mod, "_ocr_poll", failing_poll)
    monkeypatch.setattr(ingest_mod, "_reconcile", lambda db, sid: None)

    out = ingest_document(db, doc.id)

    assert out["status"] == "failed"
    db.refresh(doc)
    assert doc.status == "failed"
    assert "no tables" in (doc.fail_reason or "")
    assert attempts["n"] == 2                    # initial + one retry
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_ingest.py -k "places_persists or retries_once" -v`
Expected: FAIL — `ImportError: cannot import name 'ingest_document'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to app/services/ingest.py
from ..models.core import Document, Statement, LineItem


# --- thin seams to Stage 3 / Stage 4 (lazy; monkeypatched in tests) ---
def _ocr_submit(path: str) -> str:
    from .ocr_client import submit
    return submit(path)


def _ocr_poll(job_id: str) -> dict:
    from .ocr_client import poll
    return poll(job_id)


def _reconcile(db, statement_id: int) -> None:
    from .recon import reconcile_statement
    reconcile_statement(db, statement_id)


def _to_float(s):
    if s is None:
        return None
    s = str(s).strip().replace(",", "")
    if s == "" or s == "-":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _run_ocr(path: str) -> dict:
    """Submit + poll to completion. Returns the OCR result dict or raises RuntimeError."""
    job = _ocr_submit(path)
    while True:
        res = _ocr_poll(job)
        status = res.get("status")
        if status == "done":
            return res.get("result", {})
        if status == "failed":
            raise RuntimeError(res.get("error", "ocr failed"))
        # queued/triaging/extracting -> keep polling (stub returns terminal immediately)


def ingest_document(db, doc_id: int) -> dict:
    doc = db.query(Document).filter(Document.id == doc_id).one()

    # submit + poll, with one retry on failure
    doc.status = "submitted"; db.commit()
    result = None
    for attempt in range(2):                      # initial + one retry
        try:
            doc.status = "extracting"; db.commit()
            result = _run_ocr(doc.path)
            break
        except RuntimeError as e:
            doc.status = "failed"; doc.fail_reason = str(e); db.commit()
    if result is None:
        return {"status": "failed", "statements": 0, "unmatched": 0}

    # split + persist
    doc.status = "placing"; db.commit()
    grouped, unmatched = split_rows(result.get("rows", []))
    doc.unmatched = unmatched

    statement_ids = []
    for kind, rows in grouped.items():
        st = Statement(document_id=doc.id, kind=kind, period=doc.period,
                       fiscal_year=doc.fiscal_year, unit="triệu đồng")
        db.add(st); db.flush()
        for r in rows:
            db.add(LineItem(statement_id=st.id, code=str(r.get("code", "")),
                            label=r.get("metric", ""), value=_to_float(r.get("curr")),
                            prev_value=_to_float(r.get("prev")),
                            confidence=r.get("confidence", 100.0),
                            status="unverified", page=r.get("page")))
        statement_ids.append(st.id)
    doc.status = "done"; db.commit()

    for sid in statement_ids:
        _reconcile(db, sid)

    return {"status": "done", "statements": len(statement_ids), "unmatched": len(unmatched)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_ingest.py -v`
Expected: PASS (all ingest tests).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/ingest.py" "Financial analyze/backend/tests/test_ingest.py"
git commit -m "feat(ocr): ingest_document orchestration, status machine, retry-once, reconcile"
```

---

### Task 6: Upload route — `POST /api/documents`

**Files:**
- Create: `app/routes/documents.py`
- Modify: `app/main.py` (register router)
- Test: `tests/test_documents_route.py`

**Interfaces:**
- Consumes: `ingest_document` (Task 5); `Document` model; `get_db`, settings `upload_dir`.
- Produces: `POST /api/documents` (multipart: `file`, `period`, `fiscal_year`) → saves the file under `upload_dir`, creates a `Document` (status=queued), runs `ingest_document`, returns `{"id","status","statements","unmatched"}`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_documents_route.py
import io
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.db import Base, get_db
from app.models import core  # noqa: F401
import app.routes.documents as docs_route
from tests.ocr_fixtures import vnm_ocr_rows


@pytest.fixture
def client(monkeypatch, tmp_path):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def override():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = override
    monkeypatch.setattr(docs_route, "UPLOAD_DIR", str(tmp_path))
    # shim ingest internals to avoid real OCR/recon
    import app.services.ingest as ingest_mod
    monkeypatch.setattr(ingest_mod, "_ocr_submit", lambda path: "job-1")
    monkeypatch.setattr(ingest_mod, "_ocr_poll",
                        lambda job: {"status": "done", "result": {"rows": vnm_ocr_rows()}})
    monkeypatch.setattr(ingest_mod, "_reconcile", lambda db, sid: None)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_upload_creates_document_and_ingests(client):
    resp = client.post("/api/documents",
                       files={"file": ("vnm.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")},
                       data={"period": "Q4 2024", "fiscal_year": "2024"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "done"
    assert body["statements"] == 3
    assert body["unmatched"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_documents_route.py -v`
Expected: FAIL — 404 (route not registered) / import error.

- [ ] **Step 3: Write minimal implementation**

```python
# app/routes/documents.py
import os
import uuid

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.orm import Session

from ..db import get_db
from ..config import get_settings
from ..models.core import Document
from ..services.ingest import ingest_document

router = APIRouter()
UPLOAD_DIR = get_settings().upload_dir


@router.post("/documents")
def upload_document(
    file: UploadFile = File(...),
    period: str = Form(...),
    fiscal_year: int = Form(...),
    db: Session = Depends(get_db),
):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    dest = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_{file.filename}")
    with open(dest, "wb") as f:
        f.write(file.file.read())

    doc = Document(path=dest, kind="BCTC", status="queued",
                   period=period, fiscal_year=fiscal_year)
    db.add(doc); db.commit()

    summary = ingest_document(db, doc.id)
    return {"id": doc.id, **summary}
```

In `app/main.py`, register the router alongside the others:
```python
from .routes import market, documents
# after app creation:
app.include_router(documents.router, prefix="/api", tags=["documents"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_documents_route.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pytest -v`
Expected: PASS (tt200 + ingest + route tests).

- [ ] **Step 6: Commit**

```bash
git add "Financial analyze/backend/app/routes/documents.py" "Financial analyze/backend/app/main.py" "Financial analyze/backend/tests/test_documents_route.py"
git commit -m "feat(ocr): POST /api/documents multipart upload + ingest"
```

---

## Self-Review

**Spec coverage:**
- Trust boundary (laptop reads, Mac structures) → Tasks 1-5 are all Mac-side; OCR engine excluded. ✓
- Lifecycle steps 7-10 (split/store/reconcile) → Task 4 (split), Task 5 (store + reconcile). Steps 1-6 (upload/ingest/submit/poll) → Task 6 (upload) + Task 5 (`_run_ocr` submit/poll). ✓
- §3 split: balance sheet by Mã số (unique codes), KQKD-vs-LCTT by fuzzy label → Task 2 `place_row`. ✓
- Fuzzy/diacritic-insensitive match → Task 1 `normalize_label` + Task 2 `_similarity` + `LABEL_MATCH_THRESHOLD`. ✓
- OCR `section` = hint/tiebreaker only → Task 2 (`_SECTION_HINT` used only when label sub-threshold). ✓
- §4 quarantine unmatched → Task 4 `split_rows` + Task 5 persists `doc.unmatched`. ✓
- §5 period user-entered, applied to all statements; value=curr, prev_value=prev → Task 5 + Task 6. ✓
- §6 status machine queued→submitted→extracting→placing→done|failed + retry-once + fail_reason → Task 5. ✓
- Model fields period/fiscal_year/fail_reason/unmatched → Task 3. ✓
- Route POST /api/documents multipart → Task 6. ✓
- Deterministic tests vs stub VNM fixture (incl. planted 270 + an unknown-code row) → Tasks 4-6. ✓

**Placeholder scan:** No TBD/TODO. Stage-3/4 dependencies are bridged by thin `_ocr_submit/_ocr_poll/_reconcile` seams (Task 5) that are real functions (lazy-import the actual deps) and monkeypatched in tests — a genuine dependency-injection seam, not a placeholder. The planted-270 value flows through as `unverified` (recon shimmed in these tests); the *repair* is asserted in the reconciliation plan's own tests, not duplicated here.

**Type consistency:** OCR row keys (`section/code/metric/curr/prev/page/confidence`) identical across fixtures (Task 4) and consumers (Tasks 2,5). `place_row -> str` kind used by `split_rows` (Task 4). `split_rows -> (grouped, unmatched)` consumed by `ingest_document` (Task 5). `ingest_document -> {status,statements,unmatched}` returned by the route (Task 6). `_to_float` handles `curr/prev` strings. Consistent.

**Note on `_run_ocr` poll loop:** the stub returns a terminal status immediately, so the `while` loop runs once. A real worker returning intermediate statuses would loop; a production hardening (poll timeout/sleep) is deferred to the real-OCR stage (Stage 8) — out of scope here, noted.
