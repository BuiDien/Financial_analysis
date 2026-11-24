from datetime import datetime, timedelta, timezone

from app.models.newswatch import CompanyName
from app.newswatch.aliases import Names, refresh_official_names, resolve
from app.marketdata.fixture import FixtureProvider


def _cfg(aliases=None):
    return {"etf_tickers": [], "aliases": aliases or {}, "vietnam_terms": [],
            "topics": {}, "trusted_sources": []}


def test_resolve_terms_combine_ticker_alias_and_official(db):
    db.add(CompanyName(symbol="HPG", official_name="Công ty Cổ phần Tập đoàn Hòa Phát",
                       fetched_at=datetime.now(timezone.utc)))
    db.commit()
    assert resolve(db, "HPG", _cfg({"HPG": ["Hòa Phát"]})).terms == [
        "HPG", "Hòa Phát", "Tập đoàn Hòa Phát"]


def test_resolve_terms_strip_prefixes_and_dedup(db):
    db.add_all([
        CompanyName(symbol="VCB", official_name="Ngân hàng TMCP Ngoại thương Việt Nam"),
        CompanyName(symbol="ABC", official_name="CTCP ABC"),
    ])
    db.commit()
    assert resolve(db, "VCB", _cfg()).terms == ["VCB", "Ngoại thương Việt Nam"]
    assert resolve(db, "ABC", _cfg()).terms == ["ABC"]
    assert resolve(db, "ZZZ", _cfg()).terms == ["ZZZ"]


def test_refresh_fills_empty_table(db):
    prov = FixtureProvider(company_names={"HPG": "Công ty Cổ phần Tập đoàn Hòa Phát"})
    assert refresh_official_names(db, prov) == 1
    assert db.get(CompanyName, "HPG").official_name.endswith("Hòa Phát")
    prov2 = FixtureProvider(company_names={"HPG": "New Name", "FPT": "FPT Corp"})
    assert refresh_official_names(db, prov2, max_age_days=0) == 2
    assert db.get(CompanyName, "HPG").official_name == "New Name"


def test_refresh_skips_when_fresh(db):
    db.add(CompanyName(symbol="HPG", official_name="x", fetched_at=datetime.now(timezone.utc)))
    db.commit()
    prov = FixtureProvider(company_names={"HPG": "y"})
    assert refresh_official_names(db, prov) == 0
    assert prov.calls == []


def test_refresh_survives_provider_error(db):
    old = datetime.now(timezone.utc) - timedelta(days=90)
    db.add(CompanyName(symbol="HPG", official_name="keep", fetched_at=old))
    db.commit()

    class Boom(FixtureProvider):
        def list_company_names(self):
            raise RuntimeError("down")

    assert refresh_official_names(db, Boom()) == 0
    assert db.get(CompanyName, "HPG").official_name == "keep"


def test_resolve_brand_prefers_config_alias(db):
    db.add(CompanyName(symbol="HPG", official_name="Công ty Cổ phần Tập đoàn Hòa Phát"))
    db.commit()
    n = resolve(db, "hpg", _cfg({"HPG": ["Hòa Phát", "Hoa Phat"]}))
    assert n == Names(terms=["HPG", "Hòa Phát", "Hoa Phat", "Tập đoàn Hòa Phát"],
                      brand="Hòa Phát", has_alias=True)


def test_resolve_brand_falls_back_to_short_name_then_ticker(db):
    db.add(CompanyName(symbol="VCB", official_name="Ngân hàng TMCP Ngoại thương Việt Nam"))
    db.commit()
    n = resolve(db, "VCB", _cfg())
    assert n.brand == "Ngoại thương Việt Nam"
    assert not n.has_alias
    n = resolve(db, "ZZZ", _cfg())
    assert n == Names(terms=["ZZZ"], brand="ZZZ", has_alias=False)

