import json
from pathlib import Path

from app.config import get_settings
from app.newswatch.watch_config import load_watch_config

REAL = Path(__file__).resolve().parent.parent / "newswatch.json"


def test_string_values_become_one_item_lists(tmp_path):
    p = tmp_path / "w.json"
    p.write_text(json.dumps({
        "etf_tickers": "e1vfvn30",
        "aliases": {"vcb": "Vietcombank", "hpg": ["Hòa Phát"]},
        "vietnam_terms": "vietnam",
        "topics": {"sbv": "sbv", "tariffs": ["tariff"]},
        "trusted_sources": "reuters.com",
    }), encoding="utf-8")
    cfg = load_watch_config(str(p))
    assert cfg["etf_tickers"] == ["E1VFVN30"]
    assert cfg["aliases"] == {"VCB": ["Vietcombank"], "HPG": ["Hòa Phát"]}
    assert cfg["vietnam_terms"] == ["vietnam"]
    assert cfg["topics"] == {"sbv": ["sbv"], "tariffs": ["tariff"]}
    assert cfg["trusted_sources"] == ["reuters.com"]


def test_real_config_parses():
    cfg = load_watch_config(str(REAL))
    assert cfg["etf_tickers"] and all(t.isupper() for t in cfg["etf_tickers"])
    assert cfg["aliases"]["HPG"] and all(isinstance(v, list) and all(len(x) > 1 for x in v)
                                          for v in cfg["aliases"].values())
    assert set(cfg["topics"]) == {"tariffs", "reclassification", "sbv", "sanctions"}
    for kws in cfg["topics"].values():
        assert kws and all(isinstance(k, str) and len(k) > 1 for k in kws)
    assert "reuters.com" in cfg["trusted_sources"]
    assert "vietnam" in cfg["vietnam_terms"]


def test_real_config_thresholds():
    assert load_watch_config(str(REAL))["thresholds"] == {
        "rsi_max": 30.0, "drop_pct": 10.0, "sessions": 5, "rsi_reset": 40.0,
        "news_days": 7, "max_holding_alerts": 3, "vnindex_drop_pct": 2.0}


def test_thresholds_from_json_override(tmp_path):
    p = tmp_path / "w.json"
    p.write_text(json.dumps({"thresholds": {"rsi_max": 25, "sessions": "3", "news_days": 14}}),
                 encoding="utf-8")
    t = load_watch_config(str(p))["thresholds"]
    assert t["rsi_max"] == 25.0 and isinstance(t["rsi_max"], float)
    assert t["sessions"] == 3 and isinstance(t["sessions"], int)
    assert t["news_days"] == 14
    s = get_settings()
    assert t["drop_pct"] == s.newswatch_drop_pct
    assert t["max_holding_alerts"] == s.newswatch_max_holding_alerts


def test_missing_thresholds_fall_back_to_settings(tmp_path, monkeypatch):
    monkeypatch.setenv("NEWSWATCH_RSI_OVERSOLD", "28")
    monkeypatch.setenv("NEWSWATCH_VNINDEX_DROP_PCT", "1.5")
    get_settings.cache_clear()
    try:
        p = tmp_path / "w.json"
        p.write_text("{}", encoding="utf-8")
        t = load_watch_config(str(p))["thresholds"]
        assert t["rsi_max"] == 28.0
        assert t["vnindex_drop_pct"] == 1.5
        assert t["sessions"] == get_settings().newswatch_drop_sessions
    finally:
        get_settings.cache_clear()
