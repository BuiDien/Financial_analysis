# OCR Worker Upgrade: Protocol v1 + Result Schema v1

> Legacy only. New workers must follow
> [`OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md`](OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md).
> The page-Markdown v2 path removes the `code/id/bbox` requirement from raw OCR transport.

This runbook updates the real OCR worker on `192.168.1.212` to the contract
required by the Helix coordinator. It fixes both observed failures:

- connection rejected because the worker did not advertise protocol/schema capabilities;
- results rejected because `schemaVersion` and per-row `bbox` were missing.

The repository worker at `Financial_analyze/scripts/ocr_worker.py` is the
transport reference. Its `run_ocr()` is still a stub, so do **not** replace the
custom WSL extraction pipeline wholesale. Merge the protocol and validation
changes below into the real worker while preserving its OCR implementation.

## 1. Required contract

The worker must advertise:

```python
OCR_PROTOCOL_VERSION = 1
OCR_RESULT_SCHEMA_VERSION = 1
OCR_CAPABILITIES = ["bbox"]
```

It may advertise `bbox` only when every returned row contains a real source
location. A placeholder or full-page box is not acceptable for production
review because it cannot identify the source line.

## 2. Upgrade the `hello` frame

Replace the legacy hello:

```python
await ws.send(json.dumps({"type": "hello", "name": name}))
```

with:

```python
await ws.send(json.dumps({
    "type": "hello",
    "name": name,
    "protocolVersion": OCR_PROTOCOL_VERSION,
    "resultSchemaVersions": [OCR_RESULT_SCHEMA_VERSION],
    "capabilities": OCR_CAPABILITIES,
}))
```

The coordinator will answer with either:

```json
{
  "type": "welcome",
  "workerId": "...",
  "protocolVersion": 1,
  "resultSchemaVersion": 1,
  "requiredCapabilities": ["bbox"]
}
```

or a terminal `deny`. Check the negotiated contract before accepting work:

```python
if welcome.get("type") != "welcome":
    raise RuntimeError(f"Pairing rejected: {welcome}")
if welcome.get("protocolVersion") != OCR_PROTOCOL_VERSION:
    raise RuntimeError(f"Unsupported coordinator protocol: {welcome}")
if welcome.get("resultSchemaVersion") != OCR_RESULT_SCHEMA_VERSION:
    raise RuntimeError(f"Unsupported result schema: {welcome}")
```

## 3. Preserve source geometry during OCR

The legacy worker currently returns text and values but discards layout
coordinates. Keep the original page dimensions and the detected rectangle,
quadrilateral, or polygon for every financial row.

For a pixel rectangle `[x1, y1, x2, y2]`:

```python
def normalize_rect(rect, page_width: int, page_height: int) -> dict:
    if page_width <= 0 or page_height <= 0:
        raise ValueError("page dimensions must be positive")

    x1, y1, x2, y2 = map(float, rect)
    if x1 < 0 or y1 < 0 or x2 <= x1 or y2 <= y1:
        raise ValueError(f"invalid source rectangle: {rect}")
    if x2 > page_width or y2 > page_height:
        raise ValueError(
            f"rectangle {rect} exceeds page {page_width}x{page_height}"
        )

    return {
        "x": x1 / page_width,
        "y": y1 / page_height,
        "width": (x2 - x1) / page_width,
        "height": (y2 - y1) / page_height,
    }
```

For a quadrilateral or polygon, first calculate its smallest axis-aligned
enclosing rectangle:

```python
def polygon_to_rect(points) -> list[float]:
    if not points:
        raise ValueError("source polygon is empty")
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return [min(xs), min(ys), max(xs), max(ys)]
```

For table rows made from several detected cells, use the union of the row's
cells:

```python
def union_rects(rects) -> list[float]:
    if not rects:
        raise ValueError("table row has no source rectangles")
    return [
        min(float(rect[0]) for rect in rects),
        min(float(rect[1]) for rect in rects),
        max(float(rect[2]) for rect in rects),
        max(float(rect[3]) for rect in rects),
    ]
```

Use the exact rendered image dimensions that produced the OCR coordinates. Do
not normalize using PDF points when the coordinates came from a raster image.

If the current vLLM response contains only Markdown/text and no coordinates,
it cannot satisfy this contract by itself. Retain geometry from the layout or
OCR stage, then join the parsed financial row back to its detected page row.
PP-Structure-style table-cell coordinates are preferable; otherwise use the
layout element or recognized-line rectangle that actually contains the row.

## 4. Convert each legacy row

The server accepts extra row fields, but every row must contain the following
core evidence:

```python
def build_result_row(
    legacy_row: dict,
    *,
    page_number: int,
    source_rect,
    page_width: int,
    page_height: int,
) -> dict:
    code = legacy_row.get("code")
    row_id = legacy_row.get("id")
    metric = legacy_row.get("metric") or legacy_row.get("label")

    if not code and not row_id:
        raise ValueError("row requires TT200 code or stable id")
    if not metric:
        raise ValueError("row requires metric or label")

    confidence = int(round(float(legacy_row.get("confidence", 0))))
    confidence = max(0, min(100, confidence))

    return {
        "code": str(code) if code is not None else None,
        "id": str(row_id) if row_id is not None else None,
        "section": legacy_row.get("section"),
        "metric": str(metric),
        "curr": str(legacy_row.get("curr", "")),
        "prev": (
            None
            if legacy_row.get("prev") is None
            else str(legacy_row["prev"])
        ),
        "page": int(page_number),
        "confidence": confidence,
        "bbox": normalize_rect(
            source_rect,
            page_width=page_width,
            page_height=page_height,
        ),
        "rawText": legacy_row.get("rawText") or legacy_row.get("raw_text"),
    }
```

Prefer a real TT200 `code`. The current server permits `id` as a fallback, but
rows without either `code` or `id` are rejected. Remove `None` optional fields
before sending if desired; do not remove required fields.

## 5. Validate locally before upload

Run validation after OCR and before the `progress: 90` and `result` frames.
This prevents a long invalid payload from crossing the network:

```python
def validate_result_rows(rows: list[dict]) -> None:
    if not isinstance(rows, list) or not rows:
        raise ValueError("OCR result must contain at least one row")

    for index, row in enumerate(rows):
        prefix = f"rows[{index}]"
        if not row.get("code") and not row.get("id"):
            raise ValueError(f"{prefix} requires code or id")
        if not row.get("metric") and not row.get("label"):
            raise ValueError(f"{prefix} requires metric or label")
        if not isinstance(row.get("curr"), str):
            raise ValueError(f"{prefix}.curr must be a string")
        if not isinstance(row.get("page"), int) or row["page"] < 1:
            raise ValueError(f"{prefix}.page must be a positive integer")
        if not isinstance(row.get("confidence"), int):
            raise ValueError(f"{prefix}.confidence must be an integer")
        if not 0 <= row["confidence"] <= 100:
            raise ValueError(f"{prefix}.confidence must be between 0 and 100")

        bbox = row.get("bbox")
        if not isinstance(bbox, dict):
            raise ValueError(f"{prefix}.bbox is required")
        x = float(bbox["x"])
        y = float(bbox["y"])
        width = float(bbox["width"])
        height = float(bbox["height"])
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise ValueError(f"{prefix}.bbox is not a positive rectangle")
        if x + width > 1.000001 or y + height > 1.000001:
            raise ValueError(f"{prefix}.bbox extends beyond the page")
```

## 6. Upgrade the result envelope

Replace the legacy result:

```python
await ws.send(json.dumps({
    "type": "result",
    "jobId": job_id,
    "rows": rows,
}))
```

with:

```python
validate_result_rows(rows)

await ws.send(json.dumps({
    "type": "result",
    "jobId": job_id,
    "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
    "rows": rows,
}, ensure_ascii=False))
```

The result must stay below 5 MiB and contain at most 5,000 rows.

## 7. Wait for server acknowledgement

Sending a result does not mean the job succeeded. Wait up to 30 seconds for
the server to validate and persist it:

```python
raw_ack = await asyncio.wait_for(ws.recv(), timeout=30)
ack = json.loads(raw_ack)

if ack.get("jobId") != job_id:
    raise RuntimeError(f"Unexpected acknowledgement: {ack}")

if ack.get("type") == "result_rejected":
    print(
        f"Job {job_id} rejected: "
        f"[{ack.get('errorCode', 'unknown')}] {ack.get('error', 'unknown error')}"
    )
    # Do not send another error frame. The coordinator already recorded it.
    return

if ack.get("type") != "result_ack":
    raise RuntimeError(f"Coordinator did not accept result: {ack}")

print(
    f"Job {job_id} accepted: {ack.get('rowCount')} rows; "
    f"review={ack.get('reviewId')}"
)
```

Only `result_ack` means the worker may print `done` and accept another job.

## 8. Send structured failures

Use a non-retryable error for malformed OCR output:

```python
await ws.send(json.dumps({
    "type": "error",
    "jobId": job_id,
    "error": str(exc),
    "errorCode": "invalid_result",
    "retryable": False,
}))
```

Use `retryable: true` only when the same document can reasonably succeed
unchanged, for example a temporary local model-server outage:

```python
await ws.send(json.dumps({
    "type": "error",
    "jobId": job_id,
    "error": str(exc),
    "errorCode": "model_server_unavailable",
    "retryable": True,
}))
```

## 9. Expected complete result

```json
{
  "type": "result",
  "jobId": "job_123",
  "schemaVersion": 1,
  "rows": [
    {
      "code": "270",
      "section": "balance",
      "metric": "TỔNG CỘNG TÀI SẢN",
      "curr": "52800000",
      "prev": "51000000",
      "page": 3,
      "confidence": 82,
      "bbox": {
        "x": 0.08,
        "y": 0.42,
        "width": 0.84,
        "height": 0.035
      },
      "rawText": "270 TỔNG CỘNG TÀI SẢN 52.800.000 51.000.000"
    }
  ]
}
```

## 10. Safe rollout on the WSL worker

1. Stop the worker process, but leave the local OCR/model server running.
2. Back up the real worker source file.
3. Merge the constants, hello frame, bbox preservation, row builder, local
   validation, result envelope, acknowledgement handling, and structured
   errors from this runbook.
4. Do not replace the custom `run_ocr()` with the repository stub.
5. Run a syntax check:

   ```bash
   python -m py_compile path/to/ocr_worker.py
   ```

6. Run local adapter tests with at least:
   - one rectangle;
   - one polygon or multi-cell row;
   - a missing bbox that must fail locally;
   - a bbox beyond the page that must fail locally;
   - Unicode Vietnamese labels;
   - 540 rows, matching the recent document size.
7. Start the worker with the current coordinator URL and pairing code.
8. Confirm the server sends `welcome`, not `deny`.
9. Dispatch a small test PDF first.
10. Confirm the backend terminal prints the full payload between
    `OCR WORKER MESSAGE BEGIN/END`.
11. Confirm the worker receives `result_ack` and the Inbox becomes
    `ready_for_review`.
12. Open several rows in the review UI and confirm each highlight surrounds
    the correct source line before retrying the full MBB document.

## 11. Acceptance checklist

- [ ] `hello.protocolVersion == 1`
- [ ] `hello.resultSchemaVersions == [1]`
- [ ] `hello.capabilities` contains `bbox`
- [ ] result contains `schemaVersion == 1`
- [ ] every row has `code` or `id`
- [ ] every row has `metric` or `label`
- [ ] `curr` is a string
- [ ] `page` is one-based and within the PDF page count
- [ ] `confidence` is an integer from 0 through 100
- [ ] every bbox is real, normalized, positive, and inside the page
- [ ] worker waits for matching `result_ack`
- [ ] worker does not send a second error after `result_rejected`
- [ ] server review highlight matches the original PDF source
