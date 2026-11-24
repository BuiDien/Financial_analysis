"""OCR worker wire protocol: versions, result formats, job states, negotiation.

See the module docstring of ``app/routes/sync.py`` and docs/design/OCR_PROTOCOL.md
for the frame sequence.
"""

import json

from ..ocr_contract import OCR_RESULT_SCHEMA_VERSION
from ..ocr_page_contract import OCR_PAGE_RESULT_FORMAT, OCR_PAGE_SCHEMA_VERSION

__all__ = [
    "ACTIVE_JOB_STATUSES",
    "CHUNK_SIZE",
    "CONTROL_PENDING_STATUSES",
    "FINISHED_JOB_STATUSES",
    "MAX_FINISHED_JOBS",
    "MAX_PAIR_ATTEMPTS",
    "OCR_PAGE_RESULT_FORMAT",
    "OCR_PAGE_SCHEMA_VERSION",
    "OCR_PROTOCOL_VERSION",
    "OCR_REQUIRED_CAPABILITIES",
    "OCR_RESULT_SCHEMA_VERSION",
    "PAGE_REQUIRED_CAPABILITIES",
    "STRUCTURED_RESULT_FORMAT",
    "SUPPORTED_RESULT_FORMATS",
    "negotiate_result_format",
    "print_worker_message",
]

# Binary chunk size for streaming a PDF to a worker. 512 KiB keeps frames
# comfortably small for any WS stack while a multi-MB scan still ships in a
# handful of frames.
CHUNK_SIZE = 512 * 1024
OCR_PROTOCOL_VERSION = 1
OCR_REQUIRED_CAPABILITIES = {"bbox"}
STRUCTURED_RESULT_FORMAT = "structured_rows_v1"
PAGE_REQUIRED_CAPABILITIES = {"page_ack"}
SUPPORTED_RESULT_FORMATS = {STRUCTURED_RESULT_FORMAT, OCR_PAGE_RESULT_FORMAT}
MAX_PAIR_ATTEMPTS = 5

# Job states. ACTIVE jobs may still receive worker progress/page frames;
# CONTROL_PENDING jobs await the worker's control_ack; FINISHED jobs are only
# kept for the UI and pruned beyond MAX_FINISHED_JOBS.
ACTIVE_JOB_STATUSES = {"sent", "parsing", "receiving_pages"}
CONTROL_PENDING_STATUSES = {"holding", "stopping"}
FINISHED_JOB_STATUSES = {"done", "failed", "held", "stopped"}
MAX_FINISHED_JOBS = 100


def print_worker_message(worker_id: str, worker_name: str, message: dict) -> None:
    """Print the exact post-pairing JSON payload before validation or mutation."""
    print(
        "\n===== OCR WORKER MESSAGE BEGIN =====\n"
        f"workerId: {worker_id}\n"
        f"workerName: {worker_name}\n"
        f"{json.dumps(message, ensure_ascii=False, indent=2)}\n"
        "===== OCR WORKER MESSAGE END =====",
        flush=True,
    )


def negotiate_result_format(hello: dict) -> tuple[str | None, set[str]]:
    """Select the best result format while accepting the legacy hello shape."""
    capabilities = set(hello.get("capabilities", []))
    offered_formats = set(hello.get("resultFormats", []))
    if (
        OCR_PAGE_RESULT_FORMAT in offered_formats
        and PAGE_REQUIRED_CAPABILITIES <= capabilities
    ):
        return OCR_PAGE_RESULT_FORMAT, PAGE_REQUIRED_CAPABILITIES
    schema_versions = hello.get("resultSchemaVersions", [])
    if (
        OCR_RESULT_SCHEMA_VERSION in schema_versions
        and OCR_REQUIRED_CAPABILITIES <= capabilities
    ):
        return STRUCTURED_RESULT_FORMAT, OCR_REQUIRED_CAPABILITIES
    return None, set()
