import importlib.util
import json
from pathlib import Path

import pytest


WORKER_PATH = Path(__file__).parents[2] / "scripts" / "ocr_worker.py"
SPEC = importlib.util.spec_from_file_location("ocr_worker", WORKER_PATH)
ocr_worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ocr_worker)


class _Socket:
    def __init__(self, frames):
        self.frames = iter(frames)

    async def recv(self):
        return next(self.frames)


@pytest.mark.anyio
async def test_receive_pdf_reassembles_binary_chunks():
    socket = _Socket([
        b"%PDF-",
        b"1.4",
        json.dumps({"type": "job_end", "jobId": "job_1"}),
    ])

    payload = await ocr_worker.receive_pdf(socket, {"jobId": "job_1", "bytes": 8})

    assert payload == b"%PDF-1.4"


@pytest.mark.anyio
async def test_receive_pdf_rejects_byte_count_mismatch():
    socket = _Socket([
        b"short",
        json.dumps({"type": "job_end", "jobId": "job_1"}),
    ])

    with pytest.raises(RuntimeError, match="byte count mismatch"):
        await ocr_worker.receive_pdf(socket, {"jobId": "job_1", "bytes": 10})


@pytest.mark.anyio
async def test_receive_pdf_rejects_wrong_job_end():
    socket = _Socket([
        json.dumps({"type": "job_end", "jobId": "job_other"}),
    ])

    with pytest.raises(RuntimeError, match="Unexpected frame"):
        await ocr_worker.receive_pdf(socket, {"jobId": "job_1", "bytes": 0})


def test_placeholder_result_includes_review_evidence(monkeypatch):
    class _Response:
        def __enter__(self): return self
        def __exit__(self, *_args): return None
        def read(self): return b"{}"

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: _Response())

    row = ocr_worker.run_ocr(b"%PDF", "http://local-vllm")[0]

    assert row["page"] == 1
    assert row["bbox"] == {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
    assert row["rawText"].startswith("STUB")
