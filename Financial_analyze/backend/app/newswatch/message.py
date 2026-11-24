"""Telegram alert text and the vault alert note. Verdict first, then facts."""
import math
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ..services.news_feeds import NewsItem
from .verdict import GlobalVerdict, HoldingFacts, Verdict

_TZ = ZoneInfo("Asia/Ho_Chi_Minh")

HOLDING_LABELS = {
    "company_news": "Company news behind the drop",
    "market_wide": "Broad selloff, no company problem found",
    "no_news": "No news found — possible shakeout",
    "unclear": "Unclear",
    "unavailable": "Verdict unavailable (model not reachable)",
}
GLOBAL_LABELS = {
    "global_cause": "Likely global cause",
    "no_clear_cause": "No clear global cause",
    "vietnam_topic": "Vietnam-specific news",
    "unavailable": "Verdict unavailable (model not reachable)",
}
TOPIC_NAMES = {
    "tariffs": "Trade/tariffs",
    "reclassification": "Market reclassification",
    "sbv": "SBV policy",
    "sanctions": "Sanctions",
}


def _ddmm(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, _TZ).strftime("%d/%m")


def _link(it: NewsItem) -> str:
    """`[title](url) — source`, safe against feed text breaking markdown/lines."""
    title = " ".join(it["title"].split()).replace("[", "(").replace("]", ")")
    url = it["url"].strip()
    url = url.replace(" ", "%20").replace("(", "%28").replace(")", "%29")
    source = " ".join(it["source"].split())
    return f"[{title}]({url}) — {source}"


def _verdict_line(label: str, reason: str, category: str = "") -> str:
    if category == "unavailable":
        return label  # already reads "Verdict unavailable (...)"
    return f"Verdict: {label}. {reason}".rstrip()


def format_holding_alert(facts: HoldingFacts, verdict: Verdict, news_days: int = 7) -> str:
    sig = facts["signal"]
    parts = []
    if sig.get("rsi") is not None:
        parts.append(f"RSI {math.floor(sig['rsi'])}")
    if sig["drop_pct"] != 0.0:
        parts.append(f"{sig['drop_pct']:+.0f}% in {sig['sessions']} sessions")
    ticker = facts["ticker"]
    lines = [
        f"🔻 {ticker} oversold" + (" — " + ", ".join(parts) if parts else ""),
        _verdict_line(HOLDING_LABELS.get(verdict["category"], "Unclear"), verdict["reason"],
                      verdict["category"]),
        "Facts:",
    ]
    if facts.get("vnindex_pct") is not None:
        lines.append(f" • VN-Index {facts['vnindex_pct']:+.1f}% same period")
    cited = list(verdict.get("cited") or [])
    news = facts["company_news"]
    if news:
        by_id = {i["id"]: i for i in news}
        first = [by_id[c] for c in cited if c in by_id]
        ordered = first + [i for i in news if i not in first]
        for it in ordered:
            date_part = f", {_ddmm(it['published'])}" if it.get("published") else ""
            lines.append(f" • {_link(it)}{date_part}")
    else:
        lines.append(f" • No {ticker} news found in sources checked ({news_days}d)")
    for it in facts["global_news"]:
        if it["id"] in cited:
            lines.append(f" • Global: {_link(it)}")
    if facts["source_errors"]:
        keys = list(dict.fromkeys(e.split(":", 1)[0].strip() for e in facts["source_errors"]))
        lines.append(f" • ⚠ Sources unavailable: {', '.join(keys)}")
    return "\n".join(lines)


FALLBACK_ITEMS = 5


def format_global_alert(items: list[NewsItem], vnindex_pct: float | None, verdict: GlobalVerdict,
                        facts_if_unavailable: bool = False) -> str:
    """Header + verdict, then only the items the verdict cited (none when no clear cause).

    With ``facts_if_unavailable`` and no model, list the first few matched items
    instead: unverified facts beat silence.
    """
    category = verdict["category"]
    by_id = {i["id"]: i for i in items}
    cited = [by_id[c] for c in (verdict.get("cited") or []) if c in by_id]
    if category in ("no_clear_cause", "unavailable"):
        cited = []
    if category == "unavailable" and facts_if_unavailable:
        cited = items[:FALLBACK_ITEMS]
    if category in ("vietnam_topic", "unavailable") and cited and cited[0].get("topic"):
        key = cited[0].get("topic", "")
        header = f"🌏 Vietnam news: {TOPIC_NAMES.get(key, key)}"
    elif vnindex_pct is not None:
        header = f"🌏 Vietnam market alert — VN-Index {vnindex_pct:+.1f}% today"
    else:
        header = "🌏 Vietnam market alert"
    lines = [header, _verdict_line(GLOBAL_LABELS.get(category, "No clear global cause"),
                                   verdict["reason"], category)]
    for it in cited:
        lines.append(f" • {_link(it)}")
    return "\n".join(lines)


def combine(alerts: list[str], overflow_tickers: list[str]) -> str:
    parts = list(alerts)
    if overflow_tickers:
        parts.append(f"Also oversold: {', '.join(overflow_tickers)} (no verdict; daily cap reached)")
    return "\n\n".join(parts)


def write_alert_note(day: date, text: str, vault_news_dir: str) -> str:
    if not text:
        return ""
    path = Path(vault_news_dir) / "Alerts" / f"{day.isoformat()}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", encoding="utf-8") as fh:
        if new:
            fh.write(f"# Alerts — {day.isoformat()}\n")
        fh.write(f"\n{text}\n")
    return str(path)
