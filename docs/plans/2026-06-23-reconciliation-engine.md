# Reconciliation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic reconciliation engine that verifies OCR-extracted TT200 statement values against accounting identities, auto-repairs single-error groups, and flags ambiguous ones for human review.

**Architecture:** A pure-function rule layer (`recon_rules.py`, operates on plain `{code: value}` dicts — no ORM, fully unit-testable) + a solver/orchestration layer (`recon.py`, iterative fixpoint loop that calls the rule layer, then bridges to the database to persist statuses/flags/corrections) + a correction REST endpoint (`routes/line_items.py`) that re-runs recon after a manual edit. No LLM anywhere in this engine.

**Tech Stack:** Python 3.x, FastAPI, SQLAlchemy 2.x, SQLite, pytest, FastAPI `TestClient`.

## Global Constraints

- Backend root: `Financial analyze/backend` (note the space). All paths below are relative to it; run commands from there.
- Reporting unit is **triệu đồng**; values are floats.
- Constants (exact): `TOLERANCE_REL = 0.01`, `TOLERANCE_ABS = 1.0`, `LOW_CONF_THRESHOLD = 85.0`, `MAX_ITERS = 5`.
- Engine is **deterministic** — no LLM, no network, no randomness.
- Line-item `status` ∈ `unverified | verified | repaired | flagged`. Flag `status` ∈ `open | resolved`. Correction `source` ∈ `backsolve | manual`.
- Existing models live in `app/models/core.py` (`LineItem`, `ReconFlag`, `Correction`) — reuse, do not redefine.
- **v1 scope:** within-statement rules only. Cross-statement rules (`STMT:code`) are listed in data but NOT executed in v1 (see Task 2 note).
- The repo is not yet a git repo. Run `git init` once before starting if you want the commit steps to work.
- Run tests with the backend venv active: `cd "Financial analyze/backend" && pytest`.

## File Structure

- Create `app/services/recon_rules.py` — `RULES` data + pure helpers (`rule_codes`, `evaluate`, `within_tolerance`, `solve`). No ORM, no state.
- Create `app/services/recon.py` — `Item` dataclass, `reconcile()` (pure iterative solver over `Item`s), `reconcile_statement(db, statement_id)` (ORM bridge: load → reconcile → persist statuses/flags/corrections → notify), `notify_user()` stub.
- Create `app/routes/line_items.py` — `PUT /api/line_items/{id}` correction endpoint.
- Modify `app/models/core.py` — add `ReconFlag.reason` column.
- Modify `app/main.py` — register the `line_items` router.
- Create `tests/__init__.py` (if missing), `tests/conftest.py` (in-memory DB + VNM fixture), `tests/fixtures_vnm.py` (the planted VNM data), `tests/test_recon_rules.py`, `tests/test_recon.py`, `tests/test_recon_statement.py`, `tests/test_line_items_route.py`.

---

### Task 1: Rule layer — constants, `rule_codes`, `evaluate`, `within_tolerance`

**Files:**
- Create: `app/services/recon_rules.py`
- Test: `tests/test_recon_rules.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Constants `TOLERANCE_REL=0.01`, `TOLERANCE_ABS=1.0`, `LOW_CONF_THRESHOLD=85.0`, `MAX_ITERS=5`.
  - `RULES: list[dict]` — declarative TT200 identities.
  - `rule_codes(rule: dict) -> list[str]` — every code a rule references.
  - `evaluate(rule: dict, values: dict[str, float]) -> tuple[float, float]` — returns `(expected, got)`. Raises `KeyError` if a referenced code is absent from `values`.
  - `within_tolerance(expected: float, got: float) -> bool`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_recon_rules.py
from app.services import recon_rules as r


def test_sum_rule_evaluate_balanced():
    rule = {"type": "sum", "total": "270", "parts": ["100", "200"]}
    expected, got = r.evaluate(rule, {"270": 52_000_000, "100": 36_500_000, "200": 15_500_000})
    assert expected == 52_000_000  # 100 + 200
    assert got == 52_000_000       # stated 270


def test_sum_rule_with_signs():
    rule = {"type": "sum", "total": "20", "parts": ["10", "11"], "signs": [1, -1]}
    expected, got = r.evaluate(rule, {"20": 24_420_000, "10": 60_479_000, "11": 36_059_000})
    assert expected == 60_479_000 - 36_059_000
    assert got == 24_420_000


def test_equals_rule_evaluate():
    rule = {"type": "equals", "members": ["270", "440"]}
    expected, got = r.evaluate(rule, {"270": 52_000_000, "440": 52_000_000})
    assert expected == got == 52_000_000


def test_rule_codes_sum_and_equals():
    assert set(r.rule_codes({"type": "sum", "total": "270", "parts": ["100", "200"]})) == {"270", "100", "200"}
    assert set(r.rule_codes({"type": "equals", "members": ["270", "440"]})) == {"270", "440"}


def test_within_tolerance_relative():
    assert r.within_tolerance(52_000_000, 52_100_000) is True   # 0.19% <= 1%
    assert r.within_tolerance(52_000_000, 52_800_000) is False  # 1.5% > 1%


def test_within_tolerance_absolute_floor():
    assert r.within_tolerance(0.0, 0.5) is True    # within 1.0 abs floor
    assert r.within_tolerance(0.0, 2.0) is False   # beyond floor, and rel undefined at 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_recon_rules.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.recon_rules` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

```python
# app/services/recon_rules.py
"""Declarative TT200 reconciliation rules + pure helper functions.

Pure: operates on plain {code: value} dicts. No ORM, no state, no I/O.
A "rule" is an accounting identity a correct statement must satisfy.
"""

TOLERANCE_REL = 0.01        # 1%
TOLERANCE_ABS = 1.0         # 1 triệu đồng floor (absorbs sub-million rounding)
LOW_CONF_THRESHOLD = 85.0   # OCR confidence below this is "uncertain"
MAX_ITERS = 5

# v1: within-statement identities. Cross-statement (STMT:code) listed but NOT
# executed in v1 — see reconcile() which filters to within-statement rules.
RULES = [
    {"type": "sum",    "total": "270", "parts": ["100", "200"]},
    {"type": "sum",    "total": "440", "parts": ["300", "400"]},
    {"type": "equals", "members": ["270", "440"]},
    {"type": "sum",    "total": "20",  "parts": ["10", "11"], "signs": [1, -1]},
    {"type": "sum",    "total": "50",  "parts": ["20", "30", "40"]},
]

# Cross-statement rules (deferred — not run in v1):
CROSS_STATEMENT_RULES = [
    {"type": "equals", "members": ["CDKT:110", "LCTT:70"]},
]


def rule_codes(rule: dict) -> list[str]:
    if rule["type"] == "sum":
        return [rule["total"], *rule["parts"]]
    if rule["type"] == "equals":
        return list(rule["members"])
    raise ValueError(f"unknown rule type: {rule['type']}")


def evaluate(rule: dict, values: dict[str, float]) -> tuple[float, float]:
    """Return (expected, got). Raises KeyError if a referenced code is missing."""
    if rule["type"] == "sum":
        signs = rule.get("signs", [1] * len(rule["parts"]))
        expected = sum(values[c] * s for c, s in zip(rule["parts"], signs))
        got = values[rule["total"]]
        return expected, got
    if rule["type"] == "equals":
        a, b = rule["members"]
        return values[a], values[b]
    raise ValueError(f"unknown rule type: {rule['type']}")


def within_tolerance(expected: float, got: float) -> bool:
    diff = abs(expected - got)
    if diff <= TOLERANCE_ABS:
        return True
    if expected == 0:
        return False
    return diff / abs(expected) <= TOLERANCE_REL
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_recon_rules.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/recon_rules.py" "Financial analyze/backend/tests/test_recon_rules.py"
git commit -m "feat(recon): declarative TT200 rules + evaluate/tolerance helpers"
```

---

### Task 2: Rule layer — `solve` (back-solve a single unknown)

**Files:**
- Modify: `app/services/recon_rules.py`
- Test: `tests/test_recon_rules.py`

**Interfaces:**
- Consumes: `RULES`, `evaluate` from Task 1.
- Produces: `solve(rule: dict, target: str, values: dict[str, float]) -> float` — the value `target` must take for the rule to hold exactly, given the other members. `target` must be one of `rule_codes(rule)`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_recon_rules.py

def test_solve_sum_for_total():
    rule = {"type": "sum", "total": "270", "parts": ["100", "200"]}
    # total unknown -> equals sum of parts
    assert r.solve(rule, "270", {"100": 36_500_000, "200": 15_500_000}) == 52_000_000


def test_solve_sum_for_part():
    rule = {"type": "sum", "total": "270", "parts": ["100", "200"]}
    # one part unknown -> total minus the other part
    assert r.solve(rule, "200", {"270": 52_000_000, "100": 36_500_000}) == 15_500_000


def test_solve_sum_for_part_with_signs():
    rule = {"type": "sum", "total": "20", "parts": ["10", "11"], "signs": [1, -1]}
    # 20 = 10 - 11  ->  solve 11 = 10 - 20
    assert r.solve(rule, "11", {"20": 24_420_000, "10": 60_479_000}) == 60_479_000 - 24_420_000


def test_solve_equals():
    rule = {"type": "equals", "members": ["270", "440"]}
    assert r.solve(rule, "270", {"440": 52_000_000}) == 52_000_000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_recon_rules.py -k solve -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'solve'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to app/services/recon_rules.py

def solve(rule: dict, target: str, values: dict[str, float]) -> float:
    """Value `target` must take for `rule` to hold exactly, given other members."""
    if rule["type"] == "sum":
        signs = rule.get("signs", [1] * len(rule["parts"]))
        part_sign = dict(zip(rule["parts"], signs))
        if target == rule["total"]:
            return sum(values[c] * s for c, s in part_sign.items())
        # target is a part: total = Σ parts*signs  ->  isolate target
        others = sum(values[c] * s for c, s in part_sign.items() if c != target)
        # values[total] = others + target*sign_target  ->  target = (total - others)/sign_target
        return (values[rule["total"]] - others) / part_sign[target]
    if rule["type"] == "equals":
        other = [m for m in rule["members"] if m != target][0]
        return values[other]
    raise ValueError(f"unknown rule type: {rule['type']}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_recon_rules.py -v`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/recon_rules.py" "Financial analyze/backend/tests/test_recon_rules.py"
git commit -m "feat(recon): solve() to back-solve a single unknown member"
```

---

### Task 3: Add `reason` column to `ReconFlag`

**Files:**
- Modify: `app/models/core.py` (the `ReconFlag` class, around line 86-95)
- Test: `tests/test_recon_statement.py` (new file — DB round-trip)
- Create: `tests/conftest.py`, `tests/__init__.py` (if missing)

**Interfaces:**
- Consumes: existing `Base`, `ReconFlag`.
- Produces: `ReconFlag.reason` (nullable String) — `"imbalance"` or `"missing_data"`. `tests/conftest.py` exposes a `db` pytest fixture (fresh in-memory SQLite session with all tables created).

- [ ] **Step 1: Write the failing test**

```python
# tests/conftest.py
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.db import Base
from app.models import core  # noqa: F401  (register models on Base)


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

```python
# tests/test_recon_statement.py
from app.models.core import Document, Statement, ReconFlag


def _statement(db):
    doc = Document(path="/x.pdf", kind="BCTC", status="done")
    db.add(doc); db.flush()
    st = Statement(document_id=doc.id, kind="CDKT", period="Q4 2024")
    db.add(st); db.flush()
    return st


def test_recon_flag_has_reason_column(db):
    st = _statement(db)
    flag = ReconFlag(statement_id=st.id, rule="270 = 100 + 200",
                     expected=52_000_000, got=52_800_000, member_ids=[1, 2, 3],
                     status="open", reason="imbalance")
    db.add(flag); db.commit()
    got = db.query(ReconFlag).one()
    assert got.reason == "imbalance"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_recon_statement.py::test_recon_flag_has_reason_column -v`
Expected: FAIL — `TypeError: 'reason' is an invalid keyword argument for ReconFlag`.

- [ ] **Step 3: Write minimal implementation**

In `app/models/core.py`, add one line to `ReconFlag` (after the `status` column, ~line 94):

```python
    reason = Column(String, nullable=True)           # imbalance | missing_data
```

Note: SQLite dev DB is created via `Base.metadata.create_all`. For an existing `helix.db`, delete it and re-run `python -m app.db init` (dev only — no production data). Tests use a fresh in-memory DB so they need no migration.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_recon_statement.py::test_recon_flag_has_reason_column -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/models/core.py" "Financial analyze/backend/tests/conftest.py" "Financial analyze/backend/tests/test_recon_statement.py"
git commit -m "feat(recon): add reason column to recon_flags"
```

---

### Task 4: Pure solver — `reconcile()` verify + back-solve (iterative)

**Files:**
- Create: `app/services/recon.py`
- Create: `tests/fixtures_vnm.py`
- Test: `tests/test_recon.py`

**Interfaces:**
- Consumes: `recon_rules` (`RULES`, `rule_codes`, `evaluate`, `within_tolerance`, `solve`, `LOW_CONF_THRESHOLD`, `MAX_ITERS`).
- Produces:
  - `Item` dataclass: `code: str`, `value: float`, `confidence: float`, `status: str = "unverified"`, `id: int | None = None`.
  - `ReconResult` dataclass: `items: list[Item]`, `corrections: list[dict]`, `flags: list[dict]`.
    - correction dict: `{"code": str, "old": float, "new": float, "source": "backsolve"}`.
    - flag dict: `{"rule": str, "expected": float|None, "got": float|None, "member_codes": list[str], "reason": "imbalance"|"missing_data"}`.
  - `reconcile(items: list[Item], rules=RULES) -> ReconResult` — mutates item statuses, returns result.
  - `rule_label(rule: dict) -> str` — human string e.g. `"270 = 100 + 200"`.
  - `fixtures_vnm.vnm_items() -> list[Item]` — the planted VNM line items.

- [ ] **Step 1: Write the failing test**

```python
# tests/fixtures_vnm.py
from app.services.recon import Item

def vnm_items():
    """Planted VNM fixture (triệu đồng). Mã số 270 misread 52.8M (true 52.0M) @ conf 73."""
    return [
        Item(code="100", value=36_500_000, confidence=94, id=1),
        Item(code="200", value=15_500_000, confidence=93, id=2),
        Item(code="270", value=52_800_000, confidence=73, id=3),   # planted error
        Item(code="300", value=17_000_000, confidence=95, id=4),
        Item(code="400", value=35_000_000, confidence=96, id=5),
        Item(code="440", value=52_000_000, confidence=95, id=6),
    ]
```

```python
# tests/test_recon.py
from app.services.recon import Item, reconcile
from tests.fixtures_vnm import vnm_items


def test_backsolve_repairs_single_low_conf_total():
    res = reconcile(vnm_items())
    by_code = {i.code: i for i in res.items}
    # 270 was the only low-conf member of 270=100+200 -> repaired to 52,000,000
    assert by_code["270"].value == 52_000_000
    assert by_code["270"].status == "repaired"
    assert any(c["code"] == "270" and c["new"] == 52_000_000 and c["source"] == "backsolve"
               for c in res.corrections)


def test_balanced_group_marks_verified():
    res = reconcile(vnm_items())
    by_code = {i.code: i for i in res.items}
    # 440 = 300 + 400 balanced from the start
    assert by_code["440"].status == "verified"
    assert by_code["300"].status == "verified"


def test_no_flags_when_all_resolve():
    res = reconcile(vnm_items())
    assert res.flags == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_recon.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.recon`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/services/recon.py
"""Reconciliation engine — deterministic, no LLM.

Pure solver `reconcile()` runs the iterative fixpoint loop over Items; the ORM
bridge `reconcile_statement()` (Task 6) loads/persists. Rule layer = recon_rules.
"""
from dataclasses import dataclass, field

from . import recon_rules as rr


@dataclass
class Item:
    code: str
    value: float
    confidence: float
    status: str = "unverified"
    id: int | None = None


@dataclass
class ReconResult:
    items: list[Item]
    corrections: list[dict] = field(default_factory=list)
    flags: list[dict] = field(default_factory=list)


def rule_label(rule: dict) -> str:
    if rule["type"] == "sum":
        signs = rule.get("signs", [1] * len(rule["parts"]))
        terms = []
        for c, s in zip(rule["parts"], signs):
            terms.append(("- " if s < 0 else ("+ " if terms else "")) + c)
        return f"{rule['total']} = " + " ".join(terms)
    if rule["type"] == "equals":
        return " = ".join(rule["members"])
    return str(rule)


def _values(by_code: dict[str, Item]) -> dict[str, float]:
    return {c: it.value for c, it in by_code.items()}


def reconcile(items: list[Item], rules=rr.RULES) -> ReconResult:
    by_code = {it.code: it for it in items}
    result = ReconResult(items=items)

    for _ in range(rr.MAX_ITERS):
        changed = False
        for rule in rules:
            codes = rr.rule_codes(rule)
            if any(c not in by_code for c in codes):
                continue  # missing member: handled in post-loop pass
            expected, got = rr.evaluate(rule, _values(by_code))
            if rr.within_tolerance(expected, got):
                for c in codes:
                    if by_code[c].status == "unverified":
                        by_code[c].status = "verified"
                continue
            # rule fails — try a unique low-confidence suspect
            suspects = [c for c in codes if by_code[c].confidence < rr.LOW_CONF_THRESHOLD]
            if len(suspects) == 1:
                target = suspects[0]
                new_val = rr.solve(rule, target, _values(by_code))
                old_val = by_code[target].value
                by_code[target].value = new_val
                by_code[target].status = "repaired"
                result.corrections.append(
                    {"code": target, "old": old_val, "new": new_val, "source": "backsolve"})
                changed = True
        if not changed:
            break

    _flag_unresolved(by_code, result, rules)
    return result


def _flag_unresolved(by_code: dict[str, Item], result: ReconResult, rules) -> None:
    for rule in rules:
        codes = rr.rule_codes(rule)
        label = rule_label(rule)
        if any(c not in by_code for c in codes):
            result.flags.append({"rule": label, "expected": None, "got": None,
                                  "member_codes": codes, "reason": "missing_data"})
            continue
        expected, got = rr.evaluate(rule, _values(by_code))
        if not rr.within_tolerance(expected, got):
            for c in codes:
                if by_code[c].confidence < rr.LOW_CONF_THRESHOLD:
                    by_code[c].status = "flagged"
            result.flags.append({"rule": label, "expected": expected, "got": got,
                                 "member_codes": codes, "reason": "imbalance"})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_recon.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/recon.py" "Financial analyze/backend/tests/fixtures_vnm.py" "Financial analyze/backend/tests/test_recon.py"
git commit -m "feat(recon): iterative reconcile() with back-solve and verify"
```

---

### Task 5: Pure solver — flagging ambiguous groups (≥2 low-conf)

**Files:**
- Test: `tests/test_recon.py` (extend)
- (No new code expected — `_flag_unresolved` from Task 4 should cover it. This task proves the flag path with a fixture and fixes any gap.)

**Interfaces:**
- Consumes: `reconcile`, `Item` from Task 4.
- Produces: `fixtures_vnm.vnm_cashflow_items()` — a 3-line LCTT group with two low-conf members.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/fixtures_vnm.py
def vnm_cashflow_items():
    """LCTT group 50 = 20 + 30 + 40 with two low-conf members -> ambiguous -> flag."""
    return [
        Item(code="20", value=11_200_000, confidence=71, id=11),  # low
        Item(code="30", value=-1_800_000, confidence=68, id=12),  # low
        Item(code="40", value=0,          confidence=90, id=13),
        Item(code="50", value=9_400_000,  confidence=95, id=14),  # 11.2 - 1.8 + 0 = 9.4 -> actually balances!
    ]
```

```python
# append to tests/test_recon.py
from tests.fixtures_vnm import vnm_cashflow_items
from app.services.recon import reconcile, Item


def test_two_low_conf_failing_group_is_flagged():
    # Force an imbalance with two low-conf members so no unique suspect exists.
    items = [
        Item(code="20", value=11_200_000, confidence=71, id=11),
        Item(code="30", value=-1_800_000, confidence=68, id=12),
        Item(code="40", value=0,          confidence=90, id=13),
        Item(code="50", value=9_999_000,  confidence=95, id=14),  # != 9,400,000 -> fails
    ]
    res = reconcile(items)
    assert any(f["reason"] == "imbalance" and "50" in f["rule"] for f in res.flags)
    by_code = {i.code: i for i in res.items}
    assert by_code["20"].status == "flagged"
    assert by_code["30"].status == "flagged"


def test_missing_member_flags_gap():
    items = [Item(code="270", value=52_000_000, confidence=99, id=1)]  # 100, 200 absent
    res = reconcile(items)
    assert any(f["reason"] == "missing_data" for f in res.flags)
```

- [ ] **Step 2: Run test to verify it fails (or passes immediately)**

Run: `pytest tests/test_recon.py -k "flagged or gap" -v`
Expected: PASS if Task 4 logic is correct. If FAIL, fix `_flag_unresolved` in `recon.py` so that (a) a failing group with ≠1 low-conf suspect produces an `imbalance` flag and marks low-conf members `flagged`, and (b) a rule with any missing member produces a `missing_data` flag.

- [ ] **Step 3: Implementation (only if Step 2 failed)**

No change expected. If needed, reconcile the discrepancy between test and `_flag_unresolved` — do not weaken the test.

- [ ] **Step 4: Run full pure-solver tests**

Run: `pytest tests/test_recon.py tests/test_recon_rules.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/tests/fixtures_vnm.py" "Financial analyze/backend/tests/test_recon.py"
git commit -m "test(recon): cover ambiguous-flag and missing-data-gap paths"
```

---

### Task 6: ORM bridge — `reconcile_statement(db, statement_id)`

**Files:**
- Modify: `app/services/recon.py`
- Test: `tests/test_recon_statement.py` (extend)

**Interfaces:**
- Consumes: `Item`, `reconcile`, `ReconResult` (Task 4); `LineItem`, `ReconFlag`, `Correction` models; `recon_rules`.
- Produces:
  - `notify_user(statement_id: int, open_flag_count: int) -> None` — stub (prints/logs now; dashboard reads flags via API; Slack later).
  - `reconcile_statement(db, statement_id: int) -> dict` — loads the statement's `LineItem`s, runs `reconcile`, persists new `value`/`status` on line items, inserts `Correction` rows (source=backsolve), replaces this statement's `ReconFlag`s with the new open flags, calls `notify_user` if any open flags, returns `{"repaired": int, "flagged": int, "open_flags": int}`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_recon_statement.py
from app.models.core import LineItem, Correction
from app.services.recon import reconcile_statement


def _seed_vnm(db, st):
    rows = [
        ("100", 36_500_000, 94), ("200", 15_500_000, 93), ("270", 52_800_000, 73),
        ("300", 17_000_000, 95), ("400", 35_000_000, 96), ("440", 52_000_000, 95),
    ]
    for code, val, conf in rows:
        db.add(LineItem(statement_id=st.id, code=code, value=val, confidence=conf, status="unverified"))
    db.commit()


def test_reconcile_statement_repairs_and_persists(db):
    st = _statement(db)
    _seed_vnm(db, st)

    summary = reconcile_statement(db, st.id)

    li_270 = db.query(LineItem).filter_by(statement_id=st.id, code="270").one()
    assert li_270.value == 52_000_000
    assert li_270.status == "repaired"
    assert summary["repaired"] == 1
    assert summary["open_flags"] == 0
    # a backsolve correction was logged for 270
    corr = db.query(Correction).filter_by(line_item_id=li_270.id).one()
    assert corr.old_value == 52_800_000 and corr.new_value == 52_000_000 and corr.source == "backsolve"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_recon_statement.py::test_reconcile_statement_repairs_and_persists -v`
Expected: FAIL — `ImportError: cannot import name 'reconcile_statement'`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to app/services/recon.py
from ..models.core import LineItem, ReconFlag, Correction


def notify_user(statement_id: int, open_flag_count: int) -> None:
    """v1 stub: dashboard reads flags via the statement API; Slack/push later."""
    if open_flag_count:
        print(f"⚠ statement {statement_id}: {open_flag_count} chỉ tiêu cần xử lý")


def reconcile_statement(db, statement_id: int) -> dict:
    rows = db.query(LineItem).filter(LineItem.statement_id == statement_id).all()
    items = [Item(code=r.code, value=r.value, confidence=r.confidence or 100.0,
                  status=r.status, id=r.id) for r in rows]
    by_id = {r.id: r for r in rows}

    result = reconcile(items)

    # persist value/status + log backsolve corrections
    repaired = flagged = 0
    code_to_item = {it.code: it for it in result.items}
    for it in result.items:
        row = by_id[it.id]
        if it.status == "repaired":
            db.add(Correction(line_item_id=row.id, old_value=row.value,
                              new_value=it.value, source="backsolve"))
            repaired += 1
        if it.status == "flagged":
            flagged += 1
        row.value = it.value
        row.status = it.status

    # replace this statement's flags with the new set
    db.query(ReconFlag).filter(ReconFlag.statement_id == statement_id).delete()
    for f in result.flags:
        member_ids = [code_to_item[c].id for c in f["member_codes"] if c in code_to_item]
        db.add(ReconFlag(statement_id=statement_id, rule=f["rule"],
                         expected=f["expected"], got=f["got"], member_ids=member_ids,
                         status="open", reason=f["reason"]))
    db.commit()

    open_flags = len(result.flags)
    notify_user(statement_id, open_flags)
    return {"repaired": repaired, "flagged": flagged, "open_flags": open_flags}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_recon_statement.py -v`
Expected: PASS (column test from Task 3 + this one).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/services/recon.py" "Financial analyze/backend/tests/test_recon_statement.py"
git commit -m "feat(recon): reconcile_statement ORM bridge persists statuses/flags/corrections"
```

---

### Task 7: Correction endpoint — `PUT /api/line_items/{id}`

**Files:**
- Create: `app/routes/line_items.py`
- Modify: `app/main.py` (register router)
- Test: `tests/test_line_items_route.py`

**Interfaces:**
- Consumes: `reconcile_statement` (Task 6); `get_db` from `app.db`; `LineItem`, `ReconFlag` models.
- Produces: `PUT /api/line_items/{id}` body `{"value": <float>}` → writes a `Correction(source="manual")`, sets the line item value, re-runs `reconcile_statement` for its statement, returns `{"line_item": {"id", "code", "value", "status"}, "summary": {...}, "flags": [{"id","rule","status","reason"}]}`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_line_items_route.py
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.db import Base, get_db
from app.models import core  # noqa: F401
from app.models.core import Document, Statement, LineItem


@pytest.fixture
def client():
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
    # seed a flagged statement: two low-conf members make 50=20+30+40 fail
    s = Session()
    doc = Document(path="/x.pdf", kind="BCTC", status="done"); s.add(doc); s.flush()
    st = Statement(document_id=doc.id, kind="LCTT", period="Q4 2024"); s.add(st); s.flush()
    for code, val, conf in [("20", 11_200_000, 71), ("30", -1_800_000, 68),
                            ("40", 0, 90), ("50", 9_999_000, 95)]:
        s.add(LineItem(statement_id=st.id, code=code, value=val, confidence=conf, status="unverified"))
    s.commit()
    target = s.query(LineItem).filter_by(statement_id=st.id, code="50").one()
    s.close()
    yield client_with_target(TestClient(app), target.id)
    app.dependency_overrides.clear()


def client_with_target(tc, target_id):
    tc.target_id = target_id
    return tc


def test_manual_correction_reruns_recon_and_resolves(client):
    # set 50 to the balancing value 9,400,000 (= 11.2 - 1.8 + 0)
    resp = client.put(f"/api/line_items/{client.target_id}", json={"value": 9_400_000})
    assert resp.status_code == 200
    body = resp.json()
    assert body["line_item"]["value"] == 9_400_000
    # group now balances -> no open imbalance flags
    assert all(f["status"] == "resolved" or f["reason"] != "imbalance" for f in body["flags"]) or body["summary"]["open_flags"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_line_items_route.py -v`
Expected: FAIL — 404 (route not registered) or import error for the router.

- [ ] **Step 3: Write minimal implementation**

```python
# app/routes/line_items.py
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.core import LineItem, ReconFlag, Correction
from ..services.recon import reconcile_statement

router = APIRouter()


class CorrectionIn(BaseModel):
    value: float


@router.put("/line_items/{item_id}")
def correct_line_item(item_id: int, body: CorrectionIn, db: Session = Depends(get_db)):
    row = db.query(LineItem).filter(LineItem.id == item_id).first()
    if not row:
        raise HTTPException(404, "line item not found")

    db.add(Correction(line_item_id=row.id, old_value=row.value,
                      new_value=body.value, source="manual"))
    row.value = body.value
    db.commit()

    summary = reconcile_statement(db, row.statement_id)

    db.refresh(row)
    flags = db.query(ReconFlag).filter(ReconFlag.statement_id == row.statement_id).all()
    return {
        "line_item": {"id": row.id, "code": row.code, "value": row.value, "status": row.status},
        "summary": summary,
        "flags": [{"id": f.id, "rule": f.rule, "status": f.status, "reason": f.reason} for f in flags],
    }
```

In `app/main.py`, add the import and register the router (alongside the existing `market` router):

```python
from .routes import market, line_items
# ... after app creation / other includes:
app.include_router(line_items.router, prefix="/api", tags=["line_items"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_line_items_route.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pytest -v`
Expected: PASS (all recon tests).

- [ ] **Step 6: Commit**

```bash
git add "Financial analyze/backend/app/routes/line_items.py" "Financial analyze/backend/app/main.py" "Financial analyze/backend/tests/test_line_items_route.py"
git commit -m "feat(recon): PUT /api/line_items/{id} manual correction + re-reconcile"
```

---

## Self-Review

**Spec coverage:**
- Declarative TT200 rules → Task 1 (`RULES`, helpers), Task 2 (`solve`). ✓
- Iterative solver (max 5 iters, fixpoint) → Task 4 `reconcile()`. ✓
- Auto-repair single low-conf suspect + log correction → Task 4 + Task 6 (Correction persistence). ✓
- Suspect = low-conf member; unique → solve, else flag → Task 4 (`suspects` list), Task 5 (tests). ✓
- Relative% + absolute floor tolerance → Task 1 `within_tolerance`. ✓
- Flag ambiguous (≥2 low-conf) + mark members flagged → Task 4 `_flag_unresolved`, Task 5 tests. ✓
- Missing data → flag the gap → Task 4 `_flag_unresolved` (missing member), Task 5 test. ✓
- Statuses verified/repaired/flagged/unchecked → Task 4 (verified/repaired/flagged set). Note: `unchecked` = items left `unverified` when no rule touches them; no separate code needed (default stays). ✓
- recon_flags.reason column → Task 3. ✓
- Human-in-the-loop: PUT correction re-runs recon, resolves flags → Task 7. ✓
- Notify on open flags → Task 6 `notify_user` (stub; dashboard via API). ✓
- Deterministic, no LLM → no LLM imports anywhere. ✓
- Test against planted VNM fixture → Task 4/6 use it. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. Task 5 Step 3 is explicitly conditional ("only if Step 2 failed") with concrete guidance, not a placeholder.

**Type consistency:** `Item(code,value,confidence,status,id)` used identically in Tasks 4-7. `reconcile()→ReconResult`, `reconcile_statement()→dict {repaired,flagged,open_flags}`, correction dict keys `code/old/new/source`, flag dict keys `rule/expected/got/member_codes/reason` — consistent across tasks. `notify_user(statement_id, open_flag_count)` matches its call in `reconcile_statement`.

**Note on cross-statement rules:** `CROSS_STATEMENT_RULES` is defined but `reconcile()` runs only `RULES` (within-statement). Cross-statement reconciliation is explicitly v1-deferred (matches spec "out of scope").

**Decision — `unchecked` status:** the spec lists `unchecked` as a distinct status, but v1 leaves uncovered items as their incoming `unverified`. This is intentional simplification; if a true `unchecked` label is wanted later it's a one-line post-pass. Flagged as a known minor deviation.
