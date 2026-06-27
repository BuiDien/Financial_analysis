# Discussion Backlog — topics + references to revisit

Parked topics and external references to discuss/evaluate later. Not yet decided.

## Topics to revisit
1. **Reconciliation engine** — IN DISCUSSION NOW (see brainstorm below / `RECON_BRAINSTORM.md`).
2. **Alerts / Slack bot** — spec has both; Slack = "decide later". Dashboard alerts maybe enough.
3. **Market data (vnstock)** — secondary/uncertain. In or out? Drives dashboard/detail + scheduler.
4. **Multi-company / watchlist** — how to organize tracking many companies over time (vault + UI).
5. **News / search context layer** — NOTED in PLAN.md Stage 5 (RSS + SearXNG + Trafilatura MCP tools,
   Camoufox reserved). Build after core.

## External references — evaluated
- **anthropics/financial-services** — borrow methodology/structure (done: `SKILL_INTEGRATION.md`).
- **ZhuLinsen/daily_stock_analysis** (48k★, LLM daily stock analysis → dashboard → notifications, A-share-centric)
  — **DECIDED (2026-06-23): borrow patterns, not code.** Adopt: (1) decision-report **output schema**
  (conclusions, scores, trends, entry/exit points, risk alerts, catalysts, action checklist) → shape for
  Hermes `save_report`; (2) **news/search** approach (already uses SearXNG/Tavily/SerpAPI/Brave — confirms
  our news layer); (3) **daily-run cadence** → proactive analysis schedule. Skip: A-share data sources, its
  app structure, technical-trading focus (we're fundamentals/statements).
- **bytedance/deer-flow** (LangGraph multi-agent harness: agent loop, sub-agents, skills, memory, MCP, gateway)
  — **DECIDED (2026-06-23): NOT adopted / skipped.** It *competes with* Hermes Agent (same category — an
  agent runtime), not a bolt-on. Keeping Hermes Agent as the brain. Confirmed deer-flow could fill every slot
  (Qwen via Ollama, MCP, skills, gateway API, vault) and the Mac could run both — skip reason is **redundancy**,
  not hardware. Both integrate with Claude Code/Codex (so that's a non-difference). Only borrow the
  **deep-research workflow pattern** (plan → search → synthesize → report) as a Hermes *skill*. No framework swap.
  *(Possible future: run deer-flow as a SEPARATE heavy deep-research engine — a different job from the financial
  brain — if that need ever arises. Parked, not planned.)*

- **Panniantong/Agent-Reach** — https://github.com/Panniantong/Agent-Reach
  **EVALUATED (2026-06-24): park as a Stage-8 news/deep-dive option.** Unified content-access CLI — gives an
  agent "eyes on the internet": web→clean text (Jina Reader), RSS, YouTube transcripts, Twitter/X, Reddit,
  GitHub, **Xueqiu** (Chinese stock community), etc. Multi-backend with fallbacks, free (cookie auth), local
  creds, works with any shell-capable agent incl. **Hermes Agent (runs shell)**.
  - **Fit:** the news/search/deep-dive research layer (same slot as RSS/SearXNG/Trafilatura) — could *be* the
    research-fetch tool instead of hand-rolling them. Hermes calls one CLI for "read URL / get feed / fetch thread".
  - **Borrow either way:** its multi-backend **fallback pattern** (primary fails → next) for scraping resilience.
  - **Catches:** NO Vietnamese source built in (Xueqiu=Chinese) — still add VN RSS (CafeF/Vietstock) yourself;
    heavy deps (yt-dlp, gh, twitter-cli…); dual-use scraping (respect robots/ToS). Defer to Stage 8; test on VN sites first.
  - **DECIDED (2026-06-24): role + connection.** News/Agent-Reach used **deep-dive ONLY** (Hermes, scanner tier 2) —
    the **scanner stays pure-deterministic, catalyst dimension stays zero-weighted** (preserves "deterministic
    scoring, no LLM in scan" trust principle). Connection = **direct shell from Hermes** (`agent-reach fetch/get-rss …`),
    NO MCP wrapping needed (only needed if the Python scanner consumed news, which it won't). Deep-dive dossier
    cites provenance: **verified** (reconciled statements) vs **researched** (web, cited URL) — borrowed "cite every number" guardrail.

## How to use
When a topic comes up, pull it here → discuss → record the decision in the relevant doc
(`PLAN.md`, `HERMES_BRAIN.md`, etc.) → mark resolved here.
