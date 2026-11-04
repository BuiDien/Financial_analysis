"""Obsidian-backed Quick Correct library for Vietnamese OCR labels.

The library is deliberately separate from the OCR database. Obsidian notes are
the reusable source of truth; the Core keeps a small in-memory index so each
table review does not scan the whole vault or call Ollama unnecessarily.
"""

from __future__ import annotations

import re
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import yaml

from .ocr_label_levels import (
    auto_level_markdown,
    extract_label_rows,
    strip_label_level_metadata,
)


STATEMENT_TYPE_RE = re.compile(r"^[a-z0-9_]{2,64}$")
FRONT_MATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.S)
MAX_NEIGHBORS = 2


class LabelLibraryError(ValueError):
    """Raised when a vault library cannot be read or written safely."""


def normalize_label(value: str) -> str:
    """Return an accent-free, punctuation-neutral Vietnamese lookup key."""
    text = unicodedata.normalize("NFKC", value or "").casefold()
    text = text.replace("đ", "d")
    text = "".join(
        character
        for character in unicodedata.normalize("NFD", text)
        if not unicodedata.combining(character)
    )
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def comparable_label(value: str) -> str:
    """Keep accents while ignoring harmless case and whitespace differences."""
    text = unicodedata.normalize("NFKC", value or "").casefold()
    return " ".join(text.split())


def level_token(level: int) -> str:
    return "L" if level == -1 else f"L{level}"


def level_value(value: object) -> int:
    token = str(value).strip().upper()
    if token == "L":
        return -1
    if re.fullmatch(r"L?[0-3]", token):
        return int(token[-1])
    raise LabelLibraryError("Label level must be L or L0-L3")


def validate_statement_type(statement_type: str) -> str:
    token = (statement_type or "").strip().lower()
    if not STATEMENT_TYPE_RE.fullmatch(token):
        raise LabelLibraryError(
            "Statement type must use lowercase letters, numbers, and underscores",
        )
    return token


@dataclass(frozen=True)
class LabelContext:
    table: int
    row: int
    label: str
    current_level: int | None
    core_level: int | None
    parent_label: str | None
    before_labels: tuple[str, ...]
    after_labels: tuple[str, ...]

    @property
    def resolved_level(self) -> int | None:
        return self.current_level if self.current_level is not None else self.core_level


def contexts_from_markdown(markdown: str) -> list[LabelContext]:
    """Extract label rows plus the small local context used by Quick Correct."""
    original = extract_label_rows(markdown)
    inferred = extract_label_rows(
        auto_level_markdown(strip_label_level_metadata(markdown))["markdown"],
    )
    inferred_levels = {
        (row["table"], row["row"]): row["level"] for row in inferred
    }
    by_table: dict[int, list[dict[str, Any]]] = {}
    for row in original:
        resolved = row["level"]
        if resolved is None:
            resolved = inferred_levels.get((row["table"], row["row"]))
        by_table.setdefault(row["table"], []).append({**row, "resolved": resolved})

    contexts: list[LabelContext] = []
    for table, rows in by_table.items():
        for index, row in enumerate(rows):
            level = row["resolved"]
            parent = None
            if level is not None and level >= 0:
                for previous in reversed(rows[:index]):
                    previous_level = previous["resolved"]
                    if previous_level is not None and 0 <= previous_level < level:
                        parent = previous["label"]
                        break
            contexts.append(LabelContext(
                table=table,
                row=row["row"],
                label=row["label"],
                current_level=row["level"],
                core_level=inferred_levels.get((table, row["row"])),
                parent_label=parent,
                before_labels=tuple(
                    candidate["label"]
                    for candidate in rows[max(0, index - MAX_NEIGHBORS):index]
                ),
                after_labels=tuple(
                    candidate["label"]
                    for candidate in rows[index + 1:index + 1 + MAX_NEIGHBORS]
                ),
            ))
    return contexts


class ObsidianLabelLibrary:
    """Read and write the dedicated label-library subtree of an Obsidian vault."""

    def __init__(self, vault_path: str | Path, relative_path: str):
        self.vault_path = Path(vault_path).expanduser()
        self.relative_path = Path(relative_path)
        if self.relative_path.is_absolute() or ".." in self.relative_path.parts:
            raise LabelLibraryError("Label library path must stay inside the vault")
        self.root = self.vault_path / self.relative_path
        self._lock = threading.RLock()
        self._signature: tuple[tuple[str, int, int], ...] | None = None
        self._index: dict[tuple[str, str], list[dict[str, Any]]] = {}

    def _note_paths(self) -> list[Path]:
        if not self.root.exists():
            return []
        if not self.root.is_dir():
            raise LabelLibraryError("Obsidian label library path is not a directory")
        return sorted(path for path in self.root.rglob("*.md") if path.is_file())

    @staticmethod
    def _parse_note(path: Path) -> dict[str, Any] | None:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise LabelLibraryError(f"Could not read label note: {path.name}") from exc
        match = FRONT_MATTER_RE.match(text)
        if not match:
            return None
        try:
            data = yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError as exc:
            raise LabelLibraryError(f"Invalid YAML in label note: {path.name}") from exc
        if not isinstance(data, dict):
            return None
        label = str(data.get("label") or "").strip()
        statement_type = str(data.get("statement_type") or "").strip().lower()
        if not label or not STATEMENT_TYPE_RE.fullmatch(statement_type):
            return None
        patterns = data.get("patterns") or []
        if not isinstance(patterns, list):
            return None
        normalized = normalize_label(str(data.get("normalized_label") or label))
        if not normalized:
            return None
        return {
            "path": path,
            "label": label,
            "normalized_label": normalized,
            "statement_type": statement_type,
            "patterns": [pattern for pattern in patterns if isinstance(pattern, dict)],
        }

    def _refresh(self) -> None:
        paths = self._note_paths()
        signature = tuple(
            (str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in paths
        )
        if signature == self._signature:
            return
        index: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for path in paths:
            note = self._parse_note(path)
            if note is not None:
                index.setdefault(
                    (note["statement_type"], note["normalized_label"]), [],
                ).append(note)
        self._signature = signature
        self._index = index

    @staticmethod
    def _pattern_score(context: LabelContext, pattern: dict[str, Any]) -> int:
        score = 40  # exact normalized label and statement type already matched
        expected_parent = normalize_label(str(pattern.get("parent_label") or ""))
        actual_parent = normalize_label(context.parent_label or "")
        if expected_parent and expected_parent == actual_parent:
            score += 30
        expected_before = {
            normalize_label(value) for value in pattern.get("before_labels") or []
        }
        expected_after = {
            normalize_label(value) for value in pattern.get("after_labels") or []
        }
        actual_before = {normalize_label(value) for value in context.before_labels}
        actual_after = {normalize_label(value) for value in context.after_labels}
        score += min(15, len(expected_before & actual_before) * 8)
        score += min(15, len(expected_after & actual_after) * 8)
        try:
            expected_level = level_value(pattern.get("correct_level"))
        except LabelLibraryError:
            return -1
        if context.core_level == expected_level:
            score += 10
        return score

    @staticmethod
    def _approval_count(pattern: dict[str, Any]) -> int:
        sources = pattern.get("approval_sources") or []
        if not isinstance(sources, list):
            return 0
        return len({
            str(source.get("document_hash") or "").strip()
            for source in sources
            if isinstance(source, dict) and source.get("document_hash")
        })

    def suggest(self, statement_type: str, markdown: str) -> dict[str, Any]:
        """Return user-reviewable Quick Correct suggestions for one page."""
        statement_type = validate_statement_type(statement_type)
        with self._lock:
            self._refresh()
            suggestions = []
            for context in contexts_from_markdown(markdown):
                notes = self._index.get(
                    (statement_type, normalize_label(context.label)), [],
                )
                matches = []
                for note in notes:
                    for pattern in note["patterns"]:
                        score = self._pattern_score(context, pattern)
                        if score < 0:
                            continue
                        matches.append((score, self._approval_count(pattern), pattern, note))
                if not matches:
                    continue
                matches.sort(key=lambda item: (item[0], item[1]), reverse=True)
                score, approval_count, pattern, note = matches[0]
                suggested_level = level_value(pattern["correct_level"])
                if context.current_level == suggested_level:
                    continue
                confidence = (
                    "strong" if approval_count >= 3 and score >= 70
                    else "medium" if approval_count >= 2 and score >= 55
                    else "weak"
                )
                suggestions.append({
                    "source": "quick_correct",
                    "table": context.table,
                    "row": context.row,
                    "current_label": context.label,
                    "current_level": context.current_level,
                    "core_level": context.core_level,
                    "suggested_level": suggested_level,
                    "confidence": confidence,
                    "match_score": score,
                    "approval_count": approval_count,
                    "parent_label": context.parent_label,
                    "note": str(note["path"].relative_to(self.vault_path)),
                })
            return {"suggestions": suggestions, "label_count": len(contexts_from_markdown(markdown))}

    def match_label_texts(
        self, markdown: str, statement_type: str | None = None,
    ) -> dict[str, Any]:
        """Classify page labels for the automatic OCR text checker.

        Exact user-approved labels need no work. An accent/punctuation variant
        with one unambiguous canonical label can use Obsidian directly. Every
        other label is left for Ollama to review.
        """
        selected_type = validate_statement_type(statement_type) if statement_type else None
        contexts = contexts_from_markdown(markdown)
        with self._lock:
            self._refresh()
            known = []
            candidates = []
            for context in contexts:
                normalized = normalize_label(context.label)
                notes = [
                    note
                    for (note_type, note_label), values in self._index.items()
                    if note_label == normalized
                    and (selected_type is None or note_type == selected_type)
                    for note in values
                ]
                exact = next(
                    (
                        note for note in notes
                        if comparable_label(note["label"])
                        == comparable_label(context.label)
                    ),
                    None,
                )
                base = {
                    "table": context.table,
                    "row": context.row,
                    "label": context.label,
                    "level": context.current_level,
                }
                if exact is not None:
                    known.append(base)
                    continue
                canonical_labels = sorted({note["label"] for note in notes})
                if len(canonical_labels) == 1:
                    candidates.append({
                        **base,
                        "source": "obsidian",
                        "suggested_label": canonical_labels[0],
                        "confidence": "high",
                    })
                else:
                    candidates.append({**base, "source": "ollama"})
            return {
                "label_count": len(contexts),
                "known_count": len(known),
                "candidate_count": len(candidates),
                "candidates": candidates,
            }

    def record_verified_page(
        self, statement_type: str, markdown: str, document_hash: str,
    ) -> dict[str, Any]:
        """Seed/update notes from an explicitly user-approved verified page."""
        statement_type = validate_statement_type(statement_type)
        digest = (document_hash or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise LabelLibraryError("A SHA-256 document hash is required")
        contexts = contexts_from_markdown(markdown)
        if not contexts:
            return {"notes_updated": 0, "patterns_updated": 0}
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            updated_notes = 0
            updated_patterns = 0
            for context in contexts:
                level = context.resolved_level
                if level is None:
                    continue
                note_path = self._note_path(statement_type, context.label)
                note = self._load_or_create_note(note_path, statement_type, context.label)
                pattern = self._find_pattern(note["patterns"], context, level)
                if pattern is None:
                    pattern = {
                        "correct_level": level_token(level),
                        "parent_label": context.parent_label or "",
                        "before_labels": list(context.before_labels),
                        "after_labels": list(context.after_labels),
                        "approval_sources": [],
                    }
                    note["patterns"].append(pattern)
                    updated_patterns += 1
                sources = pattern.setdefault("approval_sources", [])
                if not any(
                    isinstance(source, dict) and source.get("document_hash") == digest
                    for source in sources
                ):
                    sources.append({"document_hash": digest})
                    updated_patterns += 1
                self._write_note(note_path, note)
                updated_notes += 1
            self._signature = None
            self._refresh()
            return {"notes_updated": updated_notes, "patterns_updated": updated_patterns}

    def _note_path(self, statement_type: str, label: str) -> Path:
        slug = normalize_label(label)
        if not slug:
            raise LabelLibraryError("Label cannot be empty")
        return self.root / statement_type / f"{slug}.md"

    def _load_or_create_note(
        self, path: Path, statement_type: str, label: str,
    ) -> dict[str, Any]:
        if path.exists():
            note = self._parse_note(path)
            if note is None:
                raise LabelLibraryError(f"Label note has invalid front matter: {path.name}")
            return note
        return {
            "label": label,
            "normalized_label": normalize_label(label),
            "statement_type": statement_type,
            "patterns": [],
        }

    @staticmethod
    def _find_pattern(
        patterns: list[dict[str, Any]], context: LabelContext, level: int,
    ) -> dict[str, Any] | None:
        for pattern in patterns:
            try:
                matches_level = level_value(pattern.get("correct_level")) == level
            except LabelLibraryError:
                continue
            if (
                matches_level
                and normalize_label(str(pattern.get("parent_label") or ""))
                == normalize_label(context.parent_label or "")
            ):
                return pattern
        return None

    def _write_note(self, path: Path, note: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        front_matter = yaml.safe_dump(
            {
                "label": note["label"],
                "normalized_label": note["normalized_label"],
                "statement_type": note["statement_type"],
                "patterns": note["patterns"],
            },
            allow_unicode=True,
            sort_keys=False,
        )
        body = (
            f"---\n{front_matter}---\n\n"
            f"# {note['label']}\n\n"
            "User-approved OCR hierarchy patterns. The Core maintains this "
            "structured data; the automatic label checker reads it only.\n"
        )
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_text(body, encoding="utf-8")
            temporary.replace(path)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise LabelLibraryError(f"Could not write label note: {path.name}") from exc


_LIBRARIES: dict[tuple[str, str], ObsidianLabelLibrary] = {}
_LIBRARIES_LOCK = threading.Lock()


def get_label_library(vault_path: str, relative_path: str) -> ObsidianLabelLibrary:
    if not vault_path.strip():
        raise LabelLibraryError("OBSIDIAN_VAULT_PATH is not configured")
    key = (str(Path(vault_path).expanduser()), relative_path)
    with _LIBRARIES_LOCK:
        return _LIBRARIES.setdefault(key, ObsidianLabelLibrary(*key))
