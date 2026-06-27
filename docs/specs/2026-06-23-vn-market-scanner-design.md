# VN Market Scanner — Design Spec

**Date:** 2026-06-23
**Status:** Approved (brainstorm), ready for implementation plan.
**Part of:** Distributed Financial Analysis System (see `PLAN.md`, `CORE_DESIGN.md`, `HERMES_BRAIN.md`).

## Purpose
Scan the whole Vietnamese market (HOSE/HNX/UPCOM) to surface companies worth investing, classify each
as **long-term / short-term / avoid**, and answer the hard question — **how long to hold** — without
faking precision. The scanner is the **top of a funnel**: broad, shallow screening narrows the market to a
shortlist; the user then picks names for a **deep-dive** (the existing trusted pipeline: OCR statements +
reconcile + Hermes analysis + news). Trust is *earned down the funnel.*

## Core principle (project-wide, applied here)
**Trust nothing unverified — and never fabricate numbers.**
- Broad scan data is third-party (vnstock), explicitly labeled `verified=false` ("for screening only").
- All scores/rankings are computed by **deterministic Python** — reproducible, no LLM-invented numbers.
- Hermes **narrates only** (thesis, explanation) over already-computed signals; it never scores or invents figures.
- Deep-dive escalates trust: OCR + reconcile produce `verified` data for the chosen stock.
- Output states its trust level and that it is **guidance — the human decides** (borrowed "never auto-publish"
  guardrail from `anthropics/financial-services` earnings-reviewer).

## Decisions (locked in brainstorm 2026-06-23)
- **Tiered trust:** broad scan = unverified vnstock data; full verification only at deep-dive on the shortlist.
- **Screen on 4 dimensions:** fundamentals + valuation + technical/momentum + news/catalysts.
- **Output = thesis + horizon range + review/exit triggers** (NOT a precise duration).
- **Cadence:** scheduled (periodic auto-scan) + on-demand (run-now).
- **Deep-dive trigger:** user picks from the ranked shortlist (deep-dive is expensive).
- **Deep-dive engine:** Hermes (existing pipeline). **deer-flow is NOT used** (lighter stack).
- **Scoring:** deterministic Python; Hermes narrates.
- **Output destinations:** existing Screener UI page (ranked, with unverified badge) + Obsidian vault dossiers.
- **Market data:** vnstock — now CORE to the project (the scanner needs market-wide data), not optional.
- **Reference data, NOT borrowed verdicts (2026-06-24):** vnstock provides a built-in `Screener().stock()`
  returning market-wide pre-computed fields in one call — a fast way to get RAW inputs (`roe`,
  `priceToEarning`, `priceToBook`, `marketCap`, `rsi14`, `epsGrowth1Year`, …). We pull **only the raw
  numbers** as unverified reference (`verified=false`). We **NEVER consume its pre-baked verdicts/signals**
  (`tcbsBuySellSignal` BUY/SELL, `priceBreakOut52Week`, `rsi14Status`) — those are a third party's decision,
  unreproducible, untrustable. **Our own `signals.py` + `score.py` turn raw inputs into the decision —
  deterministic, reproducible, ours.** vnstock supplies ingredients; we cook. (Screener availability is
  uncertain — TCBS API churn; Task 0 spike verifies. Fallback: loop `Finance().ratio()` per symbol.)

## Funnel architecture
```
SCAN (broad, shallow, unverified)                        DEEP-DIVE (narrow, deep, verified)
whole VN market via vnstock                              user picks a candidate
  → signals (4 dims, deterministic)                        → OCR + reconcile (if statements present) = verified
  → score + rank + long/short lean (deterministic)         → Hermes: thesis + horizon range + triggers (narrate)
  → Screener page (badged 'unverified')                    → dossier → vault note (linked to company hub)
```

## Components (isolated units — new package `backend/app/scanner/`)
- `universe.py` — fetch the VN ticker universe + broad per-stock metrics from vnstock. Returns records
  tagged `source="vnstock"`, `verified=False`. One responsibility: get broad data. No scoring.
- `signals.py` — **deterministic** functions computing each dimension from a stock's broad data:
  - *fundamentals*: ROE, ROA, biên lãi gộp/ròng, doanh thu/LN growth.
  - *valuation*: P/E, P/B, EV/EBITDA vs peers/history (cheap/expensive signal).
  - *technical*: price trend, RSI, volume momentum.
  - *catalysts*: count/recency/sentiment of recent news (RSS/SearXNG — Stage 5 news layer).
  Each returns a normalized sub-score + the raw inputs (for transparency). No LLM.
- `score.py` — **deterministic** weighted total score per stock + a **long/short lean**:
  fundamentals + valuation weighted → long-term lean; technical + catalysts weighted → short-term lean;
  weak across all → avoid. Reproducible ranking. Weights are explicit constants (tunable).
- `runner.py` — orchestrates a scan run (scheduled via existing APScheduler + on-demand endpoint),
  writes `scan_runs` + `scan_results`.
- Deep-dive: **no new engine.** A `deep_dive(symbol)` flow reuses the existing pipeline — triggers
  OCR+reconcile if statements exist (else marks "screening-only"), then Hermes produces the thesis +
  horizon range + triggers using the borrowed decision-report schema, saved to the vault.

## Data flow
```
scan run (scheduled or POST /api/scan)
  → universe.py: VN tickers + broad metrics (vnstock, verified=false)
  → signals.py: 4 deterministic sub-scores per stock
  → score.py: total score + rank + lean (long|short|avoid)
  → persist scan_runs + scan_results
  → GET /api/scan/latest → Screener page (ranked, 'unverified' badge)
user picks symbol → POST /api/scan/{symbol}/deep-dive
  → if statements present: OCR + reconcile = verified data; else 'screening-only'
  → Hermes (narrate): thesis + horizon RANGE + review/exit triggers over computed signals
  → dossier → vault note (linked to <SYM> company hub) + returned to UI
```

## "How long to hold" output (per decision)
Never a fake precise duration. Each candidate dossier states:
- **Lean:** long-term | short-term | avoid.
- **Horizon range:** e.g. "1–3 năm" (long) / "vài tuần–vài tháng" (short).
- **Thesis:** grounded in the computed signals (and verified ratios if deep-dived).
- **Review/exit triggers:** concrete conditions that would change the call.
- **Trust label:** screening-only (unverified) vs deep-dived (verified).

## Data model additions (SQLite, `models/core.py`)
- `scan_runs(id, started_at, mode["scheduled"|"manual"], universe_size)`
- `scan_results(id, run_id→scan_runs, symbol, scores(JSON per-dimension), total_score(float),
   lean["long"|"short"|"avoid"], rank(int), verified(bool=false))`
- Reuses `instruments`; deep-dive reuses `documents`/`statements`/`line_items`.

## Interfaces (REST — extends `API_CONTRACT.md`)
- `POST /api/scan` — trigger an on-demand scan; returns run id.
- `GET /api/scan/latest` — latest ranked `scan_results` for the Screener page.
- `POST /api/scan/{symbol}/deep-dive` — run the deep-dive for a chosen symbol; returns the dossier.

## Where it lives & UI
- New `backend/app/scanner/` package; scheduled via existing APScheduler (`services/scheduler.py`).
- UI: the existing **Screener page** renders ranked candidates with an `unverified` badge + lean + score;
  deep-dive dossiers saved as vault notes and shown in the UI.

## Testing (deterministic — exact)
- `signals.py`: known broad-data fixture → known sub-scores (e.g. ROE 18% → fundamentals sub-score X).
- `score.py`: fixture of sub-scores → exact total, rank order, and lean classification.
- `runner.py`: a small mock universe → ranked `scan_results` rows written.
- Trust: assert `scan_results.verified is False` for broad scans; assert no LLM call in the scoring path.

## Build order (decomposition)
1. **Broad scan tier first** — `universe` + `signals` + `score` + `runner` + `scan_runs`/`scan_results` +
   Screener UI. Delivers the market-wide funnel-top on its own.
2. **Deep-dive tier second** — `deep_dive(symbol)` reusing OCR+reconcile+Hermes + the dossier/thesis output.

## Dependencies
- vnstock broad-data feasibility (does it return market-wide fundamentals/valuation, not just prices?)
  is a **validation spike** before building `universe.py`/`signals.py`.
- News/catalysts dimension depends on the Stage-5 news layer (RSS/SearXNG); until then the catalyst
  sub-score is optional/zero-weighted.
- Deep-dive depends on the reconciliation engine (spec'd) + Hermes brain.

## Out of scope (v1)
deer-flow; auto deep-dive of top-N (user picks); precise duration estimates; themed watchlist groups;
cross-company ranking beyond the scan ranking itself; backtesting.
