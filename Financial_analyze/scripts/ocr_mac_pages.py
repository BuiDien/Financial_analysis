"""Mac OCR page pipeline: run `minicpmvocr parse`, split merged Markdown per page, clean it."""
from __future__ import annotations

import asyncio
import html
import io
import os
import re
import signal
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class OCRPage:
    page: int
    markdown: str


@dataclass(frozen=True)
class OCRConfig:
    sdk_bin: Path
    ocr_url: str
    model: str
    ocr_home: Path


class InvalidPageResult(ValueError):
    """Deterministic failure (maps to invalid_page_result)."""


class ParseFailed(RuntimeError):
    """Retryable SDK parse failure."""


def pdf_page_count(pdf_bytes: bytes) -> int:
    from pypdf import PdfReader
    try:
        n = len(PdfReader(io.BytesIO(pdf_bytes)).pages)
    except Exception as exc:
        raise InvalidPageResult(f"unreadable PDF: {exc}") from exc
    if n < 1:
        raise InvalidPageResult("PDF has no pages")
    return n


def make_page_marker() -> str:
    return f"<!-- MACOCR-PAGE-{uuid.uuid4().hex} -->"


def build_parse_command(cfg: OCRConfig, pdf: Path, out_md: Path, marker: str) -> list[str]:
    return [
        str(cfg.sdk_bin), "parse",
        "--backend", "openai",
        "--server-url", cfg.ocr_url,
        "--model", cfg.model,
        "--device", "cpu",
        "--workers", "1",
        "--page-delimiter", marker,
        "--layout-model", str(cfg.ocr_home / "PP-DocLayoutV3_infer"),
        "--set", "engine.max_model_len=40960",
        "--set", "pipeline.merge_cross_page_tables=false",
        "--input", str(pdf),
        "--output", str(out_md),
    ]


def parse_env(cfg: OCRConfig, work_dir: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    env["OCR_ASSETS_DIR"] = str(cfg.ocr_home)
    env["OCR_RUN_ROOT"] = str(work_dir / "runs")
    env["HF_HUB_OFFLINE"] = "1"
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
    return env


def parse_timeout(pages: int) -> float:
    return max(300.0, 60.0 * pages)


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def run_parse(cmd: list[str], *, env: dict, timeout_s: float, log_path: Path) -> None:
    with open(log_path, "wb") as log:
        proc = await asyncio.create_subprocess_exec(
            *cmd, env=env, stdout=log, stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            await asyncio.wait_for(proc.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            _kill_group(proc)
            await proc.wait()
            raise ParseFailed(f"SDK parse timed out after {timeout_s}s") from None
        except BaseException:
            _kill_group(proc)
            await proc.wait()
            raise
    text = log_path.read_text(encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        tail = "\n".join(text.splitlines()[-20:])
        raise ParseFailed(f"SDK parse exited {proc.returncode}:\n{tail}")
    check_parse_log(text)


_FAIL_RE = re.compile(r'"(failed|failed_blocks|pages_with_failed_blocks)"\s*:\s*(\d+)')


def check_parse_log(log_text: str) -> None:
    bad = [f"{k}={v}" for k, v in _FAIL_RE.findall(log_text) if int(v) != 0]
    if bad:
        raise ParseFailed("SDK reported failures: " + ", ".join(bad))


def split_pages(merged: str, marker: str, expected: int) -> list[OCRPage]:
    parts = [p.strip() for p in merged.split(marker)]
    if len(parts) != expected:
        raise InvalidPageResult(f"SDK produced {len(parts)} pages, PDF has {expected}")
    return [OCRPage(i, p) for i, p in enumerate(parts, 1)]


_TOKEN = re.compile(r"<(fcel|ecel|lcel|ucel|xcel|nl)>")


def otsl_to_html(body: str) -> str:
    rows: list[list[str]] = []
    row: list[str] = []
    parts = _TOKEN.split(body)
    for tok, text in zip(parts[1::2], parts[2::2]):
        if tok == "nl":
            rows.append(row)
            row = []
        elif tok in ("fcel", "ecel"):
            row.append(text.strip() if tok == "fcel" else "")
        # lcel/ucel/xcel: covered by a span, no own <td>
    if row:
        rows.append(row)
    trs = "".join(
        "<tr>" + "".join(
            f"<td>{html.escape(html.unescape(c)).replace(chr(10), ' ')}</td>" for c in r
        ) + "</tr>"
        for r in rows
    )
    return f"<table>{trs}</table>"


_IMG_RE = re.compile(r"!\[[^\]]*\]\(imgs/[^)]*\)")
_OTSL_OPEN = "<otsl>"
_OTSL_CLOSE = "</otsl>"
_OTSL_CELL = re.compile(r"<(fcel|ecel|nl)>")


def _segment_to_markdown(segment: str) -> str:
    """Convert one OTSL segment; text outside the cell tokens is kept, never dropped."""
    first = _OTSL_CELL.search(segment)
    if not first:
        return segment
    lead = segment[:first.start()].strip()
    tokens = list(_TOKEN.finditer(segment))
    tail = ""
    if tokens[-1].group(1) == "nl":
        tail = segment[tokens[-1].end():].strip()
    body = segment[first.start():tokens[-1].end()] if tail else segment[first.start():]
    parts = [p for p in (lead, otsl_to_html(body), tail) if p]
    return "\n\n".join(parts)


def _convert_otsl(md: str) -> str:
    out: list[str] = []
    pos = 0
    while True:
        start = md.find(_OTSL_OPEN, pos)
        if start < 0:
            out.append(md[pos:])
            break
        out.append(md[pos:start])
        body_start = start + len(_OTSL_OPEN)
        close = md.find(_OTSL_CLOSE, body_start)
        nxt = md.find(_OTSL_OPEN, body_start)
        blank = md.find("\n\n", body_start)
        cands = [i for i in (close, nxt, blank) if i >= 0]
        end = min(cands) if cands else len(md)
        resume = end + len(_OTSL_CLOSE) if end == close else end
        segment = md[body_start:end]
        out.append(_segment_to_markdown(segment))
        pos = resume
    return "".join(out)


def clean_page_markdown(md: str) -> str:
    md = _IMG_RE.sub("", md)
    md = _convert_otsl(md)
    return re.sub(r"\n{3,}", "\n\n", md).strip()


async def ocr_pdf_pages(pdf_bytes: bytes, work_dir: Path, cfg: OCRConfig) -> list[OCRPage]:
    pdf = work_dir / "input.pdf"
    out_md = work_dir / "output.md"
    pdf.write_bytes(pdf_bytes)
    n = pdf_page_count(pdf_bytes)
    marker = make_page_marker()
    cmd = build_parse_command(cfg, pdf, out_md, marker)
    await run_parse(cmd, env=parse_env(cfg, work_dir), timeout_s=parse_timeout(n),
                    log_path=work_dir / "parse.log")
    if not out_md.exists():
        raise ParseFailed("SDK produced no output file")
    pages = split_pages(out_md.read_text(encoding="utf-8"), marker, n)
    return [OCRPage(p.page, clean_page_markdown(p.markdown)) for p in pages]
