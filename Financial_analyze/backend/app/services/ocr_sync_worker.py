"""One OCR worker WebSocket session: handshake/pairing, then the frame loop.

``serve(ws)`` is the whole ``/ws/ocr`` handler; each inbound frame type has a
``_handle_*`` coroutine. Durable state goes through ``ocr_sync_attempts`` in a
thread; in-memory state lives on ``ocr_sync_coordinator.coordinator``.
"""

import asyncio
import logging
import secrets

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..config import get_settings
from ..ocr_page_contract import OCRPageContractError
from . import ocr_sync_network as network
from .ocr_auto_label_review import run_auto_document_label_review
from .ocr_page_results import finalize_page_result, store_page_result
from .ocr_review import OCRResultValidationError, create_review_from_result
from .ocr_sync_attempts import (
    fail_attempt_by_id,
    load_attempt,
    resolve_control,
    run_db,
)
from .ocr_sync_coordinator import (
    coordinator,
    dispatch_next_queued,
    finish_job,
    free_worker,
    release_worker_jobs,
)
from .ocr_sync_protocol import (
    ACTIVE_JOB_STATUSES,
    CONTROL_PENDING_STATUSES,
    FINISHED_JOB_STATUSES,
    MAX_PAIR_ATTEMPTS,
    OCR_PAGE_RESULT_FORMAT,
    OCR_PAGE_SCHEMA_VERSION,
    OCR_PROTOCOL_VERSION,
    OCR_REQUIRED_CAPABILITIES,
    OCR_RESULT_SCHEMA_VERSION,
    PAGE_REQUIRED_CAPABILITIES,
    STRUCTURED_RESULT_FORMAT,
    SUPPORTED_RESULT_FORMATS,
    negotiate_result_format,
    print_worker_message,
)

logger = logging.getLogger(__name__)
settings = get_settings()


async def serve(ws: WebSocket) -> None:
    await ws.accept()
    worker_id = None
    peer = ws.client.host if ws.client else "?"
    logger.info("OCR worker socket accepted from %s", peer)
    try:
        # Two-step pairing: the worker connects with just a name (no code
        # needed up front), the coordinator hands back a pairId and shows
        # the code on the Sync page, then the worker submits the code the
        # human read off screen. Friendlier than requiring the code before
        # the worker even dials in.
        hello = await ws.receive_json()
        if hello.get("type") != "hello":
            logger.warning("OCR worker %s sent invalid first frame", peer)
            await ws.send_json({"type": "deny", "reason": "expected hello"})
            await ws.close()
            return
        if "code" in hello:
            logger.warning("OCR worker %s uses the obsolete one-step handshake", peer)
            await ws.send_json(
                {
                    "type": "deny",
                    "reason": "outdated worker; update scripts/ocr_worker.py for the two-step handshake",
                    "attemptsLeft": 0,
                }
            )
            await ws.close()
            return

        protocol_version = hello.get("protocolVersion")
        schema_versions = hello.get("resultSchemaVersions", [])
        capabilities = set(hello.get("capabilities", []))
        selected_result_format, required_capabilities = negotiate_result_format(hello)
        if protocol_version != OCR_PROTOCOL_VERSION or not selected_result_format:
            reason = (
                "incompatible worker: requires protocolVersion "
                f"{OCR_PROTOCOL_VERSION} and either "
                f"{OCR_PAGE_RESULT_FORMAT} with capabilities "
                f"{sorted(PAGE_REQUIRED_CAPABILITIES)}, or result schema "
                f"{OCR_RESULT_SCHEMA_VERSION} with capabilities "
                f"{sorted(OCR_REQUIRED_CAPABILITIES)}"
            )
            logger.warning("OCR worker %s rejected: %s", peer, reason)
            await ws.send_json(
                {
                    "type": "deny",
                    "reason": reason,
                    "attemptsLeft": 0,
                    "protocolVersion": OCR_PROTOCOL_VERSION,
                    "resultSchemaVersion": OCR_RESULT_SCHEMA_VERSION,
                    "requiredCapabilities": sorted(OCR_REQUIRED_CAPABILITIES),
                    "supportedResultFormats": sorted(SUPPORTED_RESULT_FORMATS),
                }
            )
            await ws.close()
            return

        worker_name = hello.get("name", "Worker")
        # Same-machine worker: the OS already proves it is local, so skip the
        # code and go straight to welcome. Remote workers still pair.
        # A browser page always sends an Origin header; the native worker
        # never does. Only an Origin-less loopback client skips the code, so
        # a page open on this Mac cannot register itself as a worker.
        local_peer = (
            network.is_loopback_peer(ws.client.host if ws.client else None)
            and not ws.headers.get("origin")
        )
        if local_peer:
            logger.info("OCR worker %s is local; skipping pairing code", peer)
        else:
            pair_id = secrets.token_hex(4)
            await ws.send_json({"type": "pair_required", "pairId": pair_id})
        for attempt in range(0 if local_peer else MAX_PAIR_ATTEMPTS):
            reply = await ws.receive_json()
            if (
                reply.get("type") == "pair"
                and reply.get("pairId") == pair_id
                and reply.get("code") == coordinator.pair_code
            ):
                break
            remaining = MAX_PAIR_ATTEMPTS - attempt - 1
            logger.warning(
                "OCR worker %s supplied a bad pairing code (%s attempts left)",
                peer,
                remaining,
            )
            await ws.send_json(
                {
                    "type": "deny",
                    "reason": "bad pairing code",
                    "attemptsLeft": remaining,
                }
            )
            if remaining <= 0:
                await ws.close()
                return

        worker_id = secrets.token_hex(4)
        coordinator.workers[worker_id] = {
            "id": worker_id,
            "name": worker_name,
            "ip": ws.client.host if ws.client else "?",
            "status": "idle",
            "done": 0,
            "protocolVersion": protocol_version,
            "resultSchemaVersions": schema_versions,
            "resultFormats": hello.get("resultFormats", []),
            "selectedResultFormat": selected_result_format,
            "capabilities": sorted(capabilities),
            "ws": ws,
        }
        await ws.send_json(
            {
                "type": "welcome",
                "workerId": worker_id,
                "protocolVersion": OCR_PROTOCOL_VERSION,
                "selectedResultFormat": selected_result_format,
                "resultSchemaVersion": (
                    OCR_PAGE_SCHEMA_VERSION
                    if selected_result_format == OCR_PAGE_RESULT_FORMAT
                    else OCR_RESULT_SCHEMA_VERSION
                ),
                "requiredCapabilities": sorted(required_capabilities),
            }
        )
        logger.info("OCR worker %s paired as %s (%s)", peer, worker_name, worker_id)
        await dispatch_next_queued(preferred_worker_id=worker_id)

        while True:
            msg = await ws.receive_json()
            print_worker_message(worker_id, worker_name, msg)
            mtype = msg.get("type")
            if mtype == "progress":
                await _handle_progress(msg)
            elif mtype == "page_result":
                await _handle_page_result(ws, worker_id, msg)
            elif mtype == "result_end":
                await _handle_result_end(ws, worker_id, msg)
            elif mtype == "result":
                await _handle_structured_result(ws, worker_id, msg)
            elif mtype == "error":
                await _handle_worker_error(worker_id, msg)
            elif mtype == "control_ack":
                await _handle_control_ack(worker_id, msg)
    except WebSocketDisconnect as e:
        logger.info("OCR worker %s disconnected (code=%s)", peer, e.code)
    except Exception:
        logger.exception("OCR worker %s protocol failure", peer)
    finally:
        if worker_id:
            coordinator.workers.pop(worker_id, None)
            await release_worker_jobs(worker_id)


async def _handle_progress(msg: dict) -> None:
    job = coordinator.jobs.get(msg.get("jobId"))
    # A progress frame can cross a hold/stop on the wire; it must not undo
    # the pending control (that used to drop the control_ack).
    if not job or job.get("status") not in ACTIVE_JOB_STATUSES:
        return
    try:
        pct = max(0, min(100, int(msg.get("pct", 0))))
    except (TypeError, ValueError):
        return
    job["progress"] = pct
    if job["status"] == "sent":
        job["status"] = "parsing"
    if job.get("kind") != "inbox":
        return

    def update(db: Session) -> None:
        attempt = load_attempt(db, job["attemptId"])
        if attempt and attempt.status in {"sent", "processing", "receiving_pages"}:
            attempt.progress = pct
            if attempt.status == "sent":
                attempt.status = "processing"
            db.commit()

    await run_db(job["db_bind"], update)


async def _handle_page_result(ws: WebSocket, worker_id: str, msg: dict) -> None:
    job = coordinator.jobs.get(msg.get("jobId"))
    if not job:
        await ws.send_json({
            "type": "page_rejected",
            "jobId": msg.get("jobId"),
            "page": msg.get("page"),
            "error": "Unknown OCR job",
            "errorCode": "unknown_job",
            "retryable": False,
        })
        return
    if (
        job.get("kind") != "inbox"
        or job.get("resultFormat") != OCR_PAGE_RESULT_FORMAT
    ):
        await ws.send_json({
            "type": "page_rejected",
            "jobId": job["id"],
            "page": msg.get("page"),
            "error": "Job did not negotiate page_markdown_v2",
            "errorCode": "invalid_result_format",
            "retryable": False,
        })
        return
    if job.get("status") in CONTROL_PENDING_STATUSES:
        # The worker is about to see job_control and drop this job; answering
        # here could race the control frame, so stay silent.
        return
    if job.get("status") not in ACTIVE_JOB_STATUSES:
        await ws.send_json({
            "type": "page_rejected",
            "jobId": job["id"],
            "page": msg.get("page"),
            "error": f"OCR job is {job.get('status')}",
            "errorCode": "job_not_active",
            "retryable": False,
        })
        return

    def store(db: Session) -> dict:
        attempt = load_attempt(db, job["attemptId"])
        try:
            if not attempt:
                raise OCRPageContractError("OCR attempt no longer exists")
            page, page_status = store_page_result(db, attempt, attempt.inbox_item, msg)
            db.commit()
            return {
                "ok": True,
                "page": page.page_number,
                "status": page_status,
                "receivedPages": attempt.received_pages,
                "pageCount": attempt.expected_pages,
            }
        except OCRPageContractError as exc:
            db.rollback()
            fail_attempt_by_id(db, job["attemptId"], str(exc), retryable=False)
            return {"ok": False, "contract": exc}
        except Exception:
            db.rollback()
            logger.exception("Could not persist OCR page for %s", job["id"])
            return {"ok": False, "contract": None}

    outcome = await run_db(job["db_bind"], store)
    if outcome["ok"]:
        if job.get("status") in ACTIVE_JOB_STATUSES:
            job["status"] = "receiving_pages"
        job["receivedPages"] = outcome["receivedPages"]
        await ws.send_json({
            "type": "page_ack",
            "jobId": job["id"],
            "page": outcome["page"],
            "status": outcome["status"],
            "receivedPages": outcome["receivedPages"],
            "pageCount": outcome["pageCount"],
        })
        return
    exc = outcome["contract"]
    if exc is None:
        await ws.send_json({
            "type": "page_rejected",
            "jobId": job["id"],
            "page": msg.get("page"),
            "error": "Could not persist OCR page",
            "errorCode": "page_persistence_failed",
            "retryable": True,
        })
        return
    finish_job(job, "failed", error=str(exc), errorCode=exc.code, retryable=False)
    await ws.send_json({
        "type": "page_rejected",
        "jobId": job["id"],
        "page": msg.get("page"),
        "error": str(exc),
        "errorCode": exc.code,
        "retryable": exc.retryable,
    })
    free_worker(worker_id)
    await dispatch_next_queued(preferred_worker_id=worker_id, bind=job.get("db_bind"))


async def _handle_result_end(ws: WebSocket, worker_id: str, msg: dict) -> None:
    job = coordinator.jobs.get(msg.get("jobId"))
    if not job:
        await ws.send_json({
            "type": "result_rejected",
            "jobId": msg.get("jobId"),
            "error": "Unknown OCR job",
            "errorCode": "unknown_job",
            "retryable": False,
        })
        return
    if (
        job.get("kind") != "inbox"
        or job.get("resultFormat") != OCR_PAGE_RESULT_FORMAT
    ):
        await ws.send_json({
            "type": "result_rejected",
            "jobId": job["id"],
            "error": "Job did not negotiate page_markdown_v2",
            "errorCode": "invalid_result_format",
            "retryable": False,
        })
        return
    if job.get("status") == "done":
        await ws.send_json({
            "type": "result_ack",
            "jobId": job["id"],
            "status": "ready_for_review",
            "pageCount": job.get("receivedPages", job.get("pageCount")),
            "reviewId": job.get("reviewId"),
            "inboxItemId": job.get("inboxItemId"),
        })
        return

    def finalize(db: Session) -> dict:
        attempt = load_attempt(db, job["attemptId"])
        try:
            if not attempt:
                raise OCRPageContractError("OCR attempt no longer exists")
            review, missing = finalize_page_result(db, attempt, attempt.inbox_item, msg)
            db.commit()
            return {
                "ok": True,
                "missing": missing,
                "reviewId": review.id if review is not None else None,
                "receivedPages": attempt.received_pages,
            }
        except OCRPageContractError as exc:
            db.rollback()
            fail_attempt_by_id(db, job["attemptId"], str(exc), retryable=False)
            return {"ok": False, "contract": exc}
        except Exception:
            db.rollback()
            logger.exception("Could not finalize OCR pages for %s", job["id"])
            return {"ok": False, "contract": None}

    outcome = await run_db(job["db_bind"], finalize)
    completed = terminal_rejection = False
    if outcome["ok"] and outcome["missing"]:
        await ws.send_json({
            "type": "result_incomplete",
            "jobId": job["id"],
            "errorCode": "missing_pages",
            "missingPages": outcome["missing"],
            "retryable": True,
        })
    elif outcome["ok"]:
        completed = True
        finish_job(
            job, "done", progress=100,
            receivedPages=outcome["receivedPages"], reviewId=outcome["reviewId"],
        )
        await ws.send_json({
            "type": "result_ack",
            "jobId": job["id"],
            "status": "ready_for_review",
            "pageCount": outcome["receivedPages"],
            "reviewId": outcome["reviewId"],
            "inboxItemId": job.get("inboxItemId"),
        })
    elif outcome["contract"] is not None:
        exc = outcome["contract"]
        terminal_rejection = True
        finish_job(job, "failed", error=str(exc), errorCode=exc.code, retryable=False)
        await ws.send_json({
            "type": "result_rejected",
            "jobId": job["id"],
            "error": str(exc),
            "errorCode": exc.code,
            "retryable": exc.retryable,
        })
    else:
        await ws.send_json({
            "type": "result_rejected",
            "jobId": job["id"],
            "error": "Could not finalize OCR pages",
            "errorCode": "result_persistence_failed",
            "retryable": True,
        })
    if completed and settings.enable_automatic_ocr_label_review:
        coordinator.spawn(asyncio.to_thread(
            run_auto_document_label_review,
            job["db_bind"],
            job["reviewId"],
        ))
    if completed or terminal_rejection:
        free_worker(worker_id, completed=completed)
        await dispatch_next_queued(preferred_worker_id=worker_id, bind=job.get("db_bind"))


async def _handle_structured_result(ws: WebSocket, worker_id: str, msg: dict) -> None:
    job = coordinator.jobs.get(msg.get("jobId"))
    if job:
        ack = None
        if job.get("resultFormat", STRUCTURED_RESULT_FORMAT) != STRUCTURED_RESULT_FORMAT:
            await ws.send_json({
                "type": "result_rejected",
                "jobId": job["id"],
                "error": "Job requires page_result messages",
                "errorCode": "invalid_result_format",
                "retryable": False,
            })
            return
        if job.get("kind") == "inbox":

            def persist(db: Session) -> dict:
                attempt = load_attempt(db, job["attemptId"])
                try:
                    if not attempt:
                        raise ValueError("OCR attempt no longer exists")
                    review = create_review_from_result(db, attempt, attempt.inbox_item, msg)
                    db.commit()
                    return {"ok": True, "reviewId": review.id}
                except Exception as exc:
                    db.rollback()
                    retryable = not isinstance(exc, OCRResultValidationError)
                    error_code = "result_persistence_failed" if retryable else exc.code
                    fail_attempt_by_id(db, job["attemptId"], str(exc), retryable=retryable)
                    return {
                        "ok": False, "error": str(exc),
                        "errorCode": error_code, "retryable": retryable,
                    }

            outcome = await run_db(job["db_bind"], persist)
            if outcome["ok"]:
                rows = msg.get("rows", [])
                finish_job(
                    job, "done", rows=rows, progress=100,
                    rowCount=len(rows), reviewId=outcome["reviewId"],
                )
                ack = {
                    "type": "result_ack",
                    "jobId": job["id"],
                    "status": "ready_for_review",
                    "rowCount": job["rowCount"],
                    "reviewId": outcome["reviewId"],
                    "inboxItemId": job.get("inboxItemId"),
                }
            else:
                finish_job(
                    job, "failed", error=outcome["error"],
                    errorCode=outcome["errorCode"], retryable=outcome["retryable"],
                )
                await ws.send_json({
                    "type": "result_rejected",
                    "jobId": job["id"],
                    "error": outcome["error"],
                    "errorCode": outcome["errorCode"],
                    "retryable": outcome["retryable"],
                })
        else:
            rows = msg.get("rows", [])
            finish_job(job, "done", rows=rows, progress=100, rowCount=len(rows))
            ack = {
                "type": "result_ack",
                "jobId": job["id"],
                "status": "done",
                "rowCount": job["rowCount"],
            }
        if ack:
            await ws.send_json(ack)
    free_worker(worker_id, completed=bool(job and job.get("status") == "done"))
    if job:
        await dispatch_next_queued(preferred_worker_id=worker_id, bind=job.get("db_bind"))


async def _handle_worker_error(worker_id: str, msg: dict) -> None:
    job = coordinator.jobs.get(msg.get("jobId"))
    if job:
        finish_job(
            job, "failed",
            error=msg.get("error", "worker error"),
            errorCode=msg.get("errorCode", "worker_error"),
            retryable=bool(msg.get("retryable", False)),
        )
        if job.get("kind") == "inbox":
            await run_db(
                job["db_bind"],
                lambda db: fail_attempt_by_id(
                    db, job["attemptId"], job["error"], retryable=job["retryable"],
                ),
            )
    free_worker(worker_id)
    if job:
        await dispatch_next_queued(preferred_worker_id=worker_id, bind=job.get("db_bind"))


async def _handle_control_ack(worker_id: str, msg: dict) -> None:
    job = coordinator.jobs.get(msg.get("jobId"))
    action = msg.get("action")
    # Trust the acknowledged action itself: a progress/page frame may have
    # touched the job between the control request and this ack.
    if (
        action not in {"hold", "stop"}
        or not job
        or job.get("workerId") != worker_id
        or job.get("status") in FINISHED_JOB_STATUSES
    ):
        return
    if job.get("kind") == "inbox":

        def resolve(db: Session) -> None:
            attempt = load_attempt(db, job["attemptId"])
            if attempt:
                resolve_control(db, attempt, action)
                db.commit()

        await run_db(job["db_bind"], resolve)
    finish_job(job, "held" if action == "hold" else "stopped")
    free_worker(worker_id)
    await dispatch_next_queued(preferred_worker_id=worker_id, bind=job.get("db_bind"))

