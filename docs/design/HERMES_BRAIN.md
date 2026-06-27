# Hermes Brain — Design (Hermes-Agent-native)

The brain is **Hermes Agent** (NousResearch's self-improving agentic CLI — Claude-Code-like), running
on the Mac with **Qwen3 35B** via Ollama. It already provides the agent loop, a skills system, MCP
client, memory, and an OpenAI-compatible API server. **We don't build an agent loop** — we plug into it:
1. write VN financial **skills** into its skills dir, 2. expose our financial **tools** as an **MCP server**
from the Core, 3. point the website chat at its **API server**.

Repo: github.com/NousResearch/hermes-agent · docs: hermes-agent.nousresearch.com/docs

## Locked decisions (2026-06-22)
- Brain = **Hermes Agent**, model **Qwen3 35B** (Ollama), on the **Mac (M2 Max 64GB)**. GPU laptop = OCR only.
- **Tools via MCP** (Hermes Agent is MCP-native) — the Core runs an MCP server. *(supersedes the old
  "Path 1 Python tool-calling, MCP later" — MCP is now the path.)*
- **Skills** live in `~/.hermes/skills/`, agentskills.io standard (`SKILL.md` + frontmatter). VN skills
  adapted from `anthropics/financial-services` (`financial-analysis` vertical).
- **Website chat → Hermes Agent API server** (`/v1/chat/completions`, OpenAI-compatible, `API_SERVER_KEY`).
  `src/api-client.jsx :: hermesComplete()` already speaks this shape.
- **Code calculates, Hermes narrates** — math lives in MCP tools (Python), never in the model.
- **Obsidian vault on the Mac** = memory + reports. Hermes Agent already has the vault; structured
  statement/report notes written via MCP obsidian tools (or a skill).
- **Proactive:** OCR parse done → Core pings the Hermes Agent API ("analyze statement N") → Hermes runs
  the skill + MCP tools → writes vault.
- **Per-company first**, cross-company later.

## Topology
```
Mac (M2 Max, 64GB)
  Hermes Agent (Qwen3 35B) ── ~/.hermes/skills/ + MCP client + API server :PORT + Obsidian vault
        ▲ MCP (config.yaml)                         ▲ /v1/chat/completions
        │                                           │
  Core (FastAPI) ── MCP server (financial tools) ───┘ serves UI + SQLite + OCR pipeline
        ▲ HelixAPI (data)              ▲ chat
  Website ─────────────────────────────┘
GPU laptop (RTX 4070): OCR system  ◄── Core OCR port
```
Boundaries: UI↔Core (`API_CONTRACT.md`) · Core↔OCR (`OCR_PROTOCOL.md`) · Hermes↔Core-tools (MCP) ·
Website↔Hermes (API server). Brain + Core both on the Mac.

## What we build vs what Hermes Agent gives
| Concern | Provided by Hermes Agent | We build |
|---|---|---|
| Agent loop / reasoning | ✅ | — |
| Skill discovery + slash commands | ✅ `~/.hermes/skills/` | the VN skill `.md`s |
| Tool calling | ✅ MCP client | the **MCP server** (Core) + its tools |
| Memory / sessions | ✅ | — |
| Website ↔ brain | ✅ API server | point `hermesComplete()` at it |
| Model | ✅ Ollama Qwen3 35B | — |

## MCP server (the Core's job)
A small MCP server (Python, e.g. `mcp` SDK or FastAPI-MCP) exposing financial tools. Registered in
`~/.hermes/config.yaml`:
```yaml
mcp_servers:
  financial:
    url: "http://localhost:8000/mcp"      # or stdio command
    headers: { Authorization: "Bearer <secret>" }
```
Tools become `mcp_financial_<tool>`.

### Tool catalog (MCP)
- **Calc (deterministic):** `compute_ratios(statement_id)`, `compare_periods(statement_id)`,
  `growth_cagr(symbol, metric, years)`, `cross_statement_check(document_id)`.
- **Data:** `get_statement(id)`, `get_line_items(statement_id)`, `get_prices(symbol)`, `list_documents()`.
- **Obsidian:** `save_statement_note(statement_id)`, `save_report(statement_id, md)`,
  `query_vault(query)`, `read_note(path)`, `list_company_notes(symbol)`,
  `rebuild_company_hub(symbol)` [auto-refresh `<SYM>.md` index + cross-period ratio-trend table].
- **News/search (Stage 5):** `get_latest_news(symbol)` [feedparser RSS], `search_news(query)`
  [SearXNG, Docker or native venv on localhost:8888], `read_article(url)` [Trafilatura full-text].
  Camoufox reserved for hard-blocked sites. Grounds analysis in real-world events.

## Skills (`~/.hermes/skills/financial/...`)
Adapted from `anthropics/financial-services` → VN / TT200. Each `SKILL.md`:
```yaml
---
name: phan-tich-chi-so
description: Diễn giải chỉ số tài chính của một BCTC (khi hỏi về sức khỏe/chỉ số)
version: 0.1.0
metadata: { hermes: { tags: [bctc, vn], category: financial } }
---
Phân tích chỉ số DN Việt Nam (TT200). KHÔNG tự tính — gọi mcp_financial_compute_ratios.
Bước: 1) gọi tool lấy số  2) diễn giải mạnh/yếu  3) 2-3 điểm chú ý. Ngắn gọn, tiếng Việt.
```
Auto-discovered → available as `/phan-tich-chi-so`. Integration path being finalized (install-from-GitHub
vs manual placement) — see `SKILL_INTEGRATION.md`.

## Data flow
```
OCR parse done → Core: write SQLite → ping Hermes API ("phân tích statement N")
  → Hermes: load skill → call mcp_financial_compute_ratios / get_statement
  → narrate → call mcp_financial_save_statement_note + save_report  → Obsidian vault
You ask (sidebar) → website → Hermes API server → skill + MCP tools → grounded answer
```

## Borrowed patterns (decided 2026-06-23)
- **Report output schema** (from `ZhuLinsen/daily_stock_analysis`): a Hermes `save_report` should produce a
  decision-oriented note — **kết luận, điểm số, xu hướng, điểm vào/ra, cảnh báo rủi ro, chất xúc tác (catalysts),
  checklist hành động**. Concrete + actionable, not just prose.
- **Deep-research workflow** (pattern from `bytedance/deer-flow`, NOT the framework): a skill that runs
  **plan → search (news/SearXNG) → synthesize → report** for richer analysis. deer-flow itself is rejected
  (it competes with Hermes Agent). See `DISCUSSION_BACKLOG.md`.
- **Daily cadence**: proactive analysis can also run on a daily schedule (not only on OCR parse).

## Open (settle at build time)
- Exact `compute_ratios` list (VN: thanh khoản, đòn bẩy, sinh lời, hiệu quả).
- MCP transport: HTTP (Core endpoint) vs stdio subprocess.
- Whether obsidian writes go through our MCP tools or a Hermes Agent obsidian skill the user already has.
