"""OCR worker — laptop side of the distributed OCR pipeline.

Dials the Mac coordinator (backend/app/routes/sync.py), pairs with a code,
receives PDF filings, and is meant to return structured statement rows via a
local PaddleOCR-VL server (started separately by setup_laptop.sh / vLLM).

Usage:
    pip install vllm websockets pypdf   # done by setup_laptop.sh
    python ocr_worker.py --connect ws://<mac-host>:8000/ws/ocr --code ABC-DEF \\
        --vllm-url http://localhost:8001 --name "Dien's Laptop"

Wire protocol matches the CURRENT backend (backend/app/routes/sync.py), not
the newer target design in docs/design/OCR_PROTOCOL.md — that doc calls for
binary-chunked PDF transfer and a {"type":"paired"} response; the running
backend still uses base64-in-JSON and {"type":"welcome"}. Update this file
alongside sync.py if/when that gap is closed (tracked in docs/PLAN.md).
"""
import argparse
import asyncio
import base64
import json

import websockets


def run_ocr(pdf_bytes: bytes, vllm_url: str) -> list[dict]:
    """Extract statement rows from a PDF via the local PaddleOCR-VL server.

    STUB: table/row structuring (mapping PaddleOCR-VL's raw output to TT200
    Ma so `code` + curr/prev/page/confidence) is not implemented. Wiring this
    up is unscheduled real-GPU-OCR work (docs/PLAN.md Stage 8) — this
    function currently just proves the vLLM round trip and returns one
    placeholder row so the pipeline is exercisable end to end.
    """
    import urllib.request

    # PaddleOCR-VL is a document-parsing VLM: page images in, structured text
    # out. Converting `pdf_bytes` to page images (e.g. via pypdf + a renderer,
    # or PP-DocLayout's own page loader) is also not done here — see the TODO
    # above. This call shape (OpenAI-compatible /v1/chat/completions) is a
    # starting point; verify the exact prompt/response format against the
    # PaddleOCR-VL model card before trusting the output.
    req = urllib.request.Request(
        f"{vllm_url}/v1/models",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            json.loads(resp.read())
    except Exception as e:
        raise RuntimeError(f"vLLM server unreachable at {vllm_url}: {e}") from e

    return [
        {"code": "270", "section": "balance", "metric": "STUB — wire up PaddleOCR-VL parsing",
         "curr": "0", "prev": "0", "page": 1, "confidence": 0},
    ]


async def run_worker(connect_url: str, code: str, name: str, vllm_url: str):
    print(f"Connecting to {connect_url} ...")
    async with websockets.connect(connect_url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "hello", "code": code, "name": name}))
        welcome = json.loads(await ws.recv())
        if welcome.get("type") != "welcome":
            print(f"Pairing failed: {welcome}")
            return
        print(f"Paired. workerId={welcome.get('workerId')}. Waiting for jobs...")

        async for raw in ws:
            msg = json.loads(raw)
            if msg.get("type") != "job":
                continue
            job_id = msg["jobId"]
            filename = msg.get("filename", "?")
            print(f"Job {job_id}: {filename}")
            pdf_bytes = base64.b64decode(msg["pdf_b64"])

            await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 10}))
            try:
                rows = run_ocr(pdf_bytes, vllm_url)
            except Exception as e:
                await ws.send(json.dumps({"type": "error", "jobId": job_id, "error": str(e)}))
                continue
            await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 90}))
            await ws.send(json.dumps({"type": "result", "jobId": job_id, "rows": rows}))
            print(f"Job {job_id}: done ({len(rows)} rows)")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--connect", required=True, help="ws://<mac-host>:8000/ws/ocr")
    p.add_argument("--code", required=True, help="pairing code shown on the Mac's Sync page")
    p.add_argument("--name", default="OCR Worker")
    p.add_argument("--vllm-url", default="http://localhost:8001")
    args = p.parse_args()
    asyncio.run(run_worker(args.connect, args.code, args.name, args.vllm_url))


if __name__ == "__main__":
    main()
