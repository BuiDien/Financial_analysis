"""Mac OCR worker — local page worker for the distributed OCR pipeline.

Dials Core's coordinator (backend/app/routes/sync.py), pairs with the code shown
on the Sync page, receives PDF filings and returns one Markdown result per PDF
page using the `page_markdown_v2` protocol
(docs/design/OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md). OCR runs fully locally:
`minicpmvocr parse` (ocr_mac_pages.py) against the MLX model server on
127.0.0.1:18499.

Start it with `Financial_analyze/scripts/start_ocr_mac.sh`, which launches the
MLX server, runs the self-test and then this worker in the foreground.

Protocol outline:
  hello (resultFormats=[page_markdown_v2], capabilities=[page_ack])
  -> pair_required -> pair(code) -> welcome (or deny + retry the code);
     a Core on this same machine answers hello with welcome directly (no code)
  job header -> binary PDF chunks -> job_end
  page_result per page, each waiting for a durable page_ack
  result_end -> result_ack (or result_incomplete -> resend the listed pages)

A dropped connection or a Core restart abandons the current job (the SDK
subprocess is killed, the work folder deleted); the worker reconnects with
backoff (1 s doubling to 30 s) and asks for the new pairing code.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Awaitable, Callable

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ocr_mac_pages import (  # noqa: E402
    InvalidPageResult,
    OCRConfig,
    OCRPage,
    ParseFailed,
    ocr_pdf_pages,
    pdf_page_count,
)

__all__ = ["OCRPage", "OCRConfig", "InvalidPageResult", "ParseFailed"]


OCR_PROTOCOL_VERSION = 1
OCR_PAGE_SCHEMA_VERSION = 2
OCR_RESULT_FORMAT = "page_markdown_v2"
OCR_CAPABILITIES = ["page_ack"]

PAGE_ACK_TIMEOUT_SECONDS = 30
MAX_PAGE_SEND_ATTEMPTS = 3
MAX_FINALIZE_ATTEMPTS = 3
MAX_MISSING_PAGE_REPAIR_ROUNDS = 3
MAX_PAGE_MARKDOWN_BYTES = 1024 * 1024
MAX_DOCUMENT_MARKDOWN_BYTES = 20 * 1024 * 1024

# Retry delay base: attempt n waits RETRY_DELAY_SECONDS * 2**(n-1).
RETRY_DELAY_SECONDS = 1.0
RECONNECT_INITIAL_SECONDS = 1
RECONNECT_MAX_SECONDS = 30

# The SDK gives no usable per-page progress (its pipeline finishes all pages within the
# last seconds), so progress during the parse is an estimate from elapsed time. Rate
# measured on the 61-page MBB Q3 2026 statement: 642 s, about 10.5 s per page.
ESTIMATED_SECONDS_PER_PAGE = 10.5
PROGRESS_INTERVAL_SECONDS = 10.0
PROGRESS_PARSE_START = 20
PROGRESS_PARSE_END = 90
PROGRESS_ESTIMATE_CAP = 89  # never claim the parse is done before it is

SCRIPTS_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPTS_DIR.parent
DEFAULT_CONNECT = "ws://127.0.0.1:8000/ws/ocr"
DEFAULT_NAME = "Mac OCR (MLX)"
DEFAULT_OCR_URL = "http://127.0.0.1:18499"
DEFAULT_OCR_HOME = PROJECT_DIR / "models" / "ocr"
DEFAULT_SDK_BIN = PROJECT_DIR / ".venv-ocr-sdk" / "bin" / "minicpmvocr"

OcrFn = Callable[[bytes, Path], Awaitable[list[OCRPage]]]

_SAFE_JOB_ID = re.compile(r"[A-Za-z0-9_.-]+")


class JobControl(Exception):
    """Core asked to hold or stop the current job; control_ack is already sent."""

    def __init__(self, action: str):
        super().__init__(action)
        self.action = action


class ResultRejected(RuntimeError):
    """Core already recorded a terminal rejection; do not send a second error."""


def _dumps(message: dict) -> str:
    return json.dumps(message, ensure_ascii=False)


def _retry_delay(attempt: int) -> float:
    return RETRY_DELAY_SECONDS * 2 ** (attempt - 1)


# --- contract checks -----------------------------------------------------------------


def hello_message(name: str) -> dict:
    return {
        "type": "hello",
        "name": name,
        "protocolVersion": OCR_PROTOCOL_VERSION,
        "resultFormats": [OCR_RESULT_FORMAT],
        "capabilities": OCR_CAPABILITIES,
    }


def validate_welcome(welcome: dict) -> None:
    if welcome.get("type") != "welcome":
        raise RuntimeError(f"Pairing rejected: {welcome}")
    if welcome.get("protocolVersion") != OCR_PROTOCOL_VERSION:
        raise RuntimeError(f"Unsupported transport protocol: {welcome}")
    if welcome.get("selectedResultFormat") != OCR_RESULT_FORMAT:
        raise RuntimeError(f"Page Markdown was not selected: {welcome}")
    if welcome.get("resultSchemaVersion") != OCR_PAGE_SCHEMA_VERSION:
        raise RuntimeError(f"Unsupported page schema: {welcome}")
    if set(welcome.get("requiredCapabilities", [])) != set(OCR_CAPABILITIES):
        raise RuntimeError(f"Unexpected required capabilities: {welcome}")


def validate_job_contract(job: dict) -> None:
    if job.get("resultFormat") != OCR_RESULT_FORMAT:
        raise RuntimeError(f"Job requires unsupported result format: {job}")
    if job.get("resultSchemaVersion") != OCR_PAGE_SCHEMA_VERSION:
        raise RuntimeError(f"Job requires unsupported schema: {job}")
    if set(job.get("requiredCapabilities", [])) != set(OCR_CAPABILITIES):
        raise RuntimeError(f"Job requires unsupported capabilities: {job}")


def validate_pages(pages: list[OCRPage], page_count: int) -> None:
    """Pages 1..page_count exactly once, Markdown strings within the UTF-8 byte limits."""
    if not isinstance(pages, list):
        raise InvalidPageResult("OCR pages must be a list")
    if len(pages) != page_count:
        raise InvalidPageResult(f"Expected {page_count} pages, received {len(pages)}")
    numbers = [page.page for page in pages]
    if not all(isinstance(n, int) and not isinstance(n, bool) for n in numbers):
        raise InvalidPageResult(f"Page numbers must be integers; received {numbers}")
    if sorted(numbers) != list(range(1, page_count + 1)):
        raise InvalidPageResult(
            f"Pages must appear exactly once from 1 through {page_count}; received {numbers}"
        )
    total_bytes = 0
    for page in pages:
        if not isinstance(page.markdown, str):
            raise InvalidPageResult(f"Page {page.page} Markdown must be a string")
        size = len(page.markdown.encode("utf-8"))
        if size > MAX_PAGE_MARKDOWN_BYTES:
            raise InvalidPageResult(f"Page {page.page} Markdown exceeds 1 MiB ({size} bytes)")
        total_bytes += size
    if total_bytes > MAX_DOCUMENT_MARKDOWN_BYTES:
        raise InvalidPageResult(f"Document Markdown exceeds 20 MiB ({total_bytes} bytes)")


# --- frames --------------------------------------------------------------------------


async def receive_pdf(ws, job: dict) -> bytes:
    """Receive one binary-chunked PDF and verify its job id and byte count."""
    job_id = job["jobId"]
    expected_bytes = int(job.get("bytes", -1))
    if expected_bytes < 0:
        raise RuntimeError(f"Job {job_id} has no valid byte count")

    payload = bytearray()
    while True:
        frame = await ws.recv()
        if isinstance(frame, bytes):
            payload.extend(frame)
            if len(payload) > expected_bytes:
                raise RuntimeError(f"Job {job_id} exceeded its announced byte count")
            continue

        message = json.loads(frame)
        if message.get("type") != "job_end" or message.get("jobId") != job_id:
            raise RuntimeError(f"Unexpected frame while receiving job {job_id}")
        break

    if len(payload) != expected_bytes:
        raise RuntimeError(
            f"Job {job_id} byte count mismatch: expected {expected_bytes}, got {len(payload)}"
        )
    return bytes(payload)


async def recv_for_job(ws, job_id: str, timeout: float | None) -> dict:
    """Return the next JSON frame for `job_id`.

    A hold/stop `job_control` is acknowledged with `control_ack` and raised as
    JobControl. Must be the only coroutine awaiting ws.recv().
    """
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    if not isinstance(raw, str):
        raise RuntimeError(f"Unexpected binary frame while awaiting job {job_id}")
    message = json.loads(raw)
    if message.get("type") == "job_control":
        if message.get("jobId") != job_id:
            raise RuntimeError(f"Control message belongs to another job: {message}")
        action = message.get("action")
        if action not in {"hold", "stop"}:
            raise RuntimeError(f"Unknown control action: {message}")
        await ws.send(_dumps({"type": "control_ack", "jobId": job_id, "action": action}))
        raise JobControl(action)
    if message.get("jobId") != job_id:
        raise RuntimeError(f"Message belongs to another job: {message}")
    return message


async def _recv_until(ws, job_id: str, deadline: float, accept: Callable[[dict], bool]) -> dict:
    """recv_for_job until `accept(message)` or the deadline; skipped frames are logged."""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise asyncio.TimeoutError
        message = await recv_for_job(ws, job_id, remaining)
        if accept(message):
            return message
        print(f"job={job_id} ignoring stale {message.get('type')} page={message.get('page')}")


def page_message(job_id: str, page: OCRPage, page_count: int) -> dict:
    return {
        "type": "page_result",
        "jobId": job_id,
        "schemaVersion": OCR_PAGE_SCHEMA_VERSION,
        "page": page.page,
        "pageCount": page_count,
        "markdown": page.markdown,
    }


async def send_page(ws, job_id: str, page: OCRPage, page_count: int) -> dict:
    """Send one page_result and wait for its durable page_ack; retries are byte-identical."""
    encoded = _dumps(page_message(job_id, page, page_count))
    raw_bytes = page.markdown.encode("utf-8")
    checksum = hashlib.sha256(raw_bytes).hexdigest()

    def is_reply(message: dict) -> bool:
        # A late ack for an earlier page (after a timeout retry) is stale: skip it.
        return not (message.get("type") == "page_ack" and message.get("page") != page.page)

    for attempt in range(1, MAX_PAGE_SEND_ATTEMPTS + 1):
        print(
            f"job={job_id} page={page.page}/{page_count} bytes={len(raw_bytes)} "
            f"sha256={checksum} send_attempt={attempt}"
        )
        started = time.monotonic()
        await ws.send(encoded)
        try:
            response = await _recv_until(
                ws, job_id, started + PAGE_ACK_TIMEOUT_SECONDS, is_reply
            )
        except asyncio.TimeoutError:
            if attempt == MAX_PAGE_SEND_ATTEMPTS:
                raise RuntimeError(
                    f"No acknowledgement for page {page.page} after "
                    f"{MAX_PAGE_SEND_ATTEMPTS} attempts"
                ) from None
            await asyncio.sleep(_retry_delay(attempt))
            continue

        kind = response.get("type")
        if kind == "page_ack":
            if response.get("status") not in {"stored", "already_stored"}:
                raise RuntimeError(f"Unknown page acknowledgement: {response}")
            rtt_ms = int((time.monotonic() - started) * 1000)
            print(
                f"job={job_id} page={page.page}/{page_count} "
                f"ack={response['status']} rtt_ms={rtt_ms}"
            )
            return response
        if kind == "page_rejected":
            if response.get("retryable") and attempt < MAX_PAGE_SEND_ATTEMPTS:
                print(f"job={job_id} page={page.page} retryable rejection: {response}")
                await asyncio.sleep(_retry_delay(attempt))
                continue
            raise ResultRejected(
                f"Page {page.page} rejected [{response.get('errorCode', 'unknown')}]: "
                f"{response.get('error', 'unknown error')}"
            )
        raise RuntimeError(f"Unexpected response for page {page.page}: {response}")

    raise RuntimeError(f"Could not send page {page.page}")  # pragma: no cover


async def finalize(ws, job_id: str, pages: dict[int, OCRPage], page_count: int) -> dict:
    """Send result_end, repair result_incomplete pages, return the result_ack."""

    def is_reply(message: dict) -> bool:
        return message.get("type") != "page_ack"  # stale page acks are not replies

    failures = 0
    repair_rounds = 0
    while True:
        await ws.send(_dumps({
            "type": "result_end",
            "jobId": job_id,
            "schemaVersion": OCR_PAGE_SCHEMA_VERSION,
            "pageCount": page_count,
        }))
        try:
            response = await _recv_until(
                ws, job_id, time.monotonic() + PAGE_ACK_TIMEOUT_SECONDS, is_reply
            )
        except asyncio.TimeoutError:
            failures += 1
            if failures >= MAX_FINALIZE_ATTEMPTS:
                raise RuntimeError(
                    f"No final acknowledgement for {job_id} after {MAX_FINALIZE_ATTEMPTS} attempts"
                ) from None
            await asyncio.sleep(_retry_delay(failures))
            continue

        kind = response.get("type")
        if kind == "result_ack":
            if response.get("status") != "ready_for_review":
                raise RuntimeError(f"Unexpected final status: {response}")
            if response.get("pageCount") != page_count:
                raise RuntimeError(f"Server page count mismatch: {response}")
            return response
        if kind == "result_incomplete":
            repair_rounds += 1
            if repair_rounds > MAX_MISSING_PAGE_REPAIR_ROUNDS:
                raise RuntimeError(
                    f"Server still reports missing pages after "
                    f"{MAX_MISSING_PAGE_REPAIR_ROUNDS} repair rounds"
                )
            missing = response.get("missingPages")
            if not isinstance(missing, list) or not missing:
                raise RuntimeError(f"Invalid missing-page response: {response}")
            unknown = [n for n in missing if n not in pages]
            if unknown:
                raise RuntimeError(f"Server requested pages unavailable locally: {unknown}")
            print(f"job={job_id} server is missing pages {missing}; resending")
            for number in missing:
                await send_page(ws, job_id, pages[number], page_count)
            continue
        if kind == "result_rejected":
            if response.get("retryable"):
                failures += 1
                if failures >= MAX_FINALIZE_ATTEMPTS:
                    raise RuntimeError(
                        f"Could not finalize {job_id} after "
                        f"{MAX_FINALIZE_ATTEMPTS} retryable failures"
                    )
                await asyncio.sleep(_retry_delay(failures))
                continue
            raise ResultRejected(
                f"Result rejected [{response.get('errorCode', 'unknown')}]: "
                f"{response.get('error', 'unknown error')}"
            )
        raise RuntimeError(f"Unexpected final response: {response}")


# --- job processing ------------------------------------------------------------------


def _being_cancelled() -> bool:
    current = asyncio.current_task()
    return current is not None and current.cancelling() > 0


async def _stop_watcher(task: asyncio.Task) -> dict | None:
    """Cancel the control watcher after OCR finished and wait for it.

    Returns a frame it managed to receive before the cancel took effect (None if
    it was cancelled cleanly); its errors, e.g. JobControl, propagate.
    """
    task.cancel()
    try:
        return await task
    except asyncio.CancelledError:
        if _being_cancelled():
            raise
        return None


async def _abandon(*tasks: asyncio.Task) -> None:
    """Cleanup: cancel every task, then wait for all of them so their own cleanup
    (killing the SDK subprocess group) has finished. Errors of abandoned tasks are
    logged, never raised over the exception already in flight; our own
    cancellation is re-raised after all tasks are drained."""
    pending = []
    for task in tasks:
        if task.done():
            if not task.cancelled():
                task.exception()  # outcome already handled by the caller
        else:
            task.cancel()
            pending.append(task)
    cancelled_self = False
    for task in pending:
        try:
            await task
        except asyncio.CancelledError:
            if _being_cancelled():
                cancelled_self = True
        except Exception as exc:
            print(f"Abandoned task ended with {type(exc).__name__}: {exc}")
    if cancelled_self:
        raise asyncio.CancelledError


def _work_dir(work_root: Path, job_id: str) -> Path:
    if not _SAFE_JOB_ID.fullmatch(job_id) or job_id in {".", ".."}:
        raise RuntimeError(f"Unsafe job id for a work folder: {job_id!r}")
    return work_root / job_id


async def _send_progress(ws, job_id: str, pct: int) -> None:
    await ws.send(_dumps({"type": "progress", "jobId": job_id, "pct": pct}))


def estimated_progress(elapsed_s: float, page_count: int) -> int:
    """Progress percentage for a parse running `elapsed_s` seconds (time-based estimate)."""
    expected = max(page_count, 1) * ESTIMATED_SECONDS_PER_PAGE
    fraction = min(max(elapsed_s, 0.0) / expected, 1.0)
    span = PROGRESS_PARSE_END - PROGRESS_PARSE_START
    return min(PROGRESS_PARSE_START + int(span * fraction), PROGRESS_ESTIMATE_CAP)


async def _progress_ticker(ws, job_id: str, page_count: int) -> None:
    """Send rising progress estimates while the parse runs; cancelled when it ends."""
    started = time.monotonic()
    last = PROGRESS_PARSE_START
    while True:
        await asyncio.sleep(PROGRESS_INTERVAL_SECONDS)
        pct = estimated_progress(time.monotonic() - started, page_count)
        if pct > last:
            await _send_progress(ws, job_id, pct)
            last = pct


async def _run_ocr_watching_control(ws, job_id: str, ocr: OcrFn, pdf_bytes: bytes,
                                    work_dir: Path, page_count: int) -> list[OCRPage]:
    """Run OCR while one receive task watches for hold/stop. Exactly one ws reader.

    A ticker task sends estimated progress meanwhile (send only, never reads)."""
    ocr_task = asyncio.create_task(ocr(pdf_bytes, work_dir))
    watch_task = asyncio.create_task(recv_for_job(ws, job_id, None))
    ticker_task = asyncio.create_task(_progress_ticker(ws, job_id, page_count))
    try:
        done, _ = await asyncio.wait({ocr_task, watch_task},
                                     return_when=asyncio.FIRST_COMPLETED)
        if watch_task in done:
            # Raises JobControl (control_ack already sent) or the receive error, e.g.
            # ConnectionClosed. Any other frame for this job is a protocol violation.
            message = watch_task.result()
            raise RuntimeError(f"Unexpected frame while running OCR for {job_id}: {message}")
        # OCR finished: stop the watcher before anyone else reads the socket. If a frame
        # slipped in before the cancel took effect, it is returned or raised here.
        message = await _stop_watcher(watch_task)
        if message is not None:
            raise RuntimeError(f"Unexpected frame while running OCR for {job_id}: {message}")
        return ocr_task.result()
    finally:
        # Cancelling ocr_pdf_pages kills the SDK subprocess group and waits for it.
        # The ticker goes first so no estimate is sent after the OCR outcome.
        await _abandon(ticker_task, ocr_task, watch_task)


async def process_job(ws, job: dict, ocr: OcrFn, work_root: Path,
                      keep_work: bool = False) -> str:
    """Run one job end to end. Returns "hold"/"stop" for a control outcome."""
    job_id = job["jobId"]
    validate_job_contract(job)
    work_dir = _work_dir(work_root, job_id)
    created = False
    try:
        await _send_progress(ws, job_id, 10)
        pdf_bytes = await receive_pdf(ws, job)
        page_count = pdf_page_count(pdf_bytes)
        await _send_progress(ws, job_id, 20)

        if work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True)
        created = True

        ocr_started = time.monotonic()
        pages = await _run_ocr_watching_control(ws, job_id, ocr, pdf_bytes, work_dir,
                                                page_count)
        ocr_s = time.monotonic() - ocr_started
        print(f"Job {job_id}: OCR complete: {len(pages)}/{page_count} pages in {ocr_s:.0f} s "
              f"({ocr_s / max(page_count, 1):.1f} s/page)")
        await _send_progress(ws, job_id, PROGRESS_PARSE_END)
        validate_pages(pages, page_count)
        ordered = sorted(pages, key=lambda p: p.page)
        by_number = {p.page: p for p in ordered}

        for page in ordered:
            await send_page(ws, job_id, page, page_count)
        final_ack = await finalize(ws, job_id, by_number, page_count)
        return f"done — {final_ack['pageCount']} pages, review {final_ack.get('reviewId')} ready"
    except JobControl as control:
        return control.action
    finally:
        if created and not keep_work:
            shutil.rmtree(work_dir, ignore_errors=True)


async def handle_job(ws, job: dict, ocr: OcrFn, work_root: Path,
                     keep_work: bool = False) -> None:
    """process_job plus error ownership: report worker-owned failures to Core."""
    job_id = job.get("jobId")
    print(f"Job {job_id}: {job.get('filename', '?')}")
    try:
        outcome = await process_job(ws, job, ocr, work_root, keep_work)
    except ConnectionClosed:
        raise
    except JobControl as control:  # process_job returns these; kept as a safety net
        print(f"Job {job_id}: {control.action} acknowledged")
        return
    except ResultRejected as exc:
        print(f"Job {job_id}: failed — {exc}")
        return
    except Exception as exc:
        deterministic = isinstance(exc, InvalidPageResult)
        print(f"Job {job_id}: failed — {type(exc).__name__}: {exc}")
        await ws.send(_dumps({
            "type": "error",
            "jobId": job_id,
            "error": str(exc),
            "errorCode": "invalid_page_result" if deterministic else "worker_job_failed",
            "retryable": not deterministic,
        }))
        return
    if outcome in {"hold", "stop"}:
        print(f"Job {job_id}: {outcome} acknowledged")
    else:
        print(f"Job {job_id}: {outcome}")


# --- session / reconnect -------------------------------------------------------------


async def _pair(ws, name: str, read_code: Callable[[str], Awaitable[str]]) -> dict | None:
    """Hello + pairing. Returns the validated welcome, or None if the code was refused."""
    await ws.send(_dumps(hello_message(name)))
    pair_required = json.loads(await ws.recv())
    if pair_required.get("type") == "welcome":
        # Core on this same machine trusts loopback workers: no code needed.
        validate_welcome(pair_required)
        return pair_required
    if pair_required.get("type") != "pair_required":
        raise RuntimeError(f"Core refused this worker: {pair_required}")
    pair_id = pair_required["pairId"]

    prompt = "Pairing code from the Sync page: "
    while True:
        code = await read_code(prompt)
        await ws.send(_dumps({"type": "pair", "pairId": pair_id, "code": code}))
        reply = json.loads(await ws.recv())
        if reply.get("type") != "deny":
            break
        attempts_left = reply.get("attemptsLeft", 0)
        if attempts_left <= 0:
            print(f"Pairing failed: {reply.get('reason', reply)}")
            return None
        prompt = f"Wrong code ({attempts_left} attempts left). Re-enter code: "
    validate_welcome(reply)
    return reply


async def run_session(connect_url: str, name: str, ocr: OcrFn, work_root: Path,
                      read_code: Callable[[str], Awaitable[str]], keep_work: bool = False,
                      *, connect=websockets.connect,
                      on_paired: Callable[[], None] | None = None) -> None:
    """One connection: pair, then process jobs one at a time until the socket closes.

    Raises ConnectionClosed/OSError on transport loss and RuntimeError on a contract
    mismatch; returns normally only when pairing was refused.
    """
    print(f"Connecting to {connect_url} ...")
    async with connect(connect_url, max_size=None) as ws:
        welcome = await _pair(ws, name, read_code)
        if welcome is None:
            return
        print(
            f"Paired. workerId={welcome.get('workerId')} format={OCR_RESULT_FORMAT} "
            f"schema={OCR_PAGE_SCHEMA_VERSION}. Waiting for jobs..."
        )
        if on_paired is not None:
            on_paired()
        while True:
            raw = await ws.recv()
            if isinstance(raw, bytes):
                print("Ignoring unexpected binary frame outside a job")
                continue
            message = json.loads(raw)
            if message.get("type") != "job":
                if message.get("type") not in {"job_end", "job_control"}:
                    print(f"Ignoring {message.get('type')} frame outside a job")
                continue
            await handle_job(ws, message, ocr, work_root, keep_work)


async def run_forever(connect_url: str, name: str, ocr: OcrFn, work_root: Path,
                      read_code: Callable[[str], Awaitable[str]], keep_work: bool = False,
                      *, connect=websockets.connect, sleep=asyncio.sleep) -> None:
    """Reconnect loop: backoff 1 s doubling to 30 s, reset after a session that paired.

    Retried: ConnectionClosed, OSError, asyncio.TimeoutError, InvalidHandshake and a
    refused pairing code. A contract mismatch (RuntimeError) is not retried.
    """
    delay = RECONNECT_INITIAL_SECONDS
    try:
        while True:
            paired = False

            def mark_paired() -> None:
                nonlocal paired
                paired = True

            try:
                await run_session(connect_url, name, ocr, work_root, read_code, keep_work,
                                  connect=connect, on_paired=mark_paired)
                print("Pairing was refused.")
            except ConnectionClosed as exc:
                print(f"Connection to Core closed ({exc}).")
            except (OSError, asyncio.TimeoutError, InvalidHandshake) as exc:
                # InvalidHandshake: TCP accepted but the HTTP upgrade failed, e.g. Core
                # restarting under uvicorn --reload (InvalidMessage / InvalidStatus).
                print(f"Cannot reach Core at {connect_url} ({type(exc).__name__}: {exc}).")
            if paired:
                delay = RECONNECT_INITIAL_SECONDS
            print(f"Reconnecting in {delay} s ...")
            await sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)
    except KeyboardInterrupt:
        print("\nWorker stopped.")


# --- CLI -----------------------------------------------------------------------------


def check_ocr_server(ocr_url: str) -> None:
    """Fail fast when the local MLX model server is not answering."""
    url = f"{ocr_url.rstrip('/')}/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            json.loads(resp.read())
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise SystemExit(
            f"OCR model server is not reachable at {url} ({exc}). "
            "Start the Mac OCR stack with Financial_analyze/scripts/start_ocr_mac.sh."
        ) from exc


async def read_code_from_terminal(prompt: str) -> str:
    """input() on a daemon thread so Ctrl+C at the prompt does not hang shutdown."""
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()

    def deliver(setter, value) -> None:
        if not future.done():
            setter(value)

    def reader() -> None:
        try:
            value = input(prompt)
        except BaseException as exc:  # EOFError etc. belong to the awaiting coroutine
            loop.call_soon_threadsafe(deliver, future.set_exception, exc)
        else:
            loop.call_soon_threadsafe(deliver, future.set_result, value)

    threading.Thread(target=reader, name="pair-code-input", daemon=True).start()
    return (await future).strip()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Mac OCR worker (page_markdown_v2).")
    p.add_argument("--connect", default=DEFAULT_CONNECT, help="Core OCR WebSocket URL")
    p.add_argument("--name", default=DEFAULT_NAME)
    p.add_argument("--ocr-url", default=DEFAULT_OCR_URL, help="local MLX model server")
    p.add_argument("--ocr-home", type=Path, default=DEFAULT_OCR_HOME)
    p.add_argument("--model", default=None,
                   help="model id/path served by the MLX server (default <ocr-home>/minicpm-ocr-1.0)")
    p.add_argument("--work-root", type=Path, default=None,
                   help="per-job work folders (default: a new temp dir)")
    p.add_argument("--keep-work", action="store_true", help="keep per-job work folders")
    p.add_argument("--sdk-bin", type=Path, default=DEFAULT_SDK_BIN)
    args = p.parse_args(argv)
    if args.model is None:
        args.model = str(args.ocr_home / "minicpm-ocr-1.0")
    return args


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    check_ocr_server(args.ocr_url)
    cfg = OCRConfig(sdk_bin=args.sdk_bin, ocr_url=args.ocr_url, model=args.model,
                    ocr_home=args.ocr_home)

    def ocr(pdf: bytes, work_dir: Path) -> Awaitable[list[OCRPage]]:
        return ocr_pdf_pages(pdf, work_dir, cfg)

    temp_root = args.work_root is None
    work_root = Path(tempfile.mkdtemp(prefix="macocr-")) if temp_root else args.work_root
    work_root.mkdir(parents=True, exist_ok=True)
    try:
        asyncio.run(run_forever(args.connect, args.name, ocr, work_root,
                                read_code_from_terminal, args.keep_work))
    except KeyboardInterrupt:
        print("\nWorker stopped.")
    except RuntimeError as exc:
        raise SystemExit(f"Worker stopped: {exc}") from exc
    finally:
        if temp_root and not args.keep_work:
            shutil.rmtree(work_root, ignore_errors=True)


if __name__ == "__main__":
    main()
