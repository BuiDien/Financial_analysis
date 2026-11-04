"""Read-only OCR hierarchy tools for Hermes Agent.

These tools expose the same deterministic evidence used by the Helix label
review job. They intentionally provide no page mutation, approval, verification,
publication, or Obsidian-write capability.

Register with Hermes:
    hermes mcp add ocr_review \
      --command "<repo>/Financial_analyze/backend/app/mcp/.venv/bin/python" \
      --args "<repo>/Financial_analyze/backend/app/mcp/ocr_review_tools.py"
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP

_BACKEND_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

from app.services.ocr_label_levels import (  # noqa: E402
    build_label_review_evidence,
    verify_level_totals,
)

CORE_URL = os.getenv("HELIX_CORE_URL", "http://127.0.0.1:8000").rstrip("/")
CORE_API_KEY = os.getenv("HELIX_CORE_API_KEY", "")
mcp = FastMCP("ocr_review")


def _get(path: str) -> dict:
    headers = {"Accept": "application/json"}
    if CORE_API_KEY:
        headers["Authorization"] = f"Bearer {CORE_API_KEY}"
    request = Request(f"{CORE_URL}{path}", headers=headers)
    try:
        with urlopen(request, timeout=10) as response:
            return json.load(response)
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode()).get("detail")
        except (ValueError, UnicodeDecodeError):
            detail = None
        raise RuntimeError(
            f"Helix Core returned HTTP {exc.code}: {detail or exc.reason}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(
            "Helix Core is unreachable; start the backend before using OCR tools"
        ) from exc


@mcp.tool()
def get_ocr_review_context(review_id: int, page_number: int) -> dict:
    """Read one current OCR Markdown page and its immutable review coordinates.

    Use before reviewing hierarchy labels. Returns the current revision, page
    content hash, review status, and effective Markdown. This tool is read-only.
    """
    review = _get(f"/api/ocr-inbox/reviews/{review_id}")
    page = _get(f"/api/ocr-inbox/reviews/{review_id}/pages/{page_number}")
    return {
        "review_id": review_id,
        "page": page_number,
        "revision": review["revision"],
        "review_status": review["status"],
        "page_status": page["status"],
        "content_sha256": hashlib.sha256(
            page["effective_markdown"].encode("utf-8"),
        ).hexdigest(),
        "effective_markdown": page["effective_markdown"],
    }


@mcp.tool()
def get_ocr_label_evidence(review_id: int, page_number: int) -> dict:
    """Return deterministic hierarchy candidates and exact total evidence.

    Use this instead of asking the model to calculate. The result includes only
    rows whose current level differs from deterministic inference.
    """
    page = _get(f"/api/ocr-inbox/reviews/{review_id}/pages/{page_number}")
    return build_label_review_evidence(page["effective_markdown"])


@mcp.tool()
def verify_ocr_label_totals(review_id: int, page_number: int) -> dict:
    """Verify direct parent/child label totals using exact-decimal Core code."""
    page = _get(f"/api/ocr-inbox/reviews/{review_id}/pages/{page_number}")
    return verify_level_totals(page["effective_markdown"])


if __name__ == "__main__":
    mcp.run(transport="stdio")
