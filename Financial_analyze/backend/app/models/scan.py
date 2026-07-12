from sqlalchemy import (
    Column, Integer, String, Float, Boolean, DateTime, ForeignKey, JSON, func,
)
from sqlalchemy.orm import relationship

from ..db import Base


class ScanRun(Base):
    __tablename__ = "scan_runs"
    id = Column(Integer, primary_key=True, index=True)
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    mode = Column(String, default="manual")          # scheduled | manual
    universe_size = Column(Integer, default=0)

    results = relationship("ScanResult", back_populates="run", cascade="all, delete-orphan")


class ScanResult(Base):
    __tablename__ = "scan_results"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("scan_runs.id"), index=True, nullable=False)
    symbol = Column(String, index=True, nullable=False)
    scores = Column(JSON, default=dict)              # per-dimension sub-scores
    total_score = Column(Float, default=0.0)
    lean = Column(String, default="avoid")           # long_term | short_term | avoid
    rank = Column(Integer, default=0)
    verified = Column(Boolean, default=False)        # broad scan = always False

    run = relationship("ScanRun", back_populates="results")
