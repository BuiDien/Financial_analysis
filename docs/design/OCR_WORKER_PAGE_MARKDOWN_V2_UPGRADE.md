# OCR Worker Upgrade — Page Markdown v2

Date: 2026-07-18  
Target: real WSL/vLLM OCR worker and repository reference worker  
Server requirement: dual-format page-Markdown server deployed first  
Protocol: transport version 1, result format `page_markdown_v2`, schema version 2

## 1. Objective

Update the worker so one completed PDF job produces one Markdown result per PDF page.

The worker must:

1. Connect and explicitly negotiate `page_markdown_v2`.
2. Receive and verify the complete PDF.
3. OCR the entire PDF locally into an ordered page collection.
4. Validate that pages `1..N` are present exactly once.
5. Send one `page_result` and wait for its durable `page_ack`.
6. Retry an identical page when an acknowledgement is lost or persistence is temporarily unavailable.
7. Send `result_end` only after every page is acknowledged.
8. Resend pages listed by `result_incomplete`.
9. Release the page buffer only after `result_ack`.

The worker must stop producing financial `rows` for this path. It must not create fake `code`, `id`,
`bbox`, `section`, `curr`, or `prev` values.

## 2. Do not replace the custom OCR engine

The repository reference worker is:

```text
Financial_analyze/scripts/ocr_worker.py
```

Its transport code is a reference, but its `run_ocr()` implementation is a stub. The real WSL worker
contains the working vLLM/PaddleOCR pipeline. Preserve that OCR setup and replace these boundaries:

| Current worker behavior | Required behavior |
|---|---|
| `run_ocr(...) -> rows` | `run_ocr_pages(...) -> pages` |
| advertises schema 1 + `bbox` | advertises `page_markdown_v2` + `page_ack` |
| validates financial row identities | validates page numbering and Markdown sizes |
| sends one large `result` | sends acknowledged `page_result` messages |
| waits for one row result ack | waits for every page ack, then final ack |

Do not copy the repository stub over the real OCR implementation.

## 3. Constants

Replace:

```python
OCR_RESULT_SCHEMA_VERSION = 1
OCR_CAPABILITIES = ["bbox"]
```

with:

```python
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
```

The transport protocol remains version 1 because pairing and PDF binary transfer are unchanged. The
result representation has its own format and schema version.

## 4. New handshake

Send this hello:

```python
await ws.send(json.dumps({
    "type": "hello",
    "name": name,
    "protocolVersion": OCR_PROTOCOL_VERSION,
    "resultFormats": [OCR_RESULT_FORMAT],
    "capabilities": OCR_CAPABILITIES,
}, ensure_ascii=False))
```

Do not send `resultSchemaVersions: [1]` and do not advertise `bbox`.

After pairing, require all negotiated values:

```python
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
```

Expected welcome:

```json
{
  "type": "welcome",
  "workerId": "58023ec0",
  "protocolVersion": 1,
  "selectedResultFormat": "page_markdown_v2",
  "resultSchemaVersion": 2,
  "requiredCapabilities": ["page_ack"]
}
```

If the server selects anything else, stop before accepting a PDF. Silent fallback to row schema 1
would recreate the `code or id` failure.

## 5. Validate every job header

Before receiving binary chunks:

```python
def validate_job_contract(job: dict) -> None:
    if job.get("resultFormat") != OCR_RESULT_FORMAT:
        raise RuntimeError(f"Job requires unsupported result format: {job}")
    if job.get("resultSchemaVersion") != OCR_PAGE_SCHEMA_VERSION:
        raise RuntimeError(f"Job requires unsupported schema: {job}")
    if set(job.get("requiredCapabilities", [])) != set(OCR_CAPABILITIES):
        raise RuntimeError(f"Job requires unsupported capabilities: {job}")
```

Keep the existing binary PDF receiver and byte-count verification. Do not begin OCR when the
announced and received PDF byte counts differ.

## 6. Page result interface

Change the OCR adapter boundary to return one object per source PDF page:

```python
pages = [
    {"page": 1, "markdown": "# Page 1\n\n..."},
    {"page": 2, "markdown": "# Page 2\n\n..."},
]
```

Recommended type:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class OCRPage:
    page: int
    markdown: str
```

Then:

```python
def run_ocr_pages(pdf_bytes: bytes, vllm_url: str) -> list[OCRPage]:
    """Return exactly one Markdown result for every source PDF page."""
    ...
```

Rules:

- Page numbers are one-based.
- One source PDF page produces exactly one result object.
- Keep page Markdown separate. Do not merge the document in the worker.
- Preserve Vietnamese text and Markdown tables exactly as returned by the OCR pipeline.
- A genuinely blank page is represented by `OCRPage(page=N, markdown="")`; do not omit it.
- Do not embed base64 images or the original PDF in Markdown.
- Do not include server page markers such as `<!-- PAGE:1 -->`; the server adds them during merging.

If vLLM returns document-level Markdown, change the adapter so each rendered page is submitted and
captured separately. Do not attempt to split a large document string using headings after OCR because
headings are OCR content, not reliable page boundaries.

## 7. Determine the expected page count

Calculate it from the received PDF before OCR:

```python
from io import BytesIO
from pypdf import PdfReader


def pdf_page_count(pdf_bytes: bytes) -> int:
    count = len(PdfReader(BytesIO(pdf_bytes)).pages)
    if count < 1:
        raise InvalidPageResult("PDF contains no pages")
    return count
```

Use the same `expected_page_count` for local validation and every outbound `pageCount`.

## 8. Local page validation

Add deterministic validation before sending page 1:

```python
class InvalidPageResult(RuntimeError):
    """The local OCR output cannot satisfy the negotiated page contract."""


def validate_pages(pages: list[OCRPage], expected_page_count: int) -> None:
    if not isinstance(pages, list):
        raise InvalidPageResult("OCR pages must be a list")
    if len(pages) != expected_page_count:
        raise InvalidPageResult(
            f"Expected {expected_page_count} pages, received {len(pages)}"
        )

    numbers = [page.page for page in pages]
    expected_numbers = list(range(1, expected_page_count + 1))
    if sorted(numbers) != expected_numbers:
        raise InvalidPageResult(
            f"Pages must appear exactly once from 1 through {expected_page_count}; "
            f"received {numbers}"
        )

    total_bytes = 0
    for page in pages:
        if not isinstance(page.page, int):
            raise InvalidPageResult("Page number must be an integer")
        if not isinstance(page.markdown, str):
            raise InvalidPageResult(f"Page {page.page} Markdown must be a string")
        size = len(page.markdown.encode("utf-8"))
        if size > MAX_PAGE_MARKDOWN_BYTES:
            raise InvalidPageResult(
                f"Page {page.page} Markdown exceeds 1 MiB ({size} bytes)"
            )
        total_bytes += size

    if total_bytes > MAX_DOCUMENT_MARKDOWN_BYTES:
        raise InvalidPageResult(
            f"Document Markdown exceeds 20 MiB ({total_bytes} bytes)"
        )
```

Sort once after validation:

```python
pages = sorted(pages, key=lambda page: page.page)
pages_by_number = {page.page: page for page in pages}
```

Never “repair” missing pages by renumbering later pages. A missing source page must fail locally.

## 9. Page message builder

```python
def page_message(job_id: str, page: OCRPage, page_count: int) -> dict:
    return {
        "type": "page_result",
        "jobId": job_id,
        "schemaVersion": OCR_PAGE_SCHEMA_VERSION,
        "page": page.page,
        "pageCount": page_count,
        "markdown": page.markdown,
    }
```

Serialize with Unicode preserved:

```python
encoded = json.dumps(message, ensure_ascii=False)
await ws.send(encoded)
```

Do not add row fields to this message.

## 10. One receiver at a time

The current reference worker starts a `control_task = asyncio.create_task(ws.recv())` during OCR and
later directly calls `ws.recv()` for the result acknowledgement. That is safe only if the control task
has been cancelled and awaited first.

The updated worker must maintain this invariant:

> At most one coroutine may be awaiting `ws.recv()` on a WebSocket.

During GPU OCR, one receive task may wait for `job_control` while the OCR work runs in a thread. Cancel
and await it when OCR finishes. During page upload, use a single synchronous receive helper that routes
acknowledgements and control messages.

Suggested control exception:

```python
class JobControlled(RuntimeError):
    def __init__(self, action: str):
        super().__init__(action)
        self.action = action
```

Suggested receiver:

```python
async def receive_job_message(ws, job_id: str, timeout: float) -> dict:
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
        await ws.send(json.dumps({
            "type": "control_ack",
            "jobId": job_id,
            "action": action,
        }))
        raise JobControlled(action)

    if message.get("jobId") != job_id:
        raise RuntimeError(f"Message belongs to another job: {message}")
    return message
```

Do not start a background receiver and also call this helper.

## 11. Send and acknowledge one page

```python
import hashlib


class ResultRejected(RuntimeError):
    """The server already recorded a terminal contract rejection."""


async def send_page_with_retry(
    ws,
    *,
    job_id: str,
    page: OCRPage,
    page_count: int,
) -> None:
    message = page_message(job_id, page, page_count)
    encoded = json.dumps(message, ensure_ascii=False)
    raw_bytes = page.markdown.encode("utf-8")
    checksum = hashlib.sha256(raw_bytes).hexdigest()

    for send_attempt in range(1, MAX_PAGE_SEND_ATTEMPTS + 1):
        print(
            f"job={job_id} page={page.page}/{page_count} "
            f"bytes={len(raw_bytes)} sha256={checksum} "
            f"send_attempt={send_attempt}"
        )
        await ws.send(encoded)
        try:
            response = await receive_job_message(
                ws, job_id, PAGE_ACK_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            if send_attempt == MAX_PAGE_SEND_ATTEMPTS:
                raise RuntimeError(
                    f"No acknowledgement for page {page.page} after "
                    f"{MAX_PAGE_SEND_ATTEMPTS} attempts"
                )
            await asyncio.sleep(2 ** (send_attempt - 1))
            continue

        if response.get("type") == "page_ack":
            if response.get("page") != page.page:
                raise RuntimeError(
                    f"Expected acknowledgement for page {page.page}: {response}"
                )
            if response.get("status") not in {"stored", "already_stored"}:
                raise RuntimeError(f"Unknown page acknowledgement: {response}")
            print(
                f"job={job_id} page={page.page}/{page_count} "
                f"ack={response['status']}"
            )
            return

        if response.get("type") == "page_rejected":
            if response.get("retryable") and send_attempt < MAX_PAGE_SEND_ATTEMPTS:
                await asyncio.sleep(2 ** (send_attempt - 1))
                continue
            raise ResultRejected(
                f"Page {page.page} rejected "
                f"[{response.get('errorCode', 'unknown')}]: "
                f"{response.get('error', 'unknown error')}"
            )

        raise RuntimeError(f"Unexpected response for page {page.page}: {response}")
```

Retries must reuse the exact serialized payload. The server treats an identical retry as idempotent
and returns `already_stored`. Different content for the same page causes `page_conflict` and fails the
attempt.

## 12. Finalize and repair missing pages

```python
async def finalize_result(
    ws,
    *,
    job_id: str,
    pages_by_number: dict[int, OCRPage],
    page_count: int,
) -> dict:
    finalize_failures = 0
    repair_rounds = 0
    while finalize_failures < MAX_FINALIZE_ATTEMPTS:
        await ws.send(json.dumps({
            "type": "result_end",
            "jobId": job_id,
            "schemaVersion": OCR_PAGE_SCHEMA_VERSION,
            "pageCount": page_count,
        }))
        try:
            response = await receive_job_message(
                ws, job_id, PAGE_ACK_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            finalize_failures += 1
            if finalize_failures >= MAX_FINALIZE_ATTEMPTS:
                raise RuntimeError(
                    f"No final acknowledgement for {job_id} after "
                    f"{MAX_FINALIZE_ATTEMPTS} attempts"
                )
            await asyncio.sleep(2 ** (finalize_failures - 1))
            continue

        if response.get("type") == "result_ack":
            if response.get("status") != "ready_for_review":
                raise RuntimeError(f"Unexpected final status: {response}")
            if response.get("pageCount") != page_count:
                raise RuntimeError(f"Server page count mismatch: {response}")
            return response

        if response.get("type") == "result_incomplete":
            repair_rounds += 1
            if repair_rounds > MAX_MISSING_PAGE_REPAIR_ROUNDS:
                raise RuntimeError(
                    f"Server still reports missing pages after "
                    f"{MAX_MISSING_PAGE_REPAIR_ROUNDS} repair rounds"
                )
            missing = response.get("missingPages")
            if not isinstance(missing, list) or not missing:
                raise RuntimeError(f"Invalid missing-page response: {response}")
            unknown = [number for number in missing if number not in pages_by_number]
            if unknown:
                raise RuntimeError(
                    f"Server requested pages unavailable locally: {unknown}"
                )
            for number in missing:
                await send_page_with_retry(
                    ws,
                    job_id=job_id,
                    page=pages_by_number[number],
                    page_count=page_count,
                )
            continue

        if response.get("type") == "result_rejected":
            if response.get("retryable"):
                finalize_failures += 1
                if finalize_failures >= MAX_FINALIZE_ATTEMPTS:
                    raise RuntimeError(
                        f"Could not finalize {job_id} after "
                        f"{MAX_FINALIZE_ATTEMPTS} retryable failures"
                    )
                await asyncio.sleep(2 ** (finalize_failures - 1))
                continue
            raise ResultRejected(
                f"Result rejected [{response.get('errorCode', 'unknown')}]: "
                f"{response.get('error', 'unknown error')}"
            )

        raise RuntimeError(f"Unexpected final response: {response}")

    raise RuntimeError(f"Could not finalize {job_id}")
```

Do not discard `pages_by_number` until this function returns `result_ack`.

## 13. Updated job-processing outline

```python
async def process_job(ws, job: dict, vllm_url: str) -> str:
    job_id = job["jobId"]
    validate_job_contract(job)
    await ws.send(json.dumps({
        "type": "progress", "jobId": job_id, "pct": 10,
    }))

    pdf_bytes = await receive_pdf(ws, job)
    expected_page_count = pdf_page_count(pdf_bytes)

    # Keep exactly one ws.recv() task active while OCR runs.
    ocr_task = asyncio.create_task(
        asyncio.to_thread(run_ocr_pages, pdf_bytes, vllm_url)
    )
    control_task = asyncio.create_task(ws.recv())
    try:
        done, _ = await asyncio.wait(
            {ocr_task, control_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if control_task in done:
            # Reuse the existing validated hold/stop handling here.
            ...

        control_task.cancel()
        with suppress(asyncio.CancelledError):
            await control_task

        pages = ocr_task.result()
        validate_pages(pages, expected_page_count)
        pages = sorted(pages, key=lambda page: page.page)
        pages_by_number = {page.page: page for page in pages}

        await ws.send(json.dumps({
            "type": "progress", "jobId": job_id, "pct": 90,
        }))

        for page in pages:
            await send_page_with_retry(
                ws,
                job_id=job_id,
                page=page,
                page_count=expected_page_count,
            )

        final_ack = await finalize_result(
            ws,
            job_id=job_id,
            pages_by_number=pages_by_number,
            page_count=expected_page_count,
        )
        return (
            f"done — {final_ack['pageCount']} pages accepted, "
            f"review {final_ack.get('reviewId')} ready"
        )
    except JobControlled as controlled:
        # receive_job_message already sent control_ack. Do not send an error
        # or result_end after a successful hold/stop acknowledgement.
        return controlled.action
    finally:
        if not control_task.done():
            control_task.cancel()
```

Replace the `...` with the worker’s existing control validation, `control_ack`, and OCR cancellation.
Do not send `result_end` after hold or stop. Ensure the main loop treats returned `hold`/`stop` as a
control outcome rather than printing it as a completed OCR job.

## 14. Error ownership

There are two different failure paths.

### Worker-owned error

Send an `error` message when the server has not already recorded the failure, for example:

- PDF byte mismatch.
- local OCR engine failure;
- invalid local page count;
- acknowledgement timeout after all retries;
- malformed/unexpected coordinator message.

Example:

```python
await ws.send(json.dumps({
    "type": "error",
    "jobId": job_id,
    "error": str(exc),
    "errorCode": (
        "invalid_page_result"
        if isinstance(exc, InvalidPageResult)
        else "worker_job_failed"
    ),
    "retryable": not isinstance(exc, InvalidPageResult),
}, ensure_ascii=False))
```

### Server-owned rejection

When `page_rejected` or `result_rejected` is non-retryable, the server already records the terminal
attempt failure. Catch `ResultRejected`, print it, and do not send a second `error` message.

```python
except ResultRejected as exc:
    print(f"Job {job_id}: failed — {exc}")
    continue
```

## 15. Diagnostic output

Always log metadata for each page:

```text
job=job_2831b0eaed page=7/57 bytes=18422 sha256=... send_attempt=1
job=job_2831b0eaed page=7/57 ack=stored rtt_ms=43
```

Add an opt-in flag such as `--print-page-json` for full payload comparison:

```python
if print_page_json:
    print("===== OCR WORKER OUTBOUND PAGE BEGIN =====")
    print(encoded)
    print("===== OCR WORKER OUTBOUND PAGE END =====")
```

The server independently prints received messages between `OCR WORKER MESSAGE BEGIN/END`. During the
canary test, compare:

- job ID;
- page number and page count;
- exact Markdown;
- UTF-8 byte size;
- worker checksum and server-stored checksum.

Never print the pairing code, WebSocket credentials, or PDF binary content.

## 16. Worker tests required before connection

Use a fake WebSocket server or mocked socket with deterministic response queues.

### Contract tests

- Unicode Vietnamese Markdown survives JSON serialization.
- Empty Markdown is accepted for an existing blank page.
- Missing, duplicate, zero, and out-of-range page numbers fail locally.
- Non-string Markdown fails locally.
- A page above 1 MiB and a document above 20 MiB fail locally.

### Upload state-machine tests

- Three pages produce three `page_result` messages followed by one `result_end`.
- The worker does not send page 2 before page 1 is acknowledged.
- Timeout resends byte-identical JSON.
- `already_stored` advances to the next page.
- Retryable `page_rejected` resends the same page.
- `page_conflict` raises `ResultRejected` and sends no worker `error` afterward.
- `result_incomplete: [2]` resends only page 2.
- The page buffer remains available until `result_ack`.
- Hold/stop is acknowledged while waiting for a page acknowledgement.
- At no point do two coroutines await `ws.recv()` concurrently.

### Integration test

- Fake server performs the full hello/pair/job/chunks/job_end/page ack/final ack lifecycle.
- Assert `ensure_ascii=False` preserves Vietnamese text.
- Assert the final worker status is printed only after `result_ack`.

## 17. Local verification commands

From the worker repository:

```bash
python -m py_compile path/to/ocr_worker.py
pytest -q path/to/worker/tests
```

If Ruff is installed:

```bash
ruff check path/to/ocr_worker.py path/to/worker/tests
```

Git workflow:

```bash
git switch -c feat/ocr-page-markdown-v2
git status --short
git diff --check
git diff
```

Review the diff before committing. Do not mix model-server changes or OCR-quality experiments into the
transport upgrade branch.

## 18. Canary rollout

1. Confirm the updated server is running and its database migration completed.
2. Stop the old worker process; keep the vLLM/model server running.
3. Back up the real worker source.
4. Apply the handshake, page adapter, validator, ack loop, finalizer, and tests.
5. Run syntax, unit, and fake-server tests.
6. Start the worker using the current server URL and new pairing code.
7. Confirm `welcome.selectedResultFormat == page_markdown_v2`.
8. Dispatch a two- or three-page test PDF.
9. Confirm one `page_ack` for every page and one final `result_ack`.
10. Query the server review endpoints and compare both pages exactly.
11. Test one correction and confirm raw Markdown remains unchanged.
12. Dispatch a medium report.
13. Finally retry the previously failing MBB report.

Do not begin with the large report. The small canary makes page ordering and acknowledgement problems
obvious without paying the full OCR runtime.

## 19. Expected successful log sequence

```text
Connecting to ws://192.168.1.x:8000/ws/ocr ...
Paired workerId=58023ec0 format=page_markdown_v2 schema=2
Job job_2831b0eaed: statement.pdf
OCR complete: 57/57 pages
job=job_2831b0eaed page=1/57 bytes=... sha256=... send_attempt=1
job=job_2831b0eaed page=1/57 ack=stored
...
job=job_2831b0eaed page=57/57 ack=stored
Job job_2831b0eaed: done — 57 pages accepted, review 19 ready
```

The worker must not print `done` after the last `page_ack`; it prints `done` only after `result_ack`.

## 20. Acceptance checklist

- [ ] Hello advertises only `page_markdown_v2` and `page_ack`.
- [ ] Worker validates the selected result format and schema before accepting work.
- [ ] Job header requires page Markdown schema 2.
- [ ] PDF byte count is verified.
- [ ] OCR returns exactly one result per source PDF page.
- [ ] Page numbers are unique, contiguous, one-based, and match the PDF count.
- [ ] Blank pages are sent rather than omitted.
- [ ] Vietnamese Markdown is serialized with `ensure_ascii=False`.
- [ ] Worker sends one page at a time and waits for matching `page_ack`.
- [ ] Page retries are byte-identical.
- [ ] `already_stored` is treated as success.
- [ ] `result_incomplete` resends only the server-requested pages.
- [ ] Page data remains buffered until final `result_ack`.
- [ ] Hold/stop works during OCR and result upload.
- [ ] Only one coroutine reads the WebSocket at a time.
- [ ] Non-retryable server rejection does not cause a second worker error.
- [ ] No `code`, `id`, `bbox`, or financial row structure is fabricated.
- [ ] Small and medium canaries complete before the MBB report.
- [ ] Server and worker logs show the same job ID, page count, and content.

## 21. Server responses reference

| Message | Meaning | Worker action |
|---|---|---|
| `page_ack: stored` | Page committed for first time | Continue |
| `page_ack: already_stored` | Identical retry already committed | Continue |
| `page_rejected`, retryable | Temporary page persistence failure | Retry identical page |
| `page_rejected`, non-retryable | Contract or content conflict | Stop; no second error |
| `result_incomplete` | Server is missing listed pages | Resend only listed pages |
| `result_ack` | Review created and job complete | Release buffer; print done |
| `result_rejected`, retryable | Temporary finalization failure | Resend `result_end` with backoff |
| `result_rejected`, non-retryable | Terminal finalization failure | Stop; no second error |
| `job_control` | User requested hold/stop | Cancel work, ack action, do not finalize |

This runbook supersedes `OCR_WORKER_V1_UPGRADE.md` for new workers. The schema-1 document remains only
for legacy compatibility during migration.
