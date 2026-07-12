from sqlalchemy import (
    Column, Integer, String, DateTime, ForeignKey, JSON, Text, UniqueConstraint, func,
)
from sqlalchemy.orm import relationship

from ..db import Base


class OCRInboxItem(Base):
    __tablename__ = "ocr_inbox_items"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String(255), nullable=False)
    storage_path = Column(String(1024), nullable=False, unique=True)
    size_bytes = Column(Integer, nullable=False)
    pages = Column(Integer, nullable=False, default=0)
    checksum_sha256 = Column(String(64), nullable=False, index=True)
    status = Column(String(32), nullable=False, default="uploaded", index=True)
    error = Column(Text, nullable=True)

    company = Column(String(160), nullable=True)
    ticker = Column(String(20), nullable=True)
    filing_type = Column(String(80), nullable=True)
    period = Column(String(80), nullable=True)
    currency = Column(String(12), nullable=True)
    unit = Column(String(40), nullable=True)

    published_filing_id = Column(Integer, ForeignKey("filings.id"), nullable=True, unique=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    attempts = relationship(
        "OCRAttempt", back_populates="inbox_item", cascade="all, delete-orphan",
        order_by="OCRAttempt.id",
    )
    reviews = relationship(
        "OCRReviewJob", back_populates="inbox_item", cascade="all, delete-orphan",
        order_by="OCRReviewJob.id",
    )
    published_filing = relationship("Filing")


class OCRAttempt(Base):
    __tablename__ = "ocr_attempts"

    id = Column(Integer, primary_key=True, index=True)
    inbox_item_id = Column(Integer, ForeignKey("ocr_inbox_items.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_attempt_id = Column(Integer, ForeignKey("ocr_attempts.id"), nullable=True)
    job_id = Column(String(64), nullable=True, unique=True, index=True)
    worker_id = Column(String(64), nullable=True)
    worker_name = Column(String(160), nullable=True)
    status = Column(String(32), nullable=False, default="queued", index=True)
    progress = Column(Integer, nullable=False, default=0)
    schema_version = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    automatic = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    inbox_item = relationship("OCRInboxItem", back_populates="attempts")
    review = relationship(
        "OCRReviewJob", back_populates="attempt", uselist=False, cascade="all, delete-orphan",
    )
    parent_attempt = relationship("OCRAttempt", remote_side=[id])


class OCRReviewJob(Base):
    __tablename__ = "ocr_review_jobs"

    id = Column(Integer, primary_key=True, index=True)
    inbox_item_id = Column(Integer, ForeignKey("ocr_inbox_items.id", ondelete="CASCADE"), nullable=False, index=True)
    attempt_id = Column(Integer, ForeignKey("ocr_attempts.id", ondelete="CASCADE"), nullable=False, unique=True)
    status = Column(String(32), nullable=False, default="ready_for_review", index=True)
    revision = Column(Integer, nullable=False, default=1)
    schema_version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    verified_at = Column(DateTime(timezone=True), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)

    inbox_item = relationship("OCRInboxItem", back_populates="reviews")
    attempt = relationship("OCRAttempt", back_populates="review")
    rows = relationship(
        "OCRReviewRow", back_populates="review", cascade="all, delete-orphan",
        order_by="OCRReviewRow.id",
    )
    events = relationship(
        "OCRAuditEvent", back_populates="review", cascade="all, delete-orphan",
        order_by="OCRAuditEvent.id",
    )


class OCRReviewRow(Base):
    __tablename__ = "ocr_review_rows"
    __table_args__ = (
        UniqueConstraint("review_id", "source_index", name="uq_ocr_review_source_index"),
    )

    id = Column(Integer, primary_key=True, index=True)
    review_id = Column(Integer, ForeignKey("ocr_review_jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    source_index = Column(Integer, nullable=False)
    status = Column(String(32), nullable=False, default="pending", index=True)
    raw_data = Column(JSON, nullable=False, default=dict)
    reviewed_data = Column(JSON, nullable=True)
    page = Column(Integer, nullable=False)
    bbox = Column(JSON, nullable=False)
    confidence = Column(Integer, nullable=False, default=0)
    rejection_reason = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    review = relationship("OCRReviewJob", back_populates="rows")
    events = relationship("OCRAuditEvent", back_populates="row")


class OCRAuditEvent(Base):
    __tablename__ = "ocr_audit_events"

    id = Column(Integer, primary_key=True, index=True)
    review_id = Column(Integer, ForeignKey("ocr_review_jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    row_id = Column(Integer, ForeignKey("ocr_review_rows.id", ondelete="SET NULL"), nullable=True, index=True)
    action = Column(String(40), nullable=False)
    actor = Column(String(120), nullable=False, default="local-user")
    revision = Column(Integer, nullable=False)
    before_data = Column(JSON, nullable=True)
    after_data = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    review = relationship("OCRReviewJob", back_populates="events")
    row = relationship("OCRReviewRow", back_populates="events")
