from sqlalchemy import Boolean, Column, DateTime, Integer, JSON, String, Text

from ..db import Base


class TickerMetrics(Base):
    __tablename__ = "ticker_metrics"
    symbol = Column(String, primary_key=True)
    exchange = Column(String, nullable=False, default="")
    industry = Column(String, nullable=True)
    is_bank = Column(Boolean, nullable=False, default=False)
    financials = Column(JSON, nullable=True)
    financials_at = Column(DateTime(timezone=True), nullable=True)
    prices = Column(JSON, nullable=True)          # compute_price_metrics dict
    prices_at = Column(DateTime(timezone=True), nullable=True)
    last_error = Column(String, nullable=True)
    board = Column(JSON, nullable=True)           # {flag, status, foreign_room, as_of}


class Strategy(Base):
    __tablename__ = "screener_strategies"
    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)
    starter_key = Column(String, nullable=True)   # set for shipped starters
    rules = Column(JSON, nullable=False, default=list)
    updated_at = Column(DateTime(timezone=True))


class ScreenerState(Base):
    __tablename__ = "screener_state"
    key = Column(String, primary_key=True)
    value = Column(JSON)


class TickerNote(Base):
    __tablename__ = "ticker_notes"
    id = Column(Integer, primary_key=True)
    symbol = Column(String, index=True, nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True), nullable=True)  # only when edited
