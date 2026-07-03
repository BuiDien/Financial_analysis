# Sync Worker Guide — Connect & Communicate over the WebSocket

How a **worker laptop** connects to the **coordinator** (the Mac/Core) and exchanges OCR jobs over the
Sync WebSocket. This documents the **actual wire protocol** implemented in
`backend/app/routes/sync.py` and driven by the `page-sync` UI.

> The Mac is the coordinator (it listens); the worker dials in. See the architecture rationale in
> `OCR_PROTOCOL.md`. As of 2026-07-03 the coordinator streams the PDF as **binary chunks**
> (`job` → binary frames → `job_end`) — the earlier `pdf_b64` field is gone. Result rows still use
> the tracker `id` key today; the target is Mã số `code` per `OCR_PROTOCOL.md`.

---

## 1. Connect

The coordinator listens at:

```
ws://<mac-host>:8000/ws/ocr
```

- `<mac-host>` — the Mac's LAN hostname or IP (e.g. `mac.local` or `192.168.1.20`). The Sync page shows the
  exact URL ("This machine · Coordinator").
- Both machines must be on the same network.
- The **pairing code** is on the Sync page (e.g. `ABC-23`). It rotates when you click *Regenerate*.

Open a standard WebSocket connection to that URL. No headers/auth on the socket itself — authentication is
the pairing-code handshake (step 2).

---

## 2. Handshake (two-step pairing)

The worker connects with just its **name** — no code needed up front. The coordinator hands back a
`pairId` (and shows the code on the Sync page); the worker then submits the code the human read off
the screen:

```jsonc
// worker → server
{ "type": "hello", "name": "Dien's Laptop" }

// server → worker
{ "type": "pair_required", "pairId": "a1b2c3d4" }

// worker → server
{ "type": "pair", "pairId": "a1b2c3d4", "code": "ABC-23" }

// server → worker  (success)
{ "type": "welcome", "workerId": "9f2a" }

// server → worker  (wrong code — retry the "pair" frame, don't reconnect)
{ "type": "deny", "reason": "bad pairing code", "attemptsLeft": 4 }
```

On a `deny` with `attemptsLeft > 0`, re-send the `pair` frame with a corrected code on the same
socket. Exhausting attempts (`attemptsLeft: 0`) closes the socket. On `welcome`, the worker is
registered as **idle** and appears under *Connected Workers* on the page.

---

## 3. Receive a job (text frame + binary chunks)

When you dispatch a filing from the UI, the coordinator picks an idle worker, announces the job in a
**text frame**, streams the PDF as **binary frames** (512 KiB chunks), then closes the transfer with
`job_end`:

```jsonc
// server → worker  (text)
{ "type": "job", "jobId": "job_9f2a1", "filingId": 12,
  "filename": "VNM-Q4-2024.pdf", "bytes": 2118144 }

// server → worker  (binary frame) ×N — raw PDF bytes, chunked

// server → worker  (text)
{ "type": "job_end", "jobId": "job_9f2a1" }
```

Worker rules:
- **Reassemble** binary frames in arrival order into one buffer (WebSocket guarantees per-connection
  ordering; the coordinator sends one job at a time per worker, so chunks never interleave).
- On `job_end`, **verify** the buffer length equals the announced `bytes`. Mismatch → send an
  `error` frame (step 6) and discard the buffer.
- Then run OCR locally (PP-DocLayout triage → PaddleOCR-VL extract, or any OCR for now).

No base64 anywhere — the bytes on the wire are the PDF.

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

## 6. Report failure

If OCR fails (or the byte count check fails), send an `error` frame instead of a `result`:

```jsonc
// worker → server
{ "type": "error", "jobId": "job_9f2a1", "error": "no tables found" }
```

The coordinator marks the job **failed** (with the message) and returns the worker to **idle** —
the worker stays connected and can take the next job.

---

## 7. Lifecycle summary

```
worker                              coordinator (Mac)
  | --- ws connect ----------------> |
  | --- hello{name} ---------------> |
  | <-- pair_required{pairId} ------ |
  | --- pair{pairId,code} ---------> |
  | <-- welcome{workerId} ---------- |   (or deny{attemptsLeft} → retry pair)
  |                                  |
  | <-- job{jobId,bytes} ----------- |   (on user dispatch)
  | <-- <binary chunk> ×N ---------- |
  | <-- job_end{jobId} ------------- |
  | --- progress{jobId,pct} -------> |   (repeat)
  | --- result{jobId,rows} --------> |   (or error{jobId,error})
  |        ...idle, wait...          |
  | <-- job ... (next)               |
```

Disconnect: just close the socket. The coordinator drops the worker from its list.

---

## 8. Reference worker (Python)

A minimal, runnable worker. Requires `pip install websockets`. Swap `run_ocr()` for the real OCR engine;
here it returns a canned VNM result so you can test the full loop today.

```python
# worker.py  —  run: python worker.py --connect ws://mac.local:8000/ws/ocr --code ABC-23
import argparse, asyncio, json
import websockets

def run_ocr(pdf_bytes: bytes) -> list[dict]:
    """Replace with PP-DocLayout + PaddleOCR-VL. Returns result rows."""
    # ...real OCR here...  (pdf_bytes is the raw PDF)
    return [
        {"id": "rev", "section": "income",  "metric": "Doanh thu thuần",
         "curr": "60479000", "prev": "59956000", "page": 5, "confidence": 98},
        {"id": "ta",  "section": "balance", "metric": "TỔNG CỘNG TÀI SẢN",
         "curr": "52000000", "prev": "51000000", "page": 3, "confidence": 96},
    ]

async def main(url: str, code: str, name: str):
    async with websockets.connect(url, max_size=None) as ws:
        # two-step pairing
        await ws.send(json.dumps({"type": "hello", "name": name}))
        pair_required = json.loads(await ws.recv())
        assert pair_required["type"] == "pair_required", pair_required
        await ws.send(json.dumps({"type": "pair", "pairId": pair_required["pairId"], "code": code}))
        welcome = json.loads(await ws.recv())
        if welcome.get("type") != "welcome":
            print("pairing rejected:", welcome); return
        print("paired as", welcome["workerId"])

        job, buf = None, bytearray()
        async for raw in ws:                        # main loop: wait for jobs
            if isinstance(raw, bytes):              # binary frame = PDF chunk
                buf.extend(raw)
                continue
            msg = json.loads(raw)
            if msg.get("type") == "job":
                job, buf = msg, bytearray()
                print(f"job {msg['jobId']}: {msg.get('filename')} ({msg['bytes']} bytes incoming)")
            elif msg.get("type") == "job_end" and job:
                job_id = job["jobId"]
                if len(buf) != job["bytes"]:
                    await ws.send(json.dumps({"type": "error", "jobId": job_id,
                        "error": f"size mismatch: got {len(buf)}, expected {job['bytes']}"}))
                    job = None
                    continue
                pdf = bytes(buf)
                await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 30}))
                try:
                    rows = run_ocr(pdf)             # ← the heavy work
                except Exception as e:
                    await ws.send(json.dumps({"type": "error", "jobId": job_id, "error": str(e)}))
                    job = None
                    continue
                await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 90}))
                await ws.send(json.dumps({"type": "result", "jobId": job_id, "rows": rows}))
                print(f"job {job_id}: returned {len(rows)} rows")
                job = None

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--connect", required=True, help="ws://<mac-host>:8000/ws/ocr")
    ap.add_argument("--code", required=True, help="pairing code from the Sync page")
    ap.add_argument("--name", default="Worker Laptop")
    a = ap.parse_args()
    asyncio.run(main(a.connect, a.code, a.name))
```

---

## 9. Test it locally (one machine)

You can prove the loop without a second laptop:

1. Start the backend (coordinator): `cd backend && uvicorn app.main:app --port 8000`.
2. Point the website at it: in the browser console
   `localStorage.setItem('helix_api_url','http://localhost:8000'); location.reload();`.
3. Open the **Sync** page → *Start listening* → copy the pairing code.
4. Run the worker against localhost:
   `python worker.py --connect ws://localhost:8000/ws/ocr --code <CODE>`.
5. It appears under *Connected Workers*. Upload a filing (Statements → Filings), then *Send to worker*.
