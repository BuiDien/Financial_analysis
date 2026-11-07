# Company History from OCR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn verified OCR reviews into one deduplicated, source-linked history per company and show it as owner-chosen charts in the Financial Statements page.

**Architecture:** Pure functions (period/unit parsing, table extraction, fact keying, derivation) under `backend/app/services/history_*.py`; an Obsidian-backed line catalogue with stable ids; a thin ORM bridge + FastAPI routes; the frontend adds an "Add to history" wizard on the OCR review screen and a live mode to `src/page-statements.jsx`, built from ported Lucian UX/UI elements.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy / SQLite / pytest; React via Babel standalone (`src/*.jsx`, no build step); Lucian UX/UI CLI (`node /Users/dien/.claude/plugins/cache/lucian-uxui/lucian-uxui/1.2.0/skills/lucian-uxui/scripts/lucian-uxui.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-06-company-history-design.md`

## Global Constraints

- Fully local; no network calls at runtime; no new services or Python dependencies.
- **Never `git commit`/`git push`** (project CLAUDE.md). Each task ends with a checkpoint that lists changed files.
- Values stored as integers in đồng; the original cell text and unit kept as provenance.
- Code never picks between disagreeing values, never guesses a period or unit, never plots a YTD value as a quarter, never plots a number from an unverified page.
- Only pages passing the subtotal gate (spec §6.5) contribute facts.
- Schema changes go through `backend/app/db.py` `_upgrade_legacy_ocr_schema()` (add-column) plus `Base.metadata.create_all` (new tables). No Alembic.
- Pure logic never touches the DB (CORE_DESIGN "pure core + thin ORM bridge").
- Lucian ports: keep each element's `<!-- Lucian UX/UI Prompt #ID · MIT License … -->` line, structure, sizes and motion; adapt data and colours only; map `--ux-*` tokens onto the app's CSS variables for light and dark (`references/porting.md`). Charts: one axis per chart, fixed series colour per line (never re-coloured when lines are added/removed), direct labels for ≤ 4 lines, hover tooltips, table view.
- Backend tests: `cd Financial_analyze/backend && .venv/bin/python -m pytest -q`. JSX check: Babel transform of each edited `.jsx` (command in Task 8).

## Review Focus

1. **Multi-row table headers** (OCR HTML with `rowspan`, header split over two rows, e.g. MBB cash-flow p7) — periods must land on the right value columns. Test in Task 3 with the real p7 fixture.
2. **"-" versus blank cells** — "-" is a printed zero (a fact with value 0); a blank cell is no fact. Test in Task 3.
3. **The same PDF uploaded twice** (duplicate upload is allowed) — two inbox items printing identical numbers must plot one point marked "2 sources agree", not two. Test in Task 5.
4. **OCR page corrected after a conflict was resolved** — re-running "Add to history" changes the chosen source's value; the conflict must re-open. Test in Task 6.
5. **Comparison columns of another year** (Q3 2026 statement printing 31/12/2025) — must be accepted as facts and not trip the period check, which only requires one value column to end at the label's end date. Test in Task 2.

---

### Task 1: Data model and upload labels

**Files:**
- Modify: `Financial_analyze/backend/app/models/ocr.py` (add 3 columns to `OCRInboxItem`; add `StatementFact`, `FactResolution`)
- Modify: `Financial_analyze/backend/app/db.py` (`_upgrade_legacy_ocr_schema` additions for `ocr_inbox_items`)
- Modify: `Financial_analyze/backend/app/routes/ocr_inbox.py` (`LabelsIn`, `update_labels`, `_serialize_item`)
- Test: `Financial_analyze/backend/tests/test_history_models.py`, `Financial_analyze/backend/tests/test_ocr_inbox.py`

**Interfaces:**
- Produces:
  - `OCRInboxItem.scope: str|None` (`"consolidated"|"separate"`), `.fiscal_year: int|None`, `.period_code: str|None` (`Q1|Q2|Q3|Q4|H1|FY`).
  - `StatementFact` (table `statement_facts`): `id, inbox_item_id (FK ocr_inbox_items, CASCADE), review_id, review_revision, ticker, scope, statement_kind ("balance"|"income"|"cashflow"), line_key, fact_key (index), period_type ("instant"|"quarter"|"ytd"|"year"), period_start (Date, null), period_end (Date), value (BigInteger), origin ("printed"|"calculated"), page_number, table_number, row_number, column_number (all nullable for calculated), row_label, raw_text, raw_unit, inputs (JSON), status ("active"|"superseded", index), created_at`.
  - `FactResolution` (table `fact_resolutions`): `id, ticker, scope, statement_kind, fact_key, chosen_fact_id (FK statement_facts), chosen_value (BigInteger), note, resolved_at`; unique `(ticker, scope, statement_kind, fact_key)`.
  - `LabelsIn` gains optional `scope`, `fiscal_year` (2000–2100), `period_code`; `_serialize_item(...)["labels"]` includes them.

- [ ] **Step 1: Write failing tests.** `test_history_models.py::test_fact_and_resolution_round_trip` (uses `conftest.db`: insert an item, a fact with `value=1_837_857_452_000_000`, a resolution; read back equal; second resolution with the same key raises `IntegrityError`). In `test_ocr_inbox.py`: `test_labels_accept_scope_year_period` (PATCH with `scope="consolidated", fiscal_year=2026, period_code="Q3"` → 200 and echoed); `test_labels_reject_bad_period_code` (`period_code="Q5"` → 422; `scope="group"` → 422).
- [ ] **Step 2: Run** `.venv/bin/python -m pytest -q tests/test_history_models.py tests/test_ocr_inbox.py` — expect the new tests to fail.
- [ ] **Step 3: Implement** the columns, models, upgrade entries (`"scope": "VARCHAR(16)", "fiscal_year": "INTEGER", "period_code": "VARCHAR(4)"`) and `LabelsIn` validation (`Literal` types).
- [ ] **Step 4: Run** the full backend suite — all pass.
- [ ] **Step 5: Checkpoint** — list changed files. Do not commit.

### Task 2: Periods, units, statement kinds (pure)

**Files:**
- Create: `Financial_analyze/backend/app/services/history_periods.py`
- Test: `Financial_analyze/backend/tests/test_history_periods.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Period: type: str; start: date|None; end: date`
  - `parse_column_period(header: str) -> Period|None`
  - `parse_unit_multiplier(text: str) -> int|None`
  - `detect_statement_kind(text: str) -> str|None` (`"balance"|"income"|"cashflow"`)
  - `label_period(fiscal_year: int, period_code: str) -> tuple[date, date]`
  - `columns_cover_label(periods: list[Period], fiscal_year: int, period_code: str) -> bool`

- [ ] **Step 1: Write failing tests** (`test_history_periods.py`):
  - `parse_column_period("30/09/2026") == Period("instant", None, date(2026,9,30))`; also `"Tại ngày 31/12/2025"`.
  - `"Giai đoạn từ 01/07/2026 đến 30/09/2026"` → `quarter 2026-07-01..2026-09-30`; `"Giai đoạn từ 01/01/2026 đến 30/09/2026"` → `ytd`; `"từ 01/01/2025 đến 31/12/2025"` → `year`; `"Quý 3 năm 2026"` → `quarter 2026-07-01..2026-09-30`.
  - `None` for `"Thuyết minh"`, `"Mã số"`, `"Số cuối kỳ"`, `""`.
  - Units: `"triệu đồng"`→`1_000_000`, `"Đơn vị: triệu VND"`→`1_000_000`, `"đồng"`→`1`, `"nghìn đồng"`→`1_000`, `"tỷ đồng"`→`1_000_000_000`, `"VND"`→`1`, unknown → `None`.
  - Kinds: `"BÁO CÁO TÌNH HÌNH TÀI CHÍNH HỢP NHẤT"`/`"BẢNG CÂN ĐỐI KẾ TOÁN"`→`balance`; `"BÁO CÁO KẾT QUẢ HOẠT ĐỘNG KINH DOANH"`→`income`; `"BÁO CÁO LƯU CHUYỂN TIỀN TỆ"`→`cashflow`; match also on the accent-free normalized form (OCR drops accents: `"LUU CHUYEN TIEN TE"`).
  - `label_period(2026,"Q3") == (date(2026,7,1), date(2026,9,30))`; `H1` → Jan 1–Jun 30; `FY` → Jan 1–Dec 31.
  - **Review Focus 5:** `columns_cover_label([instant 2026-09-30, instant 2025-12-31], 2026, "Q3") is True`; `[instant 2025-12-31]` with `(2026,"Q3")` is `False`.
- [ ] **Step 2: Run** `.venv/bin/python -m pytest -q tests/test_history_periods.py` — fail.
- [ ] **Step 3: Implement.** Match on text normalized with `ocr_label_library.normalize_label` where accents vary. 3-month span → `quarter`; starts 01/01 and 4–11 months → `ytd`; 12 months → `year`. `columns_cover_label` is true when any period's `end` equals the label end date.
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Checkpoint.**

### Task 3: Table extraction from page Markdown (pure)

**Files:**
- Create: `Financial_analyze/backend/app/services/history_extract.py`
- Create: `Financial_analyze/backend/tests/fixtures/history/mbb_q3_2026_p03.md`, `mbb_q3_2026_p07.md`, plus the income-statement page (first page of attempt 25 whose text matches `detect_statement_kind == "income"`), exported from `backend/helix.db` attempt 25 `raw_markdown`
- Test: `Financial_analyze/backend/tests/test_history_extract.py`

**Interfaces:**
- Consumes: `parse_column_period`, `parse_unit_multiplier`, `detect_statement_kind` (Task 2); `ocr_label_levels.parse_financial_number`, the level hierarchy used by `verify_level_totals`.
- Produces:
  - `@dataclass class ExtractedRow: row: int; label: str; parent_label: str|None; code: str|None; cells: list[str]; is_amount: bool`
  - `@dataclass class ExtractedColumn: column: int; header: str; period: Period|None`
  - `@dataclass class ExtractedTable: page: int; table: int; kind: str|None; columns: list[ExtractedColumn]; unit_multiplier: int|None; rows: list[ExtractedRow]`
  - `extract_tables(page: int, markdown: str, previous_kind: str|None) -> list[ExtractedTable]`
  - `cell_value(text: str, multiplier: int) -> int|None` (`"-"`→`0`; blank→`None`; `"(352.741)"`×10⁶ → `-352_741_000_000`; non-integer after scaling → `None`)
  - `is_amount_row(label: str) -> bool`

- [ ] **Step 1: Write failing tests:**
  - `test_balance_sheet_page_columns` (p03 fixture): one table, `kind == "balance"`, two value columns with `Period("instant", None, 2026-09-30)` and `2025-12-31`; "Thuyết minh" not a value column; row "Bất động sản đầu tư" has `parent_label` None-or-section and its children "Nguyên giá…" have `parent_label == "Bắt động sản đầu tư"` (OCR spelling kept).
  - **Review Focus 1:** `test_cash_flow_page_multi_row_header` (p07 fixture): value columns map to the two "Giai đoạn từ…" periods despite the two-row header with `rowspan`.
  - **Review Focus 2:** `test_dash_is_zero_blank_is_none`: `cell_value("-", 10**6) == 0`, `cell_value("", 10**6) is None`, `cell_value("(352.741)", 10**6) == -352_741_000_000`.
  - `test_non_amount_rows_skipped`: `is_amount_row` false for `"Lãi cơ bản trên cổ phiếu"`, `"EPS"`, `"Tỷ lệ an toàn vốn (%)"`, `"Số lượng cổ phiếu"`; true for `"Cho vay khách hàng"`.
  - `test_continued_table_inherits_kind`: page text with `"(tiếp theo)"` and no kind heading → `kind == previous_kind`.
  - `test_mã_số_column_detected`: a Markdown table with header `| Chỉ tiêu | Mã số | 31/12/2025 |` → `rows[i].code == "270"` and `Mã số` is not a value column.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** Header rows = the consecutive top rows where no value cell parses as a number; a column's header text = its header-row cells joined with a space (expand `colspan`/`rowspan`). Unit: search table header then page text for a unit phrase. Kind: page heading text, else `previous_kind` when "tiếp theo" appears. Parent label: nearest preceding row of lower level from the existing level inference.
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Checkpoint.**

### Task 4: Line catalogue with stable ids (Obsidian-backed)

**Files:**
- Create: `Financial_analyze/backend/app/services/history_lines.py`
- Modify: `Financial_analyze/backend/app/config.py` (`obsidian_line_catalog_path: str = "Financial Analyze/Line Catalog"`)
- Test: `Financial_analyze/backend/tests/test_history_lines.py`

**Interfaces:**
- Consumes: `ocr_label_library.normalize_label`.
- Produces:
  - `@dataclass class Line: key: str; name: str; parent_key: str|None; aliases: list[str]`
  - `@dataclass class LineMatch: key: str|None; suggestions: list[tuple[str, str, float]]` (key, name, score 0–1, best first, max 5)
  - `class LineCatalog(vault_path: str|Path, relative_path: str)` with `lines(ticker, scope, kind) -> list[Line]`, `match(ticker, scope, kind, label, parent_label, code) -> LineMatch`, `add_line(ticker, scope, kind, name, parent_key, aliases) -> str`, `add_alias(ticker, scope, kind, key, alias) -> None`, `get(ticker, scope, kind, key) -> Line|None`
  - Alias strings: `f"code:{code}"`, `f"label:{normalize_label(parent_label or '')}>{normalize_label(label)}"`. Keys: `"ln_" + uuid4().hex[:12]`.
  - `get_line_catalog(vault_path, relative_path) -> LineCatalog` (cached per path, like `get_label_library`).

- [ ] **Step 1: Write failing tests** (`tmp_path` vault):
  - `test_new_line_then_match_by_label`: `add_line("MBB","consolidated","balance","Tổng tài sản có",None,[alias for "TỔNG TÀI SẢN CÓ"])`; `match(..., "TONG TÀI SAN CÓ", None, None).key` equals it (accent-free match).
  - `test_code_alias_wins_over_label`.
  - `test_same_label_different_parent_is_unknown`: "Dự phòng rủi ro" under "Cho vay khách hàng" known; under "Chứng khoán đầu tư" → `key is None`, suggestion list contains the first.
  - `test_persists_to_obsidian_and_reloads`: new `LineCatalog` on the same vault sees the line; the note path is `<vault>/Financial Analyze/Line Catalog/MBB-consolidated-balance.md` with YAML front matter listing lines.
  - `test_scopes_are_separate`: a consolidated line is not matched under `separate`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement** following `ObsidianLabelLibrary`'s note read/write and in-memory index pattern (thread lock, refresh on mtime). Suggestions ranked by `difflib.SequenceMatcher` ratio on normalized names.
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Checkpoint.**

### Task 5: Fact keys, point states, derived quarters (pure)

**Files:**
- Create: `Financial_analyze/backend/app/services/history_facts.py`
- Test: `Financial_analyze/backend/tests/test_history_facts.py`

**Interfaces:**
- Consumes: `Period` (Task 2).
- Produces (facts here are plain dicts with keys `id, line_key, period_type, period_start, period_end, value, origin, inbox_item_id, status`):
  - `fact_key(line_key: str, period: Period) -> str` = `f"{line_key}|{type}|{start or ''}|{end}"`
  - `@dataclass class PointState: fact_key: str; value: int|None; status: str; origin: str; source_ids: list[int]` with `status ∈ {"single","agree","resolved","conflict"}`
  - `point_states(facts: list[dict], resolutions: dict[str, dict]) -> dict[str, PointState]` (only `status == "active"` facts; resolution dict has `chosen_fact_id`, `chosen_value`)
  - `derive_missing_quarters(facts: list[dict]) -> list[dict]` (one line; returns new dicts with `origin="calculated"`, `inputs=[ids]`, `id=None`)

- [ ] **Step 1: Write failing tests:**
  - `test_single_and_agree`: one source → `single`; two sources same value → `agree`, `value` set, two `source_ids`.
  - **Review Focus 3:** `test_duplicate_upload_is_one_point`: facts from inbox items 1 and 2 with identical key and value → exactly one `PointState`, `status == "agree"`.
  - `test_conflict_has_no_value`: two values → `status "conflict"`, `value is None`.
  - `test_resolution_applies_only_while_source_unchanged`: resolution pointing at fact 7 with `chosen_value` 5 → `resolved`; same resolution but fact 7 now 6 (or superseded) → `conflict`.
  - `test_derive_q4_from_year_minus_9m_ytd`: year 2025 = 100, ytd Jan–Sep 2025 = 70 → calculated quarter Oct–Dec 2025 = 30, `inputs` = both ids.
  - `test_derive_q2_q3`: Q1 = 10, ytd H1 = 25, ytd 9M = 45 → Q2 = 15, Q3 = 20.
  - `test_printed_quarter_not_overridden`: printed Q4 = 31 and derivable 30 → no derived fact returned for that key (the caller adds it as a conflicting source; see Task 6).
  - `test_balance_instants_never_derived`: only `instant` facts → `[]`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** Derivation only from `printed` facts of the same year; returns derived facts for a missing key, and for a key that has a printed value returns a derived fact flagged `conflicts_with_printed=True` only when values differ (so Task 6 stores it as a second source and the point becomes a conflict).
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Checkpoint.**

### Task 6: "Add to history" — preview, write, remove (ORM bridge + routes)

**Files:**
- Create: `Financial_analyze/backend/app/services/history_store.py`
- Create: `Financial_analyze/backend/app/routes/history.py` (router prefix `/history`; registered in `main.py` with `prefix="/api"`); preview/write live under `ocr_inbox.router` in `routes/ocr_inbox.py`
- Modify: `Financial_analyze/backend/app/routes/ocr_inbox.py` (`update_labels`: 409 `"Remove this document from history first"` when the item has active facts)
- Test: `Financial_analyze/backend/tests/test_history_store.py`, `Financial_analyze/backend/tests/test_history_routes.py`

**Interfaces:**
- Consumes: Tasks 1–5; `ocr_total_checks.page_total_check`; `get_line_catalog`.
- Produces:
  - `history_preview(db, review: OCRReviewJob, answers: dict) -> dict` and `history_write(db, review, answers) -> dict` (`{"written": int, "superseded": int, "conflicts_open": int}`), `history_remove(db, item: OCRInboxItem) -> int`.
  - `POST /api/ocr-inbox/reviews/{id}/history-preview` body `HistoryAnswersIn`; `POST /api/ocr-inbox/reviews/{id}/history` same body (409 when `blocking` non-empty or revision stale); `DELETE /api/ocr-inbox/{item_id}/history`; `POST /api/history/{ticker}/{scope}/resolutions` body `{statement_kind, fact_key, chosen_fact_id}`.
  - `HistoryAnswersIn`: `revision: int`; `tables: list[{page, table, kind|"skip", unit_multiplier, columns: list[{column, period_type, period_start, period_end} | {column, skip: true}]}]`; `lines: list[{page, table, row, line_key | new_line_name}]`; `accepted_misreads: list[{page, content_sha256, table, parent_row, column_label}]`; `resolutions: list[{fact_key, chosen: "incoming" | int}]`. All lists optional (preview with `{revision}` alone proposes everything).
  - Preview response: `{"blocking": [{"code", "message", "page"?, "table"?, "row"?}], "tables": [...ExtractedTable as JSON + per-row {"status": "matched"|"unknown"|"skipped", "line_key", "line_name", "suggestions", "skip_reason"}], "misreads": [{page, content_sha256, ...likely_misread}], "conflicts": [{fact_key, line_name, period, existing: [{fact_id, value, filename, page}], incoming: {value, page, row}}]}`.
  - Blocking codes: `review_not_verified`, `labels_missing`, `table_kind_unknown`, `column_period_unknown`, `unit_unknown`, `period_mismatch`, `line_unanswered`, `misread_unaccepted`. Open conflicts do **not** block.

- [ ] **Step 1: Write failing tests** (`test_history_routes.py`, reuse `create_markdown_review` + verify flow from `test_ocr_inbox.py` with a 2-column balance-sheet table and labels `MBB/consolidated/2026/Q3`):
  - `test_preview_blocks_until_answers_complete`: first preview lists `line_unanswered` for each row; after answering all as new lines → no blocking.
  - `test_write_then_series_has_points` (with Task 7) or assert `statement_facts` rows: 2 periods × N lines, `value` scaled to đồng.
  - `test_rewrite_same_pdf_supersedes` (spec: one PDF, one set of facts): write twice → active count unchanged, first set `superseded`.
  - `test_period_mismatch_blocks`: labels `2026/Q2` → blocking `period_mismatch`.
  - `test_unaccepted_misread_blocks`: page with the 222.313 table → `misread_unaccepted`; with `accepted_misreads` carrying the page hash → not blocking; after the page text changes, the old acceptance no longer applies.
  - `test_labels_locked_while_in_history` and `test_remove_from_history_unlocks`.
  - **Review Focus 4:** `test_resolution_reopens_after_source_changes`: two reviews disagree on a key → resolve choosing review A's fact; correct review A's page so the value changes and re-run write → point state `conflict`.
  - `test_unverified_review_rejected` → `review_not_verified`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** Uses each page's effective Markdown in page order, carrying `previous_kind` across pages. New lines are created in the catalogue only in `history_write`. Write = in one transaction: supersede this `inbox_item_id`'s active facts, insert printed facts, then recompute derived facts for every touched line (delete active calculated facts of those lines, insert new from `derive_missing_quarters`), then upsert resolutions given in answers (`"incoming"` → the new fact id). Labels must be complete: `ticker, scope, fiscal_year, period_code`.
- [ ] **Step 4: Run** — pass; full suite passes.
- [ ] **Step 5: Checkpoint.**

### Task 7: Read API for charts

**Files:**
- Modify: `Financial_analyze/backend/app/routes/history.py`
- Test: `Financial_analyze/backend/tests/test_history_routes.py`

**Interfaces:**
- Consumes: `point_states` (Task 5), models (Task 1), `LineCatalog.get` (Task 4).
- Produces:
  - `GET /api/history/companies` → `[{"ticker","scope","kinds":[...],"documents":int,"last_period_end":"YYYY-MM-DD"}]`
  - `GET /api/history/{ticker}/{scope}/lines` → `[{"key","name","kind","parent_key"}]` (lines with active facts)
  - `GET /api/history/{ticker}/{scope}/series?lines=k1,k2&grain=quarter|year&from=YYYY-MM-DD&to=YYYY-MM-DD` → `{"lines":[{"key","name","kind","points":[{"fact_key","period_type","period_start","period_end","value","status","origin","inputs","sources":[{"fact_id","inbox_item_id","filename","page","row","row_label","value","reviewed":true}]}]}]}`

- [ ] **Step 1: Write failing tests:** `test_series_quarter_grain_excludes_ytd` (ytd fact present → not in points); `test_series_year_grain_uses_year_and_dec31_instants`; `test_series_conflict_point_has_null_value_and_both_sources`; `test_series_calculated_point_lists_inputs`; `test_companies_and_lines_list_only_active`.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** Points sorted by `period_end`; `from`/`to` filter on `period_end`; `row_label` from `StatementFact.row_label` (the OCR label as printed).
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Checkpoint.**

### Task 8: Lucian base, API client, labels and the "Add to history" wizard

**Files:**
- Create: `Financial_analyze/src/lucian-ui.css` (tokens mapped to app variables + ported element CSS), `Financial_analyze/src/lucian-ui.jsx` (React components ported from Lucian, each preceded by its license comment)
- Modify: `Financial_analyze/Financial Analyze.html` (link `src/lucian-ui.css`; add `<script type="text/babel" src="src/lucian-ui.jsx">` after `ui-kit.jsx`; bump `?v=` on edited scripts)
- Modify: `Financial_analyze/src/api-client.jsx` (methods below)
- Modify: `Financial_analyze/src/page-ocr-inbox.jsx` (`OCRPublishPanel` gains scope / fiscal year / period selects; "Add to history" button beside "Verify review"; wizard)

**Interfaces:**
- Consumes: Task 6 endpoints.
- Produces:
  - `HelixAPI.historyPreview(reviewId, answers)`, `historyWrite(reviewId, answers)`, `historyRemove(itemId)`, `historyResolve(ticker, scope, body)`, `historyCompanies()`, `historyLines(ticker, scope)`, `historySeries(ticker, scope, {lines, grain, from, to})`.
  - Components on `window`: `LxSelect` (#031: `{value, options:[{value,label}], onChange, label}`), `LxWizard` (#042: `{steps:[{id,title,render,canNext}], onFinish, busy}`), `LxSegmented` (#047: `{value, options, onChange}`), `LxTagInput` (#029: `{items:[{key,label,color}], suggestions, onAdd, onRemove, placeholder}`), `LxSidePanel` (#273: `{open, title, onClose, onPrev, onNext, children}`), `LxSmallMultiples` (#400: `{series:[{key,name,color,points:[{x,y,status,origin}]}], onPointClick, formatValue}`). Task 9 uses the last four.

- [ ] **Step 1: Fetch elements and tokens:** `node <lucian-cli> tokens` and `get 031 042 047 029 273 400`; read each "How to use it".
- [ ] **Step 2: Port** into `lucian-ui.css` / `lucian-ui.jsx` per `references/porting.md` (scripts run in `useEffect` on mount with cleanup on unmount; map every `var(--ux-*)` used to the app's variables in both themes).
- [ ] **Step 3: Wire the labels panel** (selects: scope Consolidated/Separate, fiscal year, period Q1–Q4/H1/FY) through `ocrInboxLabels`; show the 409 "Remove this document from history first" message with a **Remove from history** button calling `historyRemove`.
- [ ] **Step 4: Wizard** (`LxWizard`), opened by **Add to history** (enabled when the review is verified): steps *Tables & periods* (per table: kind select incl. "Skip", unit select, per value column period chips with `LxSelect` to fix unknown ones) → *Lines* (unknown rows: `LxSelect` of suggestions + "New line"; skipped rows listed with reason) → *Checks* (each likely misread: open page / "Value correct as printed"; each conflict: pick a source or leave open) → *Add*. Every change re-posts `historyPreview`; *Next* disabled while that step has blocking items; *Add* calls `historyWrite` and toasts `written / superseded / conflicts_open`.
- [ ] **Step 5: Verify:** Babel check every edited JSX:
  `cd <scratch>/jsx && node -e "const B=require('@babel/standalone'),fs=require('fs');for(const f of process.argv.slice(1))B.transform(fs.readFileSync(f,'utf8'),{presets:['react']});console.log('JSX OK')" <files>` → `JSX OK`. Then run the app (`run` skill) and walk the wizard on review 4 (MBB Q3 2026) in light and dark themes, at 375 px, keyboard-only, and with reduced motion.
- [ ] **Step 6: Checkpoint.**

### Task 9: Financial Statements page — live company history

**Files:**
- Modify: `Financial_analyze/src/page-statements.jsx`
- Modify: `Financial_analyze/src/lucian-ui.jsx` (`LxGrowthChart`, built from #400's marks and tokens — no Lucian match)

**Interfaces:**
- Consumes: Task 7 endpoints via `HelixAPI.history*`; `LxSelect`, `LxSegmented`, `LxTagInput`, `LxSidePanel`, `LxSmallMultiples` (Task 8).
- Produces: `PageStatements` renders `<CompanyHistory/>` when `HelixAPI.live` and `historyCompanies()` is non-empty; otherwise the existing demo, unchanged.

- [ ] **Step 1: Filter row** (one row): company + scope `LxSelect`, line picker `LxTagInput` (suggestions from `historyLines`), From/To quarter `LxSelect`, Quarter|Year `LxSegmented`, view `LxSegmented` "Small charts | Growth (start = 100)". Default lines: none picked → empty state "Pick lines to compare".
- [ ] **Step 2: Charts.** Small charts (default) via `LxSmallMultiples`, each with its own scale and title "name · latest value · change since first period"; Growth via `LxGrowthChart` (index = value / first non-null value × 100, real value in tooltip). Series colours from the dataviz palette slots in pick order and kept per line key (removing a line does not re-colour others; 9th+ line → message "Up to 8 lines"). Points: solid printed, hollow calculated, red ring + "⚠ sources differ" for `conflict` (no value plotted). Values shown in tỷ đồng with Vietnamese grouping.
- [ ] **Step 3: Source panel.** Point click opens `LxSidePanel`: value, period, origin (+ "calculated: FY − 9M" with inputs), each source (filename, page, row label, reviewed ✓) with **Open scan** (`HelixAPI.ocrInboxPageUrl(item, page)`); for `conflict`, a **Use this value** button per source calling `historyResolve`, then refetch.
- [ ] **Step 4: Table view** toggle under the charts listing the same points (period × line), for copying and accessibility.
- [ ] **Step 5: Verify:** Babel check; run the app with real data after Task 10's first document; check light/dark, 375 px, keyboard, reduced motion; label collisions eyeballed.
- [ ] **Step 6: Checkpoint.**

### Task 10: Acceptance with real documents and docs

**Files:**
- Modify: `docs/PLAN.md` (Phase 2/3 lines: OCR → structured facts done via this design), `docs/design/CORE_DESIGN.md` ("Open — multi-period" answered: separate period rows, link to spec)

- [ ] **Step 1 (owner):** set labels for the four MBB inbox items (Q4 2025 HN, Q3 2025 HN, Q3 2026 HN, Q1 2026 riêng lẻ), verify their reviews, and run **Add to history** for each.
- [ ] **Step 2:** Check spec §8 items 1–6 in the running app; record results (counts of facts, any conflicts and their causes) in the checkpoint.
- [ ] **Step 3:** Update the two docs.
- [ ] **Step 4: Checkpoint** — list all changed files from Tasks 1–10 and suggest the commit message:
  `feat(history): turn verified OCR statements into a deduplicated company history with charts`
