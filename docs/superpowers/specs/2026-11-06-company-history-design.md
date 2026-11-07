# Company History from OCR — Design

Date: 2026-11-06
Status: draft for review
Builds on: `docs/superpowers/specs/2026-11-05-mac-ocr-worker-design.md` (OCR pages),
`docs/design/CORE_DESIGN.md` (planned `statements` + `line_items`), today's subtotal checks
(`backend/app/services/ocr_total_checks.py`).

## 1. Intent

OCR today ends at a reviewed Markdown document per PDF. One document alone does not show how a
company is doing. The owner wants every verified statement of a company joined into **one clean
history**, shown as charts where the owner chooses which lines to compare over time — the big
picture, not two documents side by side.

The value of the chart depends entirely on trust. Every point must be a number a human verified,
traceable to its PDF page and row, and counted once.

## 2. Goals

1. Turn a verified OCR review into stored facts: one value per **company + scope + statement +
   line + period**, with provenance (PDF, page, table, row, column, original text).
2. Join facts from many documents into one history per company; detect and surface duplicates
   and disagreements instead of hiding them.
3. A **Company history** page: the owner picks company, scope and lines; charts show the history.
4. Balance sheet, income statement and cash-flow lines in the first version, including derived
   quarterly profit (Q4 = full year − 9-month YTD), clearly marked **calculated**.

## 3. Non-goals (this version)

- Downloading statements, or deciding which quarter a PDF belongs to (the owner does this).
- Comparing two different companies on one chart.
- Hermes writing analysis from the history (later, on top of the same facts).
- Ratios (ROE, NIM, …), forecasts, alerts.
- Migrating the prototype `Filing` table / the "Publish" button (PLAN Phase 1 decision; untouched).

## 4. Anti-goals (failure even if it "works")

- Any chart point from a page that was not human-verified.
- Code choosing between two different values for the same fact. It flags; the owner decides.
- Counting a value twice: the same period printed in two documents becomes two points, or a
  year-to-date (lũy kế) value is plotted as a quarter.
- Guessing a unit or a period silently.
- Automatic "back-solve" repair of numbers (`API_CONTRACT.md` §3 plans it). Not in this feature:
  the subtotal check only flags.
- Anything leaving the Mac (fully local).

## 5. Decided by the owner (2026-11-06)

| Decision | Source |
|---|---|
| Owner downloads statements and sets company + year + quarter at upload; code never guesses the period | owner |
| Code joins documents, removes duplicates, draws charts | owner |
| Owner picks which lines to compare on the chart | owner |
| Default view: one small chart per line (own scale); switch to "growth, start = 100" on one chart | owner (mockups B + C) |
| "Same line or new line?" is answered while reviewing each statement | owner |
| Profit lines included; Q4 (and any missing quarter) derived and marked calculated | owner |

## 6. Design

### 6.1 Flow

```
upload PDF ─ owner sets: ticker, scope (hợp nhất / riêng lẻ), fiscal year, period (Q1–Q4 / H1 / FY)
   → OCR (unchanged) → page review (unchanged) → Verify review (unchanged)
   → NEW: "Add to history" step on the same review screen
        1. detect statement tables and their columns
        2. owner confirms statement kind, column periods, unit
        3. owner answers "same line or new?" for unknown lines
        4. owner resolves conflicts with facts already in the history
        5. facts written
   → Company history page reads facts
```

### 6.2 Upload labels

Existing `PATCH /api/ocr-inbox/{id}/labels` keeps its free-text fields. Add structured fields on
`ocr_inbox_items`: `scope` (`consolidated` | `separate`), `fiscal_year` (int), `period_code`
(`Q1`–`Q4`, `H1`, `FY`). Required before "Add to history" (not before OCR).

*(Design call.)* Scope is a label like the period: comparing consolidated with separate figures
is wrong, so they are separate histories. Of the four current inbox items, the Q1 2026 PDF is
`riêng lẻ` and lands in its own history.

### 6.3 What a statement table becomes

A verified page can hold one or more HTML/Markdown tables (`ocr_label_levels` already parses
both). For each table the extraction proposes:

- **Statement kind**: balance sheet / income statement / cash flow / other (skip). Proposed from
  the heading text on the page (e.g. "BÁO CÁO TÌNH HÌNH TÀI CHÍNH", "KẾT QUẢ HOẠT ĐỘNG",
  "LƯU CHUYỂN TIỀN TỆ"); the owner confirms. A table continued on the next page ("(tiếp theo)")
  keeps the kind of the previous table.
- **Columns → periods**: each numeric column maps to a period, parsed from its header:
  - a date (`30/09/2026`, `31/12/2025`) → `instant` at that date (balance sheet);
  - "Giai đoạn từ 01/07/2026 đến 30/09/2026" (3 months) → `quarter`;
  - from 01/01 and longer than 3 months → `ytd` (lũy kế);
  - 12 months → `year`.
  Unparseable header → the owner sets it; nothing is assumed. "Thuyết minh" / "Mã số" columns are
  not values.
- **Period check**: the document's own current period must agree with the upload label (e.g.
  `Q3 2026` ⇔ a `quarter` or `instant` ending 30/09/2026). Disagreement blocks the step with a
  warning the owner must resolve (fix the label or the column). It never changes the label.
- **Unit**: read from the table/page ("triệu đồng", "đồng", "nghìn tỷ") or the upload label;
  conflicting or missing → owner sets it. Values are stored as integers in đồng; the original text
  and unit stay in provenance.
- *(Design call.)* Rows that are not money in the table unit — per-share values (EPS, "Lãi cơ bản
  trên cổ phiếu", "đồng/cổ phiếu"), percentages, ratios, share counts — are **skipped in v1** and
  listed on the step as "skipped: not an amount", so nothing is scaled by the wrong unit.

### 6.4 Lines and matching

A **line** is a stable identity in one history: `ticker + scope + statement kind + line key`.
*(Design call.)* The line key is a **generated stable id** (e.g. `ln_7f3a…`), never the Mã số or the
label itself. Mã số, normalized label + parent, and the owner's "same as" answers are all stored as
**aliases** that resolve to it. So a document with Mã số and one without (or OCR dropping that
column) still land on one line, and renaming never migrates stored facts.

- Line key match order:
  1. **Mã số** when the table has one (TT200 companies) — strongest key.
  2. Normalized label (`ocr_label_library.normalize_label`: accent/case/punctuation-free)
     **plus the normalized parent label** (from the level hierarchy), so "Dự phòng rủi ro" under
     loans and under securities stay different lines.
  3. A stored mapping the owner made earlier.
- Anything else is **unknown**: the step lists it and asks "same as <existing line> or new line?",
  with suggestions ranked by label similarity. The answer is stored and reused for that company.
- *(Design call.)* Mappings are stored as Obsidian notes next to the existing label library
  (the owner's chosen memory), one note per company+scope+statement, with stable line keys in the
  front matter; Core keeps an in-memory index, as `ObsidianLabelLibrary` already does. Facts in
  SQLite reference the line key.

### 6.5 Facts, duplicates, conflicts

Table `statement_facts` (SQLite, Core):

| column | meaning |
|---|---|
| `ticker`, `scope`, `statement_kind`, `line_key` | which line |
| `period_type` (`instant`/`quarter`/`ytd`/`year`), `period_start`, `period_end` | which period |
| `value` (integer, đồng) | the number |
| `fact_key` | line_key + period_type + period_start + period_end |
| `origin` (`printed`/`calculated`) | how it was obtained |
| `inbox_item_id`, `review_id`, `review_revision`, `page_number`, `table`, `row`, `column` | provenance (printed) |
| `raw_text`, `raw_unit` | original cell text and unit |
| `inputs` (JSON) | fact ids used (calculated) |
| `status` (`active`/`superseded`) | |

Rules:

- **One value per key.** The key is line + `period_type` + `period_start` + `period_end`.
  The same key printed by several documents (the Q3 2026 statement repeats 31/12/2025 from the
  Q4 2025 statement) is stored as several source rows but plotted once.
- **Agreement** → point shows "2 sources agree".
- **Disagreement** → **conflict**: the step shows both values with their sources and the owner
  picks one (or corrects the OCR page and re-runs the step). Until resolved, the point is shown
  with a red ⚠ ring and the chart tooltip lists both values. Code never picks.
- *(Design call.)* Table `fact_resolutions`: `fact_key`, `chosen_fact_id` (one source row),
  `chosen_value`, `resolved_at`, `note`. The series endpoint plots: the only value when all
  active sources agree; the chosen source when a resolution exists **and** that source is still
  active with the same value; otherwise the point is an open conflict (no value plotted, ⚠ shown).
  So a re-verify or recalculation that changes or removes the chosen source re-opens the conflict
  automatically. The owner cannot type a free value here — to fix a number, they correct the OCR
  page, so every plotted number still points at a reviewed page.
- *(Design call.)* **One PDF, one set of facts.** Facts are owned by `inbox_item_id`. Running
  "Add to history" again for the same PDF — from the same review or from a newer review after an
  OCR retry — marks that PDF's earlier facts `superseded` and writes the new ones. Never
  duplicates. (No "reopen review" transition is added; a newer review comes from the existing
  retry path.)
- *(Design call.)* Changing a PDF's upload labels after its facts are written is blocked with
  "Remove this document from history first"; add a **Remove from history** action that supersedes
  its facts. Labels and facts never silently disagree.
- *(Design call.)* **Subtotal gate.** A page contributes facts when its current `page_total_check`
  has no likely misreads, or each remaining one is marked by the owner as **"value correct as
  printed"** (per flagged misread; stored with that run's answers, tied to the page content hash,
  so editing the page clears it). Large irregular mismatches (counted, not flagged — mostly
  hierarchy guesses) do not block. Pages with nothing checkable (`checked == 0`) pass; the human
  verification already happened.

### 6.6 Calculated periods (profit and cash flow)

- Quarter values are printed values when a document prints them.
- A missing quarter is derived only from printed facts of the same line, scope and year:
  `Q4 = year − ytd(9 months)`; `Q2 = ytd(6) − Q1`, `Q3 = ytd(9) − ytd(6)` when needed.
- Marked `calculated`, listing its inputs. Shown as a hollow point; tooltip "calculated: FY 2025 −
  9M 2025".
- A calculated value never overrides a printed one. If both exist and differ → conflict.
- Balance-sheet lines (`instant`) are never calculated.
- Inputs changed (a conflict resolved, a review re-verified) → recalculate.

### 6.7 Company history (Financial Statements page, live mode)

*(Plan-time change, owner rule "reuse existing UI".)* Not a new page: it is the **live mode of the existing
Financial Statements page** (`src/page-statements.jsx`, today demo data only). When the backend is
reachable (`HelixAPI.live`) the page shows the company history; offline it keeps the demo,
labelled as demo — the same pattern as the screener's VN mode.

- Header row (filters in one row): company (ticker), scope, line picker (search over the line
  catalogue, add/remove chips), period range, **Quarter | Year** toggle, view switch
  **Small charts | Growth (start = 100)**.
- **Small charts (default):** one small line chart per picked line, each with its own scale; title
  shows latest value and change since the first period.
- **Growth view:** one chart, every line indexed to 100 at the first visible period; real values on
  hover.
- Points: solid = printed, hollow = calculated, red ring = unresolved conflict.
- Hover: value, period, origin. Click: source panel — PDF name, page, row label, reviewed ✓,
  subtotal check ✓, and **open scan** (existing page-image endpoint
  `GET /api/ocr-inbox/{item_id}/pages/{page}`).
- A table view of the same data (accessibility, and for copying numbers).
- Quarter view plots `quarter` and `instant` facts; Year view plots `year` and year-end `instant`
  facts. YTD facts are never plotted directly.
- Mockups: `.superpowers/brainstorm/*/content/chart-layout-v2.html` (option B default, C switch).

### 6.7a UI elements (Lucian UX/UI library, owner's choice 2026-11-06)

The owner asked for the new screens to use Lucian UX/UI elements (`lucian-uxui` skill; ported per
its `references/porting.md`, keeping each element's license comment line, structure and motion;
data and colours adapted to the app's theme tokens).

| Part | Element |
|---|---|
| Small charts (default view) | #400 Synced-cursor small multiples |
| Line picker (search + chips) | #029 Colored tag input |
| Small charts / Growth and Quarter / Year switches | #047 Period segmented control |
| Company, scope, From / To quarter | #031 Custom select listbox |
| Source panel on point click | #273 Detail side panel from a list row |
| "Add to history" step | #042 Step-by-step wizard (kinds → periods & unit → lines → conflicts → write) |
| Growth (start = 100) chart | no match — built by the builder from #400's marks and tokens |

Fetch only these with `get`; re-search if an element turns out not to fit.

### 6.8 API (shape for the builder)

- `POST /api/ocr-inbox/reviews/{id}/history-preview` → proposed tables, kinds, column periods,
  units, line matches, unknown lines, conflicts, blocking problems.
- `POST /api/ocr-inbox/reviews/{id}/history` (with `revision` and the owner's answers) → writes facts.
- `GET /api/history/companies` → tickers + scopes with facts.
- `GET /api/history/{ticker}/{scope}/lines` → line catalogue.
- `GET /api/history/{ticker}/{scope}/series?lines=…&from=…&to=…&grain=quarter|year` → points with
  origin, conflict flag and provenance ids.

## 7. Constraints

- Local only; SQLite; no new runtime services.
- Pure functions for parsing/matching/deriving (CORE_DESIGN "pure core + thin ORM bridge").
- Schema change via the existing `db.py` upgrade helpers (no Alembic yet, PLAN Phase 0).
- Do not create a second statement model: these facts are the `line_items` CORE_DESIGN planned,
  stored one row per period, which answers CORE_DESIGN's open "multi-period" question
  (separate period rows, not a `prev` column).
- UI files: `src/*.jsx` are edited in place in recent commits, but an older note says the design
  artifact is the source of truth and a re-export overwrites `src/`. The owner confirms which
  applies before UI work.

## 8. Acceptance

Using the four MBB PDFs already in the OCR Inbox (Q4 2025 HN, Q3 2025 HN, Q3 2026 HN, Q1 2026 riêng lẻ):

1. After review + "Add to history", the consolidated history has balance-sheet lines at
   30/09/2025, 31/12/2025, 30/09/2026 and the comparison dates those documents print, each date
   once; values printed by two documents show "2 sources agree" or a conflict.
2. The Q1 2026 separate statement appears only under scope `separate`.
3. Profit lines show printed quarters; a missing quarter is calculated and drawn hollow.
4. Clicking any point opens the right PDF page with the row named.
5. Setting the Q3 2026 PDF's label to Q2 2026 blocks the step with a period warning.
6. Re-verifying a review does not duplicate points.
7. Unit tests for: column-header period parsing, unit parsing, line matching, derivation,
   duplicate/conflict rules. Backend suite passes.

## 9. Left to the builder

- Statement-kind keyword list and similarity ranking for "same line?" suggestions.
- Exact Obsidian note layout for line mappings (follow `ocr_label_library.py`'s pattern).
- Chart implementation inside the existing JSX stack (no new framework); follow the dataviz rules
  (one axis per chart, fixed series colours, direct labels for ≤ 4 lines, hover tooltips).
- Page layout details of the "Add to history" step within the review screen.
