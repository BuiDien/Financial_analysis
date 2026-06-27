# Sync Worker Guide — Connect & Communicate over the WebSocket

How a **worker laptop** connects to the **coordinator** (the Mac/Core) and exchanges OCR jobs over the
Sync WebSocket. This documents the **actual wire protocol** implemented in
`backend/app/routes/sync.py` and driven by the `page-sync` UI.

> The Mac is the coordinator (it listens); the worker dials in. See the architecture rationale in
> `OCR_PROTOCOL.md`. **Note:** the current implementation uses `pdf_b64` (base64 PDF in JSON) and result
> rows keyed by `id`. The target protocol in `OCR_PROTOCOL.md` upgrades these to binary chunks + Mã số
> `code` — not yet implemented; build to what's below today.

---

## 1. Connect

The coordinator listens at:

```
ws://<mac-host>:8000/ws/ocr
```

- `<mac-host>` — the Mac's LAN hostname or IP (e.g. `mac.local` or `192.168.1.20`). The Sync page shows the
  exact URL ("This machine · Coordinator").
- Both machines must be on the same network.
- Get the **pairing code** from the Sync page (e.g. `ABC-23`). It rotates when you click *Regenerate*.

Open a standard WebSocket connection to that URL. No headers/auth on the socket itself — authentication is
the pairing-code handshake (step 2).

---

## 2. Handshake (pair)

Immediately after the socket opens, the worker sends a `hello` frame with the pairing code:

```jsonc
// worker → server
{ "type": "hello", "code": "ABC-23", "name": "Dien's Laptop" }
```

The coordinator replies:

```jsonc
// server → worker  (success)
{ "type": "welcome", "workerId": "a1b2c3d4" }

// server → worker  (rejected — wrong/expired code; socket then closes)
{ "type": "deny", "reason": "bad pairing code" }
```

On `welcome`, the worker is registered as **idle** and appears under *Connected Workers* on the page.
On `deny`, the server closes the socket — re-read the current code and reconnect.

---

## 3. Receive a job

When you dispatch a filing from the UI, the coordinator picks an idle worker and pushes a `job` frame:

```jsonc
// server → worker
{
  "type": "job",
  "jobId": "job_9f2a1",
  "filingId": 12,
  "filename": "VNM-Q4-2024.pdf",
  "pdf_b64": "<base64-encoded PDF bytes>"
}
```

Decode `pdf_b64` (base64 → bytes) to recover the PDF, then run OCR on it locally (PP-DocLayout triage →
PaddleOCR-VL extract, or any OCR for now).

---

## 4. Report progress (optional but recommended)

While parsing, send `progress` frames so the pipeline bar moves on the page:

```jsonc
// worker → server
{ "type": "progress", "jobId": "job_9f2a1", "pct": 60 }
```

`pct` is 0–100. Send as many as you like; the page shows the latest.

---

## 5. Return the result

When done, send one `result` frame with the extracted rows:

```jsonc
// worker → server
{
  "type": "result",
  "jobId": "job_9f2a1",
  "rows": [
    { "id": "rev", "section": "income",   "metric": "Doanh thu thuần", "curr": "60479000", "prev": "59956000", "page": 5, "confidence": 98 },
    { "id": "ta",  "section": "balance",  "metric": "TỔNG CỘNG TÀI SẢN", "curr": "52000000", "prev": "51000000", "page": 3, "confidence": 96 }
  ]
}
```

Row fields:
- `id` — a stable key for the metric (tracker id today; **target: Mã số `code`** per `OCR_PROTOCOL.md`).
- `section` — `income | balance | cashflow`.
- `metric` — the line label (Vietnamese).
- `curr` / `prev` — string amounts, raw digits, may be `-`-prefixed. No thousands separators.
- `page` — source page number.
- `confidence` — 0–100 per value.

After the result, the coordinator marks the worker **idle** again and bumps its parsed count. The worker
stays connected and waits for the next `job`. Keep the socket open and keep reading frames in a loop.

---

## 6. Lifecycle summary

```
worker                              coordinator (Mac)
  | --- ws connect ----------------> |
  | --- hello{code,name} ----------> |
  | <-- welcome{workerId} ---------- |   (or deny → close)
  |                                  |
  | <-- job{jobId,pdf_b64} --------- |   (on user dispatch)
  | --- progress{jobId,pct} -------> |   (repeat)
  | --- result{jobId,rows} --------> |
  |        ...idle, wait...          |
  | <-- job ... (next)               |
```

Disconnect: just close the socket. The coordinator drops the worker from its list.

---

## 7. Reference worker (Python)

A minimal, runnable worker. Requires `pip install websockets`. Swap `run_ocr()` for the real OCR engine;
here it returns a canned VNM result so you can test the full loop today.

```python
# worker.py  —  run: python worker.py --connect ws://mac.local:8000/ws/ocr --code ABC-23
import argparse, asyncio, base64, json
import websockets

def run_ocr(pdf_bytes: bytes) -> list[dict]:
    """Replace with PP-DocLayout + PaddleOCR-VL. Returns result rows."""
    # ...real OCR here...  (pdf_bytes is the decoded PDF)
    return [
        {"id": "rev", "section": "income",  "metric": "Doanh thu thuần",
         "curr": "60479000", "prev": "59956000", "page": 5, "confidence": 98},
        {"id": "ta",  "section": "balance", "metric": "TỔNG CỘNG TÀI SẢN",
         "curr": "52000000", "prev": "51000000", "page": 3, "confidence": 96},
    ]

async def main(url: str, code: str, name: str):
    async with websockets.connect(url, max_size=64 * 1024 * 1024) as ws:   # allow big PDFs
        await ws.send(json.dumps({"type": "hello", "code": code, "name": name}))
        hello_ack = json.loads(await ws.recv())
        if hello_ack.get("type") != "welcome":
            print("pairing rejected:", hello_ack.get("reason")); return
        print("paired as", hello_ack.get("workerId"))

        async for raw in ws:                       # main loop: wait for jobs
            msg = json.loads(raw)
            if msg.get("type") != "job":
                continue
            job_id = msg["jobId"]
            pdf = base64.b64decode(msg["pdf_b64"])
            print(f"job {job_id}: {msg.get('filename')} ({len(pdf)} bytes)")

            await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 30}))
            rows = run_ocr(pdf)                     # ← the heavy work
            await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 90}))
            await ws.send(json.dumps({"type": "result", "jobId": job_id, "rows": rows}))
            print(f"job {job_id}: returned {len(rows)} rows")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--connect", required=True, help="ws://<mac-host>:8000/ws/ocr")
    ap.add_argument("--code", required=True, help="pairing code from the Sync page")
    ap.add_argument("--name", default="Worker Laptop")
    a = ap.parse_args()
    asyncio.run(main(a.connect, a.code, a.name))
```

---

## 8. Test it locally (one machine)

You can prove the loop without a second laptop:

1. Start the backend (coordinator): `cd backend && uvicorn app.main:app --port 8000`.
2. Point the website at it: in the browser console
   `localStorage.setItem('helix_api_url','http://localhost:8000'); location.reload();`.
3. Open the **Sync** page → *Start listening* → copy the pairing code.
4. Run the worker against localhost:
   `python worker.py --connect ws://localhost:8000/ws/ocr --code <CODE>`.
5. It appears under *Connected Workers*. Upload a filing (Statements → Filings), then *Send to worker*
   on the Sync page → watch progress → *Apply data* merges the returned rows into that filing's tracker.

---

## 9. Notes & gotchas
- **One result per job.** Send exactly one `result`; the coordinator marks the job done on first receipt.
- **Stay connected.** Don't close after a job — loop and wait for the next `job` frame.
- **Big PDFs.** Set a generous `max_size` on the socket (the example uses 64 MiB); base64 inflates size ~33%.
- **Reconnect on `deny`.** The code rotates; re-fetch it from the page and reconnect.
- **Heartbeats.** `websockets` handles ping/pong automatically; if you use another client, keep the socket alive.
- **Future:** when `OCR_PROTOCOL.md`'s binary-chunk + Mã số `code` upgrade lands, the `job` frame becomes a
  text frame + binary chunks, and rows carry `code`. Build modularly so the swap is small.
