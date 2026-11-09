"""Gmail import: connection settings (one row) and pulled broker reports.

The app password is NOT stored here — it lives in macOS Keychain
(see services/secret_store.py).
"""
from sqlalchemy import Boolean, Column, DateTime, Integer, JSON, String, Text, func

from ..db import Base


class GmailConfig(Base):
    __tablename__ = "gmail_config"
    id = Column(Integer, primary_key=True)  # always 1
    address = Column(String, nullable=True)
    query = Column(Text, nullable=True)
    enabled = Column(Boolean, nullable=False, default=False)
    interval_minutes = Column(Integer, nullable=False, default=30)
    last_checked_at = Column(DateTime(timezone=True), nullable=True)
    last_status = Column(String, nullable=True)  # ok | error
    last_error = Column(Text, nullable=True)
    last_summary = Column(JSON, nullable=True)


class GmailReport(Base):
    """One Gmail message matched by the query. Unique per Gmail message id,
    so a message is downloaded once no matter how often we check."""

    __tablename__ = "gmail_reports"
    id = Column(Integer, primary_key=True, index=True)
    gm_msgid = Column(String, unique=True, index=True, nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=True)
    sender = Column(String, nullable=True)
    subject = Column(Text, nullable=True)
    status = Column(String, nullable=False)  # downloaded | no_pdf | error
    error = Column(Text, nullable=True)
    # [{filename, path, size, sha256, encrypted}]
    attachments = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
