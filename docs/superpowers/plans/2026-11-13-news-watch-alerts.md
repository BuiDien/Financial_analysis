# News Watch + Oversold Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the close, tell the user (via Telegram) when a portfolio holding is oversold and whether news explains the drop; push major Vietnam-relevant global news; and feed per-holding news into the daily vault note.

**Architecture:** New package `backend/app/newswatch/` with small pure modules (oversold math, topic matching, verdict parsing, message formatting) plus thin I/O modules (holdings query, news fetchers, alert store). Two entry scripts run as Hermes cron jobs in `--no-agent` mode under the backend venv: each computes facts, asks Hermes for a verdict through the existing local API (`app.services.ai.hermes_complete`), records the alert in SQLite, and prints the message — Hermes delivers stdout to Telegram, empty stdout is silent. The existing daily collector is made holdings-aware and re-registered as a cron job.

**Tech Stack:** Python 3.11, FastAPI backend modules, SQLAlchemy (SQLite), pydantic-settings, feedparser, pytest, Hermes Agent CLI (`hermes cron`), local Qwen via llama.cpp behind Hermes.

**Spec:** `docs/superpowers/specs/2026-11-13-news-watch-alerts-design.md`

## Global Constraints

- **No `git commit` / `git push` by the agent** (CLAUDE.md). Each task ends by listing files ready to commit + a suggested message; the user commits.
- Fully local at runtime: verdicts via Hermes (local Qwen3.6-35B, llama.cpp). No cloud LLM calls; never use `ai.cloud_complete`.
- Prices only via `app.services.market.get_history` (vnstock is sunsetting; keep the seam). VN tickers need the `VN:` prefix; VN-Index is `VN:VNINDEX`. Bars: `{"date": "YYYY-MM-DD…", "open","high","low","close","volume"}`, oldest first.
- Do not upgrade vnstock (pinned 4.0.4).
- Oversold = RSI(14) < 30 **or** drop > 10% over 5 sessions. Episode closes when RSI(14) > 40.
- Caps: max 3 holding alerts with verdicts per day (overflow named in one extra line in the same message), max 1 global alert per day. Nothing to report → print nothing.
- Verdict categories: `company_news`, `market_wide`, `no_news`, `unclear`, plus `unavailable` (model offline). Message: verdict first, then facts; every news fact has a link.
- Global push: (VN-Index day change ≤ −2% at close) **or** (trusted-source article naming Vietnam on a configured topic: trade/tariffs on Vietnam, FTSE/MSCI reclassification, SBV rate/FX moves, sanctions).
- Holdings = `PositionProjection` rows, `quantity > 0`, `currency == "VND"`, minus configured ETF tickers. Watchlist out of scope.
- Run tests from `Financial_analyze/backend`: `.venv/bin/pytest <path> -v`.

## Review Focus

1. **A company-news source fails or a holding has no alias, and the model says `no_news`** → must downgrade to `unclear` (a false "no news → buying chance" is the worst failure). Pinned in Task 6.
2. **The same Vietnam-topic article shows up on several mornings** → alert at most once per URL. Pinned in Task 8.
3. **Holiday / non-trading day at 15:15** (VN-Index last bar ≠ today) → silent, no episodes touched. Pinned in Task 8.
4. **Short price history** (new listing, < 15 bars) → no signal, no crash. Pinned in Task 2.
5. **Model replies with prose, code fences, or an unknown category** → parse fenced JSON; anything else becomes `unclear`, never a crash. Pinned in Task 6.

---

### Task 1: Settings, watch config, alert tables, holdings query

**Files:**
- Modify: `Financial_analyze/backend/app/config.py` (News section)
- Create: `Financial_analyze/backend/newswatch.json`
- Create: `Financial_analyze/backend/app/models/newswatch.py`
- Modify: `Financial_analyze/backend/app/db.py` (`init_db` model imports)
- Modify: `Financial_analyze/backend/tests/conftest.py` (model import line)
- Create: `Financial_analyze/backend/app/newswatch/__init__.py`, `app/newswatch/watch_config.py`, `app/newswatch/holdings.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_holdings.py`

**Interfaces:**
- Produces:
  - Settings: `newswatch_config_path: str = str(BACKEND_DIR / "newswatch.json")`, `newswatch_rsi_oversold: float = 30.0`, `newswatch_rsi_reset: float = 40.0`, `newswatch_drop_pct: float = 10.0`, `newswatch_drop_sessions: int = 5`, `newswatch_news_days: int = 7`, `newswatch_max_holding_alerts: int = 3`, `newswatch_vnindex_drop_pct: float = 2.0`.
  - `WatchConfig` TypedDict: `etf_tickers: list[str]`, `aliases: dict[str, list[str]]`, `vietnam_terms: list[str]`, `topics: dict[str, list[str]]`, `trusted_sources: list[str]`.
  - `load_watch_config(path: str | None = None) -> WatchConfig` (missing keys → empty defaults; tickers upper-cased).
  - Model `NewsAlert` (`news_alerts`): `id`, `kind` (`"holding"|"global"`), `ticker` (nullable), `alert_date` (Date), `episode_open` (Boolean, default False), `verdict` (String 16), `message` (Text), `facts` (JSON), `created_at`.
  - Model `CompanyName` (`company_names`): `symbol` (PK, String 16), `official_name` (String), `fetched_at` (DateTime).
  - `current_vn_holdings(db: Session, etf_tickers: Iterable[str] = ()) -> list[str]` — sorted, distinct, upper-case.

- [ ] **Step 1: Write failing tests** in `tests/test_newswatch_holdings.py`:
  - `test_current_vn_holdings_filters_zero_foreign_and_etf`: seed a `Portfolio` + `PositionProjection` rows `HPG` (qty 100, VND), `MBB` (qty 0, VND), `AAPL` (qty 5, USD), `E1VFVN30` (qty 50, VND), `FPT` (qty 10, VND, second portfolio) → `current_vn_holdings(db, ["E1VFVN30"]) == ["FPT", "HPG"]`.
  - `test_load_watch_config_defaults_missing_keys`: write `{"aliases": {"hpg": ["Hòa Phát"]}}` to tmp → `cfg["etf_tickers"] == []`, `cfg["aliases"] == {"HPG": ["Hòa Phát"]}`, `cfg["topics"] == {}`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_newswatch_holdings.py -v` → FAIL (module not found).
- [ ] **Step 3: Implement** settings, models (register in `db.init_db` import list and conftest's `from app.models import …` line), `watch_config.py`, `holdings.py`. Create `newswatch.json` with:
  - `etf_tickers`: `["E1VFVN30", "FUEVFVND", "FUESSVFL", "FUEVN100", "FUEKIV30"]`
  - `aliases`: brand names for each current holding — get the list with `current_vn_holdings` against the real DB (`helix.db`, portfolio 1, ~10 tickers); include the unaccented form too (e.g. `"HPG": ["Hòa Phát", "Hoa Phat"]`, `"VNM": ["Vinamilk"]`).
  - `vietnam_terms`: `["vietnam", "việt nam", "viet nam"]`
  - `topics`: `"tariffs": ["tariff", "thuế đối ứng", "thuế quan", "trade deal"]`, `"reclassification": ["ftse", "msci", "nâng hạng", "emerging market"]`, `"sbv": ["state bank of vietnam", "sbv", "ngân hàng nhà nước", "lãi suất điều hành", "tỷ giá"]`, `"sanctions": ["sanction", "trừng phạt"]`
  - `trusted_sources`: `["reuters", "bloomberg", "sbv.gov.vn", "ssc.gov.vn", "hsx.vn", "hnx.vn", "chinhphu.vn"]`
- [ ] **Step 4: Run** the test file → PASS; also `.venv/bin/pytest tests/test_smoke.py -v` → PASS (init_db still works).
- [ ] **Step 5: Hand off** — files ready to commit; suggested message `feat(newswatch): settings, alert tables, holdings query`.

### Task 2: Oversold detection and episode state

**Files:**
- Create: `Financial_analyze/backend/app/newswatch/oversold.py`, `app/newswatch/store.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_oversold.py`

**Interfaces:**
- Consumes: `app.backtest.indicators.rsi(closes, n=14) -> list[float | None]`; `NewsAlert` (Task 1).
- Produces:
  - `OversoldSignal` TypedDict: `rsi: float | None`, `drop_pct: float` (negative = fall, e.g. `-11.2`), `sessions: int`, `close: float`.
  - `pct_change(closes: list[float], sessions: int) -> float | None` — `(closes[-1] / closes[-1 - sessions] - 1) * 100`, `None` if too short.
  - `latest_rsi(closes: list[float], n: int = 14) -> float | None`.
  - `check_oversold(closes, *, rsi_max=30.0, drop_pct=10.0, sessions=5) -> OversoldSignal | None` — signal if `rsi < rsi_max` or `pct_change <= -drop_pct`.
  - `store.open_episode(db, ticker) -> NewsAlert | None` — latest `kind="holding"` row for ticker with `episode_open=True`.
  - `store.close_if_recovered(db, ticker, rsi_now: float | None, reset: float = 40.0) -> bool` — sets `episode_open=False` on the open row when `rsi_now > reset`.
  - `store.record_alert(db, *, kind, ticker, alert_date, verdict, message, facts, episode_open) -> NewsAlert` (commits).
  - `store.global_alert_sent(db, day: date) -> bool`; `store.alerted_urls(db, kind="global") -> set[str]` (from `facts["urls"]`).

- [ ] **Step 1: Write failing tests:**
  - `test_rsi_trigger`: steadily falling 30-bar series → signal with `rsi < 30`.
  - `test_drop_trigger_without_low_rsi`: flat 25 bars then 5 bars ending at 88% of start → `signal["drop_pct"] == pytest.approx(-12.0)`.
  - `test_no_signal_on_flat_series` → `None`.
  - `test_short_history_returns_none`: 10 bars → `check_oversold(...) is None` and no exception (Review Focus 4).
  - `test_episode_lifecycle`: `record_alert(..., episode_open=True)` for HPG → `open_episode` returns it; `close_if_recovered(db, "HPG", 38.0)` → False, still open; `close_if_recovered(db, "HPG", 41.0)` → True, `open_episode` → None.
  - `test_global_alert_sent_and_urls`: record a global row with `facts={"urls": ["https://r/1"]}` → `global_alert_sent(db, day)` True, `alerted_urls(db) == {"https://r/1"}`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_newswatch_oversold.py -v` → FAIL.
- [ ] **Step 3: Implement** `oversold.py` (pure, no I/O) and `store.py`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Hand off** — suggested message `feat(newswatch): oversold signal and alert episode store`.

### Task 3: Company names for news matching

**Files:**
- Modify: `Financial_analyze/backend/app/screener/provider.py` (Protocol + `FixtureProvider`)
- Modify: `Financial_analyze/backend/app/screener/vnstock_provider.py` (`VnstockProvider`)
- Create: `Financial_analyze/backend/app/newswatch/aliases.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_aliases.py`

**Interfaces:**
- Consumes: `CompanyName` (Task 1), `WatchConfig["aliases"]`, `app.screener.provider.get_provider` (existing factory).
- Produces:
  - `MarketDataProvider.list_company_names(self) -> dict[str, str]` (symbol → official name). `FixtureProvider` takes optional `company_names: dict | None` and returns it (default `{}`).
  - `aliases.refresh_official_names(db, provider, max_age_days: int = 30) -> int` — upserts `CompanyName` rows when the table is empty or the newest `fetched_at` is older than `max_age_days`; returns rows written; on provider error leaves the cache untouched and returns 0.
  - `aliases.names_for(db, symbol: str, cfg: WatchConfig) -> list[str]` — `[symbol] + cfg["aliases"].get(symbol, []) + [short official name]`, de-duplicated, order kept. Short official name = official name with leading legal prefix stripped (`"Công ty Cổ phần"`, `"Tổng Công ty"`, `"Ngân hàng TMCP"`, `"CTCP"`, case-insensitive).
  - `aliases.has_brand_alias(symbol, cfg) -> bool`.

- [ ] **Step 1: Write failing tests:**
  - `test_names_for_combines_ticker_alias_and_official`: cfg aliases `{"HPG": ["Hòa Phát"]}`, `CompanyName("HPG", "Công ty Cổ phần Tập đoàn Hòa Phát")` → `["HPG", "Hòa Phát", "Tập đoàn Hòa Phát"]`.
  - `test_refresh_skips_when_fresh`: fresh rows → `refresh_official_names(db, FixtureProvider(company_names={...}))` returns 0 and no provider call recorded.
  - `test_refresh_survives_provider_error`: provider whose `list_company_names` raises → returns 0, existing rows unchanged.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_newswatch_aliases.py -v` → FAIL.
- [ ] **Step 3: Implement.** `VnstockProvider.list_company_names` uses vnstock 4.0.4 `Listing().all_symbols()` (verify the name column in the REPL — expected `organ_name`) through `self._call`, so it shares the rate limiter.
- [ ] **Step 4: Run** the new test file **and** `tests/test_provider_seam.py tests/test_screener_vnstock_provider.py` → PASS.
- [ ] **Step 5: Hand off** — suggested message `feat(newswatch): company name aliases for news matching`.

### Task 4: Per-holding VN news sources

**Files:**
- Create: `Financial_analyze/backend/app/newswatch/sources.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_sources.py`

**Interfaces:**
- Consumes: `app.services.news.fetch_vn_rss`, `app.services.news.search_web`, `news._plain_summary`, `feedparser`.
- Produces:
  - `NewsItem` TypedDict: `id: str` (assigned later by facts builder), `title: str`, `url: str`, `source: str`, `published: int` (epoch, 0 if unknown), `summary: str`.
  - `Fetcher = Callable[[], list[NewsItem]]`; `DEFAULT_VN_FETCHERS: dict[str, Fetcher]` with keys `"cafef"`, `"vietstock"`, `"hose"`, `"hnx"`.
  - `mentions(text: str, names: list[str]) -> bool` — ticker names (all-caps, ≤ 5 chars) match on word boundary; other names case-insensitive substring; compare after Unicode NFC normalisation.
  - `fetch_all_vn(fetchers: dict[str, Fetcher] | None = None) -> tuple[list[NewsItem], list[str]]` — runs every fetcher once; on a fetcher exception appends `"<key>: <error>"` to errors and continues; de-dup by URL.
  - `match_holding_news(items: list[NewsItem], names: list[str], since_epoch: int, search=news.search_web) -> tuple[list[NewsItem], list[str]]` — keeps items mentioning any name with `published >= since_epoch` or `published == 0`; if none, one SearXNG fallback `search(f'"{names[1] if len(names) > 1 else names[0]}" cổ phiếu', 5)` (a failure goes to the returned errors); returns `(matches, fallback_errors)`.

- [ ] **Step 1: Write failing tests** (fake fetchers, no network):
  - `test_mentions_word_boundary`: `mentions("HPG tăng trần", ["HPG"])` True; `mentions("HPGX ...", ["HPG"])` False; `mentions("Tập đoàn Hòa Phát báo lãi", ["HPG", "Hòa Phát"])` True.
  - `test_fetch_all_vn_dedups_by_url`: two fetchers returning the same URL → one item.
  - `test_failing_source_reported_not_raised`: one fetcher raises → errors `== ["vietstock: boom"]`, other results still returned.
  - `test_match_drops_old_items`: item with `published < since_epoch` → not matched; `published == 0` → matched.
  - `test_searxng_fallback_only_when_empty`: no matches → `search` called once with `'"Hòa Phát" cổ phiếu'`; with a match → not called.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_newswatch_sources.py -v` → FAIL.
- [ ] **Step 3: Implement.** CafeF via `fetch_vn_rss(limit=200)`. Vietstock / HOSE / HNX: verify in a REPL which public RSS or listing pages answer without login (candidates: Vietstock RSS index `https://vietstock.vn/rss`, HOSE disclosures page, HNX disclosures page). Implement each that works with feedparser or a minimal HTML parse; for any that doesn't, leave it out of `DEFAULT_VN_FETCHERS` and note it in the module docstring. No headless browser.
- [ ] **Step 4: Run** → PASS. Manual check: `.venv/bin/python -c "from app.newswatch import sources as s; import time; items, errs = s.fetch_all_vn(); print(len(items), errs); print(s.match_holding_news(items, ['HPG','Hòa Phát'], int(time.time())-7*86400))"` prints items or explicit errors.
- [ ] **Step 5: Hand off** — suggested message `feat(newswatch): per-holding VN news sources`.

### Task 5: Global rule — Vietnam topics and VN-Index drop

**Files:**
- Create: `Financial_analyze/backend/app/newswatch/global_rule.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_global_rule.py`

**Interfaces:**
- Consumes: `WatchConfig` (Task 1), `NewsItem` (Task 4), `news_collector.fetch_global_rss_feeds`, `news.search_web`.
- Produces:
  - `is_trusted(item: NewsItem, trusted: list[str]) -> bool` — any trusted token in `source` or URL host (lower-case).
  - `match_vietnam_topics(items: list[NewsItem], cfg: WatchConfig, exclude_urls: set[str] = frozenset()) -> list[dict]` — returns items (plus `"topic": <topic key>`) that are trusted, contain a `vietnam_terms` term, and contain a keyword from some topic, in title+summary; skips `exclude_urls`; first matching topic wins.
  - `fetch_global_candidates(cfg: WatchConfig) -> tuple[list[NewsItem], list[str]]` — global RSS feeds + one `search_web(f"Vietnam {topic}", 5, time_range="day")` per topic key; errors collected, never raised.
  - `vnindex_day_change(bars: list[dict]) -> tuple[str, float] | None` — `(last_date, pct)` from the last two bars.

- [ ] **Step 1: Write failing tests:**
  - `test_topic_match_requires_vietnam_topic_and_trusted`: Reuters "US raises tariffs on Vietnam goods" → match `topic == "tariffs"`; same title from `searxng/randomblog.com` → no match; Reuters "US tariffs on Canada" → no match.
  - `test_exclude_already_alerted_urls` (Review Focus 2): matching item whose URL is in `exclude_urls` → empty.
  - `test_vnindex_day_change`: closes 1300 → 1270 → `pct == pytest.approx(-2.3077, rel=1e-3)`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Hand off** — suggested message `feat(newswatch): global Vietnam-topic and VN-Index rules`.

### Task 6: Facts and verdict via Hermes

**Files:**
- Create: `Financial_analyze/backend/app/newswatch/verdict.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_verdict.py`

**Interfaces:**
- Consumes: `OversoldSignal` (Task 2), `NewsItem` (Task 4), `app.services.ai.hermes_complete(system, messages, max_tokens, timeout_seconds) -> str` (raises `RuntimeError` when Hermes is down).
- Produces:
  - `HoldingFacts` TypedDict: `ticker`, `signal: OversoldSignal`, `vnindex_pct: float | None` (same `sessions` window), `company_news: list[NewsItem]`, `global_news: list[NewsItem]`, `source_errors: list[str]`, `has_alias: bool`.
  - `assign_ids(facts: HoldingFacts) -> HoldingFacts` — company items `c1..cN`, global items `g1..gN` (max 5 each, newest first).
  - `Verdict` TypedDict: `category: Literal["company_news","market_wide","no_news","unclear","unavailable"]`, `reason: str`, `cited: list[str]`.
  - `ask_verdict(facts: HoldingFacts, complete=hermes_complete) -> Verdict`.
  - `GlobalVerdict` TypedDict: `category: Literal["global_cause","no_clear_cause","vietnam_topic","unavailable"]`, `reason: str`, `cited: list[str]`.
  - `ask_global_verdict(items: list[NewsItem], vnindex_pct: float | None, complete=hermes_complete) -> GlobalVerdict`.

Prompt contract (system prompt, exact rules): answer **only** JSON `{"category": ..., "reason": <≤ 25 words, English>, "cited": [fact ids]}`; use only the facts given; never recommend buying or selling; say `unclear` when facts conflict or are thin. Call with `max_tokens=300`, `timeout_seconds=120`.

Post-parse guards (in this order):
1. `RuntimeError` from `complete` → `unavailable`, reason `"model offline"`.
2. Strip ```` ``` ```` / ```` ```json ```` fences; JSON parse failure or unknown category → `unclear`.
3. Drop cited ids not present in facts.
4. `company_news` with no cited `c*` id → `unclear`.
5. `no_news` when `source_errors` non-empty or `has_alias` False → `unclear`, reason prefixed `"News coverage incomplete — "`.

- [ ] **Step 1: Write failing tests** (fake `complete`):
  - `test_parses_fenced_json`: returns ```` ```json\n{"category":"market_wide","reason":"Index fell too","cited":["g1"]}\n``` ```` → category `market_wide`, cited `["g1"]`.
  - `test_unknown_category_becomes_unclear` and `test_prose_reply_becomes_unclear` (Review Focus 5).
  - `test_no_news_downgraded_when_source_failed` (Review Focus 1): `source_errors=["hose: timeout"]`, model says `no_news` → `unclear`.
  - `test_no_news_downgraded_without_alias`: `has_alias=False` → `unclear`.
  - `test_company_news_needs_company_citation`: cited `["g1"]` only → `unclear`.
  - `test_invented_ids_dropped`: cited `["c1","c9"]` with only `c1` present → `["c1"]`.
  - `test_model_offline_unavailable`: `complete` raises `RuntimeError` → `unavailable`.
  - `test_prompt_contains_only_given_facts`: capture messages; assert each company item title and URL appears and the system prompt contains `"never recommend buying or selling"`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_newswatch_verdict.py -v` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Hand off** — suggested message `feat(newswatch): grounded Hermes verdict with guards`.

### Task 7: Message formatting and vault alert note

**Files:**
- Create: `Financial_analyze/backend/app/newswatch/message.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_message.py`

**Interfaces:**
- Consumes: `HoldingFacts`, `Verdict`, `GlobalVerdict` (Task 6).
- Produces:
  - `format_holding_alert(facts: HoldingFacts, verdict: Verdict) -> str`
  - `format_global_alert(items: list[NewsItem], vnindex_pct: float | None, verdict: GlobalVerdict) -> str`
  - `combine(alerts: list[str], overflow_tickers: list[str]) -> str` — alerts joined by a blank line; if `overflow_tickers`, append `"Also oversold: X, Y (see vault)"`; `""` when both empty.
  - `write_alert_note(day: date, text: str, vault_news_dir: str) -> str` — appends to `<vault_news_dir>/Alerts/<YYYY-MM-DD>.md` (create dir/file; heading `# Alerts — <date>` on first write); returns path; no-op returning `""` for empty text.

Exact holding format (spec):
```
🔻 {TICKER} oversold — RSI {rsi:.0f}, {drop:+.0f}% in {sessions} sessions
Verdict: {label}. {reason}
Facts:
 • VN-Index {vnindex:+.1f}% same period
 • [{title}]({url}) — {source}, {dd/mm}          (company items, cited first)
 • No {TICKER}-specific news in {days} days      (when company_news empty)
 • Global: [{title}]({url}) — {source}           (global items cited by verdict)
 • ⚠ Sources unavailable: {keys}                 (when source_errors)
```
Labels: `company_news` → "Company news behind the drop", `market_wide` → "Broad selloff, no company problem found", `no_news` → "No news found — possible shakeout", `unclear` → "Unclear", `unavailable` → "Verdict unavailable (model offline)". RSI segment omitted when `rsi` is None. Global header: `🌏 Vietnam market alert — VN-Index {pct:+.1f}% today` or `🌏 Vietnam news: {topic}` when triggered by topic.

- [ ] **Step 1: Write failing tests:** exact-string test for the spec example (HPG, RSI 26, −11%, VN-Index −6%, no company news, one cited global item, `market_wide`); `test_unavailable_still_shows_facts`; `test_combine_overflow_line`; `test_combine_empty_is_empty`; `test_write_alert_note_appends` (two calls → one heading, both texts).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Hand off** — suggested message `feat(newswatch): alert message format and vault note`.

### Task 8: Job orchestration and entry scripts

**Files:**
- Create: `Financial_analyze/backend/app/newswatch/run.py`
- Create: `Financial_analyze/scripts/newswatch_after_close.py`, `Financial_analyze/scripts/newswatch_morning.py`
- Test: `Financial_analyze/backend/tests/test_newswatch_run.py`

**Interfaces:**
- Consumes: everything from Tasks 1–7; `market.get_history`.
- Produces:
  - `Deps` dataclass with defaults: `history: Callable[[str], list[dict]] = lambda t: market.get_history(t, "6mo")`, `complete = ai.hermes_complete`, `vn_news: Callable[[], tuple[list[NewsItem], list[str]]] = sources.fetch_all_vn`, `global_news: Callable[[WatchConfig], tuple[list[NewsItem], list[str]]] = global_rule.fetch_global_candidates`, `search = news.search_web`, `vault_news_dir: str = settings.vault_news_dir`.
  - `run_after_close(db, today: date, deps: Deps | None = None, cfg: WatchConfig | None = None) -> str`
  - `run_morning(db, today: date, deps: Deps | None = None, cfg: WatchConfig | None = None) -> str`

`run_after_close` algorithm:
1. VN-Index bars via `deps.history("VN:VNINDEX")`; if last bar date ≠ `today` → return `""` (holiday/no data; touch nothing).
2. For each holding (Task 1): closes → `close_if_recovered(rsi_now)`; `check_oversold`; skip if signal is None or `open_episode` exists.
3. Candidates sorted by `drop_pct` ascending; first `newswatch_max_holding_alerts` get facts (company news: one `deps.vn_news()` call, then `match_holding_news(items, names_for(...), since = today − newswatch_news_days, deps.search)` per ticker; `source_errors` = fetch errors + that ticker's fallback errors; `has_alias = has_brand_alias(...)`; global items from one `global_news(cfg)` call, last 24 h) → `ask_verdict` → `format_holding_alert`; the rest go to `overflow_tickers`.
4. Every candidate (incl. overflow) → `record_alert(kind="holding", episode_open=True, …)`.
5. Global leg: if `vnindex_day_change` ≤ −`newswatch_vnindex_drop_pct` and not `global_alert_sent(today)` → `ask_global_verdict` on the global items → `format_global_alert` → `record_alert(kind="global", facts={"urls": [...]})`.
6. `text = combine(...)`; `write_alert_note`; return `text`.

`run_morning`: if `today.weekday() >= 5` or `global_alert_sent(today)` → `""`. `match_vietnam_topics(global_news(cfg), cfg, exclude_urls=alerted_urls(db))`; none → `""`; else `ask_global_verdict` (category `vietnam_topic`) → message → record → vault → return.

Scripts: copy the re-exec-under-`backend/.venv` header from `scripts/collect_daily_news.py` (clears `PYTHONPATH`/`PYTHONHOME`), open `SessionLocal()`, call `init_db()`, run the job for today in `Asia/Ho_Chi_Minh`, `print(text, end="")` only when non-empty. Any uncaught exception → print to **stderr** and exit 1 (so Hermes reports a failure instead of delivering a traceback as an alert).

- [ ] **Step 1: Write failing tests** with fake `Deps` (in-memory db fixture, seeded holdings, synthetic bars):
  - `test_holiday_is_silent` (Review Focus 3): VN-Index last bar = yesterday → `""`, no `NewsAlert` rows.
  - `test_oversold_alerts_once_per_episode`: HPG falling series → first run returns text containing `"HPG oversold"`; second run same day/next day with still-low RSI → `""`.
  - `test_episode_reopens_after_recovery`: after run 1, feed recovering bars (RSI > 40) then falling again → alert again.
  - `test_cap_and_overflow`: 5 oversold holdings → message has 3 `"oversold —"` blocks and `"Also oversold:"` with the other 2; 5 rows recorded.
  - `test_vnindex_drop_adds_one_global_alert`: VN-Index −2.5% → text contains `"🌏"`; second run same day → no second global block.
  - `test_morning_topic_alert_once_per_url` (Review Focus 2): same Reuters tariff item on two mornings → alert first, `""` second.
  - `test_model_offline_still_sends_facts`: `complete` raises → text contains `"Verdict unavailable"`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_newswatch_run.py -v` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Live dry run** (Hermes + SearXNG up): `Financial_analyze/backend/.venv/bin/python Financial_analyze/scripts/newswatch_after_close.py` — expect a message or nothing; then delete the rows it created (`DELETE FROM news_alerts`) so the dry run doesn't suppress real alerts. Report what it printed.
- [ ] **Step 6: Hand off** — suggested message `feat(newswatch): after-close and morning alert jobs`.

### Task 9: Holdings-aware daily collector

**Files:**
- Modify: `Financial_analyze/backend/app/services/news_collector.py` (`TRACKED_TICKERS`, `collect_all_articles`, `write_daily_note`)
- Modify: `Financial_analyze/scripts/collect_daily_news.py`
- Test: `Financial_analyze/backend/tests/test_news_collector.py` (add tests)

**Interfaces:**
- Consumes: `current_vn_holdings`, `names_for`, `load_watch_config`, `sources.fetch_all_vn`, `sources.mentions` (Tasks 1, 3, 4).
- Produces:
  - `TRACKED_TICKERS` loses the VN names (`VNM`, `VIC`, `FPT`, `HPG`, `MBB`); keeps indices/US/crypto.
  - `collect_all_articles(date: str, holdings: dict[str, list[str]] | None = None) -> dict` — `holdings` maps ticker → names; result gains `"holdings": {ticker: [NewsItem]}` and `"source_errors": [str]`.
  - `write_daily_note` writes a `## Holdings` section (one `### TICKER` per holding, `- **[title](url)** — source` lines, or `_No news._`) **between** `## Day Summary` and `## Articles`, so `parse_daily_note` (which keys on the article regex) still parses — holdings lines use a different shape (`- [title](url) — source`) to stay out of the article parser.
  - `collect_daily_news.py` builds `holdings` from the DB (`current_vn_holdings` + `names_for`) and passes it.

- [ ] **Step 1: Write failing tests:** `test_daily_note_has_holdings_section` (fake result with `holdings={"HPG": [item]}` → note contains `## Holdings`, `### HPG`, item link); `test_parse_daily_note_ignores_holdings_lines` (round-trip: parsed articles unchanged by the holdings section); `test_tracked_tickers_has_no_vn_names`.
- [ ] **Step 2: Run** `.venv/bin/pytest tests/test_news_collector.py -v` → new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole file → PASS (existing tests included).
- [ ] **Step 5: Hand off** — suggested message `feat(news): holdings-aware daily collector`.

### Task 10: Cron registration and Telegram setup

**Files:**
- Create: `Financial_analyze/scripts/register_newswatch_cron.sh`
- Modify: `Financial_analyze/backend/README.md` (short "News watch" section: setup, jobs, how to pause)
- Modify: `docs/PLAN.md` Phase 6 — tick "Complete Hermes cron registration"

**Interfaces:**
- Consumes: scripts from Tasks 8–9.

`register_newswatch_cron.sh` (idempotent — skip a job whose `--name` already appears in `hermes cron list`):
1. `mkdir -p ~/.hermes/scripts` and symlink `collect_daily_news.py`, `newswatch_morning.py`, `newswatch_after_close.py` into it.
2. Create, all with `--timezone Asia/Ho_Chi_Minh --interpreter <repo>/Financial_analyze/backend/.venv/bin/python --catch-up off`:
   - `news-daily-collect`: `"0 8 * * 1-5"`, `--script collect_daily_news.py`, agent mode, `--deliver local`, prompt: read today's vault note path from the script output and fill in the Day Summary and per-article summaries, set `processed: true` (per 2026-07-07 digest spec).
   - `newswatch-morning`: `"30 8 * * 1-5"`, `--script newswatch_morning.py --no-agent --deliver telegram --failure-deliver local`.
   - `newswatch-after-close`: `"15 15 * * 1-5"`, `--script newswatch_after_close.py --no-agent --deliver telegram --failure-deliver local`.
3. Print `hermes cron list`.

- [ ] **Step 1: User setup (ask the user, don't do it for them):** create a Telegram bot with BotFather and connect it to the Hermes gateway (`hermes gateway setup` / Telegram section of `~/.hermes/config.yaml`). Confirm with a test message from Hermes before continuing.
- [ ] **Step 2: Write the script**; run `bash -n Financial_analyze/scripts/register_newswatch_cron.sh` → no output.
- [ ] **Step 3: Run it** (after user OK — it changes Hermes state) → `hermes cron list` shows the 3 jobs.
- [ ] **Step 4: Trigger once:** `hermes cron run newswatch-after-close` (or the CLI's equivalent) → message in Telegram or silent run recorded in `hermes cron runs`; then clear any `news_alerts` rows the test created.
- [ ] **Step 5: Full test run:** `.venv/bin/pytest -q` → all pass.
- [ ] **Step 6: Hand off** — suggested message `feat(newswatch): register Hermes cron jobs`.
