from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import relationship

from ..db import Base


MONEY = Numeric(28, 8)
QUANTITY = Numeric(28, 10)


class Portfolio(Base):
    __tablename__ = "portfolios"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    name = Column(String, default="Main")
    display_currency = Column(String(3), nullable=False, default="USD")
    ledger_revision = Column(Integer, nullable=False, default=0)
    projection_revision = Column(Integer, nullable=False, default=0)
    projection_status = Column(String(24), nullable=False, default="ready")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    holdings = relationship(
        "Holding", back_populates="portfolio", cascade="all,delete-orphan"
    )
    transactions = relationship(
        "PortfolioTransaction", back_populates="portfolio", cascade="all,delete-orphan"
    )


class Holding(Base):
    """Legacy aggregate position. Kept only for migration/API compatibility."""

    __tablename__ = "holdings"
    id = Column(Integer, primary_key=True, index=True)
    portfolio_id = Column(Integer, ForeignKey("portfolios.id"), nullable=False)
    ticker = Column(String, index=True, nullable=False)
    shares = Column(Numeric(28, 10), nullable=False)
    cost_basis = Column(Numeric(28, 8), nullable=False)
    opened_at = Column(DateTime(timezone=True), server_default=func.now())
    migrated_at = Column(DateTime(timezone=True), nullable=True)
    portfolio = relationship("Portfolio", back_populates="holdings")


class PortfolioTransaction(Base):
    __tablename__ = "portfolio_transactions"
    id = Column(Integer, primary_key=True)
    portfolio_id = Column(
        Integer, ForeignKey("portfolios.id"), nullable=False, index=True
    )
    type = Column(String(16), nullable=False, index=True)
    effective_at = Column(DateTime(timezone=True), nullable=False, index=True)
    ticker = Column(String(32), nullable=True, index=True)
    quantity = Column(QUANTITY, nullable=True)
    unit_price = Column(MONEY, nullable=True)
    cash_amount = Column(MONEY, nullable=True)
    currency = Column(String(3), nullable=False, index=True)
    fees = Column(MONEY, nullable=False, default=0)
    taxes = Column(MONEY, nullable=False, default=0)
    note = Column(Text, nullable=True)
    source = Column(String(32), nullable=False, default="manual")
    external_id = Column(String(160), nullable=True)
    status = Column(String(16), nullable=False, default="active", index=True)
    replaces_transaction_id = Column(
        Integer, ForeignKey("portfolio_transactions.id"), nullable=True
    )
    currency_assumed = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    voided_at = Column(DateTime(timezone=True), nullable=True)
    portfolio = relationship("Portfolio", back_populates="transactions")

    __table_args__ = (
        UniqueConstraint(
            "portfolio_id", "source", "external_id", name="uq_portfolio_import_external"
        ),
    )


class PositionProjection(Base):
    __tablename__ = "portfolio_position_projections"
    id = Column(Integer, primary_key=True)
    portfolio_id = Column(
        Integer, ForeignKey("portfolios.id"), nullable=False, index=True
    )
    ticker = Column(String(32), nullable=False)
    currency = Column(String(3), nullable=False)
    quantity = Column(QUANTITY, nullable=False)
    cost_basis_native = Column(MONEY, nullable=False)
    cost_basis_display = Column(MONEY, nullable=False)
    revision = Column(Integer, nullable=False)
    __table_args__ = (
        UniqueConstraint(
            "portfolio_id", "ticker", "currency", name="uq_portfolio_position"
        ),
    )


class CashProjection(Base):
    __tablename__ = "portfolio_cash_projections"
    id = Column(Integer, primary_key=True)
    portfolio_id = Column(
        Integer, ForeignKey("portfolios.id"), nullable=False, index=True
    )
    currency = Column(String(3), nullable=False)
    balance = Column(MONEY, nullable=False)
    revision = Column(Integer, nullable=False)
    __table_args__ = (
        UniqueConstraint("portfolio_id", "currency", name="uq_portfolio_cash"),
    )


class ProjectionSummary(Base):
    __tablename__ = "portfolio_projection_summaries"
    portfolio_id = Column(Integer, ForeignKey("portfolios.id"), primary_key=True)
    display_currency = Column(String(3), nullable=False)
    realized_gain = Column(MONEY, nullable=False, default=0)
    income = Column(MONEY, nullable=False, default=0)
    net_contributions = Column(MONEY, nullable=False, default=0)
    revision = Column(Integer, nullable=False)
    calculated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DailyPortfolioSnapshot(Base):
    __tablename__ = "portfolio_daily_snapshots"
    id = Column(Integer, primary_key=True)
    portfolio_id = Column(
        Integer, ForeignKey("portfolios.id"), nullable=False, index=True
    )
    date = Column(Date, nullable=False)
    display_currency = Column(String(3), nullable=False)
    value = Column(MONEY, nullable=False)
    net_flow = Column(MONEY, nullable=False, default=0)
    twr = Column(Numeric(20, 12), nullable=False, default=0)
    revision = Column(Integer, nullable=False)
    __table_args__ = (
        UniqueConstraint(
            "portfolio_id",
            "date",
            "display_currency",
            name="uq_portfolio_daily_snapshot",
        ),
    )


class PortfolioJob(Base):
    __tablename__ = "portfolio_jobs"
    id = Column(String(48), primary_key=True)
    portfolio_id = Column(
        Integer, ForeignKey("portfolios.id"), nullable=False, index=True
    )
    type = Column(String(24), nullable=False)
    status = Column(String(16), nullable=False, default="queued", index=True)
    progress = Column(Integer, nullable=False, default=0)
    payload = Column(Text, nullable=True)
    result = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)


class MarketDataPoint(Base):
    __tablename__ = "portfolio_market_data"
    id = Column(Integer, primary_key=True)
    kind = Column(String(12), nullable=False)  # quote | fx | close
    key = Column(String(80), nullable=False)
    date = Column(Date, nullable=False)
    value = Column(MONEY, nullable=False)
    provider = Column(String(32), nullable=False, default="yfinance")
    fetched_at = Column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("kind", "key", "date", name="uq_portfolio_market_point"),
    )
