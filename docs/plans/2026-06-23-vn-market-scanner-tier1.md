# VN Market Scanner — Tier 1 (Broad Scan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the broad-scan tier of the VN Market Scanner — screen the whole VN market on deterministic fundamental/valuation/technical signals, score + rank + classify long/short/avoid, and expose results via REST for the Screener page.

**Architecture:** A `backend/app/scanner/` package with single-responsibility modules: `universe.py` (fetch broad vnstock data, tagged unverified), `signals.py` (pure deterministic sub-scores per dimension), `score.py` (pure deterministic total + lean + rank), `runner.py` (orchestrate a run, persist). New `scan_runs`/`scan_results` SQLite models. Routes `POST /api/scan`, `GET /api/scan/latest`. The scoring path is pure functions over plain dicts — no ORM, no LLM — so it is exactly unit-testable.

**Tech Stack:** Python 3.x, FastAPI, SQLAlchemy 2.x, SQLite, vnstock, pytest, FastAPI `TestClient`.

## Global Constraints

- Backend root: `Financial analyze/backend` (note the space). Paths below are relative to it; run commands from there.
- **Scoring path is deterministic Python — NO LLM, no network, no randomness.** vnstock is called only in `universe.py` (data fetch), never in `signals.py`/`score.py`.
- Broad-scan data is third-party: every `scan_results` row has `verified = False`.
- Sub-scores are normalized to **0–100**. Total score is a weighted average, also 0–100.
- **Weights (exact):** fundamentals 0.40, valuation 0.30, technical 0.30, catalysts 0.0 (zero-weighted until the news layer exists).
- **Lean rule (exact):** `long_score = fundamentals*0.5 + valuation*0.5`; `short_score = technical*1.0`; if `total < 40` → `"avoid"`; elif `long_score >= short_score` → `"long"`; else → `"short"`.
- Lean ∈ `long | short | avoid`. Scan mode ∈ `scheduled | manual`.
- Existing models live in `app/models/core.py`; existing scheduler in `app/services/scheduler.py`; tests use the `db` fixture in `tests/conftest.py` (created in the reconciliation plan — recreate if absent).
- EXCLUDE tier 2 (deep-dive). Catalysts dimension is scaffolded but zero-weighted.
- Repo is not yet a git repo. Run `git init` once before starting for the commit steps to work.
- Run tests: `cd "Financial analyze/backend" && pytest`.

## File Structure

- Create `app/scanner/__init__.py` — package marker.
- Create `app/scanner/signals.py` — pure deterministic sub-score functions (fundamentals/valuation/technical/catalysts) + `compute_signals(stock: dict) -> dict`. No ORM, no vnstock.
- Create `app/scanner/score.py` — pure `score_stock(signals: dict) -> dict` (total + lean) and `rank(results: list[dict]) -> list[dict]`. No ORM.
- Create `app/scanner/universe.py` — `fetch_universe() -> list[dict]` (vnstock broad data, each tagged `verified=False`). Network lives here only.
- Create `app/scanner/runner.py` — `run_scan(db, mode, universe=None) -> dict` orchestration: fetch → signals → score → rank → persist `scan_runs`+`scan_results`.
- Modify `app/models/core.py` — add `ScanRun`, `ScanResult` models.
- Create `app/routes/scan.py` — `POST /api/scan`, `GET /api/scan/latest`.
- Modify `app/main.py` — register the `scan` router.
- Modify `app/services/scheduler.py` — add a scheduled scan job.
- Create `tests/scanner_fixtures.py`, `tests/test_signals.py`, `tests/test_score.py`, `tests/test_runner.py`, `tests/test_scan_route.py`.
- Spike artifact: `docs/superpowers/spikes/2026-06-23-vnstock-broad-data.md`.

---

### Task 0: vnstock feasibility spike

**Files:**
- Create: `docs/superpowers/spikes/2026-06-23-vnstock-broad-data.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a documented decision — does vnstock return market-wide fundamentals/valuation, and the **exact field names** `universe.py` will map. This locks the `stock` dict shape used by every later task.

- [ ] **Step 1: Probe vnstock for a listing + one company's fundamentals/valuation**

Run (from `Financial analyze/backend`, venv active):
```bash
python - <<'PY'
from vnstock import Vnstock, Listing
# 1) can we list the whole market?
try:
    listing = Listing().all_symbols()
    print("LISTING COLUMNS:", list(listing.columns)[:10], "rows:", len(listing))
except Exception as e:
    print("listing error:", e)
# 2) PREFERRED: the built-in market-wide Screener (one call, all stocks + metrics)
try:
    from vnstock import Screener
    sc = Screener().stock(params={"exchangeName": "HOSE,HNX,UPCOM"}, limit=1700)
    print("SCREENER COLS:", list(sc.columns))
    print("SCREENER ROWS:", len(sc))
except Exception as e:
    print("screener error (may be deprecated — TCBS API churn):", e)
# 3) FALLBACK: per-symbol ratios if the screener is down
v = Vnstock().stock(symbol="VNM", source="VCI")
for name in ("ratio", "income_statement", "balance_sheet"):
    try:
        df = getattr(v.finance, name)(period="year")
        print(name, "COLS:", list(df.columns)[:15])
    except Exception as e:
        print(name, "error:", e)
PY
```
Expected: prints available columns OR errors. Capture actual output.

- [ ] **Step 2: Write the spike findings**

Record in `docs/superpowers/spikes/2026-06-23-vnstock-broad-data.md`:
- **Does `Screener().stock()` work?** If yes → it's the universe source (one call, market-wide). If no →
  fall back to looping `Finance().ratio()` per symbol.
- Whether a market-wide symbol listing is available (`Listing().all_symbols()`).
- Which fundamental fields exist (ROE, ROA, margins, growth) + exact names (e.g. `roe`, `epsGrowth1Year`).
- Which valuation fields exist + names (e.g. `priceToEarning`, `priceToBook`, `marketCap`).
- Which technical fields exist + names (e.g. `rsi14`, `relativeStrength1Month`).
- **TRUST RULE (from spec):** map ONLY raw-number fields. **Exclude any pre-baked verdict/signal field**
  (`tcbsBuySellSignal`, `priceBreakOut52Week`, `rsi14Status`) — those are a third party's decision, never
  consumed. Our scoring computes the decision from raw inputs.
- **Decision:** confirm the `stock` dict keys `universe.py` will produce. If a dimension's data is
  unavailable market-wide, mark that sub-score zero-weighted (like catalysts) and note it.

The canonical `stock` dict for the rest of this plan (adjust names to match the spike, keep keys):
```python
{
  "symbol": "VNM", "market": "HOSE", "verified": False,
  "roe": 0.18, "roa": 0.10, "gross_margin": 0.40, "net_margin": 0.15,
  "revenue_growth": 0.08, "profit_growth": 0.05,      # fundamentals
  "pe": 15.0, "pb": 3.0, "sector_pe": 18.0,            # valuation
  "price": 64500, "sma50": 62000, "sma200": 60000, "rsi": 55, "vol_ratio": 1.2,  # technical
  "news_count": 0, "news_sentiment": 0.0,              # catalysts (zero-weighted v1)
}
```

- [ ] **Step 3: Commit**

```bash
git add "Financial analyze/backend/docs/superpowers/spikes/2026-06-23-vnstock-broad-data.md" 2>/dev/null || git add docs/superpowers/spikes/2026-06-23-vnstock-broad-data.md
git commit -m "spike(scanner): confirm vnstock market-wide fundamentals/valuation fields"
```

---

### Task 1: Signals — fundamentals + valuation + technical sub-scores

**Files:**
- Create: `app/scanner/__init__.py` (empty)
- Create: `app/scanner/signals.py`
- Create: `tests/scanner_fixtures.py`
- Test: `tests/test_signals.py`

**Interfaces:**
- Consumes: the `stock` dict shape from Task 0.
- Produces:
  - `fundamentals_score(stock: dict) -> float` (0–100)
  - `valuation_score(stock: dict) -> float` (0–100)
  - `technical_score(stock: dict) -> float` (0–100)
  - `catalysts_score(stock: dict) -> float` (0–100; returns 0.0 in v1)
  - `compute_signals(stock: dict) -> dict` → `{"fundamentals","valuation","technical","catalysts"}` floats.
  - `tests/scanner_fixtures.py :: good_stock()`, `weak_stock()` returning `stock` dicts.

- [ ] **Step 1: Write the failing test**

```python
# tests/scanner_fixtures.py
def good_stock():
    return {
        "symbol": "VNM", "market": "HOSE", "verified": False,
        "roe": 0.20, "roa": 0.12, "gross_margin": 0.42, "net_margin": 0.16,
        "revenue_growth": 0.10, "profit_growth": 0.12,
        "pe": 12.0, "pb": 2.0, "sector_pe": 18.0,
        "price": 66000, "sma50": 62000, "sma200": 60000, "rsi": 58, "vol_ratio": 1.3,
        "news_count": 0, "news_sentiment": 0.0,
    }

def weak_stock():
    return {
        "symbol": "XYZ", "market": "HNX", "verified": False,
        "roe": 0.02, "roa": 0.01, "gross_margin": 0.08, "net_margin": 0.01,
        "revenue_growth": -0.05, "profit_growth": -0.10,
        "pe": 40.0, "pb": 6.0, "sector_pe": 18.0,
        "price": 9000, "sma50": 10000, "sma200": 11000, "rsi": 38, "vol_ratio": 0.6,
        "news_count": 0, "news_sentiment": 0.0,
    }
```

```python
# tests/test_signals.py
from app.scanner import signals as s
from tests.scanner_fixtures import good_stock, weak_stock


def test_scores_are_0_to_100():
    for fn in (s.fundamentals_score, s.valuation_score, s.technical_score, s.catalysts_score):
        assert 0.0 <= fn(good_stock()) <= 100.0
        assert 0.0 <= fn(weak_stock()) <= 100.0


def test_good_beats_weak_each_dimension():
    g, w = good_stock(), weak_stock()
    assert s.fundamentals_score(g) > s.fundamentals_score(w)
    assert s.valuation_score(g) > s.valuation_score(w)   # cheaper P/E vs sector
    assert s.technical_score(g) > s.technical_score(w)    # uptrend vs downtrend


def test_catalysts_zero_in_v1():
    assert s.catalysts_score(good_stock()) == 0.0


def test_compute_signals_keys():
    out = s.compute_signals(good_stock())
    assert set(out) == {"fundamentals", "valuation", "technical", "catalysts"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_signals.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scanner.signals`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/scanner/__init__.py
```

```python
# app/scanner/signals.py
"""Deterministic per-dimension sub-scores (0-100) from a stock's broad data.

Pure functions over a plain dict. No ORM, no vnstock, no LLM. Reproducible.
"""


def _clip(x: float) -> float:
    return max(0.0, min(100.0, x))


def fundamentals_score(stock: dict) -> float:
    # higher ROE/ROA/margins/growth => higher score. Simple linear maps, clipped.
    roe = (stock.get("roe") or 0) * 100          # 0.20 -> 20
    roa = (stock.get("roa") or 0) * 100
    gm = (stock.get("gross_margin") or 0) * 100
    nm = (stock.get("net_margin") or 0) * 100
    growth = ((stock.get("revenue_growth") or 0) + (stock.get("profit_growth") or 0)) * 100
    raw = roe * 1.5 + roa * 1.0 + gm * 0.4 + nm * 1.0 + growth * 0.5
    return _clip(raw)


def valuation_score(stock: dict) -> float:
    # cheaper than sector => higher score. P/E relative to sector + absolute P/B sanity.
    pe = stock.get("pe") or 0
    sector_pe = stock.get("sector_pe") or 0
    pb = stock.get("pb") or 0
    if pe <= 0:
        pe_component = 0.0           # negative/zero earnings: no valuation credit
    elif sector_pe > 0:
        pe_component = _clip((sector_pe / pe) * 50)   # at sector P/E -> 50; half sector P/E -> 100
    else:
        pe_component = 50.0
    pb_component = _clip((2.0 / pb) * 50) if pb > 0 else 0.0  # P/B 2 -> 50; lower -> higher
    return _clip(pe_component * 0.6 + pb_component * 0.4)


def technical_score(stock: dict) -> float:
    # uptrend (price>sma50>sma200), healthy RSI, volume>avg => higher.
    price = stock.get("price") or 0
    sma50 = stock.get("sma50") or 0
    sma200 = stock.get("sma200") or 0
    rsi = stock.get("rsi") or 50
    vol_ratio = stock.get("vol_ratio") or 1.0
    trend = 0.0
    if price > sma50:
        trend += 30
    if sma50 > sma200:
        trend += 30
    rsi_component = 40 - abs(rsi - 55) * 1.5      # best near 55, falls off both ways
    vol_component = _clip((vol_ratio - 1.0) * 20)  # above-avg volume adds a little
    return _clip(trend + _clip(rsi_component) + vol_component * 0.0 + min(vol_component, 10))


def catalysts_score(stock: dict) -> float:
    # zero-weighted in v1 until the news layer exists.
    return 0.0


def compute_signals(stock: dict) -> dict:
    return {
        "fundamentals": fundamentals_score(stock),
        "valuation": valuation_score(stock),
        "technical": technical_score(stock),
        "catalysts": catalysts_score(stock),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_signals.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/scanner/__init__.py" "Financial analyze/backend/app/scanner/signals.py" "Financial analyze/backend/tests/scanner_fixtures.py" "Financial analyze/backend/tests/test_signals.py"
git commit -m "feat(scanner): deterministic fundamentals/valuation/technical sub-scores"
```

---

### Task 2: Score — weighted total, lean, rank

**Files:**
- Create: `app/scanner/score.py`
- Test: `tests/test_score.py`

**Interfaces:**
- Consumes: `compute_signals` output dict from Task 1.
- Produces:
  - `WEIGHTS = {"fundamentals":0.40,"valuation":0.30,"technical":0.30,"catalysts":0.0}`.
  - `score_stock(signals: dict) -> dict` → `{"total_score": float, "lean": "long"|"short"|"avoid"}`.
  - `rank(results: list[dict]) -> list[dict]` — sorts by `total_score` desc, sets `result["rank"]` (1-based), returns the list.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_score.py
from app.scanner import score as sc


def test_weighted_total():
    signals = {"fundamentals": 80, "valuation": 60, "technical": 40, "catalysts": 0}
    out = sc.score_stock(signals)
    # 80*.4 + 60*.3 + 40*.3 + 0 = 32 + 18 + 12 = 62
    assert out["total_score"] == 62.0


def test_lean_long_when_fundamentals_valuation_dominate():
    out = sc.score_stock({"fundamentals": 80, "valuation": 80, "technical": 30, "catalysts": 0})
    assert out["lean"] == "long"


def test_lean_short_when_technical_dominates():
    out = sc.score_stock({"fundamentals": 50, "valuation": 45, "technical": 95, "catalysts": 0})
    # total = 50*.4+45*.3+95*.3 = 20+13.5+28.5 = 62 (>=40); short_score 95 > long_score 47.5
    assert out["lean"] == "short"


def test_lean_avoid_when_total_below_40():
    out = sc.score_stock({"fundamentals": 20, "valuation": 20, "technical": 20, "catalysts": 0})
    assert out["lean"] == "avoid"


def test_rank_orders_desc_and_sets_rank():
    results = [
        {"symbol": "A", "total_score": 50.0},
        {"symbol": "B", "total_score": 80.0},
        {"symbol": "C", "total_score": 65.0},
    ]
    ranked = sc.rank(results)
    assert [r["symbol"] for r in ranked] == ["B", "C", "A"]
    assert [r["rank"] for r in ranked] == [1, 2, 3]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_score.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scanner.score`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/scanner/score.py
"""Deterministic scoring: weighted total, long/short/avoid lean, ranking.

Pure functions. No ORM, no LLM.
"""

WEIGHTS = {"fundamentals": 0.40, "valuation": 0.30, "technical": 0.30, "catalysts": 0.0}
AVOID_THRESHOLD = 40.0


def score_stock(signals: dict) -> dict:
    total = sum(signals.get(k, 0.0) * w for k, w in WEIGHTS.items())
    long_score = signals.get("fundamentals", 0.0) * 0.5 + signals.get("valuation", 0.0) * 0.5
    short_score = signals.get("technical", 0.0) * 1.0
    if total < AVOID_THRESHOLD:
        lean = "avoid"
    elif long_score >= short_score:
        lean = "long"
    else:
        lean = "short"
    return {"total_score": round(total, 2), "lean": lean}


def rank(results: list[dict]) -> list[dict]:
    ordered = sorted(results, key=lambda r: r["total_score"], reverse=True)
    for i, r in enumerate(ordered, start=1):
        r["rank"] = i
    return ordered
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_score.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/scanner/score.py" "Financial analyze/backend/tests/test_score.py"
git commit -m "feat(scanner): deterministic weighted total, lean, ranking"
```

---

### Task 3: Models — `ScanRun` and `ScanResult`

**Files:**
- Modify: `app/models/core.py` (append after the `Alert` class, ~line 120)
- Test: `tests/test_runner.py` (new file — model round-trip first)

**Interfaces:**
- Consumes: `Base` from `app.db`.
- Produces:
  - `ScanRun(id, started_at, mode, universe_size)`.
  - `ScanResult(id, run_id→scan_runs, symbol, scores(JSON), total_score(Float), lean(String), rank(Integer), verified(Boolean default False))`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_runner.py
from app.models.core import ScanRun, ScanResult


def test_scan_models_roundtrip(db):
    run = ScanRun(mode="manual", universe_size=2)
    db.add(run); db.flush()
    db.add(ScanResult(run_id=run.id, symbol="VNM",
                      scores={"fundamentals": 80, "valuation": 60, "technical": 40, "catalysts": 0},
                      total_score=62.0, lean="long", rank=1, verified=False))
    db.commit()
    row = db.query(ScanResult).one()
    assert row.symbol == "VNM" and row.lean == "long" and row.verified is False
    assert row.scores["fundamentals"] == 80
```

(If `tests/conftest.py` with the `db` fixture does not exist, create it:)
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

Run: `pytest tests/test_runner.py::test_scan_models_roundtrip -v`
Expected: FAIL — `ImportError: cannot import name 'ScanRun'`.

- [ ] **Step 3: Write minimal implementation**

Append to `app/models/core.py`:
```python
class ScanRun(Base):
    __tablename__ = "scan_runs"
    id = Column(Integer, primary_key=True, index=True)
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    mode = Column(String, default="manual")          # scheduled | manual
    universe_size = Column(Integer, default=0)

    results = relationship("ScanResult", back_populates="run", cascade="all, delete-orphan")


class ScanResult(Base):
    __tablename__ = "scan_results"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("scan_runs.id"), index=True, nullable=False)
    symbol = Column(String, index=True, nullable=False)
    scores = Column(JSON, default=dict)              # per-dimension sub-scores
    total_score = Column(Float, default=0.0)
    lean = Column(String, default="avoid")           # long | short | avoid
    rank = Column(Integer, default=0)
    verified = Column(Boolean, default=False)        # broad scan = always False

    run = relationship("ScanRun", back_populates="results")
```

Ensure `Boolean` is imported at the top of `core.py` (the import line currently lists `Column, Integer, BigInteger, String, Float, Date, DateTime, ForeignKey, JSON, func`). Change it to include `Boolean`:
```python
from sqlalchemy import (
    Column, Integer, BigInteger, String, Float, Boolean, Date, DateTime,
    ForeignKey, JSON, func,
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_runner.py::test_scan_models_roundtrip -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/models/core.py" "Financial analyze/backend/tests/test_runner.py" "Financial analyze/backend/tests/conftest.py"
git commit -m "feat(scanner): scan_runs + scan_results models"
```

---

### Task 4: Universe — fetch broad vnstock data

**Files:**
- Create: `app/scanner/universe.py`
- Test: `tests/test_universe.py`

**Interfaces:**
- Consumes: vnstock (network); the `stock` dict shape from Task 0.
- Produces: `fetch_universe(limit: int | None = None) -> list[dict]` — returns `stock` dicts, each with `verified=False`. Network failures per symbol are skipped (logged), never crash the run. `map_row(raw: dict) -> dict` — pure mapper from a vnstock record to the canonical `stock` dict (unit-testable without network).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_universe.py
from app.scanner import universe as u


def test_map_row_produces_canonical_stock():
    raw = {  # whatever vnstock field names the spike found — mapper normalizes them
        "ticker": "VNM", "exchange": "HOSE",
        "roe": 0.20, "roa": 0.12, "gross_margin": 0.42, "net_margin": 0.16,
        "revenue_growth": 0.10, "profit_growth": 0.12,
        "pe": 12.0, "pb": 2.0, "sector_pe": 18.0,
        "price": 66000, "sma50": 62000, "sma200": 60000, "rsi": 58, "vol_ratio": 1.3,
    }
    out = u.map_row(raw)
    assert out["symbol"] == "VNM"
    assert out["market"] == "HOSE"
    assert out["verified"] is False
    assert out["roe"] == 0.20 and out["pe"] == 12.0
    # catalysts placeholders present + zeroed
    assert out["news_count"] == 0 and out["news_sentiment"] == 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_universe.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scanner.universe`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/scanner/universe.py
"""Fetch the VN market universe + broad per-stock metrics from vnstock.

The ONLY module that touches the network. Output dicts are third-party data
tagged verified=False. Field names from the Task 0 spike — adjust map_row to match.

TRUST RULE: map_row pulls ONLY raw-number fields. It must NEVER copy a pre-baked
verdict/signal field (tcbsBuySellSignal, priceBreakOut52Week, rsi14Status) — those are
a third party's decision. Our signals.py/score.py compute the decision from raw inputs.
"""

# raw-input fields only (no third-party verdicts). Keys = our canonical names;
# values = the vnstock source field names (refine to the Task 0 spike output).
_FIELD_MAP = {
    "roe": "roe", "roa": "roa", "gross_margin": "grossProfitMargin",
    "net_margin": "netProfitMargin", "revenue_growth": "revenueGrowth1Year",
    "profit_growth": "epsGrowth1Year",
    "pe": "priceToEarning", "pb": "priceToBook", "sector_pe": "industryPe",
    "price": "price", "sma50": "sma50", "sma200": "sma200",
    "rsi": "rsi14", "vol_ratio": "volumeRatio",
}
# explicitly FORBIDDEN (verdicts — never map): tcbsBuySellSignal, priceBreakOut52Week, rsi14Status


def map_row(raw: dict) -> dict:
    """Pure: normalize one vnstock record to the canonical stock dict (raw inputs only)."""
    out = {
        "symbol": raw.get("ticker") or raw.get("symbol"),
        "market": raw.get("exchange") or raw.get("market") or "",
        "verified": False,
        "news_count": 0, "news_sentiment": 0.0,   # catalysts placeholder (zero-weighted v1)
    }
    for canon, src in _FIELD_MAP.items():
        # accept either the source name or the canonical name in the raw record
        out[canon] = raw.get(src, raw.get(canon))
    return out


def fetch_universe(limit: int | None = None) -> list[dict]:
    """Prefer the market-wide Screener (one call); fall back to per-symbol ratios."""
    from vnstock import Screener  # lazy import — keeps app boot independent
    try:
        df = Screener().stock(params={"exchangeName": "HOSE,HNX,UPCOM"}, limit=limit or 1700)
        rows = df.to_dict("records")
        return [map_row(r) for r in rows]
    except Exception as e:
        print(f"  scanner: screener unavailable ({e}); falling back to per-symbol")
        return _fetch_universe_per_symbol(limit)


def _fetch_universe_per_symbol(limit: int | None) -> list[dict]:
    from vnstock import Listing, Vnstock
    out: list[dict] = []
    listing = Listing().all_symbols()
    symbols = [r["ticker"] if isinstance(r, dict) else r for r in listing.to_dict("records")]
    if limit:
        symbols = symbols[:limit]
    for sym in symbols:
        try:
            v = Vnstock().stock(symbol=sym, source="VCI")
            ratio = v.finance.ratio(period="year").iloc[0].to_dict()
            out.append(map_row({"ticker": sym, **ratio}))
        except Exception as e:
            print(f"  scanner: skip {sym}: {e}")
    return out
```

Note: exact vnstock field names come from the Task 0 spike — refine `_FIELD_MAP` source names to match.
`map_row` is tested in isolation (no network); `fetch_universe` is covered indirectly via the runner test
with an injected universe. The forbidden-verdict list is enforced by `_FIELD_MAP` containing **only raw inputs**.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_universe.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/scanner/universe.py" "Financial analyze/backend/tests/test_universe.py"
git commit -m "feat(scanner): vnstock universe fetch + pure row mapper"
```

---

### Task 5: Runner — orchestrate + persist a scan

**Files:**
- Create: `app/scanner/runner.py`
- Test: `tests/test_runner.py` (extend)

**Interfaces:**
- Consumes: `universe.fetch_universe` (Task 4, injectable), `signals.compute_signals` (Task 1), `score.score_stock`+`rank` (Task 2), `ScanRun`+`ScanResult` (Task 3).
- Produces: `run_scan(db, mode: str = "manual", universe: list[dict] | None = None) -> dict` → `{"run_id": int, "count": int}`. If `universe` is None, calls `fetch_universe()`; tests inject a fixture universe so no network is hit. Persists one `ScanRun` + N `ScanResult` rows (all `verified=False`).

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_runner.py
from app.scanner.runner import run_scan
from app.models.core import ScanRun, ScanResult
from tests.scanner_fixtures import good_stock, weak_stock


def test_run_scan_persists_ranked_results(db):
    summary = run_scan(db, mode="manual", universe=[weak_stock(), good_stock()])
    assert summary["count"] == 2

    run = db.query(ScanRun).one()
    assert run.mode == "manual" and run.universe_size == 2

    results = db.query(ScanResult).order_by(ScanResult.rank).all()
    assert results[0].symbol == "VNM"        # good_stock ranks first
    assert results[0].rank == 1
    assert all(r.verified is False for r in results)
    assert results[0].total_score > results[1].total_score
    assert set(results[0].scores) == {"fundamentals", "valuation", "technical", "catalysts"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_runner.py::test_run_scan_persists_ranked_results -v`
Expected: FAIL — `ModuleNotFoundError: app.scanner.runner`.

- [ ] **Step 3: Write minimal implementation**

```python
# app/scanner/runner.py
"""Orchestrate one scan run: fetch -> signals -> score -> rank -> persist.

Deterministic except for the universe fetch (network), which is injectable for tests.
"""
from . import signals, score
from .universe import fetch_universe
from ..models.core import ScanRun, ScanResult


def run_scan(db, mode: str = "manual", universe: list[dict] | None = None) -> dict:
    stocks = universe if universe is not None else fetch_universe()

    run = ScanRun(mode=mode, universe_size=len(stocks))
    db.add(run)
    db.flush()

    scored = []
    for stock in stocks:
        sig = signals.compute_signals(stock)
        sc = score.score_stock(sig)
        scored.append({"symbol": stock["symbol"], "scores": sig,
                       "total_score": sc["total_score"], "lean": sc["lean"]})

    for r in score.rank(scored):
        db.add(ScanResult(run_id=run.id, symbol=r["symbol"], scores=r["scores"],
                          total_score=r["total_score"], lean=r["lean"], rank=r["rank"],
                          verified=False))
    db.commit()
    return {"run_id": run.id, "count": len(scored)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_runner.py -v`
Expected: PASS (model round-trip + run_scan).

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/scanner/runner.py" "Financial analyze/backend/tests/test_runner.py"
git commit -m "feat(scanner): run_scan orchestration persists ranked results"
```

---

### Task 6: Routes — `POST /api/scan`, `GET /api/scan/latest`

**Files:**
- Create: `app/routes/scan.py`
- Modify: `app/main.py` (register router)
- Test: `tests/test_scan_route.py`

**Interfaces:**
- Consumes: `run_scan` (Task 5); `ScanRun`/`ScanResult` (Task 3); `get_db` from `app.db`.
- Produces:
  - `POST /api/scan` body `{"limit": int | null}` → `{"run_id","count"}` (manual scan; passes `limit` to the universe fetch via `run_scan` — for tests, inject through a small indirection).
  - `GET /api/scan/latest` → `{"run_id", "started_at", "results": [{"symbol","total_score","lean","rank","verified","scores"}]}` for the most recent run, ordered by rank.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_scan_route.py
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.db import Base, get_db
from app.models import core  # noqa: F401
from app.models.core import ScanRun, ScanResult


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
    # seed a completed run directly (route test focuses on GET latest)
    s = Session()
    run = ScanRun(mode="manual", universe_size=2); s.add(run); s.flush()
    s.add(ScanResult(run_id=run.id, symbol="VNM", scores={"fundamentals": 80, "valuation": 60, "technical": 40, "catalysts": 0},
                     total_score=62.0, lean="long", rank=1, verified=False))
    s.add(ScanResult(run_id=run.id, symbol="XYZ", scores={"fundamentals": 20, "valuation": 20, "technical": 20, "catalysts": 0},
                     total_score=20.0, lean="avoid", rank=2, verified=False))
    s.commit(); s.close()
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_get_latest_returns_ranked_results(client):
    resp = client.get("/api/scan/latest")
    assert resp.status_code == 200
    body = resp.json()
    assert body["results"][0]["symbol"] == "VNM"
    assert body["results"][0]["rank"] == 1
    assert body["results"][0]["lean"] == "long"
    assert body["results"][0]["verified"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_scan_route.py -v`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Write minimal implementation**

```python
# app/routes/scan.py
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models.core import ScanRun, ScanResult
from ..scanner.runner import run_scan

router = APIRouter()


class ScanIn(BaseModel):
    limit: int | None = None


@router.post("/scan")
def trigger_scan(body: ScanIn, db: Session = Depends(get_db)):
    universe = None  # production: fetch_universe(limit); kept simple here
    return run_scan(db, mode="manual", universe=universe)


@router.get("/scan/latest")
def latest(db: Session = Depends(get_db)):
    run = db.query(ScanRun).order_by(ScanRun.id.desc()).first()
    if not run:
        return {"run_id": None, "started_at": None, "results": []}
    rows = (db.query(ScanResult)
              .filter(ScanResult.run_id == run.id)
              .order_by(ScanResult.rank).all())
    return {
        "run_id": run.id,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "results": [{"symbol": r.symbol, "total_score": r.total_score, "lean": r.lean,
                     "rank": r.rank, "verified": r.verified, "scores": r.scores} for r in rows],
    }
```

In `app/main.py`, register the router alongside the existing ones:
```python
from .routes import market, scan
# after app creation / other includes:
app.include_router(scan.router, prefix="/api", tags=["scanner"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_scan_route.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "Financial analyze/backend/app/routes/scan.py" "Financial analyze/backend/app/main.py" "Financial analyze/backend/tests/test_scan_route.py"
git commit -m "feat(scanner): POST /api/scan + GET /api/scan/latest"
```

---

### Task 7: Scheduled scan job

**Files:**
- Modify: `app/services/scheduler.py`
- Test: `tests/test_scheduled_scan.py`

**Interfaces:**
- Consumes: `run_scan` (Task 5); `SessionLocal` from `app.db`.
- Produces: `scheduled_scan()` — opens a DB session, calls `run_scan(db, mode="scheduled")`, closes it. Registered as an APScheduler interval job in `start()`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_scheduled_scan.py
from unittest.mock import patch
from app.services import scheduler


def test_scheduled_scan_calls_run_scan():
    with patch("app.services.scheduler.run_scan", return_value={"run_id": 1, "count": 0}) as m, \
         patch("app.services.scheduler.SessionLocal") as Sess:
        scheduler.scheduled_scan()
        assert m.called
        # mode must be "scheduled"
        assert m.call_args.kwargs.get("mode") == "scheduled" or "scheduled" in m.call_args.args
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_scheduled_scan.py -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'scheduled_scan'`.

- [ ] **Step 3: Write minimal implementation**

Add to `app/services/scheduler.py` (top: ensure `from ..db import SessionLocal` exists; add `from ..scanner.runner import run_scan`):
```python
def scheduled_scan():
    db = SessionLocal()
    try:
        run_scan(db, mode="scheduled")
        print("✓ scheduled scan complete")
    except Exception as e:
        print(f"  scheduled scan failed: {e}")
    finally:
        db.close()
```

In `start()`, after the existing price-refresh job registration, add:
```python
    _scheduler.add_job(scheduled_scan, "interval", hours=24, id="scheduled_scan")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_scheduled_scan.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pytest -v`
Expected: PASS (all scanner tests).

- [ ] **Step 6: Commit**

```bash
git add "Financial analyze/backend/app/services/scheduler.py" "Financial analyze/backend/tests/test_scheduled_scan.py"
git commit -m "feat(scanner): daily scheduled scan job"
```

---

## Self-Review

**Spec coverage (tier 1 scope):**
- Broad scan via vnstock, tagged unverified → Task 0 spike + Task 4 `universe.py` (`verified=False`). ✓
- 4 deterministic dimensions (catalysts zero-weighted) → Task 1 `signals.py` (catalysts returns 0.0). ✓
- Deterministic weighted total + long/short/avoid lean + rank → Task 2 `score.py`. ✓
- Scoring path has NO LLM → Tasks 1-2 are pure functions; no LLM import anywhere. ✓
- `scan_runs` + `scan_results` models, `verified=False` → Task 3. ✓
- Orchestration scheduled + on-demand → Task 5 `run_scan` + Task 6 POST + Task 7 scheduled job. ✓
- Routes `POST /api/scan`, `GET /api/scan/latest` → Task 6. ✓
- Deterministic tests fixture→known scores/rank/lean → Tasks 1,2,5. ✓
- vnstock feasibility spike first → Task 0. ✓
- Tier 2 (deep-dive) excluded → not present. ✓ (Screener UI wiring is frontend/artifact work, out of this backend plan — noted below.)

**Placeholder scan:** No TBD/TODO. Task 4 explicitly defers exact vnstock field names to the Task 0 spike output with a concrete fallback `stock` dict and an isolated, network-free `map_row` test — this is a real dependency handoff, not a placeholder. Task 6 `POST /api/scan` uses `universe=None` (production fetch) and the route test targets `GET latest` (the deterministic path) — intentional, stated.

**Type consistency:** `stock` dict keys identical across Tasks 0/1/4. `compute_signals` returns the 4-key dict consumed by `score_stock` (Task 2) and `run_scan` (Task 5). `score_stock` → `{total_score, lean}`; `rank` adds `rank`; `run_scan` → `{run_id, count}`; all consistent. `ScanResult` fields (scores/total_score/lean/rank/verified) match what Task 5 writes and Task 6 reads.

**Known scope note:** Wiring the existing Screener UI page to `GET /api/scan/latest` is presentation-tier work (done in the design artifact, per project workflow) — out of this backend plan. The backend contract it consumes is delivered by Task 6.
