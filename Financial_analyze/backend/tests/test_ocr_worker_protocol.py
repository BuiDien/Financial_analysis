"""Tests for the Mac page worker (scripts/ocr_worker.py), page_markdown_v2 protocol.

No network: every socket is a fake that scripts incoming frames and records sent JSON.
"""
import asyncio
import importlib.util
import io
import json
import socket as socket_mod
import sys
from pathlib import Path

import pytest
from websockets.exceptions import ConnectionClosedError


SCRIPTS = Path(__file__).parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))  # ocr_worker imports ocr_mac_pages from the same folder
WORKER_PATH = SCRIPTS / "ocr_worker.py"
SPEC = importlib.util.spec_from_file_location("ocr_worker", WORKER_PATH)
ocr_worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ocr_worker)
w = ocr_worker

JOB_ID = "job_1"
TEST_TIMEOUT = 5


@pytest.fixture(autouse=True)
def _no_retry_delay(monkeypatch):
    monkeypatch.setattr(w, "RETRY_DELAY_SECONDS", 0)


def _pdf(pages: int) -> bytes:
    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def _job(pdf: bytes, job_id: str = JOB_ID) -> dict:
    return {
        "type": "job",
        "jobId": job_id,
        "filename": "statement.pdf",
        "bytes": len(pdf),
        "protocolVersion": 1,
        "resultFormat": "page_markdown_v2",
        "resultSchemaVersion": 2,
        "requiredCapabilities": ["page_ack"],
    }


def _welcome(**overrides) -> dict:
    welcome = {
        "type": "welcome",
        "workerId": "58023ec0",
        "protocolVersion": 1,
        "selectedResultFormat": "page_markdown_v2",
        "resultSchemaVersion": 2,
        "requiredCapabilities": ["page_ack"],
    }
    welcome.update(overrides)
    return welcome


def _ack(page: int, status: str = "stored") -> dict:
    return {"type": "page_ack", "jobId": JOB_ID, "page": page, "status": status}


def _result_ack(page_count: int, review_id: int = 42) -> dict:
    return {
        "type": "result_ack",
        "jobId": JOB_ID,
        "status": "ready_for_review",
        "pageCount": page_count,
        "reviewId": review_id,
    }


def _closed() -> ConnectionClosedError:
    return ConnectionClosedError(None, None)


class _Socket:
    """Minimal scripted socket used by the receive_pdf tests."""

    def __init__(self, frames):
        self.frames = iter(frames)
        self.sent = []

    async def recv(self):
        return next(self.frames)

    async def send(self, frame):
        self.sent.append(json.loads(frame))


class _FakeWs:
    """Reactive fake WebSocket.

    Incoming frames sit in a queue: dicts are JSON-encoded, bytes/str pass through,
    exceptions are raised from recv(). `respond(msg)` is called for every sent JSON
    message and returns frames to enqueue, like a server replying. recv() blocks when
    the queue is empty (cancellation-safe, like websockets). It also asserts that at
    most one coroutine awaits recv() at a time.
    """

    def __init__(self, initial=(), respond=None):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict] = []
        self.raw_sent: list[str] = []
        self.respond = respond or (lambda msg: [])
        self.receivers = 0
        self.max_receivers = 0
        for frame in initial:
            self.push(frame)

    def push(self, frame):
        self.queue.put_nowait(frame)

    async def recv(self):
        self.receivers += 1
        self.max_receivers = max(self.max_receivers, self.receivers)
        try:
            frame = await self.queue.get()
        finally:
            self.receivers -= 1
        if callable(frame) and not isinstance(frame, (bytes, str, dict)):
            frame = await frame()
        if isinstance(frame, BaseException):
            raise frame
        if isinstance(frame, dict):
            return json.dumps(frame, ensure_ascii=False)
        return frame

    async def send(self, frame):
        self.raw_sent.append(frame)
        msg = json.loads(frame)
        self.sent.append(msg)
        for reply in self.respond(msg) or []:
            self.push(reply)

    def types(self):
        return [m["type"] for m in self.sent]


def _job_frames(pdf: bytes, job_id: str = JOB_ID) -> list:
    return [pdf[: len(pdf) // 2], pdf[len(pdf) // 2 :], {"type": "job_end", "jobId": job_id}]


def _acking_server(page_count: int, review_id: int = 42):
    def respond(msg):
        if msg["type"] == "page_result":
            return [_ack(msg["page"])]
        if msg["type"] == "result_end":
            return [_result_ack(page_count, review_id)]
        return []

    return respond


def _pages_ocr(pages: list):
    calls = []

    async def ocr(pdf_bytes, work_dir):
        calls.append(work_dir)
        assert work_dir.is_dir()
        (work_dir / "input.pdf").write_bytes(pdf_bytes)
        return pages

    ocr.calls = calls
    return ocr


class _BlockingOcr:
    """Fake OCR that runs until cancelled and records it."""

    def __init__(self):
        self.started = asyncio.Event()
        self.cancelled = False
        self.work_dirs: list[Path] = []

    async def __call__(self, pdf_bytes, work_dir):
        self.work_dirs.append(work_dir)
        (work_dir / "input.pdf").write_bytes(pdf_bytes)
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise

    def after_start(self, frame):
        async def produce():
            await self.started.wait()
            return frame

        return produce


async def _run(coro):
    return await asyncio.wait_for(coro, TEST_TIMEOUT)


# --- receive_pdf (kept from the previous worker) -------------------------------------


@pytest.mark.anyio
async def test_receive_pdf_reassembles_binary_chunks():
    socket = _Socket(
        [
            b"%PDF-",
            b"1.4",
            json.dumps({"type": "job_end", "jobId": "job_1"}),
        ]
    )

    payload = await ocr_worker.receive_pdf(socket, {"jobId": "job_1", "bytes": 8})

    assert payload == b"%PDF-1.4"


@pytest.mark.anyio
async def test_receive_pdf_rejects_byte_count_mismatch():
    socket = _Socket(
        [
            b"short",
            json.dumps({"type": "job_end", "jobId": "job_1"}),
        ]
    )

    with pytest.raises(RuntimeError, match="byte count mismatch"):
        await ocr_worker.receive_pdf(socket, {"jobId": "job_1", "bytes": 10})


@pytest.mark.anyio
async def test_receive_pdf_rejects_wrong_job_end():
    socket = _Socket(
        [
            json.dumps({"type": "job_end", "jobId": "job_other"}),
        ]
    )

    with pytest.raises(RuntimeError, match="Unexpected frame"):
        await ocr_worker.receive_pdf(socket, {"jobId": "job_1", "bytes": 0})


# --- contract checks -----------------------------------------------------------------


def test_constants_match_upgrade_doc():
    assert w.OCR_PROTOCOL_VERSION == 1
    assert w.OCR_PAGE_SCHEMA_VERSION == 2
    assert w.OCR_RESULT_FORMAT == "page_markdown_v2"
    assert w.OCR_CAPABILITIES == ["page_ack"]
    assert w.PAGE_ACK_TIMEOUT_SECONDS == 30
    assert w.MAX_PAGE_SEND_ATTEMPTS == 3
    assert w.MAX_FINALIZE_ATTEMPTS == 3
    assert w.MAX_MISSING_PAGE_REPAIR_ROUNDS == 3
    assert w.MAX_PAGE_MARKDOWN_BYTES == 1024 * 1024
    assert w.MAX_DOCUMENT_MARKDOWN_BYTES == 20 * 1024 * 1024


def test_hello_advertises_page_markdown_only():
    h = w.hello_message("Mac OCR (MLX)")
    assert h == {"type": "hello", "name": "Mac OCR (MLX)", "protocolVersion": 1,
                 "resultFormats": ["page_markdown_v2"], "capabilities": ["page_ack"]}


def test_validate_welcome_accepts_page_markdown():
    w.validate_welcome(_welcome())


def test_validate_welcome_rejects_row_format():
    with pytest.raises(RuntimeError, match="Page Markdown was not selected"):
        w.validate_welcome(
            _welcome(selectedResultFormat="structured_rows_v1", resultSchemaVersion=1)
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"type": "deny"},
        {"protocolVersion": 2},
        {"resultSchemaVersion": 1},
        {"requiredCapabilities": ["page_ack", "bbox"]},
    ],
)
def test_validate_welcome_rejects_other_mismatches(overrides):
    with pytest.raises(RuntimeError):
        w.validate_welcome(_welcome(**overrides))


def test_validate_job_contract_accepts_page_job():
    w.validate_job_contract(_job(b"x"))


def test_validate_job_contract_rejects_wrong_schema():
    job = _job(b"x")
    job["resultSchemaVersion"] = 1
    with pytest.raises(RuntimeError, match="schema"):
        w.validate_job_contract(job)


@pytest.mark.parametrize(
    "overrides",
    [{"resultFormat": "structured_rows_v1"}, {"requiredCapabilities": ["bbox"]}],
)
def test_validate_job_contract_rejects_other_mismatches(overrides):
    job = {**_job(b"x"), **overrides}
    with pytest.raises(RuntimeError):
        w.validate_job_contract(job)


def test_validate_pages_requires_each_page_once():
    pages = [w.OCRPage(1, "a"), w.OCRPage(1, "b"), w.OCRPage(3, "c")]
    with pytest.raises(w.InvalidPageResult):
        w.validate_pages(pages, 3)


@pytest.mark.parametrize(
    "numbers,count",
    [([1], 2), ([0, 1], 2), ([1, 3], 2), ([1, 2, 3], 2)],
)
def test_validate_pages_rejects_missing_zero_and_out_of_range(numbers, count):
    with pytest.raises(w.InvalidPageResult):
        w.validate_pages([w.OCRPage(n, "x") for n in numbers], count)


def test_validate_pages_accepts_blank_page_and_any_order():
    w.validate_pages([w.OCRPage(2, ""), w.OCRPage(1, "# Trang 1")], 2)


def test_validate_pages_rejects_non_string_markdown():
    with pytest.raises(w.InvalidPageResult):
        w.validate_pages([w.OCRPage(1, None)], 1)


def test_page_size_limit_counts_utf8_bytes():
    md = "ệ" * (350 * 1024)          # 1,075,200 bytes, ~350k chars
    assert len(md) < w.MAX_PAGE_MARKDOWN_BYTES < len(md.encode("utf-8"))
    with pytest.raises(w.InvalidPageResult):
        w.validate_pages([w.OCRPage(1, md)], 1)


def test_document_size_limit():
    pages = [w.OCRPage(n, "a" * 1_000_000) for n in range(1, 22)]
    with pytest.raises(w.InvalidPageResult, match="Document"):
        w.validate_pages(pages, 21)


def test_reexports_task1_types():
    import ocr_mac_pages

    assert w.OCRPage is ocr_mac_pages.OCRPage
    assert w.InvalidPageResult is ocr_mac_pages.InvalidPageResult
    assert w.ParseFailed is ocr_mac_pages.ParseFailed


# --- recv_for_job --------------------------------------------------------------------


@pytest.mark.anyio
async def test_recv_for_job_acknowledges_control_and_raises():
    ws = _FakeWs([{"type": "job_control", "jobId": JOB_ID, "action": "stop"}])
    with pytest.raises(w.JobControl) as info:
        await _run(w.recv_for_job(ws, JOB_ID, 1))
    assert info.value.action == "stop"
    assert ws.sent == [{"type": "control_ack", "jobId": JOB_ID, "action": "stop"}]


@pytest.mark.anyio
async def test_recv_for_job_rejects_other_job_and_binary():
    ws = _FakeWs([{"type": "page_ack", "jobId": "job_other", "page": 1}, b"\x00"])
    with pytest.raises(RuntimeError, match="another job"):
        await _run(w.recv_for_job(ws, JOB_ID, 1))
    with pytest.raises(RuntimeError, match="binary"):
        await _run(w.recv_for_job(ws, JOB_ID, 1))


@pytest.mark.anyio
async def test_recv_for_job_times_out():
    ws = _FakeWs()
    with pytest.raises(asyncio.TimeoutError):
        await _run(w.recv_for_job(ws, JOB_ID, 0.01))


# --- send_page -----------------------------------------------------------------------


@pytest.mark.anyio
async def test_send_page_waits_for_ack():
    ws = _FakeWs(respond=lambda msg: [_ack(1)])
    page = w.OCRPage(1, "# Bảng cân đối kế toán\n\n| Tài sản | 100 |")

    ack = await _run(w.send_page(ws, JOB_ID, page, 2))

    assert ack == _ack(1)
    assert ws.sent[-1] == {
        "type": "page_result",
        "jobId": JOB_ID,
        "schemaVersion": 2,
        "page": 1,
        "pageCount": 2,
        "markdown": "# Bảng cân đối kế toán\n\n| Tài sản | 100 |",
    }
    assert "Bảng cân đối" in ws.raw_sent[-1]  # ensure_ascii=False on the wire


@pytest.mark.anyio
async def test_send_page_retries_identical_after_ack_timeout(monkeypatch):
    monkeypatch.setattr(w, "PAGE_ACK_TIMEOUT_SECONDS", 0.01)
    sends = []

    def respond(msg):
        sends.append(msg)
        return [] if len(sends) == 1 else [_ack(1, "already_stored")]

    ws = _FakeWs(respond=respond)
    ack = await _run(w.send_page(ws, JOB_ID, w.OCRPage(1, "Trang một"), 1))

    assert ack["status"] == "already_stored"
    assert len(ws.raw_sent) == 2
    assert ws.raw_sent[0] == ws.raw_sent[1]


@pytest.mark.anyio
async def test_send_page_gives_up_after_max_timeouts(monkeypatch):
    monkeypatch.setattr(w, "PAGE_ACK_TIMEOUT_SECONDS", 0.01)
    ws = _FakeWs()
    with pytest.raises(RuntimeError, match="No acknowledgement"):
        await _run(w.send_page(ws, JOB_ID, w.OCRPage(1, "x"), 1))
    assert len(ws.sent) == w.MAX_PAGE_SEND_ATTEMPTS


@pytest.mark.anyio
async def test_send_page_retries_on_persistence_failure():
    replies = iter(
        [
            [{"type": "page_rejected", "jobId": JOB_ID, "page": 1,
              "errorCode": "page_persistence_failed", "retryable": True}],
            [_ack(1)],
        ]
    )
    ws = _FakeWs(respond=lambda msg: next(replies))

    ack = await _run(w.send_page(ws, JOB_ID, w.OCRPage(1, "x"), 1))

    assert ack["status"] == "stored"
    assert len(ws.raw_sent) == 2 and ws.raw_sent[0] == ws.raw_sent[1]


@pytest.mark.anyio
async def test_send_page_conflict_is_terminal():
    ws = _FakeWs(respond=lambda msg: [
        {"type": "page_rejected", "jobId": JOB_ID, "page": 1, "error": "different content",
         "errorCode": "page_conflict", "retryable": False}
    ])
    with pytest.raises(w.ResultRejected, match="page_conflict"):
        await _run(w.send_page(ws, JOB_ID, w.OCRPage(1, "x"), 1))
    assert len(ws.sent) == 1


@pytest.mark.anyio
async def test_send_page_ignores_stale_ack_for_previous_page():
    ws = _FakeWs(respond=lambda msg: [_ack(1, "already_stored"), _ack(2)])
    ack = await _run(w.send_page(ws, JOB_ID, w.OCRPage(2, "x"), 2))
    assert ack == _ack(2)
    assert len(ws.sent) == 1


# --- finalize ------------------------------------------------------------------------


@pytest.mark.anyio
async def test_finalize_repairs_missing_pages():
    ends = []

    def respond(msg):
        if msg["type"] == "page_result":
            return [_ack(msg["page"])]
        ends.append(msg)
        if len(ends) == 1:
            return [{"type": "result_incomplete", "jobId": JOB_ID,
                     "errorCode": "missing_pages", "missingPages": [2], "retryable": True}]
        return [_result_ack(3)]

    ws = _FakeWs(respond=respond)
    pages = {n: w.OCRPage(n, f"p{n}") for n in (1, 2, 3)}

    ack = await _run(w.finalize(ws, JOB_ID, pages, 3))

    assert ack == _result_ack(3)
    assert ws.types() == ["result_end", "page_result", "result_end"]
    assert ws.sent[1]["page"] == 2
    assert ws.sent[0] == {"type": "result_end", "jobId": JOB_ID, "schemaVersion": 2,
                          "pageCount": 3}


@pytest.mark.anyio
async def test_finalize_gives_up_after_repair_rounds():
    def respond(msg):
        if msg["type"] == "page_result":
            return [_ack(msg["page"])]
        return [{"type": "result_incomplete", "jobId": JOB_ID, "missingPages": [1]}]

    ws = _FakeWs(respond=respond)
    with pytest.raises(RuntimeError, match="repair rounds"):
        await _run(w.finalize(ws, JOB_ID, {1: w.OCRPage(1, "x")}, 1))
    assert ws.types().count("result_end") == 4


@pytest.mark.anyio
async def test_finalize_rejects_unknown_missing_page():
    ws = _FakeWs(respond=lambda msg: [
        {"type": "result_incomplete", "jobId": JOB_ID, "missingPages": [9]}
    ])
    with pytest.raises(RuntimeError, match="unavailable locally"):
        await _run(w.finalize(ws, JOB_ID, {1: w.OCRPage(1, "x")}, 1))


@pytest.mark.anyio
async def test_finalize_retries_retryable_rejection_then_terminal():
    replies = iter([
        [{"type": "result_rejected", "jobId": JOB_ID, "retryable": True,
          "errorCode": "result_persistence_failed"}],
        [{"type": "result_rejected", "jobId": JOB_ID, "retryable": False,
          "errorCode": "page_count_mismatch", "error": "bad"}],
    ])
    ws = _FakeWs(respond=lambda msg: next(replies))
    with pytest.raises(w.ResultRejected, match="page_count_mismatch"):
        await _run(w.finalize(ws, JOB_ID, {1: w.OCRPage(1, "x")}, 1))
    assert ws.types() == ["result_end", "result_end"]


@pytest.mark.anyio
async def test_finalize_rejects_page_count_mismatch():
    ws = _FakeWs(respond=lambda msg: [_result_ack(2)])
    with pytest.raises(RuntimeError, match="page count"):
        await _run(w.finalize(ws, JOB_ID, {1: w.OCRPage(1, "x")}, 1))


# --- process_job ---------------------------------------------------------------------


@pytest.mark.anyio
async def test_process_job_happy_path(tmp_path):
    pdf = _pdf(2)
    ws = _FakeWs(_job_frames(pdf), respond=_acking_server(2))
    ocr = _pages_ocr([w.OCRPage(2, "Trang hai"), w.OCRPage(1, "Trang một")])

    outcome = await _run(w.process_job(ws, _job(pdf), ocr, tmp_path))

    assert "review" in outcome and "42" in outcome and "2 pages" in outcome
    types = ws.types()
    assert types == ["progress", "progress", "progress", "page_result", "page_result",
                     "result_end"]
    assert [m["pct"] for m in ws.sent[:3]] == [10, 20, 90]
    assert [m["page"] for m in ws.sent if m["type"] == "page_result"] == [1, 2]
    assert all(m["pageCount"] == 2 for m in ws.sent if m["type"] == "page_result")
    assert ocr.calls == [tmp_path / JOB_ID]
    assert not (tmp_path / JOB_ID).exists()
    assert ws.max_receivers == 1


def test_estimated_progress_rises_from_20_and_caps_below_90():
    pages = 10
    per_page = w.ESTIMATED_SECONDS_PER_PAGE
    assert w.estimated_progress(0, pages) == 20
    assert w.estimated_progress(pages * per_page / 2, pages) == 55
    assert w.estimated_progress(pages * per_page, pages) == w.PROGRESS_ESTIMATE_CAP
    assert w.estimated_progress(pages * per_page * 5, pages) == w.PROGRESS_ESTIMATE_CAP
    assert w.PROGRESS_ESTIMATE_CAP < 90
    values = [w.estimated_progress(t, pages) for t in range(0, 200, 7)]
    assert values == sorted(values)


@pytest.mark.anyio
async def test_process_job_sends_estimated_progress_while_ocr_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(w, "PROGRESS_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(w, "ESTIMATED_SECONDS_PER_PAGE", 0.05)
    pdf = _pdf(2)
    ws = _FakeWs(_job_frames(pdf), respond=_acking_server(2))
    pages = [w.OCRPage(1, "a"), w.OCRPage(2, "b")]

    async def slow_ocr(pdf_bytes, work_dir):
        await asyncio.sleep(0.15)
        return pages

    await _run(w.process_job(ws, _job(pdf), slow_ocr, tmp_path))

    pcts = [m["pct"] for m in ws.sent if m["type"] == "progress"]
    middle = pcts[2:-1]
    assert pcts[:2] == [10, 20] and pcts[-1] == 90
    assert middle, "expected estimated progress while OCR was running"
    assert all(20 < p <= w.PROGRESS_ESTIMATE_CAP for p in middle)
    assert middle == sorted(set(middle)), "estimates must strictly increase"
    assert ws.max_receivers == 1


@pytest.mark.anyio
async def test_progress_ticker_stops_when_job_is_stopped(tmp_path, monkeypatch):
    monkeypatch.setattr(w, "PROGRESS_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(w, "ESTIMATED_SECONDS_PER_PAGE", 0.05)
    pdf = _pdf(1)
    ocr = _BlockingOcr()
    ws = _FakeWs(_job_frames(pdf))

    async def stop_later():
        await ocr.started.wait()
        await asyncio.sleep(0.05)
        return {"type": "job_control", "jobId": JOB_ID, "action": "stop"}

    ws.push(stop_later)
    assert await _run(w.process_job(ws, _job(pdf), ocr, tmp_path)) == "stop"
    sent_after_stop = len(ws.sent)
    await asyncio.sleep(0.05)
    assert len(ws.sent) == sent_after_stop, "ticker kept sending after the job ended"
    assert ocr.cancelled


@pytest.mark.anyio
async def test_process_job_waits_for_each_ack_before_next_page(tmp_path):
    pdf = _pdf(2)
    ws = _FakeWs(_job_frames(pdf))
    ocr = _pages_ocr([w.OCRPage(1, "a"), w.OCRPage(2, "b")])

    task = asyncio.create_task(w.process_job(ws, _job(pdf), ocr, tmp_path))
    for _ in range(50):
        await asyncio.sleep(0)
    assert [m["type"] for m in ws.sent].count("page_result") == 1
    ws.push(_ack(1))
    for _ in range(50):
        await asyncio.sleep(0)
    assert [m["type"] for m in ws.sent].count("page_result") == 2
    ws.push(_ack(2))
    for _ in range(50):
        await asyncio.sleep(0)
    ws.push(_result_ack(2))
    assert "review" in await _run(task)


@pytest.mark.anyio
async def test_process_job_keep_work_keeps_folder(tmp_path):
    pdf = _pdf(1)
    ws = _FakeWs(_job_frames(pdf), respond=_acking_server(1))
    ocr = _pages_ocr([w.OCRPage(1, "x")])

    await _run(w.process_job(ws, _job(pdf), ocr, tmp_path, keep_work=True))

    assert (tmp_path / JOB_ID / "input.pdf").exists()


@pytest.mark.anyio
async def test_process_job_rejects_page_count_not_matching_pdf(tmp_path):
    pdf = _pdf(2)
    ws = _FakeWs(_job_frames(pdf), respond=_acking_server(1))
    ocr = _pages_ocr([w.OCRPage(1, "x")])

    with pytest.raises(w.InvalidPageResult):
        await _run(w.process_job(ws, _job(pdf), ocr, tmp_path))
    assert "page_result" not in ws.types()
    assert not (tmp_path / JOB_ID).exists()


@pytest.mark.anyio
async def test_hold_during_ocr_cancels_ocr(tmp_path):
    pdf = _pdf(1)
    ocr = _BlockingOcr()
    ws = _FakeWs(_job_frames(pdf))
    ws.push(ocr.after_start({"type": "job_control", "jobId": JOB_ID, "action": "hold"}))

    outcome = await _run(w.process_job(ws, _job(pdf), ocr, tmp_path))

    assert outcome == "hold"
    assert ocr.cancelled
    assert ws.sent[-1] == {"type": "control_ack", "jobId": JOB_ID, "action": "hold"}
    assert "page_result" not in ws.types()
    assert not (tmp_path / JOB_ID).exists()
    assert ws.max_receivers == 1


@pytest.mark.anyio
async def test_hold_during_page_send_stops_without_result_end(tmp_path):
    pdf = _pdf(2)

    def respond(msg):
        if msg["type"] == "page_result" and msg["page"] == 1:
            return [_ack(1)]
        if msg["type"] == "page_result":
            return [{"type": "job_control", "jobId": JOB_ID, "action": "stop"}]
        return []

    ws = _FakeWs(_job_frames(pdf), respond=respond)
    ocr = _pages_ocr([w.OCRPage(1, "a"), w.OCRPage(2, "b")])

    outcome = await _run(w.process_job(ws, _job(pdf), ocr, tmp_path))

    assert outcome == "stop"
    assert ws.sent[-1] == {"type": "control_ack", "jobId": JOB_ID, "action": "stop"}
    assert "result_end" not in ws.types()
    assert ws.types().count("page_result") == 2
    assert not (tmp_path / JOB_ID).exists()


@pytest.mark.anyio
async def test_cancelling_job_mid_ocr_kills_ocr_and_cleans_up(tmp_path):
    """Ctrl+C: asyncio.run cancels the main task; OCR must be cancelled and awaited."""
    pdf = _pdf(1)
    ocr = _BlockingOcr()
    ws = _FakeWs(_job_frames(pdf))

    task = asyncio.create_task(w.process_job(ws, _job(pdf), ocr, tmp_path))
    await _run(ocr.started.wait())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert ocr.cancelled
    assert not (tmp_path / JOB_ID).exists()
    assert ws.receivers == 0


@pytest.mark.anyio
async def test_unexpected_frame_during_ocr_fails_and_cancels(tmp_path):
    pdf = _pdf(1)
    ocr = _BlockingOcr()
    ws = _FakeWs(_job_frames(pdf))
    ws.push(ocr.after_start({"type": "page_ack", "jobId": JOB_ID, "page": 1}))

    with pytest.raises(RuntimeError, match="Unexpected"):
        await _run(w.process_job(ws, _job(pdf), ocr, tmp_path))
    assert ocr.cancelled
    assert not (tmp_path / JOB_ID).exists()


# --- handle_job: error ownership -----------------------------------------------------


@pytest.mark.anyio
async def test_invalid_pages_report_invalid_page_result(tmp_path):
    pdf = _pdf(1)
    ws = _FakeWs(_job_frames(pdf))

    async def ocr(pdf_bytes, work_dir):
        raise w.InvalidPageResult("SDK produced 2 pages, PDF has 1")

    await _run(w.handle_job(ws, _job(pdf), ocr, tmp_path))

    error = ws.sent[-1]
    assert error["type"] == "error" and error["jobId"] == JOB_ID
    assert error["errorCode"] == "invalid_page_result"
    assert error["retryable"] is False
    assert "SDK produced 2 pages" in error["error"]
    assert not (tmp_path / JOB_ID).exists()


@pytest.mark.anyio
async def test_parse_failure_reports_retryable(tmp_path):
    pdf = _pdf(1)
    ws = _FakeWs(_job_frames(pdf))

    async def ocr(pdf_bytes, work_dir):
        raise w.ParseFailed("SDK parse timed out after 300.0s")

    await _run(w.handle_job(ws, _job(pdf), ocr, tmp_path))

    error = ws.sent[-1]
    assert error["errorCode"] == "worker_job_failed"
    assert error["retryable"] is True


@pytest.mark.anyio
async def test_server_rejection_sends_no_second_error(tmp_path):
    pdf = _pdf(1)
    ws = _FakeWs(_job_frames(pdf), respond=lambda msg: [
        {"type": "page_rejected", "jobId": JOB_ID, "page": 1, "errorCode": "page_conflict",
         "retryable": False}
    ] if msg["type"] == "page_result" else [])

    await _run(w.handle_job(ws, _job(pdf), _pages_ocr([w.OCRPage(1, "x")]), tmp_path))

    assert "error" not in ws.types()


@pytest.mark.anyio
async def test_handle_job_reraises_connection_closed(tmp_path):
    ws = _FakeWs([_closed()])
    with pytest.raises(ConnectionClosedError):
        await _run(w.handle_job(ws, _job(b"abc"), _pages_ocr([]), tmp_path))
    assert "error" not in ws.types()


# --- sessions and reconnect ----------------------------------------------------------


class _Connect:
    """Fake websockets.connect: each call takes the next scripted session."""

    def __init__(self, sessions):
        self.sessions = list(sessions)
        self.urls = []

    def __call__(self, url, **kwargs):
        self.urls.append(url)
        session = self.sessions.pop(0)

        class _CM:
            async def __aenter__(self):
                if isinstance(session, BaseException):
                    raise session
                return session

            async def __aexit__(self, *exc):
                return False

        return _CM()


def _handshake(extra=()):
    return [{"type": "pair_required", "pairId": "p1"}, _welcome(), *extra]


async def _code(prompt):
    return "ABC-23"


@pytest.mark.anyio
async def test_run_session_pairs_and_processes_job(tmp_path):
    pdf = _pdf(1)
    paired = []
    ws = _FakeWs(_handshake([_job(pdf), *_job_frames(pdf)]), respond=_acking_server(1))
    original = ws.respond

    def respond(msg):
        replies = original(msg)
        if msg["type"] == "result_end":
            replies = [*replies, _closed()]
        return replies

    ws.respond = respond
    connect = _Connect([ws])

    with pytest.raises(ConnectionClosedError):
        await _run(w.run_session("ws://core/ws/ocr", "Mac OCR (MLX)",
                                 _pages_ocr([w.OCRPage(1, "x")]), tmp_path, _code,
                                 connect=connect, on_paired=lambda: paired.append(1)))

    assert ws.sent[0] == w.hello_message("Mac OCR (MLX)")
    assert ws.sent[1] == {"type": "pair", "pairId": "p1", "code": "ABC-23"}
    assert paired == [1]
    assert ws.types()[-1] == "result_end"


@pytest.mark.anyio
async def test_run_session_local_core_welcomes_without_code(tmp_path):
    asked = []

    async def read_code(prompt):
        asked.append(prompt)
        return "never"

    paired = []
    ws = _FakeWs([_welcome(), _closed()])
    with pytest.raises(ConnectionClosedError):
        await _run(w.run_session("ws://127.0.0.1:8000/ws/ocr", "n", _pages_ocr([]), tmp_path,
                                 read_code, connect=_Connect([ws]),
                                 on_paired=lambda: paired.append(1)))
    assert asked == []
    assert [m["type"] for m in ws.sent] == ["hello"]
    assert paired == [1]


@pytest.mark.anyio
async def test_run_session_local_welcome_still_validated(tmp_path):
    ws = _FakeWs([_welcome(selectedResultFormat="structured_rows_v1")])
    with pytest.raises(RuntimeError, match="Page Markdown"):
        await _run(w.run_session("ws://x", "n", _pages_ocr([]), tmp_path, _code,
                                 connect=_Connect([ws])))


@pytest.mark.anyio
async def test_run_session_reasks_code_after_deny(tmp_path):
    codes = iter(["WRONG", "ABC-23"])
    prompts = []

    async def read_code(prompt):
        prompts.append(prompt)
        return next(codes)

    ws = _FakeWs([{"type": "pair_required", "pairId": "p1"},
                  {"type": "deny", "reason": "bad pairing code", "attemptsLeft": 2},
                  _welcome(), _closed()])

    with pytest.raises(ConnectionClosedError):
        await _run(w.run_session("ws://x", "n", _pages_ocr([]), tmp_path, read_code,
                                 connect=_Connect([ws])))

    assert [m["code"] for m in ws.sent if m["type"] == "pair"] == ["WRONG", "ABC-23"]
    assert len(prompts) == 2 and "2 attempts" in prompts[1]


@pytest.mark.anyio
async def test_run_session_stops_on_incompatible_welcome(tmp_path):
    ws = _FakeWs([{"type": "pair_required", "pairId": "p1"},
                  _welcome(selectedResultFormat="structured_rows_v1")])
    with pytest.raises(RuntimeError, match="Page Markdown"):
        await _run(w.run_session("ws://x", "n", _pages_ocr([]), tmp_path, _code,
                                 connect=_Connect([ws])))


@pytest.mark.anyio
async def test_disconnect_mid_ocr_kills_subprocess_and_reconnects(tmp_path):
    pdf = _pdf(1)
    ocr = _BlockingOcr()
    session1 = _FakeWs(_handshake([_job(pdf), *_job_frames(pdf)]))
    session1.push(ocr.after_start(_closed()))
    # Session 2 really connects and pairs; the loop is stopped from inside it, after pairing.
    session2 = _FakeWs(_handshake([KeyboardInterrupt()]))
    connect = _Connect([session1, session2])
    events = []

    async def read_code(prompt):
        events.append(("read_code", len(connect.urls)))
        return "ABC-23"

    async def sleep(seconds):
        events.append(("sleep", seconds))

    await _run(w.run_forever("ws://core/ws/ocr", "Mac OCR (MLX)", ocr, tmp_path, read_code,
                             connect=connect, sleep=sleep))

    assert ocr.cancelled
    assert ocr.work_dirs == [tmp_path / JOB_ID]
    assert not (tmp_path / JOB_ID).exists()
    assert connect.urls == ["ws://core/ws/ocr", "ws://core/ws/ocr"]
    assert events == [("read_code", 1), ("sleep", 1), ("read_code", 2)]
    assert [m["type"] for m in session2.sent] == ["hello", "pair"]
    assert "error" not in session1.types()


@pytest.mark.anyio
async def test_disconnect_mid_ocr_asks_code_again_on_next_session(tmp_path):
    session1 = _FakeWs(_handshake([_closed()]))
    session2 = _FakeWs(_handshake([KeyboardInterrupt()]))
    codes = []

    async def read_code(prompt):
        codes.append(prompt)
        return "ABC-23"

    async def sleep(seconds):
        pass

    await _run(w.run_forever("ws://x", "n", _pages_ocr([]), tmp_path, read_code,
                             connect=_Connect([session1, session2]), sleep=sleep))

    assert len(codes) == 2


@pytest.mark.anyio
async def test_backoff_doubles_to_30_and_resets_after_pairing(tmp_path):
    paired_session = _FakeWs(_handshake([_closed()]))
    connect = _Connect([OSError("refused")] * 6 + [paired_session, OSError("refused"),
                                                   KeyboardInterrupt()])
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)

    await _run(w.run_forever("ws://x", "n", _pages_ocr([]), tmp_path, _code,
                             connect=connect, sleep=sleep))

    assert sleeps == [1, 2, 4, 8, 16, 30, 1, 2]


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["invalid_message", "invalid_status"])
async def test_failed_websocket_handshake_backs_off_and_retries(tmp_path, failure):
    """Core restarting under uvicorn --reload: TCP accepted, HTTP upgrade fails."""
    from websockets.datastructures import Headers
    from websockets.exceptions import InvalidMessage, InvalidStatus
    from websockets.http11 import Response

    def make():
        if failure == "invalid_message":
            return InvalidMessage("did not receive a valid HTTP response")
        return InvalidStatus(Response(503, "Service Unavailable", Headers(), b""))

    connect = _Connect([make(), make(), KeyboardInterrupt()])
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)

    await _run(w.run_forever("ws://x", "n", _pages_ocr([]), tmp_path, _code,
                             connect=connect, sleep=sleep))

    assert len(connect.urls) == 3
    assert sleeps == [1, 2]


def test_check_ocr_server_unreachable_exits():
    with socket_mod.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with pytest.raises(SystemExit) as info:
        w.check_ocr_server(f"http://127.0.0.1:{port}")
    assert "start_ocr_mac.sh" in str(info.value)


def test_cli_defaults(monkeypatch):
    args = w.parse_args([])
    assert args.connect == "ws://127.0.0.1:8000/ws/ocr"
    assert args.name == "Mac OCR (MLX)"
    assert args.ocr_url == "http://127.0.0.1:18499"
    assert args.sdk_bin.name == "minicpmvocr"
    assert args.sdk_bin.parent.parent.name == ".venv-ocr-sdk"
    assert args.ocr_home.parts[-2:] == ("models", "ocr")
    assert args.model == str(args.ocr_home / "minicpm-ocr-1.0")
    assert args.keep_work is False
