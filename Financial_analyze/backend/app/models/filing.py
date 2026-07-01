from sqlalchemy import Column, Integer, String, DateTime, JSON, Text, func
from ..db import Base


class Filing(Base):
    __tablename__ = "filings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    ticker = Column(String, index=True, nullable=False)
    filing_type = Column(String, nullable=False)   # 10-K, 10-Q, 8-K, ...
    period = Column(String, nullable=False)        # "FY 2025", "Q1 2026", ...
    filename = Column(String, nullable=False)
    storage_path = Column(String, nullable=False)
    size_bytes = Column(Integer, default=0)
    pages = Column(Integer, default=0)
    status = Column(String, default="pending")     # pending | processing | analyzed | failed
    extracted = Column(JSON, default=dict)         # {revenue, netIncome, fcf, notes}
    analysis = Column(Text, default="")            # AI deep-analysis text
    tracker = Column(JSON, default=dict)           # Data Tracker state (income/balance/cashflow/flags)
    uploaded_at = Column(DateTime(timezone=True), server_default=func.now())
