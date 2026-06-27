# Distributed Financial Analysis System

*A self-hosted platform that turns scanned financial statements and live market data into verified, structured financial insight — running entirely on local hardware, with a built-in layer that catches reading errors before they reach any analysis.*

---

## Overview

The Distributed Financial Analysis System is a personal, fully local platform for collecting, reading, verifying, and analyzing financial data. It is built for a single user who needs trustworthy figures out of documents that resist automation — specifically Vietnamese financial statements, which are typically distributed as scanned, image-only PDFs.

The system is distributed across two machines that play distinct roles. A Mac acts as the coordinating core: it schedules work, fetches market data, runs the verification logic, drives the analysis, and serves the interface. A laptop with an RTX 4070 GPU acts as a dedicated accelerator that handles the computationally heavy job of reading documents. The two communicate over the local network, and because all processing and storage happen on the user's own hardware, sensitive financial data never leaves their network.

What sets the system apart from a simple "scan and OCR" tool is that it treats extracted numbers as untrusted until they have been checked against the internal logic of the document itself. Only verified data flows into analysis.

## The Problem It Solves

Financial statements in Vietnam are usually shared as scanned images with no underlying text layer, so the numbers cannot simply be copied out — they have to be recognized from pixels. This creates three compounding problems.

First, extraction is hard. Optical character recognition on dense, multi-column financial tables is error-prone, and Vietnamese text adds diacritics that weaker models frequently misread.

Second, errors are dangerous and invisible. A single digit misread on a balance sheet — an 8 recognized as a 3 — does not announce itself. It silently propagates into every ratio, comparison, and conclusion built on top of it. For financial data, a confident-but-wrong number is worse than no number at all.

Third, doing it manually is slow and does not scale. Transcribing statements by hand is tedious, and the boredom itself introduces mistakes.

This system automates the extraction while specifically defending against the second problem. It uses the structure of a financial statement — the fact that totals must equal the sum of their parts — as an automatic correctness check, so the data that reaches analysis is data the user can rely on.

## Design Principles

The architecture is guided by a few deliberate choices:

- **Fully local.** Avoid cloud OCR and analysis costs, keep financial data on the user's network, and keep the core pipeline working even without an internet connection. The only unavoidable external connections are market-data fetching and Slack.
- **Trust nothing until it is verified.** Treat raw OCR output as a draft, not a fact. Gate all analysis behind a reconciliation step.
- **Spend compute only where it pays off.** Use cheap filtering to ensure the expensive GPU model only processes the pages that actually contain data.
- **Keep a human in the loop.** Surface uncertain figures for quick review rather than silently accepting them.
- **Separate concerns cleanly, but do not over-split.** Keep the core a single coherent application, and only break a component out into its own service when there is a real reason to — in this case, the GPU.

## System Architecture

The system follows a classic three-layer (three-tier) architecture, with dependencies flowing strictly downward: the interface depends on the logic, the logic depends on the data, and never the reverse.

### Layer 1 — Presentation (Interface)

The layer the user interacts with. It holds no business logic; it only displays data and captures input. It consists of a web dashboard for viewing live prices, browsing parsed statements, watching processing progress, and reviewing or correcting flagged figures, plus a Slack bot for chat commands and push alerts. The dashboard talks to the core through a REST interface for on-demand data and a WebSocket connection for live streaming updates.

### Layer 2 — Business Logic (Mac Core)

The brain of the system, implemented as a Python/FastAPI application on the Mac. It owns scheduling and orchestration, market-data fetching (using vnstock for Vietnamese equities and yfinance for gold and US tickers), routing of documents to the GPU worker, the reconciliation engine, AI analysis routing, and alert logic. It also serves the dashboard and exposes the REST and WebSocket interfaces that Layer 1 consumes.

Within this layer sits one specialized worker, extracted onto the laptop:

**The OCR Engine (GPU worker).** Running on the RTX 4070, this is a separate FastAPI service responsible for reading documents. It is the one component justified in being split off from the core, because high-performance OCR genuinely needs the laptop's CUDA hardware — a real physical boundary rather than an architectural preference. The core calls it across the network and treats it as a black box that takes a document and returns structured data.

### Layer 3 — Data (Storage)

Storage and retrieval only, with no business rules. A local SQLite database holds price time series, parsed statement line items, reconciliation status, correction history, job state, and alert configuration. Raw documents live on the filesystem, with the database storing their paths rather than the files themselves.

### How the Two Machines Communicate

The Mac and the laptop communicate through an asynchronous job interface rather than a blocking request. When the core has a document to process, it posts the file to the laptop and immediately receives a job identifier; the laptop queues the work and processes it in the background while the core stays responsive. The core then either polls for the result or receives it pushed over a WebSocket. The laptop is addressed by its local network hostname so a changing IP address does not break the link, every request carries a shared secret so no stray device on the network can reach the endpoint, and documents are sent as direct file uploads rather than embedded in JSON. This asynchronous design means the coordinating core never stalls while the GPU grinds through a large document.

## The Processing Pipeline

A document moves through six stages, split across the two machines.

**1. Ingest.** A scanned statement arrives — uploaded through Slack or picked up from a watchlist — and the core hands it off to the GPU worker.

**2. Triage.** Because the documents are image-only, there is no text to filter on, and most pages of a statement are narrative notes the system does not need. A lightweight layout-detection model runs on every page on the GPU — cheap enough that no page is blindly skipped — and identifies where the actual tables are. Rather than guessing whether a whole page is useful, it detects table regions directly, which is far more reliable. The filter is deliberately biased toward keeping pages, because the cost of accidentally skipping a real statement page is far higher than the cost of processing one extra page.

**3. Extract.** Only the detected table regions are passed to a vision-language OCR model, which reads them and returns structured output, preserving the standard Vietnamese account codes (Mã số) that label every line. By recognizing cropped regions instead of whole pages, the expensive model does the minimum work necessary, which keeps it fast even on modest hardware.

**4. Verify.** This is the heart of the system. Vietnamese statements follow a standardized chart of accounts, so every line carries a code, and those codes imply a web of accounting identities — total assets equals the sum of current and long-term assets, assets equal liabilities plus equity, subtotals roll up from their line items, and figures cross-check between statements and between periods. The reconciliation engine checks the extracted numbers against these identities, with a small tolerance to absorb rounding and unit declarations. When a group fails to reconcile but only one value in it was read with low confidence, the engine can back-solve the correct figure from the others and repair it automatically. Only genuinely ambiguous cases — where two or more values in a group are uncertain — are flagged for human review. A wrong reading therefore does not slip through silently; it shows up as a total that does not balance.

**5. Analyze.** Verified data, and only verified data, is passed to a local language model (Hermes) for financial insight — summaries, period comparisons, and anomaly detection. The model sits behind a clean internal interface, so the rest of the system does not depend on its implementation and it can be swapped or upgraded freely. Because the GPU laptop has limited memory, the OCR model and the analysis model share the GPU in time rather than running at once: the pipeline is naturally sequential, so OCR runs during extraction and the language model runs later during analysis, each getting the full GPU when it is its turn.

**6. Present.** Results appear on the dashboard, updating live over the WebSocket, and trigger Slack alerts when configured conditions are met. The dashboard also exposes a review panel where flagged figures can be corrected by hand; those corrections are written back to the database and the reconciliation is re-run, closing the human-in-the-loop.

## Data Model (Sketch)

| Table | Purpose |
|---|---|
| `instruments` | Tracked symbols and their market (HOSE/HNX/gold/US) |
| `prices` | Daily price and volume history per instrument |
| `documents` | Ingested files, their type, and processing status |
| `statements` | Parsed statements with kind, period, and reporting unit |
| `line_items` | Individual lines with account code, value, OCR confidence, and status |
| `recon_flags` | Reconciliation failures awaiting resolution |
| `corrections` | History of manual edits, for audit |
| `alerts` | User-defined alert conditions and channels |

## Technology Stack

| Layer | Runs on | Core technology |
|---|---|---|
| Presentation | Mac (served) | Web dashboard (HTML/CSS/JS), Slack bot |
| Business logic | Mac | Python, FastAPI, Uvicorn, vnstock, yfinance |
| OCR worker | Laptop (RTX 4070, 8GB) | PP-DocLayout, PaddleOCR-VL (via vLLM) |
| AI analysis | Laptop / Mac | Hermes (local open-weight LLM, served via Ollama) |
| Data | Mac | SQLite, local filesystem |

## Build Roadmap

The system is designed to be built in phases, each producing something usable before the next begins.

1. **Foundation** — the FastAPI core skeleton, the SQLite schema, and the market-data fetcher. Everything else hangs off this spine.
2. **OCR engine** — the GPU worker, comprising the layout-triage step and the vision-language extraction, plus the asynchronous job bridge connecting it to the core.
3. **Reconciliation** — the account-code rule engine, including back-solving and the flagging of ambiguous figures.
4. **Interface** — wiring the dashboard to the core's REST and WebSocket interfaces, adding the correction workflow, and connecting the Slack bot.

Two short validation spikes are worth running before full development begins: confirming that the chosen market-data source returns the intended tickers, and running the OCR model on a handful of real statements to confirm the extraction quality is good enough to build on.

## Notable Characteristics

- **Fully local**, with financial data never leaving the user's network and no per-use cloud costs.
- **Self-verifying**, turning the structure of a financial statement into a built-in error check rather than trusting raw OCR.
- **Efficient on modest hardware**, through cheap page triage and region-level extraction that keep the GPU workload minimal.
- **Human-in-the-loop**, surfacing uncertain figures for review in a way appropriate to financial data.
- **Cleanly layered**, with a single coherent core and exactly one justified service split — the GPU worker — kept from sprawling into unnecessary complexity.
