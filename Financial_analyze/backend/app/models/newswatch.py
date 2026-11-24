from sqlalchemy import JSON, Boolean, Column, Date, DateTime, Integer, String, Text, func

from ..db import Base


class NewsAlert(Base):
    __tablename__ = "news_alerts"
    id = Column(Integer, primary_key=True)
    kind = Column(String(16), nullable=False)  # holding | global | global_seen
    ticker = Column(String(16), nullable=True, index=True)
    alert_date = Column(Date, nullable=False, index=True)
    episode_open = Column(Boolean, nullable=False, default=False)
    verdict = Column(String(16), nullable=False)
    message = Column(Text, nullable=False)
    facts = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class CompanyName(Base):
    __tablename__ = "company_names"
    symbol = Column(String(16), primary_key=True)
    official_name = Column(String, nullable=False)
    fetched_at = Column(DateTime(timezone=True), server_default=func.now())
