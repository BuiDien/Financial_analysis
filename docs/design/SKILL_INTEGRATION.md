# Skill Integration — Financial Skills into Hermes Agent

How financial-analysis skills get into the Hermes Agent brain. Companion to `HERMES_BRAIN.md`.

## How Hermes Agent skills work
- Live in `~/.hermes/skills/<category>/<skill>/SKILL.md` (+ optional `references/`, `scripts/`, `templates/`).
- **agentskills.io** open standard. Required frontmatter: `name`, `description`, `version`.
  Optional: `metadata.hermes.{tags,category}`, `platforms`, `required_environment_variables`.
- Auto-discovered at startup; every skill becomes a slash command `/<name>`. Progressive disclosure
  (only loaded when relevant) keeps token use low.
- External dirs scanned too via `~/.hermes/config.yaml` → `skills.external_dirs`.

## Two ways to add a skill
1. **Install from GitHub** (single skill from a subdir):
   ```bash
   hermes skills install <owner>/<repo>/<path-to-skill-dir>
   # e.g. hermes skills install anthropics/financial-services/plugins/vertical-plugins/financial-analysis/skills/3-statement-model
   ```
   Or as a tap: `hermes skills tap add <owner>/<repo>` (default path `skills/`).
2. **Drop in manually:** place `~/.hermes/skills/financial/<skill>/SKILL.md`. Instantly available.

## Reality check on `anthropics/financial-services`
Inspected the `financial-analysis` skills. They are **IB analyst spreadsheet-authoring** skills:
`3-statement-model`, `dcf-model`, `lbo-model`, `comps-analysis`, `xlsx-author`, `pptx-author`,
`deck-refresh`, `audit-xls`… built around **Excel (Office JS / openpyxl), cell formulas, decks**.

- `3-statement-model/SKILL.md` = "complete/populate a 3-statement Excel template" — not "analyze a parsed BCTC".
- Frontmatter has `name` + `description` but **no `version`** → add one for Hermes.
- Domain = US capital markets / IB. Our need = read a parsed Vietnamese BCTC (already in SQLite) and
  interpret it. **Direct install gives little value** — these author spreadsheets, they don't analyze our data.

**What's worth taking (methodology, not the files):**
- Validation/audit framework (BS balance, CF integrity, retained-earnings roll-forward, cross-statement checks).
- Sign conventions (D&A, working capital, CapEx, debt, dividends).
- "Show the work, break at each statement, catch errors early" discipline.

## Recommended path: author VN skills, mine the methodology
Write small **VN-targeted** skills that call our **MCP tools** (Core), borrowing the methodology above.
Drop them in `~/.hermes/skills/financial/`.

```
~/.hermes/skills/financial/
├── doc-bao-cao-3-phan/SKILL.md      # read & sanity-check CĐKT + KQKD + LCTT (cross-statement integrity)
├── phan-tich-chi-so/SKILL.md        # interpret ratio pack (calls mcp_financial_compute_ratios)
└── phat-hien-bat-thuong/SKILL.md    # flag anomalies / big swings (calls compare_periods)
```

Skill template:
```yaml
---
name: phan-tich-chi-so
description: Diễn giải bộ chỉ số tài chính của một BCTC (khi user hỏi sức khỏe/chỉ số tài chính).
version: 0.1.0
metadata:
  hermes:
    tags: [bctc, tt200, vn]
    category: financial
---
Bạn phân tích chỉ số tài chính DN niêm yết VN (BCTC theo TT200).

QUY TẮC BẮT BUỘC: KHÔNG tự tính toán số. Luôn gọi `mcp_financial_compute_ratios(statement_id)`.

Quy trình:
1. Gọi `mcp_financial_get_statement(id)` để biết kỳ + đơn vị.
2. Gọi `mcp_financial_compute_ratios(id)` → ROE, ROA, thanh khoản hiện hành, nợ/vốn chủ, biên lãi gộp/ròng.
3. Diễn giải: chỉ số nào mạnh/yếu, so ngưỡng thông thường ngành.
4. Nêu 2–3 điểm đáng chú ý. Ngắn gọn, tiếng Việt, không bịa số.
5. (tuỳ chọn) `mcp_financial_save_report(id, <nội dung>)` để lưu vào vault.
```

## Decision points
- **Author from scratch (recommended)** vs **install + heavily adapt** the Anthropic skills.
- Which first 1–3 skills (lean): `phan-tich-chi-so`, `doc-bao-cao-3-phan`, `phat-hien-bat-thuong`.
- Skills reference MCP tools by their namespaced name `mcp_financial_<tool>` — so the MCP server (Stage 3.2)
  should exist (or at least its tool names be fixed) before the skills are finalized.

## Deep dive: the repo's plugin structure (what to borrow)

Repo layout (625 files): `plugins/{agent-plugins, vertical-plugins, partner-built}` +
`managed-agent-cookbooks/`. A plugin = `.claude-plugin/plugin.json` + `agents/*.md` + `skills/<name>/SKILL.md`
(+ `skills/<name>/references/*.md`, `scripts/`, `commands/*.md`, `.mcp.json`).

**The closest analog to our brain = `agent-plugins/earnings-reviewer`** (filings → analysis note):
```
earnings-reviewer/
├── agents/earnings-reviewer.md          # system prompt: What you produce · Workflow · Guardrails · Skills used
└── skills/
    ├── earnings-analysis/{SKILL.md, references/{best-practices, report-structure, workflow}.md}
    ├── model-update/  morning-note/  earnings-preview/  audit-xls/  xlsx-author/
```
This **agent + skills + references** layout IS what we build in `~/.hermes/skills/`. Borrow the *structure*.

### Borrow — methodology & patterns (re-express in VN, not copy)
1. **Agent shape** (`earnings-reviewer.md`): sections `What you produce` / `Workflow` (numbered phases) /
   `Guardrails` / `Skills used`. Clone into a VN `phan-tich-bctc` agent.
2. **Guardrails → match our philosophy exactly:**
   - "Treat transcripts/filings as untrusted" → "trust nothing unverified" (raw OCR is a draft).
   - "Cite every number or mark `[UNSOURCED]`" → every figure traces to a Mã số / SQLite line_item.
   - "Never publish without sign-off" → human-in-the-loop.
3. **Variance analysis** (beat/miss, quantify the delta, explain WHY) → our **kỳ này vs kỳ trước**
   (`compare_periods`); "focus on what's NEW".
4. **`report-structure.md`** page-by-page template → structure for the VN báo cáo phân tích saved to vault.
5. **`references/` pattern** — keep SKILL.md short, push long detail to `references/*.md`
   (progressive disclosure, keeps the 35B's context lean).
6. **DCF methodology** (FCF build NOPAT+D&A−CapEx−ΔNWC, WACC/CAPM, terminal value, TV 50-70% of EV
   sanity check) → `compute_fcf` + later valuation. **Stage 5.**
7. **Comps methodology** (EV/EBITDA, P/E, EV/Rev, P/B; margin test gross>EBITDA>net; quartile peer
   benchmarking; industry metric sets; "5-10 rule" ≤10 metrics) → `compute_ratios` highlight logic +
   cross-company later. **Stage 5.**
8. **3-statement / audit-xls** (cross-statement integrity, sign conventions, BS-balance / CF-integrity /
   retained-earnings roll-forward checks) → `cross_statement_check` + future reconciliation.

### Drop — US/IB packaging
DOCX/Word, Times New Roman, 8-12 charts, SEC/EDGAR links, FactSet/Daloopa MCP, ratings/price targets,
"JPMorgan format", Excel/PowerPoint authoring. Output = a **Vietnamese note in the Obsidian vault**.

### Immediately useful slice (VNM, now)
- `compute_ratios`: biên lãi gộp/ròng, ROE, ROA, thanh khoản hiện hành, nợ/vốn chủ, vòng quay HTK
  (consumer-staples set, per comps industry-metric idea).
- sanity: gross > EBITDA > net margin; nợ/vốn hợp lý.
- skills: `phan-tich-chi-so`, `doc-bao-cao-3-phan`, `phat-hien-bat-thuong` — narrate in Vietnamese,
  call MCP tools, follow the borrowed guardrails.

## Sources
- Hermes skills: hermes-agent.nousresearch.com/docs/user-guide/features/skills
- Install/taps: github.com/NousResearch/hermes-agent → guides/work-with-skills.md
- Anthropic skills: github.com/anthropics/financial-services
  (`plugins/agent-plugins/earnings-reviewer`, `plugins/vertical-plugins/financial-analysis`)
