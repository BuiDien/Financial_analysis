# Sync Worker Guide — Page-Markdown Server Contract

Status: server ready; worker implementation is the next deployment step.

This is the concise integration guide for connecting a worker to the server implemented in
`backend/app/routes/sync.py`. See `OCR_PROTOCOL.md` for validation rules and server review APIs.

## Connection

Connect to:

```text
ws://<server-host>:8000/ws/ocr
```

The server’s Sync page shows the host and rotating pairing code.

## Handshake

Send:

```json
{
  "type": "hello",
  "name": "Dien WSL (vLLM)",
  "protocolVersion": 1,
  "resultFormats": ["page_markdown_v2"],
  "capabilities": ["page_ack"]
}
```

Receive `pair_required`, send the pairing code with its `pairId`, then require this selection in the
welcome message:

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

Do not process a job unless page Markdown was selected.

## Receive the PDF

The server sends:

1. A JSON `job` header with byte count and `resultFormat: "page_markdown_v2"`.
2. Raw PDF binary frames.
3. A JSON `job_end` frame.

Verify the byte count before OCR.

## Send page results

Finish OCR for the whole PDF, validate local page numbering, and keep the pages buffered. Then send
one page and wait for its matching acknowledgement:

```json
{
  "type": "page_result",
  "jobId": "job_2831b0eaed",
  "schemaVersion": 2,
  "page": 1,
  "pageCount": 57,
  "markdown": "# Page 1\n\nOCR content..."
}
```

Expected response:

```json
{
  "type": "page_ack",
  "jobId": "job_2831b0eaed",
  "page": 1,
  "status": "stored",
  "receivedPages": 1,
  "pageCount": 57
}
```

`already_stored` is also success. Match acknowledgements by both job ID and page number.

## Finish

After every page is acknowledged:

```json
{"type":"result_end","jobId":"job_2831b0eaed","schemaVersion":2,"pageCount":57}
```

If the server returns `result_incomplete`, resend the listed pages and send `result_end` again. Keep
all page data until the server returns:

```json
{
  "type": "result_ack",
  "jobId": "job_2831b0eaed",
  "status": "ready_for_review",
  "pageCount": 57,
  "reviewId": 19,
  "inboxItemId": 42
}
```

## Retry rules

- Wait for `page_ack` after each page.
- On acknowledgement timeout, resend the identical page up to three times with backoff.
- Treat `already_stored` as success.
- Stop on a non-retryable `page_rejected` or `result_rejected`.
- On `result_incomplete`, resend only `missingPages`.
- Do not fabricate `code`, `id`, or `bbox`; the page format does not use them.
- Use one WebSocket receive loop so acknowledgements and `job_control` messages cannot race.

## Diagnostic mode

Serialize JSON with `ensure_ascii=False`. For each page, log job ID, page/pageCount, UTF-8 byte size,
SHA-256, attempt number, acknowledgement status, and round-trip time. An opt-in debug mode may print
the complete outbound JSON for comparison with the server’s `OCR WORKER MESSAGE BEGIN/END` output.
Never print pairing credentials.

## Legacy workers

The server still accepts the existing schema-1 hello and structured row result while migration is in
progress. The new worker should advertise only `page_markdown_v2` so it cannot accidentally fall back
to the row validator.
