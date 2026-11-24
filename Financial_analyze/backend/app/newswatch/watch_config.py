"""Editable news-watch configuration (newswatch.json)."""
import json
from typing import TypedDict

from ..config import get_settings


class WatchThresholds(TypedDict):
    rsi_max: float             # RSI(14) at or below this counts as oversold
    drop_pct: float            # min % fall over `sessions` sessions
    sessions: int
    rsi_reset: float           # RSI must recover above this before re-alerting
    news_days: int             # news look-back window
    max_holding_alerts: int
    vnindex_drop_pct: float    # VN-Index day fall (%) that triggers the market check


# threshold key -> (Settings field used as fallback, type)
_THRESHOLD_SETTINGS: dict[str, tuple[str, type]] = {
    "rsi_max": ("newswatch_rsi_oversold", float),
    "drop_pct": ("newswatch_drop_pct", float),
    "sessions": ("newswatch_drop_sessions", int),
    "rsi_reset": ("newswatch_rsi_reset", float),
    "news_days": ("newswatch_news_days", int),
    "max_holding_alerts": ("newswatch_max_holding_alerts", int),
    "vnindex_drop_pct": ("newswatch_vnindex_drop_pct", float),
}


def _thresholds(raw: dict | None) -> WatchThresholds:
    """JSON values win; any missing key falls back to Settings (env-overridable)."""
    raw = raw or {}
    settings = get_settings()
    out = {}
    for key, (field, cast) in _THRESHOLD_SETTINGS.items():
        v = raw.get(key)
        out[key] = cast(getattr(settings, field) if v is None else v)
    return out  # type: ignore[return-value]


class WatchConfig(TypedDict):
    etf_tickers: list[str]
    aliases: dict[str, list[str]]
    vietnam_terms: list[str]
    topics: dict[str, list[str]]
    trusted_sources: list[str]
    thresholds: WatchThresholds


def _as_list(v) -> list:
    """A bare string means one entry, not a list of characters."""
    if v is None:
        return []
    return [v] if isinstance(v, str) else list(v)


def load_watch_config(path: str | None = None) -> WatchConfig:
    path = path or get_settings().newswatch_config_path
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return {
        "etf_tickers": [str(t).upper() for t in _as_list(raw.get("etf_tickers"))],
        "aliases": {str(k).upper(): _as_list(v) for k, v in raw.get("aliases", {}).items()},
        "vietnam_terms": _as_list(raw.get("vietnam_terms")),
        "topics": {k: _as_list(v) for k, v in raw.get("topics", {}).items()},
        "trusted_sources": _as_list(raw.get("trusted_sources")),
        "thresholds": _thresholds(raw.get("thresholds")),
    }
