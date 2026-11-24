"""Job orchestration: 15:15 after-close oversold check, 08:30 morning Vietnam-topic check.

After close: decide candidates (episodes.sweep) -> gather facts (aliases + news) ->
judge (verdict) -> format (message) -> persist (one commit for episode changes and
alert rows; the vault note is best-effort).
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Callable, Protocol
from zoneinfo import ZoneInfo

from ..config import get_settings
from ..screener.provider import get_provider
from ..services import ai, market, news
from ..services.news_feeds import NewsItem, dedupe_by_url, fetch_all_vn, match_holding_news
from . import aliases, episodes, global_rule, holdings, message, oversold, store, verdict
from .watch_config import WatchConfig, load_watch_config

_TZ = ZoneInfo("Asia/Ho_Chi_Minh")
VNINDEX = "VN:VNINDEX"
Fetched = tuple[list[NewsItem], list[str]]  # (items, source errors)


class NewsPort(Protocol):
    def vn_items(self) -> Fetched: ...
    def global_items(self, cfg: WatchConfig) -> Fetched: ...
    def search(self, query: str, count: int = 5, **kw) -> list[dict]: ...


class LiveNews:
    """Production adapter; every web search (global and per-holding) goes through search()."""

    def vn_items(self) -> Fetched:
        return fetch_all_vn()

    def global_items(self, cfg: WatchConfig) -> Fetched:
        return global_rule.fetch_global_candidates(cfg, search=self.search)

    def search(self, query: str, count: int = 5, **kw) -> list[dict]:
        return news.search_web(query, count, **kw)


@dataclass
class Deps:
    history: Callable[[str], list[dict]] = lambda t: market.get_history(t, "6mo")
    complete: Callable[..., str] = ai.hermes_complete
    news: NewsPort = field(default_factory=LiveNews)
    provider_factory: Callable[[], object] = get_provider  # official company names
    vault_news_dir: str = field(default_factory=lambda: get_settings().vault_news_dir)


class _NewsCache:
    """Fetch each feed set at most once per run; global items limited to the last 24 h."""

    def __init__(self, port: NewsPort, cfg: WatchConfig):
        self._port, self._cfg, self._vn, self._g = port, cfg, None, None

    def vn(self) -> Fetched:
        if self._vn is None:
            self._vn = self._port.vn_items()
        return self._vn

    def recent_global(self) -> list[NewsItem]:
        if self._g is None:
            items, _ = self._port.global_items(self._cfg)
            cutoff = int(datetime.now(_TZ).timestamp()) - 86400
            # undated items (RSS without dates, published == 0) are kept
            self._g = dedupe_by_url(i for i in items if i["published"] == 0 or i["published"] >= cutoff)
        return self._g


def _since(day: date, days_back: int) -> int:
    return int(datetime.combine(day - timedelta(days=days_back), time.min, tzinfo=_TZ).timestamp())


def _closes(bars: list[dict]) -> list[float]:
    return [float(b["close"]) for b in bars]


def _persist(db, today: date, text: str, pending: list[dict], deps: Deps) -> None:
    """One commit for the alert rows plus any episode changes already in the session;
    then the vault note — delivery never depends on the vault."""
    for row in pending:
        store.record_alert(db, alert_date=today, commit=False, **row)
    db.commit()
    try:
        message.write_alert_note(today, text, deps.vault_news_dir)
    except Exception as e:  # noqa: BLE001
        print(f"vault note failed: {e}", file=sys.stderr)


def _holding_alert(db, ticker, sig, vn_closes, news_cache, deps, cfg, since) -> tuple[str, dict]:
    names = aliases.resolve(db, ticker, cfg)
    items, fetch_errors = news_cache.vn()
    matched, search_errors = match_holding_news(items, names.terms, since,
                                                search=deps.news.search, brand=names.brand)
    facts, v = verdict.judge_holding({
        "ticker": ticker, "signal": sig,
        "vnindex_pct": oversold.pct_change(vn_closes, sig["sessions"]),
        "company_news": matched, "global_news": news_cache.recent_global(),
        "source_errors": [*fetch_errors, *search_errors], "has_alias": names.has_alias,
    }, deps.complete)
    text = message.format_holding_alert(facts, v, cfg["thresholds"]["news_days"])
    return text, dict(kind="holding", ticker=ticker, verdict=v["category"], message=text,
                      episode_open=True,
                      facts={"signal": sig, "urls": [i["url"] for i in facts["company_news"]]})


def run_after_close(db, today: date, deps: Deps | None = None,
                    cfg: WatchConfig | None = None) -> str:
    deps = deps or Deps()
    cfg = cfg or load_watch_config()
    th = cfg["thresholds"]

    vn_bars = deps.history(VNINDEX)
    if not vn_bars or str(vn_bars[-1]["date"])[:10] != today.isoformat():
        return ""  # holiday / no data: touch nothing
    try:  # commits on its own, so it runs before any episode change is staged
        aliases.refresh_official_names(db, deps.provider_factory())
    except Exception as e:  # noqa: BLE001 — never block the run
        print(f"official-name refresh failed: {e}", file=sys.stderr)

    held = holdings.current_vn_holdings(db, cfg["etf_tickers"])
    closes: dict[str, list[float]] = {}
    for ticker in held:
        try:
            closes[ticker] = _closes(deps.history(f"VN:{ticker}"))
        except Exception:  # noqa: BLE001 — one bad ticker must not kill the job
            print(f"{ticker}: price data unavailable", file=sys.stderr)
    try:
        candidates = episodes.sweep(db, held, closes, th)
        cap = th["max_holding_alerts"]
        news_cache = _NewsCache(deps.news, cfg)
        alerts: list[str] = []
        pending: list[dict] = []  # recorded only after every message text exists
        since = _since(today, th["news_days"])
        for ticker, sig in candidates[:cap]:
            text, row = _holding_alert(db, ticker, sig, _closes(vn_bars), news_cache, deps, cfg, since)
            alerts.append(text)
            pending.append(row)
        overflow = [t for t, _ in candidates[cap:]]
        pending += [dict(kind="holding", ticker=t, verdict="overflow", message="", episode_open=True,
                         facts={"signal": sig, "urls": []}) for t, sig in candidates[cap:]]

        change = global_rule.vnindex_day_change(vn_bars)
        if (change is not None and change[1] <= -th["vnindex_drop_pct"]
                and not store.global_alert_sent(db, today)):
            pct = change[1]
            seen, gv = verdict.judge_global(news_cache.recent_global(), pct, deps.complete)
            text = message.format_global_alert(seen, pct, gv)
            alerts.append(text)
            pending.append(dict(kind="global", ticker=None, verdict=gv["category"], message=text,
                                episode_open=False,
                                facts={"urls": [i["url"] for i in seen], "vnindex_pct": pct}))

        text = message.combine(alerts, overflow)
        _persist(db, today, text, pending, deps)
    except Exception:
        db.rollback()  # no half-applied episode changes without their alert rows
        raise
    return text


def run_morning(db, today: date, deps: Deps | None = None,
                cfg: WatchConfig | None = None) -> str:
    """Send a model-confirmed vietnam_topic with a cited item, or the matched facts
    unverified when the model is unreachable. Otherwise stay silent but record the
    matched URLs as global_seen so they never re-trigger (global_seen does not use
    up the day's one global alert)."""
    if today.weekday() >= 5 or store.global_alert_sent(db, today):
        return ""
    deps = deps or Deps()
    cfg = cfg or load_watch_config()
    items, _errors = deps.news.global_items(cfg)
    matched = global_rule.match_vietnam_topics(dedupe_by_url(items), cfg,
                                               exclude_urls=store.alerted_urls(db))
    if not matched:
        return ""
    seen, gv = verdict.judge_global(matched, None, deps.complete, mode="morning")
    if gv["category"] == "vietnam_topic" and gv["cited"]:
        text, kind = message.format_global_alert(seen, None, gv), "global"
    elif gv["category"] == "unavailable":
        text, kind = message.format_global_alert(seen, None, gv, facts_if_unavailable=True), "global"
    else:
        text, kind = "", "global_seen"
    urls = list(dict.fromkeys(m["url"] for m in matched))
    pending = [dict(kind=kind, ticker=None, verdict=gv["category"], message=text,
                    episode_open=False, facts={"urls": urls})]
    _persist(db, today, text, pending, deps)
    return text
