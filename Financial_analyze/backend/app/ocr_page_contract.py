import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


OCR_PAGE_SCHEMA_VERSION = 2
OCR_PAGE_RESULT_FORMAT = "page_markdown_v2"
MAX_PAGE_MARKDOWN_BYTES = 1024 * 1024
MAX_DOCUMENT_MARKDOWN_BYTES = 20 * 1024 * 1024
MAX_PAGE_MESSAGE_BYTES = MAX_PAGE_MARKDOWN_BYTES + 16 * 1024
MAX_DOCUMENT_PAGES = 10000


class OCRPageContractError(ValueError):
    code = "invalid_page_result"
    retryable = False


class OCRPageResultMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["page_result"]
    jobId: str = Field(min_length=1, max_length=64)
    schemaVersion: Literal[2]
    page: int = Field(ge=1, le=MAX_DOCUMENT_PAGES)
    pageCount: int = Field(ge=1, le=MAX_DOCUMENT_PAGES)
    markdown: str

    @model_validator(mode="after")
    def page_is_in_document(self):
        if self.page > self.pageCount:
            raise ValueError("page exceeds pageCount")
        return self


class OCRResultEndMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["result_end"]
    jobId: str = Field(min_length=1, max_length=64)
    schemaVersion: Literal[2]
    pageCount: int = Field(ge=1, le=MAX_DOCUMENT_PAGES)


def _validation_summary(exc: ValidationError) -> str:
    errors = exc.errors(include_url=False, include_input=False)
    details = []
    for error in errors[:8]:
        location = ".".join(str(part) for part in error["loc"])
        details.append(f"{location}: {error['msg']}")
    remaining = len(errors) - len(details)
    suffix = f"; +{remaining} more" if remaining else ""
    return f"Page result rejected: {'; '.join(details)}{suffix}"


def validate_page_message(
    message: dict, *, expected_job_id: str, expected_pages: int,
) -> OCRPageResultMessage:
    encoded_size = len(json.dumps(message, ensure_ascii=False).encode("utf-8"))
    if encoded_size > MAX_PAGE_MESSAGE_BYTES:
        raise OCRPageContractError("Page result exceeds the maximum message size")
    try:
        result = OCRPageResultMessage.model_validate(message)
    except ValidationError as exc:
        raise OCRPageContractError(_validation_summary(exc)) from exc
    if result.jobId != expected_job_id:
        raise OCRPageContractError("Page result jobId does not match the active job")
    if expected_pages and result.pageCount != expected_pages:
        raise OCRPageContractError(
            f"pageCount {result.pageCount} does not match document page count {expected_pages}"
        )
    markdown_bytes = len(result.markdown.encode("utf-8"))
    if markdown_bytes > MAX_PAGE_MARKDOWN_BYTES:
        raise OCRPageContractError("Page Markdown exceeds the 1 MiB limit")
    return result


def validate_result_end(
    message: dict, *, expected_job_id: str, expected_pages: int,
) -> OCRResultEndMessage:
    try:
        result = OCRResultEndMessage.model_validate(message)
    except ValidationError as exc:
        raise OCRPageContractError(_validation_summary(exc)) from exc
    if result.jobId != expected_job_id:
        raise OCRPageContractError("Result end jobId does not match the active job")
    if expected_pages and result.pageCount != expected_pages:
        raise OCRPageContractError(
            f"pageCount {result.pageCount} does not match document page count {expected_pages}"
        )
    return result
