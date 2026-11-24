"""Ollama-assisted Vietnamese OCR label-text correction.

Ollama receives one user-marked label at a time and returns a small structured
correction. It never mutates OCR Markdown or verifies a review.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone

from sqlalchemy.orm import Session, sessionmaker

from ..config import get_settings
from ..models.ocr import (
    OCRAuditEvent,
    OCRLabelReviewRun,
    OCRLabelSuggestion,
    OCRPageResult,
)
from . import ai
from .ocr_label_levels import extract_label_rows


logger = logging.getLogger("uvicorn.error")
SKILL_NAME = "kiem-tra-nhan-ocr"
SKILL_VERSION = "0.1.0"
ALLOWED_CONFIDENCE = {"high", "medium", "low"}

SYSTEM_PROMPT = """You correct OCR label text in Vietnamese financial
statements. Use the meaning and standard vocabulary of the complete label, not
each word by itself.

Every user message is one complete label taken from a Vietnamese balance sheet,
income statement, cash-flow statement, or financial-statement note. Read the
whole label as one phrase and decide which standard financial label it means.
It is never a conversation, question, title, persona, translation request,
project idea, or Obsidian note.

Rules:
1. Correct the whole label so all its words form one coherent, standard
   Vietnamese financial-statement label. Do not correct words independently.
2. Use the complete phrase only to resolve ambiguous OCR characters and accents.
   Prefer the correction with the smallest character difference from the OCR.
3. Never add, remove, or reorder words. Never expand a word into a longer
   financial term. Fix spelling, Vietnamese accents, spacing, punctuation,
   capitalization, and misread characters inside the existing words only.
4. Do not invent accounts, qualifiers, or meaning. Keep the original Vietnamese
   meaning. Do not translate to English and never change financial values.
5. Do not include explanations, notes, Markdown, or extra fields.
6. Return exactly one JSON object in this form:
   {"corrected_label":"...","confidence":"high|medium|low"}
7. If the label has no error, return the original label unchanged with high
   confidence.
8. Use high confidence only when the complete standard label is clear. Use
   medium or low confidence when more than one correction is possible.
9. Treat every user message as one separate label. Do not combine it with
   labels from earlier messages.
10. Do not use tools, memory, skills, or Obsidian. Do not ask the user a
   question."""


def page_markdown(page: OCRPageResult) -> str:
    return (
        page.reviewed_markdown
        if page.reviewed_markdown is not None
        else page.raw_markdown
    )


def content_sha256(markdown: str) -> str:
    return hashlib.sha256(markdown.encode("utf-8")).hexdigest()


def label_cell_sha256(label: str, level: int | None) -> str:
    return hashlib.sha256(f"{label}\x1f{level}".encode()).hexdigest()


def _json_object(content: str) -> dict:
    value = content.strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.I)
        value = re.sub(r"\s*```$", "", value)
    start, end = value.find("{"), value.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Ollama did not return a JSON object")
    try:
        parsed = json.loads(value[start:end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("Ollama returned malformed JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Ollama response must be a JSON object")
    return parsed


def _validated_label_correction(content: str, current_label: str) -> dict | None:
    payload = _json_object(content)
    if set(payload) != {"corrected_label", "confidence"}:
        raise ValueError(
            "Ollama response must contain only corrected_label and confidence"
        )
    corrected_label = payload.get("corrected_label")
    if not isinstance(corrected_label, str):
        raise ValueError("Ollama response is missing corrected_label")
    corrected_label = corrected_label.strip()
    if not corrected_label or "\n" in corrected_label or len(corrected_label) > 500:
        raise ValueError("Ollama corrected_label must be one non-empty line")
    confidence = str(payload.get("confidence", "")).lower()
    if confidence not in ALLOWED_CONFIDENCE:
        raise ValueError("Ollama confidence must be high, medium, or low")
    if corrected_label == current_label:
        return None
    return {"corrected_label": corrected_label, "confidence": confidence}


def serialize_suggestion(suggestion: OCRLabelSuggestion) -> dict:
    return {
        "id": suggestion.id,
        "table": suggestion.table_number,
        "row": suggestion.row_number,
        "current_label": suggestion.current_label,
        "suggested_label": suggestion.suggested_label,
        "suggestion_kind": (
            "label_text" if suggestion.suggested_label is not None else "label_level"
        ),
        "current_level": suggestion.current_level,
        "suggested_level": suggestion.suggested_level,
        "confidence": suggestion.confidence,
        "reason_codes": suggestion.reason_codes or [],
        "evidence": suggestion.evidence or {},
        "explanation": suggestion.explanation,
        "visual_confirmation_required": bool(
            suggestion.visual_confirmation_required
        ),
        "decision": suggestion.decision,
        "user_edited_level": suggestion.user_edited_level,
        "applied_revision": suggestion.applied_revision,
    }


def serialize_run(run: OCRLabelReviewRun) -> dict:
    requested_rows = run.requested_rows or []
    return {
        "id": run.id,
        "review_id": run.review_id,
        "page": run.page_number,
        "base_revision": run.base_revision,
        "page_content_sha256": run.page_content_sha256,
        "status": run.status,
        "trigger": run.trigger,
        "skill": {"name": run.skill_name, "version": run.skill_version},
        "model": run.model,
        "selected_rows": requested_rows,
        "active_target": (
            {
                "table": run.current_table_number,
                "row": run.current_row_number,
            }
            if run.current_table_number and run.current_row_number
            else None
        ),
        "processed_count": run.processed_count or 0,
        "total_count": len(requested_rows),
        "tool_call_count": run.tool_call_count,
        "duration_ms": run.duration_ms,
        "error": run.error,
        "suggestions": [
            serialize_suggestion(suggestion) for suggestion in run.suggestions
        ],
    }


INTERRUPTED_ERROR = "interrupted by restart"


def recover_interrupted_runs(*, bind=None) -> int:
    """Startup: a run left queued/running by a previous process can never
    finish, and while it looks active start_label_review_run returns it instead
    of starting a new one (the UI would poll it forever). Mark it failed, like
    any failed run, so the user can ask again. Returns the number of rows."""
    from sqlalchemy import inspect

    from ..db import SessionLocal

    db = Session(bind=bind) if bind is not None else SessionLocal()
    with db:
        if not inspect(db.get_bind()).has_table(OCRLabelReviewRun.__tablename__):
            return 0
        runs = (
            db.query(OCRLabelReviewRun)
            .filter(OCRLabelReviewRun.status.in_(("queued", "running")))
            .all()
        )
        now = datetime.now(timezone.utc)
        for run in runs:
            run.status = "failed"
            run.error = INTERRUPTED_ERROR
            run.finished_at = now
            run.current_table_number = None
            run.current_row_number = None
        if runs:
            db.commit()
        return len(runs)


def run_label_review(bind, run_id: int) -> None:
    """Process collected label rows one at a time without changing OCR data."""
    SessionFactory = sessionmaker(bind=bind)
    db: Session = SessionFactory()
    started = time.monotonic()
    run = None
    try:
        run = db.get(OCRLabelReviewRun, run_id)
        if not run or run.status != "queued":
            return
        run.status = "running"
        run.started_at = datetime.now(timezone.utc)
        run.model = run.model or get_settings().ollama_ocr_model
        db.commit()

        page = (
            db.query(OCRPageResult)
            .filter_by(
                attempt_id=run.review.attempt_id,
                page_number=run.page_number,
            )
            .first()
        )
        if not page:
            raise RuntimeError("OCR review page no longer exists")
        markdown = page_markdown(page)
        if (
            run.review.revision != run.base_revision
            or content_sha256(markdown) != run.page_content_sha256
        ):
            raise RuntimeError("OCR review changed before Ollama could inspect it")

        requested_rows = run.requested_rows or []
        if not requested_rows:
            raise RuntimeError("No labels were selected for label review")
        labels_by_key = {
            (label["table"], label["row"]): label
            for label in extract_label_rows(markdown)
        }
        missing = [
            row for row in requested_rows
            if (row["table"], row["row"]) not in labels_by_key
        ]
        if missing:
            raise RuntimeError("One or more marked label rows no longer exist")
        candidates = [
            (labels_by_key[(row["table"], row["row"])], row)
            for row in requested_rows
        ]
        run.tool_call_count = 0
        run.processed_count = 0
        db.commit()

        suggestion_count = 0
        for candidate, request in candidates:
            # Commit before every provider call: polling now tells the user
            # precisely which marked label has been sent to Ollama.
            run.current_table_number = candidate["table"]
            run.current_row_number = candidate["row"]
            db.commit()
            source = request.get("source", "ollama")
            if source == "obsidian":
                response = json.dumps({
                    "corrected_label": request.get("suggested_label"),
                    "confidence": request.get("confidence", "high"),
                }, ensure_ascii=False)
                reason_codes = ["obsidian_verified_label"]
            else:
                response = ai.ollama_label_complete(
                    SYSTEM_PROMPT,
                    candidate["label"],
                    timeout_seconds=get_settings().ollama_timeout_seconds,
                )
                run.tool_call_count += 1
                reason_codes = ["ollama_ocr_label_correction"]
            correction = _validated_label_correction(response, candidate["label"])
            if correction:
                suggestion_count += 1
                db.add(OCRLabelSuggestion(
                    run=run,
                    table_number=candidate["table"],
                    row_number=candidate["row"],
                    label_cell_hash=label_cell_sha256(
                        candidate["label"], candidate["level"],
                    ),
                    current_label=candidate["label"],
                    suggested_label=correction["corrected_label"],
                    current_level=candidate["level"],
                    # The legacy column is required by existing local
                    # databases. It is ignored for label-text suggestions.
                    suggested_level=(
                        candidate["level"]
                        if candidate["level"] is not None else 0
                    ),
                    confidence=correction["confidence"],
                    reason_codes=reason_codes,
                    evidence={"source": source},
                    explanation="",
                    visual_confirmation_required=0,
                ))
            run.processed_count += 1
            db.commit()
        run.status = "completed"
        run.current_table_number = None
        run.current_row_number = None
        run.finished_at = datetime.now(timezone.utc)
        run.duration_ms = int((time.monotonic() - started) * 1000)
        run.review.events.append(OCRAuditEvent(
            action=(
                "automatic_label_suggestions_created"
                if run.trigger == "worker_auto"
                else "ollama_label_suggestions_created"
            ),
            actor=(
                "automatic-label-checker"
                if run.trigger == "worker_auto" else "ollama"
            ),
            revision=run.base_revision,
            after_data={
                "run_id": run.id,
                "page": run.page_number,
                "count": suggestion_count,
                "processed_count": run.processed_count,
                "selected_count": len(candidates),
            },
        ))
        db.commit()
    except Exception as exc:
        db.rollback()
        run = db.get(OCRLabelReviewRun, run_id)
        if run:
            run.status = "failed"
            run.error = str(exc)[:1000] or exc.__class__.__name__
            run.finished_at = datetime.now(timezone.utc)
            run.duration_ms = int((time.monotonic() - started) * 1000)
            db.commit()
    finally:
        db.close()
