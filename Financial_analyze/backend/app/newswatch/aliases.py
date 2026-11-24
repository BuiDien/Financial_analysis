"""Company-name matching terms: ticker + configured brand aliases + short official name."""
import re
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

from sqlalchemy import func

from ..models.newswatch import CompanyName
from .watch_config import WatchConfig

_PREFIX = re.compile(r"^\s*(công ty cổ phần|tổng công ty|ngân hàng tmcp|ctcp)\s+",
                     re.IGNORECASE)


def _short_name(official: str) -> str:
    return _PREFIX.sub("", official, count=1).strip()


def refresh_official_names(db, provider, max_age_days: int = 30) -> int:
    newest = db.query(func.max(CompanyName.fetched_at)).scalar()
    if newest is not None:
        if newest.tzinfo is None:
            newest = newest.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - newest < timedelta(days=max_age_days):
            return 0
    try:
        names = provider.list_company_names()
    except Exception:
        return 0
    now = datetime.now(timezone.utc)
    for sym, name in names.items():
        sym = sym.upper()
        row = db.get(CompanyName, sym)
        if row is None:
            db.add(CompanyName(symbol=sym, official_name=name, fetched_at=now))
        else:
            row.official_name, row.fetched_at = name, now
    db.commit()
    return len(names)


class Names(NamedTuple):
    terms: list[str]   # ticker, config aliases, short official name — deduped casefold
    brand: str         # best search term: first config alias, else short official name, else ticker
    has_alias: bool    # a configured brand alias exists


def resolve(db, symbol: str, cfg: WatchConfig) -> Names:
    symbol = symbol.upper()
    configured = [a for a in cfg["aliases"].get(symbol, []) if a and a.strip()]
    row = db.get(CompanyName, symbol)
    short = _short_name(row.official_name) if row and row.official_name else ""
    seen: set[str] = set()
    terms: list[str] = []
    for n in (symbol, *configured, *([short] if short else [])):
        if n.casefold() not in seen:
            seen.add(n.casefold())
            terms.append(n)
    brand = configured[0] if configured else (short or symbol)
    return Names(terms=terms, brand=brand, has_alias=bool(configured))

