# Core Design — Business + Data Tier (Mac)

The thin spine. Python/FastAPI on the Mac. Serves the presentation, stores data, talks to the
external OCR system over a port. Builds to `API_CONTRACT.md` (UI side) + `OCR_PROTOCOL.md` (OCR side).

## Locked decisions (2026-06-22)
- **Serving:** FastAPI serves the static website itself (`StaticFiles`). One process, one origin, no CORS.
- **OCR orchestration:** **async + poll**. Submit → job_id → poll status. UI polls document status.
- **OCR stub:** in-process stub behind `ocr_client` interface; `ocr_worker_url` empty → stub, set → real host.
- **Storage:** SQLite (8-table schema, drafted) + `uploads/` on filesystem (DB stores paths, not files).
- **Tier 2 ↔ Tier 3 access (2026-06-24): Direct ORM + pure-core.** Business logic uses the SQLAlchemy
  `Session` directly (`db.query/add/commit`); the session arrives via `Depends(get_db)` in routes and is
  **passed as an argument** to services (e.g. `reconcile_statement(db, id)`, `run_scan(db, ...)`) — no global
  session. **No repository layer** (SQLAlchemy ORM is already the abstraction; a repo wrapper = over-engineering
  for a single-user SQLite tool). The clean separation that matters: **the real logic is PURE functions over
  plain dicts/dataclasses** (`recon.reconcile(items)`, `scanner.signals/score`) that never touch the DB; a thin
  **ORM bridge** loads rows → calls the pure function → persists results (`reconcile_statement` = bridge,
  `reconcile` = pure). Keeps business rules out of the data layer and DB queries out of the pure logic.
- **Deferred:** reconciliation, market prices (secondary), AI/Hermes, alerts, Slack.

## Responsibilities (minimal)
1. Serve the website.
2. Ingest documents (save file + `documents` row).
3. Orchestrate OCR over the port (mock now).
4. Persist `statements` + `line_items`.
5. Serve parsed data back to the UI.
6. **Expose an MCP server** (financial tools) for the Hermes Agent brain — calc/data/obsidian.
   The Core does **not** run an agent loop; Hermes Agent does (see `HERMES_BRAIN.md`).
7. **Proactive trigger:** after OCR parse, ping the Hermes Agent API to analyze + write the vault.

## Data flow
```
UI upload → POST /api/documents            (save file, status=queued)
          → ocr_client.submit(doc)         → job_id           (background task)
          → poll: triaging→extracting→done
          → ocr returns rows (mock VNM)
          → write statements + line_items   (status=unverified)
UI poll   → GET /api/documents/{id}         (status)
UI fetch  → GET /api/statements/{id}        (rows for review table)
```

## Module layout (backend/app)
```
main.py            FastAPI app: lifespan, StaticFiles mount, routers
config.py          settings (ocr_worker_url, ocr_shared_secret, ...)    [done]
db.py              engine/session/init_db                               [done]
models/core.py     8 tables                                             [done]
seed.py            instruments seed                                     [done — only if market kept]
routes/
  market.py        quotes/history/indices/instruments  (secondary)     [done]
  documents.py     POST /documents, GET /documents[/id], POST /{id}/ocr [TODO]
  statements.py    GET /statements/{id}                                 [TODO]
services/
  ocr_client.py    submit()/poll() — picks stub vs real by config       [TODO]
  ocr_stub.py      mock VNM rows (incl. planted 270 error)              [TODO]
  market.py        vnstock + yfinance                                   [done]
  scheduler.py     price refresh (only if market kept)                  [done]
mcp/               MCP server for Hermes Agent (calc/data/obsidian tools) [TODO — Stage 3]
```

## Endpoints (Core) — see API_CONTRACT.md for shapes
- `GET /health`
- `POST /api/documents` (multipart) → `{id,status}`
- `GET /api/documents` · `GET /api/documents/{id}`
- `POST /api/documents/{id}/ocr` → triggers OCR, returns rows when done
- `GET /api/statements/{id}` → statement + line_items
- `GET /api/instruments|quote|history|indices` (market, secondary)
- Static `/` → serves the website

## Build order (when approved)
1. `documents.py` + `ocr_client.py` + `ocr_stub.py` — ingest + mock OCR end-to-end.
2. `statements.py` — serve parsed rows.
3. Mount `StaticFiles` to serve the UI from FastAPI.
4. Wire UI `HelixAPI` calls (in artifact) to these endpoints; flip mock→live per page.
5. (later) recon, market, AI, alerts, Slack.

## Open (data tier) — still to decide
- **Multi-period statements:** one `statements` row = one period. Comparison (kỳ này/kỳ trước) — store
  prev as a column on line_items (current) vs separate period rows. Affects analysis later.
