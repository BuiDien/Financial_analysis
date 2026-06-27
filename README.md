# Distributed Financial Analysis System

A self-hosted platform that turns scanned Vietnamese financial statements and live market data into **verified, structured financial insight** — running entirely on local hardware, with a built-in layer that catches reading errors before they reach any analysis.

> **Status:** design & planning complete; implementation starting. This repository currently holds the full system design, specifications, and TDD implementation plans (see [`docs/`](docs/)).

---

## What it does

The system is a **stock scanner and analysis tool for the Vietnamese market (HOSE/HNX/UPCOM)** — built as a funnel:

```
SCAN  (broad, shallow)   →   shortlist   →   DEEP-DIVE  (narrow, deep, verified)
whole VN market via vnstock                  OCR statements + reconcile + AI analysis
deterministic screening                      thesis · horizon range · review triggers
```

It answers the questions that matter to a long-term investor: **what is worth buying, long-term or short-term, and roughly how long to hold** — without ever fabricating a number.

## The core idea: trust nothing until verified

Vietnamese financial statements are usually distributed as **scanned, image-only PDFs**. Numbers must be recognized from pixels, and a single misread digit silently corrupts every ratio built on it.

This system treats every extracted number as a **draft** until it has been checked against the statement's own internal accounting identities (TT200 chart of accounts — totals must equal the sum of their parts). Only verified data flows into analysis. A wrong reading shows up as a total that does not balance — and is either auto-repaired or flagged for review.

This principle runs through the whole design:
- **OCR output** is reconciled before it is trusted.
- **Scanner scores** are computed by deterministic Python — never invented by an LLM.
- **The AI brain narrates; it never calculates.**

## Architecture

Two machines, one trust boundary.

```
Mac (M2 Max, 64GB)                                   GPU laptop (RTX 4070, 8GB)
┌ Presentation — web dashboard + AI sidebar          ┌ OCR engine ──────────────┐
│ Core (FastAPI) — serve UI · ingest · SQLite        │ PP-DocLayout +            │
│   · MCP tool server · market scanner               │ PaddleOCR-VL              │
│   ├─ Ollama → Hermes Agent (Qwen3 35B)  [brain]    └──────────▲────────────────┘
│   └─ OCR port ─────────────────────────────────────────────────┘
│ Data — SQLite + Obsidian vault + uploads/
└──────────────────────────────────────────────────────┘
```

- **Laptop reads pixels → rows (untrusted).** **Mac structures + verifies (trust lives here).** The two-machine boundary *is* the trust boundary.
- **Three tiers** — presentation, business logic, data — with dependencies flowing strictly downward.
- **The brain** is [Hermes Agent](https://github.com/NousResearch/hermes-agent) running Qwen3 35B locally, given financial tools via an **MCP server** and an **Obsidian vault** as its memory + report store.
- **Fully local** — sensitive financial data never leaves the user's network (only market-data fetching and optional news search reach the internet).

## Components

| Layer | Runs on | Technology |
|---|---|---|
| Presentation | Mac (served by Core) | Web dashboard (React-in-browser), AI sidebar |
| Business logic | Mac | Python, FastAPI, SQLAlchemy |
| Market data | Mac | vnstock (VN equities), yfinance (gold/US) |
| OCR engine | Laptop (RTX 4070) | PP-DocLayout + PaddleOCR-VL |
| AI brain | Mac (M2 Max) | Hermes Agent + Qwen3 35B via Ollama |
| Data | Mac | SQLite + Obsidian vault + filesystem |

## Key subsystems

- **Reconciliation engine** — verifies OCR data against TT200 accounting identities; back-solves single-error groups, flags ambiguous ones, keeps a human in the loop. ([spec](docs/specs/2026-06-23-reconciliation-engine-design.md) · [plan](docs/plans/2026-06-23-reconciliation-engine.md))
- **VN market scanner** — deterministic, market-wide screening on fundamentals / valuation / technical signals; ranks candidates as long / short / avoid. ([spec](docs/specs/2026-06-23-vn-market-scanner-design.md) · [plan](docs/plans/2026-06-23-vn-market-scanner-tier1.md))
- **OCR document workflow** — turns a multi-page scanned BCTC into three clean statements (CĐKT / KQKD / LCTT) with correct Mã số line items. ([spec](docs/specs/2026-06-24-ocr-document-workflow-design.md) · [plan](docs/plans/2026-06-24-ocr-document-workflow.md))
- **Hermes brain** — agentic analysis grounded in verified data, writing linked reports into an Obsidian vault. ([design](docs/design/HERMES_BRAIN.md))

## Documentation

Everything lives in [`docs/`](docs/) — start with [`docs/README.md`](docs/README.md) for the full index.

- [`docs/PLAN.md`](docs/PLAN.md) — master build plan & sequence
- [`docs/system_description.md`](docs/system_description.md) — original system spec
- [`docs/design/`](docs/design/) — architecture & contracts
- [`docs/specs/`](docs/specs/) — feature design specs
- [`docs/plans/`](docs/plans/) — TDD implementation plans

## Build sequence

```
Stage 0  environment & repo
Stage 1  presentation on mock data        ✅
Stage 2  Core skeleton boots              ← foundation
Stage 3  document pipeline + OCR (stub)
Stage 4  reconciliation engine            (plan ready)
Stage 5  market scanner — broad scan      (plan ready)
Stage 6  Hermes brain (MCP tools + skills)
Stage 7  connect tiers (mock → live)
Stage 8  news/search, deep-dive, real OCR worker, …
```

## Design principles

- **Fully local** — no cloud OCR/analysis costs; data stays on the network.
- **Trust nothing until verified** — raw OCR is a draft; reconciliation gates analysis.
- **Spend compute only where it pays off** — cheap page triage so the GPU model only reads real tables.
- **Keep a human in the loop** — surface uncertain figures rather than silently accepting them.
- **Separate concerns cleanly, but don't over-split** — one coherent core, exactly one justified service split (the GPU).

---

*Built for a single investor who needs trustworthy figures out of documents that resist automation.*
