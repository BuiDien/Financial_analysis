from sqlalchemy import (
    CheckConstraint, Column, Integer, String, DateTime, ForeignKey, JSON, Text,
    UniqueConstraint, func,
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
    result_format = Column(String(40), nullable=False, default="structured_rows_v1")
    expected_pages = Column(Integer, nullable=True)
    received_pages = Column(Integer, nullable=False, default=0)
    merged_markdown = Column(Text, nullable=True)
    result_sha256 = Column(String(64), nullable=True)
    error = Column(Text, nullable=True)
    automatic = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    inbox_item = relationship("OCRInboxItem", back_populates="attempts")
    review = relationship(
        "OCRReviewJob", back_populates="attempt", uselist=False, cascade="all, delete-orphan",
    )
    pages = relationship(
        "OCRPageResult", back_populates="attempt", cascade="all, delete-orphan",
        order_by="OCRPageResult.page_number",
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
    result_format = Column(String(40), nullable=False, default="structured_rows_v1")
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
    label_review_runs = relationship(
        "OCRLabelReviewRun",
        back_populates="review",
        cascade="all, delete-orphan",
        order_by="OCRLabelReviewRun.id",
    )


class OCRPageResult(Base):
    __tablename__ = "ocr_page_results"
    __table_args__ = (
        UniqueConstraint("attempt_id", "page_number", name="uq_ocr_page_attempt_page"),
        CheckConstraint("page_number >= 1", name="ck_ocr_page_number_positive"),
        CheckConstraint("byte_size >= 0", name="ck_ocr_page_byte_size_nonnegative"),
    )

    id = Column(Integer, primary_key=True, index=True)
    attempt_id = Column(
        Integer, ForeignKey("ocr_attempts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    page_number = Column(Integer, nullable=False)
    raw_markdown = Column(Text, nullable=False)
    reviewed_markdown = Column(Text, nullable=True)
    review_status = Column(String(32), nullable=False, default="pending", index=True)
    content_sha256 = Column(String(64), nullable=False)
    byte_size = Column(Integer, nullable=False)
    label_check_status = Column(
        String(24), nullable=False, default="pending", index=True,
    )
    label_check_summary = Column(JSON, nullable=True)
    label_check_error = Column(Text, nullable=True)
    label_checked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )

    attempt = relationship("OCRAttempt", back_populates="pages")


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


class OCRLabelReviewRun(Base):
    __tablename__ = "ocr_label_review_runs"
    __table_args__ = (
        CheckConstraint("page_number >= 1", name="ck_ocr_label_run_page_positive"),
    )

    id = Column(Integer, primary_key=True, index=True)
    review_id = Column(
        Integer,
        ForeignKey("ocr_review_jobs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    page_number = Column(Integer, nullable=False)
    base_revision = Column(Integer, nullable=False)
    page_content_sha256 = Column(String(64), nullable=False)
    status = Column(String(24), nullable=False, default="queued", index=True)
    trigger = Column(String(24), nullable=False, default="user")
    skill_name = Column(String(80), nullable=False, default="kiem-tra-nhan-ocr")
    skill_version = Column(String(24), nullable=False, default="0.1.0")
    model = Column(String(120), nullable=True)
    # Rows selected by the user or collected by the automatic worker checker.
    # Ollama still processes them one label at a time.
    requested_rows = Column(JSON, nullable=True)
    current_table_number = Column(Integer, nullable=True)
    current_row_number = Column(Integer, nullable=True)
    processed_count = Column(Integer, nullable=False, default=0)
    tool_call_count = Column(Integer, nullable=False, default=0)
    input_token_count = Column(Integer, nullable=True)
    output_token_count = Column(Integer, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    review = relationship("OCRReviewJob", back_populates="label_review_runs")
    suggestions = relationship(
        "OCRLabelSuggestion",
        back_populates="run",
        cascade="all, delete-orphan",
        order_by="OCRLabelSuggestion.id",
    )


class OCRLabelSuggestion(Base):
    __tablename__ = "ocr_label_suggestions"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "table_number", "row_number",
            name="uq_ocr_label_suggestion_run_row",
        ),
        CheckConstraint(
            "current_level IS NULL OR current_level BETWEEN -1 AND 3",
            name="ck_ocr_label_suggestion_current_level",
        ),
        CheckConstraint(
            "suggested_level BETWEEN -1 AND 3",
            name="ck_ocr_label_suggestion_suggested_level",
        ),
        CheckConstraint(
            "user_edited_level IS NULL OR user_edited_level BETWEEN -1 AND 3",
            name="ck_ocr_label_suggestion_user_level",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(
        Integer,
        ForeignKey("ocr_label_review_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    table_number = Column(Integer, nullable=False)
    row_number = Column(Integer, nullable=False)
    label_cell_hash = Column(String(64), nullable=False)
    current_label = Column(Text, nullable=False)
    suggested_label = Column(Text, nullable=True)
    current_level = Column(Integer, nullable=True)
    suggested_level = Column(Integer, nullable=False)
    confidence = Column(String(12), nullable=False)
    reason_codes = Column(JSON, nullable=False, default=list)
    evidence = Column(JSON, nullable=False, default=dict)
    explanation = Column(Text, nullable=False)
    visual_confirmation_required = Column(Integer, nullable=False, default=0)
    decision = Column(String(16), nullable=False, default="pending", index=True)
    user_edited_level = Column(Integer, nullable=True)
    applied_revision = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    run = relationship("OCRLabelReviewRun", back_populates="suggestions")
