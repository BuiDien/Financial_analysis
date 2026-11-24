"""Request schemas for the OCR Inbox API."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class LabelsIn(BaseModel):
    company: str = Field(min_length=1, max_length=160)
    ticker: str = Field(min_length=1, max_length=20)
    filing_type: str = Field(min_length=1, max_length=80)
    period: str = Field(min_length=1, max_length=80)
    currency: str = Field(min_length=1, max_length=12)
    unit: str = Field(min_length=1, max_length=40)
    scope: Literal["consolidated", "separate"] | None = None
    fiscal_year: int | None = Field(default=None, ge=2000, le=2100)
    period_code: Literal["Q1", "Q2", "Q3", "Q4", "H1", "FY"] | None = None



class ReviewActionIn(BaseModel):
    revision: int = Field(ge=1)
    data: dict | None = None
    reason: str | None = Field(default=None, max_length=1000)


class MarkdownReviewActionIn(BaseModel):
    revision: int = Field(ge=1)
    markdown: str | None = None


class AutoLabelLevelsIn(BaseModel):
    revision: int = Field(ge=1)
    markdown: str


class LabelReviewTargetIn(BaseModel):
    table: int = Field(ge=1)
    row: int = Field(ge=1)


class StartLabelReviewIn(BaseModel):
    revision: int = Field(ge=1)
    targets: list[LabelReviewTargetIn] = Field(min_length=1, max_length=20)


class LabelSuggestionDecisionIn(BaseModel):
    decision: str
    user_edited_level: int | None = Field(default=None, ge=-1, le=3)


class ApplyLabelSuggestionsIn(BaseModel):
    revision: int = Field(ge=1)
    page_content_sha256: str = Field(min_length=64, max_length=64)
    suggestion_ids: list[int] = Field(min_length=1, max_length=50)


class QuickCorrectIn(BaseModel):
    revision: int = Field(ge=1)
    statement_type: str = Field(min_length=2, max_length=64)


class ReopenReviewIn(BaseModel):
    revision: int = Field(ge=1)
    reason: str | None = Field(default=None, max_length=1000)


class HistoryColumnIn(BaseModel):
    column: int = Field(ge=0)
    skip: bool = False
    period_type: Literal["instant", "quarter", "ytd", "year"] | None = None
    period_start: date | None = None
    period_end: date | None = None

    @model_validator(mode="after")
    def _check_period(self):
        if self.skip:
            return self
        if self.period_type is None or self.period_end is None:
            raise ValueError("period_type and period_end are required unless skip is true")
        if self.period_type == "instant":
            if self.period_start is not None:
                raise ValueError("an instant period has no start date")
        elif self.period_start is None or self.period_start > self.period_end:
            raise ValueError("period_start is required and must not be after period_end")
        return self


class HistoryTableIn(BaseModel):
    page: int = Field(ge=1)
    table: int = Field(ge=1)
    kind: Literal["balance", "income", "cashflow", "skip"] | None = None
    unit_multiplier: Literal[1, 1_000, 1_000_000, 1_000_000_000] | None = None
    columns: list[HistoryColumnIn] = Field(default_factory=list)


class HistoryLineIn(BaseModel):
    page: int = Field(ge=1)
    table: int = Field(ge=1)
    row: int = Field(ge=1)
    line_key: str | None = Field(default=None, max_length=80)
    new_line_name: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _one_answer(self):
        if bool(self.line_key) == bool((self.new_line_name or "").strip()):
            raise ValueError("give exactly one of line_key or new_line_name")
        return self


class HistoryMisreadIn(BaseModel):
    page: int = Field(ge=1)
    content_sha256: str = Field(min_length=64, max_length=64)
    table: int = Field(ge=1)
    parent_row: int = Field(ge=1)
    column_label: str = Field(max_length=500)


class HistoryResolutionIn(BaseModel):
    fact_key: str = Field(min_length=1, max_length=255)
    chosen: Literal["incoming"] | int


class HistoryAnswersIn(BaseModel):
    revision: int = Field(ge=1)
    tables: list[HistoryTableIn] = Field(default_factory=list)
    lines: list[HistoryLineIn] = Field(default_factory=list)
    accepted_misreads: list[HistoryMisreadIn] = Field(default_factory=list)
    resolutions: list[HistoryResolutionIn] = Field(default_factory=list)
