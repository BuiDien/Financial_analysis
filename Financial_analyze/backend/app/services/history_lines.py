"""Obsidian-backed catalogue giving every statement line a stable id.

One note per (ticker, scope, kind). OCR labels (qualified by parent label) and
Mã số codes are aliases that resolve to a line key; later tasks store facts by
key. ``match`` is read-only; only ``add_line`` / ``add_alias`` write notes.
"""

from __future__ import annotations

import difflib
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

import yaml

from .ocr_label_library import (
    FRONT_MATTER_RE,
    LabelLibraryError,
    normalize_label,
)

TICKER_RE = re.compile(r"^[A-Za-z0-9_]{1,16}$")
TOKEN_RE = re.compile(r"^[a-z0-9_]{2,64}$")
MAX_SUGGESTIONS = 5
MIN_SUGGESTION_SCORE = 0.4


@dataclass
class Line:
    key: str
    name: str
    parent_key: str | None
    aliases: list[str] = field(default_factory=list)


@dataclass
class LineMatch:
    key: str | None
    suggestions: list[tuple[str, str, float]] = field(default_factory=list)


def _validate(ticker: str, scope: str, kind: str) -> tuple[str, str, str]:
    ticker = (ticker or "").strip().upper()
    scope = (scope or "").strip().lower()
    kind = (kind or "").strip().lower()
    if not TICKER_RE.fullmatch(ticker):
        raise LabelLibraryError("Ticker must use letters, numbers, and underscores")
    if not TOKEN_RE.fullmatch(scope) or not TOKEN_RE.fullmatch(kind):
        raise LabelLibraryError(
            "Scope and kind must use lowercase letters, numbers, and underscores",
        )
    return ticker, scope, kind


def code_alias(code: str) -> str:
    return f"code:{code}"


def line_code(line) -> str | None:
    """TT200 Mã số recorded as a `code:` alias on a catalogue line; never invented."""
    for alias in (line.aliases if line else []):
        if alias.startswith("code:") and alias[5:].strip():
            return alias[5:].strip()
    return None


def line_name(catalog, ticker: str, scope: str, kind: str, key: str, facts) -> str:
    """Display name: the catalogue name, else the newest fact's row label, else the key."""
    line = catalog.get(ticker, scope, kind, key)
    if line is not None:
        return line.name
    labelled = [f for f in facts if f.row_label]
    if labelled:
        return max(labelled, key=lambda f: (f.period_end, f.id)).row_label
    return key


def label_alias(label: str, parent_label: str | None) -> str:
    return f"label:{normalize_label(parent_label or '')}>{normalize_label(label)}"


class LineCatalog:
    def __init__(self, vault_path: str | Path, relative_path: str):
        self.vault_path = Path(vault_path).expanduser()
        self.relative_path = Path(relative_path)
        if self.relative_path.is_absolute() or ".." in self.relative_path.parts:
            raise LabelLibraryError("Line catalog path must stay inside the vault")
        self.root = self.vault_path / self.relative_path
        self._lock = threading.RLock()
        self._cache: dict[Path, tuple[tuple[int, int] | None, list[Line]]] = {}

    def _path(self, ticker: str, scope: str, kind: str) -> Path:
        return self.root / f"{ticker}-{scope}-{kind}.md"

    def _load(self, path: Path) -> list[Line]:
        try:
            stat = path.stat()
        except FileNotFoundError:
            self._cache.pop(path, None)
            return []
        except OSError as exc:
            raise LabelLibraryError(f"Could not read line note: {path.name}") from exc
        signature = (stat.st_mtime_ns, stat.st_size)
        cached = self._cache.get(path)
        if cached and cached[0] == signature:
            return cached[1]
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise LabelLibraryError(f"Could not read line note: {path.name}") from exc
        match = FRONT_MATTER_RE.match(text)
        if not match:
            raise LabelLibraryError(f"Line note has no front matter: {path.name}")
        try:
            data = yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError as exc:
            raise LabelLibraryError(f"Invalid YAML in line note: {path.name}") from exc
        raw = data.get("lines") if isinstance(data, dict) else None
        if not isinstance(raw, list):
            raise LabelLibraryError(f"Line note has invalid lines: {path.name}")
        lines = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("key"):
                continue
            aliases = item.get("aliases") or []
            lines.append(Line(
                key=str(item["key"]),
                name=str(item.get("name") or ""),
                parent_key=str(item["parent_key"]) if item.get("parent_key") else None,
                aliases=[str(a) for a in aliases] if isinstance(aliases, list) else [],
            ))
        self._cache[path] = (signature, lines)
        return lines

    def _write(
        self, path: Path, ticker: str, scope: str, kind: str, lines: list[Line],
    ) -> None:
        front = yaml.safe_dump(
            {
                "ticker": ticker,
                "scope": scope,
                "kind": kind,
                "lines": [
                    {
                        "key": line.key,
                        "name": line.name,
                        "parent_key": line.parent_key,
                        "aliases": line.aliases,
                    }
                    for line in lines
                ],
            },
            allow_unicode=True,
            sort_keys=False,
        )
        body = (
            f"---\n{front}---\n\n# {ticker} {scope} {kind} line catalogue\n\n"
            "Stable line ids and aliases. The Core maintains this structured data.\n"
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_text(body, encoding="utf-8")
            temporary.replace(path)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise LabelLibraryError(f"Could not write line note: {path.name}") from exc
        self._cache.pop(path, None)

    def lines(self, ticker: str, scope: str, kind: str) -> list[Line]:
        ticker, scope, kind = _validate(ticker, scope, kind)
        with self._lock:
            return [
                Line(l.key, l.name, l.parent_key, list(l.aliases))
                for l in self._load(self._path(ticker, scope, kind))
            ]

    def get(self, ticker: str, scope: str, kind: str, key: str) -> Line | None:
        return next(
            (l for l in self.lines(ticker, scope, kind) if l.key == key), None,
        )

    def match(
        self,
        ticker: str,
        scope: str,
        kind: str,
        label: str,
        parent_label: str | None,
        code: str | None,
    ) -> LineMatch:
        lines = self.lines(ticker, scope, kind)
        if code and str(code).strip():
            wanted = code_alias(str(code).strip())
            hits = [l for l in lines if wanted in l.aliases]
            if len(hits) == 1:
                return LineMatch(hits[0].key)
        wanted = label_alias(label, parent_label)
        hits = [l for l in lines if wanted in l.aliases]
        if len(hits) == 1:
            return LineMatch(hits[0].key)
        target = normalize_label(label)
        scored = []
        for line in lines:
            names = [normalize_label(line.name)] + [
                alias.rsplit(">", 1)[-1]
                for alias in line.aliases if alias.startswith("label:")
            ]
            score = max(
                (difflib.SequenceMatcher(None, target, n).ratio() for n in names if n),
                default=0.0,
            )
            if score >= MIN_SUGGESTION_SCORE:
                scored.append((line.key, line.name, round(score, 4)))
        scored.sort(key=lambda s: s[2], reverse=True)
        return LineMatch(None, scored[:MAX_SUGGESTIONS])

    def add_line(
        self,
        ticker: str,
        scope: str,
        kind: str,
        name: str,
        parent_key: str | None,
        aliases: list[str],
    ) -> str:
        ticker, scope, kind = _validate(ticker, scope, kind)
        if not (name or "").strip():
            raise LabelLibraryError("Line name cannot be empty")
        with self._lock:
            path = self._path(ticker, scope, kind)
            lines = list(self._load(path))
            key = "ln_" + uuid4().hex[:12]
            lines.append(Line(key, name.strip(), parent_key, list(dict.fromkeys(aliases))))
            self._write(path, ticker, scope, kind, lines)
            return key

    def add_alias(
        self, ticker: str, scope: str, kind: str, key: str, alias: str,
    ) -> None:
        ticker, scope, kind = _validate(ticker, scope, kind)
        with self._lock:
            path = self._path(ticker, scope, kind)
            lines = [
                Line(l.key, l.name, l.parent_key, list(l.aliases))
                for l in self._load(path)
            ]
            line = next((l for l in lines if l.key == key), None)
            if line is None:
                raise LabelLibraryError(f"Unknown line key: {key}")
            if alias in line.aliases:
                return
            line.aliases.append(alias)
            self._write(path, ticker, scope, kind, lines)


_CATALOGS: dict[tuple[str, str], LineCatalog] = {}
_CATALOGS_LOCK = threading.Lock()


def get_line_catalog(vault_path: str, relative_path: str) -> LineCatalog:
    if not vault_path.strip():
        raise LabelLibraryError("OBSIDIAN_VAULT_PATH is not configured")
    key = (str(Path(vault_path).expanduser()), relative_path)
    with _CATALOGS_LOCK:
        return _CATALOGS.setdefault(key, LineCatalog(*key))
