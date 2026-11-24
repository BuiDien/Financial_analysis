from typing import Iterable

from sqlalchemy.orm import Session

from ..models.portfolio import PositionProjection


def current_vn_holdings(db: Session, etf_tickers: Iterable[str] = ()) -> list[str]:
    """Distinct upper-case VND tickers held (quantity > 0), minus ETFs."""
    etfs = {t.upper() for t in etf_tickers}
    rows = (
        db.query(PositionProjection.ticker)
        .filter(PositionProjection.quantity > 0, PositionProjection.currency == "VND")
        .distinct()
        .all()
    )
    return sorted({r[0].upper() for r in rows} - etfs)
