"""OCR worker — laptop side of the distributed OCR pipeline.

Dials the Mac coordinator (backend/app/routes/sync.py), pairs with a code,
receives PDF filings, and is meant to return structured statement rows via a
local PaddleOCR-VL server (started separately by setup_laptop.sh / vLLM).

Usage:
    pip install vllm websockets pypdf   # done by setup_laptop.sh
    python ocr_worker.py --connect ws://<mac-host>:8000/ws/ocr --code ABC-DEF \\
        --vllm-url http://localhost:8001 --name "Dien's Laptop"

Pairing is two-step: this worker connects with just its name, the
coordinator hands back a pairId and shows the code on the Sync page, then
this worker submits --code back. On a wrong code the coordinator sends a
`deny` with attemptsLeft and lets the worker retry the `pair` message (up
to MAX_PAIR_ATTEMPTS server-side) rather than reconnecting from scratch.

The coordinator sends a JSON job header, binary PDF chunks, then a JSON
``job_end`` frame. The worker verifies the announced byte count before OCR.
"""

import argparse
import asyncio
import json
from contextlib import suppress

import websockets


OCR_PROTOCOL_VERSION = 1
OCR_RESULT_SCHEMA_VERSION = 1
OCR_CAPABILITIES = ["bbox"]


class ResultRejected(RuntimeError):
    """The coordinator already recorded and acknowledged a terminal rejection."""


class InvalidWorkerResult(RuntimeError):
    """The local OCR adapter produced a deterministic contract violation."""


def validate_result_rows(rows: list[dict]) -> None:
    """Fail locally before uploading rows the coordinator cannot review."""
    if not isinstance(rows, list) or not rows:
        raise InvalidWorkerResult("OCR result must contain at least one row")
    for index, row in enumerate(rows):
        prefix = f"rows[{index}]"
        if not row.get("code") and not row.get("id"):
            raise InvalidWorkerResult(f"{prefix} requires code or id")
        if not row.get("label") and not row.get("metric"):
            raise InvalidWorkerResult(f"{prefix} requires label or metric")
        if not isinstance(row.get("curr"), str):
            raise InvalidWorkerResult(f"{prefix}.curr must be a string")
        if not isinstance(row.get("page"), int) or row["page"] < 1:
            raise InvalidWorkerResult(f"{prefix}.page must be a positive integer")
        confidence = row.get("confidence")
        if not isinstance(confidence, int) or not 0 <= confidence <= 100:
            raise InvalidWorkerResult(f"{prefix}.confidence must be an integer 0-100")
        bbox = row.get("bbox")
        if not isinstance(bbox, dict):
            raise InvalidWorkerResult(f"{prefix}.bbox is required")
        try:
            x, y = float(bbox["x"]), float(bbox["y"])
            width, height = float(bbox["width"]), float(bbox["height"])
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidWorkerResult(
                f"{prefix}.bbox requires numeric x, y, width, and height"
            ) from exc
        if (
            x < 0
            or y < 0
            or width <= 0
            or height <= 0
            or x + width > 1.000001
            or y + height > 1.000001
        ):
            raise InvalidWorkerResult(
                f"{prefix}.bbox must be a positive normalized rectangle inside the page"
            )


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


def run_ocr(pdf_bytes: bytes, vllm_url: str) -> list[dict]:
    """Extract statement rows from a PDF via the local PaddleOCR-VL server.

    STUB: table/row structuring (mapping PaddleOCR-VL's raw output to TT200
    Ma so `code` + curr/prev/page/confidence) is not implemented. Wiring this
    up is Phase-2 real-GPU-OCR work in docs/PLAN.md - this
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
        {
            "code": "270",
            "section": "balance",
            "metric": "STUB — wire up PaddleOCR-VL parsing",
            "curr": "0",
            "prev": "0",
            "page": 1,
            "confidence": 0,
            # Normalized displayed-page coordinates. Real extraction must return
            # the actual source row location; this full-page placeholder keeps the
            # review transport exercisable without pretending it is real OCR.
            "bbox": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
            "rawText": "STUB — no OCR text extracted",
        },
    ]


async def process_job(ws, job: dict, vllm_url: str) -> str:
    """Run one job while remaining responsive to hold/stop commands."""
    job_id = job["jobId"]
    await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 10}))
    pdf_bytes = await receive_pdf(ws, job)
    ocr_task = asyncio.create_task(asyncio.to_thread(run_ocr, pdf_bytes, vllm_url))
    control_task = asyncio.create_task(ws.recv())
    try:
        done, _ = await asyncio.wait(
            {ocr_task, control_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if control_task in done:
            raw = control_task.result()
            message = json.loads(raw) if isinstance(raw, str) else {}
            if (
                message.get("type") == "job_control"
                and message.get("jobId") == job_id
                and message.get("action") in {"hold", "stop"}
            ):
                ocr_task.cancel()
                action = message["action"]
                await ws.send(
                    json.dumps(
                        {
                            "type": "control_ack",
                            "jobId": job_id,
                            "action": action,
                        }
                    )
                )
                return action
            raise RuntimeError(f"Unexpected frame while processing job {job_id}")

        control_task.cancel()
        with suppress(asyncio.CancelledError):
            await control_task
        rows = ocr_task.result()
        validate_result_rows(rows)
        await ws.send(json.dumps({"type": "progress", "jobId": job_id, "pct": 90}))
        await ws.send(
            json.dumps(
                {
                    "type": "result",
                    "jobId": job_id,
                    "schemaVersion": OCR_RESULT_SCHEMA_VERSION,
                    "rows": rows,
                }
            )
        )
        raw_ack = await asyncio.wait_for(ws.recv(), timeout=30)
        ack = json.loads(raw_ack) if isinstance(raw_ack, str) else {}
        if ack.get("jobId") != job_id:
            raise RuntimeError(f"Unexpected result acknowledgment for {job_id}: {ack}")
        if ack.get("type") == "result_rejected":
            raise ResultRejected(
                f"Coordinator rejected result: {ack.get('error', 'unknown error')}"
            )
        if ack.get("type") != "result_ack":
            raise RuntimeError(
                f"Coordinator did not acknowledge result {job_id}: {ack}"
            )
        detail = f"done — {ack.get('rowCount', len(rows))} rows accepted"
        if ack.get("reviewId") is not None:
            detail += f", review {ack['reviewId']} ready"
        return detail
    finally:
        if not control_task.done():
            control_task.cancel()


async def run_worker(connect_url: str, code: str, name: str, vllm_url: str):
    print(f"Connecting to {connect_url} ...")
    async with websockets.connect(connect_url, max_size=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "name": name,
                    "protocolVersion": OCR_PROTOCOL_VERSION,
                    "resultSchemaVersions": [OCR_RESULT_SCHEMA_VERSION],
                    "capabilities": OCR_CAPABILITIES,
                }
            )
        )
        pair_required = json.loads(await ws.recv())
        if pair_required.get("type") != "pair_required":
            print(f"Unexpected response to hello: {pair_required}")
            return
        pair_id = pair_required["pairId"]

        await ws.send(json.dumps({"type": "pair", "pairId": pair_id, "code": code}))
        welcome = json.loads(await ws.recv())
        while welcome.get("type") == "deny":
            attempts_left = welcome.get("attemptsLeft", 0)
            if attempts_left <= 0:
                print(f"Pairing failed: {welcome}")
                return
            code = input(
                f"Wrong code ({attempts_left} attempts left). Re-enter code: "
            ).strip()
            await ws.send(json.dumps({"type": "pair", "pairId": pair_id, "code": code}))
            welcome = json.loads(await ws.recv())
        if welcome.get("type") != "welcome":
            print(f"Pairing failed: {welcome}")
            return
        if (
            welcome.get("protocolVersion") != OCR_PROTOCOL_VERSION
            or welcome.get("resultSchemaVersion") != OCR_RESULT_SCHEMA_VERSION
        ):
            print(f"Coordinator contract is incompatible: {welcome}")
            return
        print(f"Paired. workerId={welcome.get('workerId')}. Waiting for jobs...")

        async for raw in ws:
            if isinstance(raw, bytes):
                print("Ignoring unexpected binary frame outside a job")
                continue
            msg = json.loads(raw)
            if msg.get("type") != "job":
                continue
            job_id = msg["jobId"]
            filename = msg.get("filename", "?")
            print(f"Job {job_id}: {filename}")

            try:
                outcome = await process_job(ws, msg, vllm_url)
            except ResultRejected as e:
                print(f"Job {job_id}: failed — {e}")
                continue
            except Exception as e:
                retryable = not isinstance(e, InvalidWorkerResult)
                await ws.send(
                    json.dumps(
                        {
                            "type": "error",
                            "jobId": job_id,
                            "error": str(e),
                            "errorCode": (
                                "invalid_result"
                                if not retryable
                                else "worker_job_failed"
                            ),
                            "retryable": retryable,
                        }
                    )
                )
                continue
            print(f"Job {job_id}: {outcome}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--connect", required=True, help="ws://<mac-host>:8000/ws/ocr")
    p.add_argument(
        "--code", required=True, help="pairing code shown on the Mac's Sync page"
    )
    p.add_argument("--name", default="OCR Worker")
    p.add_argument("--vllm-url", default="http://localhost:8001")
    args = p.parse_args()
    try:
        asyncio.run(run_worker(args.connect, args.code, args.name, args.vllm_url))
    except KeyboardInterrupt:
        print("\nWorker stopped.")
    except Exception as e:
        raise SystemExit(f"Worker connection failed: {e}") from e


if __name__ == "__main__":
    main()
