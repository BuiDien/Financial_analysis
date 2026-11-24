"""Framework-free domain error that the HTTP layer reports as a status + detail.

Services raise ``ServiceError(status_code, detail, headers=None)``; ``app.main``
registers a handler that renders it exactly like FastAPI's ``HTTPException``:
``{"detail": detail}`` with ``status_code`` and ``headers`` (no body for
204/304). A missing detail becomes the HTTP reason phrase ("Not Found"), as
starlette does.
"""

from __future__ import annotations

import http
from typing import Any


class ServiceError(Exception):
    def __init__(self, status_code: int, detail: Any = None,
                 headers: dict[str, str] | None = None):
        if detail is None:
            detail = http.HTTPStatus(status_code).phrase
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.headers = headers

    def __str__(self) -> str:
        # Same text as starlette's HTTPException, which some callers persist.
        return f"{self.status_code}: {self.detail}"
