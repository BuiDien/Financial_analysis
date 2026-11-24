# News watch + oversold alerts — design

**Date:** 2026-11-13
**Status:** brainstormed with user, pending approval
**Builds on:** `docs/superpowers/specs/2026-07-07-daily-news-digest-design.md` (daily collector → vault),
`docs/design/HERMES_BRAIN.md`, `docs/PLAN.md` Phase 6.

## Intent (why)

The user invests in the VN market and does **not** watch prices during the day. VN prices are often
moved by manipulation, so a price move alone says little. What the user needs is to know when a
holding gets **oversold**, and **whether that drop is justified by news**:

- bad company news behind it → drop may be deserved, be careful;
- no company news, global news hit the whole market → broad selloff, often recovers;
- no news at all → possible shakeout/manipulation → may be a buying chance.

The user decides what to do (buy more / cut / wait). The system supplies a verdict plus the facts.

Global news matters too, because it moves VN prices — but only the big stuff gets pushed.

Everything else collected flows quietly into the Obsidian vault so Hermes has it as memory when
analyzing a stock.

## Goals

1. **Oversold alert** for portfolio holdings: Hermes verdict + facts (price drop, RSI, VN-Index
   move, news headlines with links — or explicit "no news found").
2. **Major global news alert**: global event **and** VN-Index down > 2% that day, **or** news that
   directly names Vietnam (tariffs on VN, FTSE upgrade, etc.).
3. **Per-holding VN news** collected daily into the vault (not just world/macro news).
4. **Restart the existing daily collector** — it has not run since 2026-08-18 (no Hermes cron job
   registered; `hermes cron list` is empty).

## Non-goals

- Watchlist tickers (watchlist lives in browser storage only; server can't see it).
- Intraday monitoring / real-time alerts.
- Social sentiment (Reddit, StockTwits) in alerts.
- Buy/sell recommendations or any automatic trading. Verdict explains the drop; it does not
  tell the user what to do.
- A new UI page. (Alerts live in Telegram + vault.)
- Cloud LLMs. Verdict runs on Hermes's local model (Qwen3.6-35B via llama.cpp).

## Anti-goals (would make the user switch it off)

- **Too many alerts.** Target: a handful per month.
- **Wrong verdicts.** A confident wrong verdict is worse than "unclear".

## Alert format (agreed)

```
🔻 HPG oversold — RSI 26, −11% in 5 sessions
Verdict: Broad selloff, no company problem found. Possible opportunity.
Facts:
 • VN-Index −6% same period (foreign net sell 3 days)
 • No HPG-specific news in 7 days
 • Global: US steel tariff talk (Reuters, 11/12)
```

Verdict first, facts after, every news fact has a link.

## Decisions

### User decided
- Purpose: vault memory for Hermes (option C) **plus** push alerts for important items.
- Alerts are both: price-move (oversold) with news context, and important news on its own.
- Trigger for holdings = oversold.
- Alert shows Hermes verdict **and** facts.
- Global push rule: global event + VN-Index > 2% down that day, or names Vietnam directly.
- Tickers come from the portfolio (holdings), not the watchlist.
- "Names Vietnam" leg is **not** any article mentioning Vietnam. Only a fixed topic list, from
  trusted sources (Reuters, Bloomberg, official sources):
  trade/tariffs aimed at Vietnam · FTSE/MSCI market reclassification · State Bank of Vietnam
  rate/FX moves · sanctions. Topic list and source list live in config — user will add topics
  later as needed.

### Claude's calls (user may override)
- **Oversold** = RSI(14) < 30 **or** drop > 10% over 5 sessions. Thresholds in config.
  Use `backend/app/backtest/indicators.py::rsi`.
- **Schedule** (weekdays, VN market days):
  - ~08:30 — morning job: collect news (existing collector + per-holding VN news), write vault note,
    evaluate global push rule against overnight news.
  - ~15:15 — after-close job: oversold check on holdings, match news from last 7 days, verdict,
    alert; also apply the VN-Index > 2% leg of the global rule here (only knowable after close).
- **Channel:** Telegram via the Hermes gateway (gateway already runs under launchd; no messaging
  platform configured yet — user must create a bot with BotFather and add the token).
- **Scheduler:** Hermes cron with `--script` (same choice as the 2026-07-07 spec). Scripts are
  deterministic (fetch, compute, match news) and print a compact facts block; Hermes writes the
  verdict and delivers it. No separate system cron, no new in-process poller.
- **Holdings source:** `PositionProjection` rows with `quantity > 0` for VN tickers
  (`backend/app/models/portfolio.py`). `Holding` is legacy — don't use it.
- **Prices:** go through `services/market.get_history` (the existing seam), never call vnstock
  directly. vnstock gen 4/5 is announced dead from 2026-11-10 — keeping fetch behind this seam
  means a later provider swap doesn't touch this feature.
- **Anti-spam rules:**
  - One alert per ticker per **oversold episode**. Episode ends when RSI(14) recovers above 40
    (hysteresis), then a new episode may alert again.
  - Daily cap: max 3 holding alerts + 1 global alert. If over cap, one combined message.
  - Nothing to report → send nothing (no "all clear" messages).
- **Anti-wrong-verdict rules:**
  - Verdict is one of: `company_news`, `market_wide`, `no_news`, `unclear`. `unclear` is a valid,
    expected answer when facts conflict or news is thin.
  - Verdict must cite only facts present in the facts block; no outside claims.
  - Every alert (facts + verdict) is logged so accuracy can be reviewed later.
- **Alert log:** new SQLite table (e.g. `news_alerts`: ticker, kind, episode_start, sent_at,
  verdict, facts_json) — also used for episode/cooldown state. Plus a vault note
  `Projects/Financial_Automation/News/Alerts/<date>.md` mirroring what was sent.
- **Verdict write-back + failure handling:**
  - *(Revised during planning.)* Jobs run as `hermes cron create --no-agent --script …
    --interpreter backend/.venv/bin/python --deliver telegram`: the script computes facts, asks
    Hermes for the verdict over the existing local API (`app.services.ai.hermes_complete`),
    records the alert in `news_alerts`, and prints the message; Hermes delivers stdout verbatim
    (empty stdout = silent). Reason: the news MCP venv has no SQLAlchemy, so an MCP
    `record_alert` tool would need a second DB stack.
  - Trade-off: an alert is recorded when printed, not on confirmed delivery. A Telegram delivery
    failure loses that alert for the episode (visible in `hermes cron runs`). Accepted for v1.
  - If the local model is down: send the facts block with "Verdict: unavailable (model offline)"
    rather than nothing. Facts alone still beat silence.
- **ETFs (e.g. E1VFVN30) excluded** from holding alerts — a VN30 ETF drop is market-wide by
  definition and would duplicate the global/VN-Index alert. Exclusion via a small config list of
  ETF tickers (projection rows have no instrument type).
- **Foreign net flow is optional.** Include "foreign net sell N days" only if a source behind the
  market seam provides it; v1 does not add a new data source for it. (Alert example above shows it
  for illustration.)
- **Holdings tickers** are stored bare (`HPG`, currency VND); prefix `VN:` before `get_history`.
  `~/.hermes/scripts` no longer exists — recreate it when registering cron jobs.
- **Better VN company news:**
  - Match by ticker **and** company name. Screener `UniverseEntry` carries no names, so: fetch the
    official name once from the listing provider behind the existing seam and cache it, **plus** a
    small config override of short brand names (VNM → "Vinamilk", HPG → "Hòa Phát") for current
    holdings — brand names are what headlines use. Missing alias ⇒ verdict leans `unclear`, never
    `no_news`.
  - Add sources beyond CafeF's two RSS feeds: Vietstock news and official HOSE/HNX disclosures.
  - Per-holding SearXNG query as fallback.
- **Collector:** replace hardcoded VN names in `news_collector.TRACKED_TICKERS` with current
  holdings; keep global/macro sources as is.

### Left to the builder
- Exact Vietstock / HOSE / HNX feed URLs and parsing — verify what is reachable without login;
  skip a source cleanly if blocked (Camoufox remains out of scope).
- Exact Hermes cron syntax and how a cron run delivers to Telegram — verify against installed
  Hermes version.
- Vault note layout for per-holding news inside the daily note.
- How "global event" is detected for the > 2% leg (likely: Hermes reads the day's global section
  and picks the top cause, or reports "no clear global cause").

## Existing pieces to reuse

| Piece | Path |
|---|---|
| Daily collector → vault | `Financial_analyze/backend/app/services/news_collector.py`, `scripts/collect_daily_news.py` |
| CafeF RSS, SearXNG, article reader | `Financial_analyze/backend/app/services/news.py` |
| Hermes news MCP tools | `Financial_analyze/backend/app/mcp/news_search_tools.py` |
| RSI / indicators | `Financial_analyze/backend/app/backtest/indicators.py` |
| Prices, VN-Index | `Financial_analyze/backend/app/services/market.py` (`get_history`, `get_indices`) |
| Holdings | `Financial_analyze/backend/app/models/portfolio.py::PositionProjection` |
| Vault path | `config.vault_news_dir` |

## User setup steps (one-time)

1. Create Telegram bot (BotFather), give token to Hermes gateway config.
2. `./scripts/run_searxng.sh` must be running (already started by `scripts/run.sh`).
3. llama.cpp server for Qwen must be up at alert times (08:30, 15:15).

## Success

- Daily vault notes resume and include per-holding VN news.
- When a holding goes oversold, user gets one Telegram message after close with a verdict and
  linked facts.
- Over a month: few alerts, and when the user checks verdicts against the facts, they hold up —
  or honestly say `unclear`.
