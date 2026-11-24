from sqlalchemy import BigInteger, Boolean, Column, DateTime, Float, JSON, String, Text

from ..db import Base


class PriceAlert(Base):
    """User price / %-move alert (moved out of browser localStorage `helix_alerts_v1`).

    Not to be confused with `news_alerts` (newswatch). `id` is a string because
    the frontend mints its own ids (`a_<ms>`); imports keep them for idempotency.
    """

    __tablename__ = "price_alerts"
    id = Column(String, primary_key=True)
    ticker = Column(String, nullable=False, index=True)
    type = Column(String, nullable=False)
    value = Column(Float, nullable=True)
    currency = Column(String, nullable=True)
    note = Column(Text, nullable=True)
    channels = Column(JSON, nullable=True)
    active = Column(Boolean, nullable=False, default=True)
    triggered = Column(Boolean, nullable=False, default=False)
    triggered_at = Column(BigInteger, nullable=True)   # epoch ms, as the frontend writes it
    triggered_price = Column(Float, nullable=True)
    created = Column(String, nullable=True)            # YYYY-MM-DD shown in the table
    extra = Column(JSON, nullable=True)                # unmodelled client fields
    created_ts = Column(DateTime(timezone=True), nullable=False)  # list ordering
