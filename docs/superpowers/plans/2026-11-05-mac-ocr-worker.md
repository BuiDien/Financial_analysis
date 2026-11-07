# Mac OCR Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GPU-laptop OCR worker with a fully local Mac worker (minicpm-ocr SDK layout + MiniCPM-OCR-1.0 on MLX) that speaks Core's existing `page_markdown_v2` protocol.

**Architecture:** `start_ocr_mac.sh` starts a patched `mlx_vlm` server on 127.0.0.1:18499 (venv A), runs a self-test, then runs the worker (venv B). Per job the worker runs `minicpmvocr parse` as a subprocess, splits the merged Markdown on a random per-job marker, cleans each page, and sends pages with durable acks. Core is not changed.

**Tech Stack:** Python 3.11 (mlx-vlm 0.6.13), Python 3.12 (minicpm-ocr 1.0.4, paddlepaddle 3.2.1, paddlex 3.4.2, websockets, pypdf), uv, bash, pytest + anyio (backend test suite).

**Spec:** `docs/superpowers/specs/2026-11-05-mac-ocr-worker-design.md` — read it before any task. Protocol details: `docs/design/OCR_PROTOCOL.md` and `docs/design/OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md`.

## Global Constraints

- **Never `git commit` or `git push`** (project rule in `CLAUDE.md`). Each task ends with a checkpoint listing changed files; the owner commits.
- Fully local runtime: nothing at runtime may contact the internet. Every server binds `127.0.0.1` only.
- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True` in every SDK process environment.
- Pins: `mlx-vlm==0.6.13`; model `openbmb/MiniCPM-OCR-1.0` revision `b2890ab4ce9d18c7f75b90966b76a972b6c9ac58`; `minicpm-ocr[all]==1.0.4`; `paddlepaddle==3.2.1`; `paddlex==3.4.2`.
- Paths: `OCR_HOME = Financial_analyze/models/ocr` (weights in `OCR_HOME/minicpm-ocr-1.0`, SDK assets via `OCR_ASSETS_DIR=OCR_HOME`, so layout at `OCR_HOME/PP-DocLayoutV3_infer`, upright at `OCR_HOME/paddle_upright`). venv A `Financial_analyze/.venv-ocr-mlx` (3.11), venv B `Financial_analyze/.venv-ocr-sdk` (3.12).
- MLX server `127.0.0.1:18499`; worker default `--connect ws://127.0.0.1:8000/ws/ocr`, `--name "Mac OCR (MLX)"`, `--ocr-url http://127.0.0.1:18499`.
- Page limits: 1 MiB per page, 20 MiB per document, measured as UTF-8 bytes.
- Protocol constants exactly as in `OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md` §3 (`PAGE_ACK_TIMEOUT_SECONDS = 30`, `MAX_PAGE_SEND_ATTEMPTS = 3`, `MAX_FINALIZE_ATTEMPTS = 3`, `MAX_MISSING_PAGE_REPAIR_ROUNDS = 3`).
- Error codes: deterministic page contract failures `invalid_page_result` (retryable false); everything else `worker_job_failed` (retryable true).
- Tests run from `Financial_analyze/backend`: `.venv/bin/python -m pytest -q tests/<file>`; async tests use `@pytest.mark.anyio` like the existing suite. No network in unit tests.
- Send all JSON with `ensure_ascii=False` (Vietnamese must survive).

## Review Focus

1. **Core restarts mid-job** → worker must kill the SDK subprocess, delete the work folder, reconnect with backoff and re-ask the pairing code; MLX server keeps running. Test in Task 3 (`test_disconnect_mid_ocr_kills_subprocess_and_reconnects`).
2. **Hold/stop arrives while pages are being sent** (not only during OCR) → `control_ack`, stop sending, no `result_end`. Test in Task 3 (`test_hold_during_page_send_stops_without_result_end`).
3. **SDK hangs** (e.g. MLX server frozen) → timeout kills the process group, retryable `worker_job_failed`. Test in Task 1 (`test_run_parse_timeout_kills_process`).
4. **Blank page** → `markdown: ""` page still sent; page count intact. Test in Task 1 (`test_split_pages_keeps_blank_page`).
5. **Vietnamese-heavy page near the limit** → size measured in UTF-8 bytes, not characters. Test in Task 3 (`test_page_size_limit_counts_utf8_bytes`).

---

## File Structure

| File | Responsibility |
|---|---|
| `Financial_analyze/scripts/ocr_mac_pages.py` (create) | SDK command, subprocess run, page split, Markdown cleanup, OTSL→HTML. No WebSocket code. |
| `Financial_analyze/scripts/ocr_worker.py` (rewrite) | Protocol: pairing, job contract, PDF receive, page send/ack, finalize, hold/stop, reconnect, CLI. |
| `Financial_analyze/scripts/serve_mlx.py` (create, from spike) | Model config patch, stray-`<think>` fix, server launch on 127.0.0.1:18499. |
| `Financial_analyze/scripts/ocr_selftest.py` (create) | One-crop request through the SDK client; fail loudly on empty/wrong text. |
| `Financial_analyze/scripts/assets/ocr_selftest.png` (create) | Fixed Vietnamese header crop. |
| `Financial_analyze/scripts/setup_ocr_mac.sh` (create) | One-time install + downloads. |
| `Financial_analyze/scripts/start_ocr_mac.sh` (create) | Start server, self-test, worker; Ctrl+C stops both. |
| `Financial_analyze/backend/tests/test_ocr_mac_pages.py` (create) | Tests for `ocr_mac_pages.py`. |
| `Financial_analyze/backend/tests/test_ocr_worker_protocol.py` (rewrite) | Tests for `ocr_worker.py`. |
| `Financial_analyze/backend/tests/test_serve_mlx.py` (create) | Tests for config patch, think fix, self-test check. |
| `spikes/ocr-mac/run_worker_path.py` (create) | Acceptance item 1 harness. |
| `.gitignore` (modify) | Ignore `Financial_analyze/models/`. |
| Docs (modify) / `setup_laptop.sh` (delete) | Retire the laptop. |

Test modules load scripts by path (as the existing test does): `importlib.util.spec_from_file_location(name, Path(__file__).parents[2] / "scripts" / "<file>.py")`. `ocr_worker.py` imports `ocr_mac_pages` after `sys.path.insert(0, str(Path(__file__).resolve().parent))`. `serve_mlx.py` and `ocr_selftest.py` must import `mlx_vlm` / `minicpmvocr` **only inside `main()`** so tests run in the backend venv.

---

### Task 1: Page pipeline module (`ocr_mac_pages.py`)

**Files:**
- Create: `Financial_analyze/scripts/ocr_mac_pages.py`
- Test: `Financial_analyze/backend/tests/test_ocr_mac_pages.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `@dataclass(frozen=True) class OCRPage: page: int; markdown: str`
  - `@dataclass(frozen=True) class OCRConfig: sdk_bin: Path; ocr_url: str; model: str; ocr_home: Path`
  - `class InvalidPageResult(ValueError)` — deterministic, maps to `invalid_page_result`.
  - `class ParseFailed(RuntimeError)` — retryable.
  - `pdf_page_count(pdf_bytes: bytes) -> int` (pypdf; raises `InvalidPageResult` if 0 pages)
  - `make_page_marker() -> str` → `f"<!-- MACOCR-PAGE-{uuid4().hex} -->"`
  - `build_parse_command(cfg: OCRConfig, pdf: Path, out_md: Path, marker: str) -> list[str]`
  - `parse_env(cfg: OCRConfig, work_dir: Path) -> dict[str, str]`
  - `parse_timeout(pages: int) -> float` → `max(300.0, 60.0 * pages)`
  - `async run_parse(cmd: list[str], *, env: dict, timeout_s: float, log_path: Path) -> None`
  - `check_parse_log(log_text: str) -> None`
  - `split_pages(merged: str, marker: str, expected: int) -> list[OCRPage]`
  - `otsl_to_html(body: str) -> str`
  - `clean_page_markdown(md: str) -> str`
  - `async ocr_pdf_pages(pdf_bytes: bytes, work_dir: Path, cfg: OCRConfig) -> list[OCRPage]`

- [ ] **Step 1: Write failing tests** in `test_ocr_mac_pages.py`:

```python
def test_build_parse_command_pins_flags(tmp_path):
    cfg = m.OCRConfig(sdk_bin=Path("/v/bin/minicpmvocr"), ocr_url="http://127.0.0.1:18499",
                      model="/h/minicpm-ocr-1.0", ocr_home=Path("/h"))
    cmd = m.build_parse_command(cfg, tmp_path / "in.pdf", tmp_path / "out.md", "<!-- M -->")
    assert cmd[:2] == ["/v/bin/minicpmvocr", "parse"]
    for pair in (["--backend", "openai"], ["--server-url", "http://127.0.0.1:18499"],
                 ["--model", "/h/minicpm-ocr-1.0"], ["--device", "cpu"], ["--workers", "1"],
                 ["--page-delimiter", "<!-- M -->"], ["--layout-model", "/h/PP-DocLayoutV3_infer"],
                 ["--input", str(tmp_path / "in.pdf")], ["--output", str(tmp_path / "out.md")]):
        i = cmd.index(pair[0]); assert cmd[i:i + 2] == pair
    assert "engine.max_model_len=40960" in cmd
    assert "pipeline.merge_cross_page_tables=false" in cmd
    assert "--no-merge-pages" not in cmd

def test_parse_env_is_local_only(tmp_path):
    env = m.parse_env(cfg, tmp_path)
    assert env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] == "True"
    assert env["OCR_ASSETS_DIR"] == "/h"
    assert env["OCR_RUN_ROOT"] == str(tmp_path / "runs")
    assert env["HF_HUB_OFFLINE"] == "1"

def test_parse_timeout():           # 1 page -> 300, 61 pages -> 3660
def test_make_page_marker_is_unique_comment():   # two calls differ; starts "<!-- MACOCR-PAGE-", ends " -->"
def test_split_pages_numbers_pages():  # "a<M>b<M>c", expected 3 -> pages 1..3 with "a","b","c" (stripped)
def test_split_pages_keeps_blank_page():  # "a<M>  \n<M>c" -> page 2 markdown == ""
def test_split_pages_count_mismatch_raises():  # expected 4 for 3 parts -> InvalidPageResult
def test_clean_removes_image_links():  # "x\n\n![image](imgs/p_001/a.png)\n\ny" -> "x\n\ny"
def test_clean_keeps_non_imgs_links():  # "![logo](http://x/y.png)" unchanged
def test_clean_converts_unconverted_otsl():
    # "<otsl><fcel>A<fcel>1.000<nl><fcel>B<ecel><nl></otsl>" ->
    # "<table><tr><td>A</td><td>1.000</td></tr><tr><td>B</td><td></td></tr></table>"
def test_clean_otsl_without_close_ends_at_blank_line():
    # "<otsl><fcel>A<nl>\n\nNext para" -> "<table><tr><td>A</td></tr></table>\n\nNext para"
def test_clean_drops_stray_otsl_tag_keeps_text():
    # "<otsl>BÁO CÁO TÌNH HÌNH\n\nx" -> "BÁO CÁO TÌNH HÌNH\n\nx"
def test_clean_leaves_html_tables_and_vietnamese_untouched():
    # a page with "<table><tr><td>Tiền mặt, vàng bạc, đá quý</td><td>5.630.243</td></tr></table>" unchanged
def test_otsl_spans_and_escaping():
    # lcel/ucel/xcel produce no cell; "&amp;" in a cell stays "&amp;" (unescape then escape)
def test_check_parse_log_accepts_zero_failures():   # '"failed": 0, "failed_blocks": 0' -> no raise
def test_check_parse_log_rejects_failures():        # '"failed_blocks": 2' -> ParseFailed
```

```python
@pytest.mark.anyio
async def test_run_parse_nonzero_exit_raises(tmp_path):
    with pytest.raises(m.ParseFailed):
        await m.run_parse(["/bin/sh", "-c", "exit 3"], env={}, timeout_s=5, log_path=tmp_path / "l")

@pytest.mark.anyio
async def test_run_parse_timeout_kills_process(tmp_path):
    with pytest.raises(m.ParseFailed, match="timed out"):
        await m.run_parse(["/bin/sh", "-c", f"echo $$ > {tmp_path}/pid; sleep 60"],
                          env={}, timeout_s=0.5, log_path=tmp_path / "l")
    pid = int((tmp_path / "pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)

@pytest.mark.anyio
async def test_run_parse_cancel_kills_process(tmp_path):
    # start run_parse as a task with "sleep 60", cancel it, assert CancelledError and pid gone

@pytest.mark.anyio
async def test_ocr_pdf_pages_end_to_end_with_fake_sdk(tmp_path):
    # fake sdk_bin = a small shell/python script that reads --page-delimiter and --output
    # from argv and writes "p1<D>![i](imgs/a.png)p2" there, prints '"failed": 0'.
    # input: a 2-page PDF made with pypdf (PdfWriter().add_blank_page(...) x2)
    # expect [OCRPage(1, "p1"), OCRPage(2, "p2")]
```

- [ ] **Step 2: Run** `cd Financial_analyze/backend && .venv/bin/python -m pytest -q tests/test_ocr_mac_pages.py` — expect collection/attribute failures.

- [ ] **Step 3: Implement** `ocr_mac_pages.py` with the interfaces above.
  - `build_parse_command` flags exactly as the first test; `--layout-model` is `ocr_home / "PP-DocLayoutV3_infer"`; also `--set engine.max_model_len=40960` and `--set pipeline.merge_cross_page_tables=false`.
  - `parse_env`: copy of `os.environ` plus the four values tested.
  - `run_parse`: `asyncio.create_subprocess_exec(..., stdout=log, stderr=STDOUT, start_new_session=True)`; on timeout or cancellation `os.killpg(proc.pid, SIGKILL)` then await the process; on timeout raise `ParseFailed("SDK parse timed out after …s")`; nonzero exit → `ParseFailed` with the last 20 log lines; then `check_parse_log(log text)`.
  - `check_parse_log`: regex `"(failed|failed_blocks|pages_with_failed_blocks)"\s*:\s*(\d+)`; any nonzero → `ParseFailed`.
  - `split_pages`: `merged.split(marker)`, each part `.strip()`, length must equal `expected` else `InvalidPageResult(f"SDK produced {n} pages, PDF has {expected}")`.
  - `clean_page_markdown`: (1) remove `!\[[^\]]*\]\(imgs/[^)]*\)`; (2) for each `<otsl>`: segment ends at `</otsl>` if present, else at the next `\n\n`, else end of text; if the segment contains `<fcel>`, `<ecel>` or `<nl>` replace tag+segment(+`</otsl>`) with `otsl_to_html(segment)`, otherwise remove only the `<otsl>` tag; (3) collapse 3+ newlines to 2 and strip.
  - `otsl_to_html`: port the logic of `spikes/ocr-mac/otsl_to_html.py::otsl_table` (cell text `html.escape(html.unescape(c))`, newlines in a cell → space, `lcel/ucel/xcel` skipped).
  - `ocr_pdf_pages`: write `work_dir/input.pdf`, count pages, marker, command, `run_parse` with `parse_timeout(n)` and `work_dir/parse.log`, read `work_dir/output.md`, `split_pages`, then clean each page.

- [ ] **Step 4: Run tests** (same command) — expect all pass.

- [ ] **Step 5: Checkpoint** — list `Financial_analyze/scripts/ocr_mac_pages.py`, `Financial_analyze/backend/tests/test_ocr_mac_pages.py`. Do not commit.

---

### Task 2: MLX server wrapper and self-test

**Files:**
- Create: `Financial_analyze/scripts/serve_mlx.py`, `Financial_analyze/scripts/ocr_selftest.py`, `Financial_analyze/scripts/assets/ocr_selftest.png`
- Test: `Financial_analyze/backend/tests/test_serve_mlx.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `serve_mlx.strip_stray_think(text: str) -> str`
  - `serve_mlx.patch_model_config(model_dir: Path) -> bool` (True if it changed the file)
  - `serve_mlx.main(argv: list[str] | None = None) -> int` — `--model-dir` (default `<repo>/Financial_analyze/models/ocr/minicpm-ocr-1.0`); host/port fixed `127.0.0.1` / `18499` (no flag to change host).
  - `ocr_selftest.EXPECTED_TEXT = "CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM"`
  - `ocr_selftest.check_selftest_text(text: str) -> None` (raises `RuntimeError`)
  - `ocr_selftest.main(argv) -> int` — `--ocr-url`, `--model`; exit 0/1.

- [ ] **Step 1: Write failing tests:**

```python
def test_strip_stray_think_removes_unclosed_leading_tag():
    assert s.strip_stray_think("<think>\n\n### CỘNG HOÀ") == "### CỘNG HOÀ"
def test_strip_stray_think_keeps_closed_block():
    assert s.strip_stray_think("<think>r</think>\n\nx") == "<think>r</think>\n\nx"
def test_strip_stray_think_keeps_plain_text():
    assert s.strip_stray_think("plain") == "plain"
def test_patch_model_config(tmp_path):
    # config.json {"model_type":"minicpm_ocr","vision_config":{"model_type":"minicpm_ocr_vision"}}
    # generation_config.json {"eos_token_id":[248044,248046]}
    assert s.patch_model_config(tmp_path) is True
    cfg = json.loads((tmp_path / "config.json").read_text())
    assert cfg["model_type"] == "minicpmv4_6"
    assert cfg["vision_config"]["model_type"] == "minicpmv4_6_vision"
    assert cfg["eos_token_id"] == [248044, 248046]
    assert json.loads((tmp_path / "config.orig.json").read_text())["model_type"] == "minicpm_ocr"
    assert s.patch_model_config(tmp_path) is False          # idempotent; orig not overwritten
def test_serve_mlx_imports_without_mlx():   # loading the module by path must not import mlx_vlm
    assert "mlx_vlm" not in sys.modules
def test_selftest_accepts_expected_text():
    t.check_selftest_text("### CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM\nĐộc lập")
def test_selftest_rejects_empty():          # "" -> RuntimeError matching "empty"
def test_selftest_rejects_wrong_text():     # "imatedo:\nMB" -> RuntimeError matching "expected"
```

Matching in `check_selftest_text` is case-insensitive after Unicode NFC normalisation and accepts `HOÀ`/`HÒA` spelling variants (normalise both to `HOA` for the comparison only).

- [ ] **Step 2: Run** `.venv/bin/python -m pytest -q tests/test_serve_mlx.py` — expect failures.

- [ ] **Step 3: Implement.**
  - `serve_mlx.py`: port `spikes/ocr-mac/serve_mlx.py`; move the patch into `install_patch()` which wraps `sys.modules["mlx_vlm.server.app"]._split_thinking_text` so the text passes through `strip_stray_think` first; `main()` sets `HF_HUB_OFFLINE=1`, calls `install_patch()`, builds argv `--host 127.0.0.1 --port 18499 --model <dir> --max-tokens 8192`, calls `mlx_vlm.server.cli.main()`. Keep the docstring that explains why (spec §6.3).
  - `patch_model_config`: write `config.orig.json` only if absent; set the three fields; return whether `config.json` changed.
  - `ocr_selftest.py main()`: uses `minicpmvocr.create_backend` exactly like the spike check (engine `type: "openai"`, `server_url`, `model_name`, `max_model_len: 40960`, `startup_timeout_sec: 60`), `wait_ready(60)`, `recognize(image, "Text Recognition:", max_new_tokens=2048)`, then `check_selftest_text`; print the text on failure.
  - Asset: create from `spikes/ocr-mac/pages/q1-2026_p01.png`, crop `(0, 0, width, height // 4)` (the crop the spike verified), save as `assets/ocr_selftest.png`, ≤ 300 KB (reduce colours/size if larger, then re-run the live check in Step 5).

- [ ] **Step 4: Run tests** — expect pass.

- [ ] **Step 5: Live check** (the spike server must be running, see `spikes/ocr-mac/serve_mlx.py`): `cd /Users/dien/Work/Project/Financial_analyze/spikes/ocr-mac && .minicpm-ocr/bin/python ../../Financial_analyze/scripts/ocr_selftest.py --ocr-url http://127.0.0.1:18499 --model "$PWD/models/minicpm-ocr-1.0"` → exit 0.

- [ ] **Step 6: Checkpoint** — list the four files. Do not commit.

---

### Task 3: Worker protocol rewrite (`ocr_worker.py`)

**Files:**
- Rewrite: `Financial_analyze/scripts/ocr_worker.py`
- Rewrite: `Financial_analyze/backend/tests/test_ocr_worker_protocol.py`

**Interfaces:**
- Consumes (Task 1): `OCRPage`, `OCRConfig`, `InvalidPageResult`, `ParseFailed`, `ocr_pdf_pages`.
- Produces:
  - Constants from Global Constraints plus `OCR_RESULT_FORMAT = "page_markdown_v2"`, `OCR_PAGE_SCHEMA_VERSION = 2`, `OCR_CAPABILITIES = ["page_ack"]`.
  - `hello_message(name: str) -> dict`
  - `validate_welcome(welcome: dict) -> None`, `validate_job_contract(job: dict) -> None` (raise `RuntimeError`, checks exactly as upgrade doc §4–5)
  - `validate_pages(pages: list[OCRPage], page_count: int) -> None` (1..N exactly once; sizes; raises `InvalidPageResult`)
  - `async receive_pdf(ws, job: dict) -> bytes` (keep current behaviour and its three tests)
  - `class JobControl(Exception)` with `.action`
  - `async recv_for_job(ws, job_id: str, timeout: float) -> dict` — returns the next JSON frame for this job; a `job_control` hold/stop frame sends `control_ack` and raises `JobControl`
  - `async send_page(ws, job_id: str, page: OCRPage, page_count: int) -> dict`
  - `async finalize(ws, job_id: str, pages: dict[int, OCRPage], page_count: int) -> dict`
  - `OcrFn = Callable[[bytes, Path], Awaitable[list[OCRPage]]]`
  - `async process_job(ws, job: dict, ocr: OcrFn, work_root: Path, keep_work: bool = False) -> str`
  - `async run_session(connect_url: str, name: str, ocr: OcrFn, work_root: Path, read_code: Callable[[str], Awaitable[str]], keep_work: bool = False) -> None` — one connection
  - `async run_forever(..., sleep=asyncio.sleep) -> None` — reconnect loop
  - `check_ocr_server(ocr_url: str) -> None` (GET `/v1/models`, `SystemExit` with a clear message if unreachable)
  - `main()` CLI: `--connect`, `--name`, `--ocr-url`, `--model`, `--ocr-home`, `--work-root` (default a temp dir), `--keep-work`, `--sdk-bin` (default `<venv B>/bin/minicpmvocr`).

- [ ] **Step 1: Write failing tests.** Keep `_Socket` and the three `receive_pdf` tests. Replace the row tests. Fake sockets script incoming frames and record sent JSON. Tests:

```python
def test_hello_advertises_page_markdown_only():
    h = w.hello_message("Mac OCR (MLX)")
    assert h == {"type": "hello", "name": "Mac OCR (MLX)", "protocolVersion": 1,
                 "resultFormats": ["page_markdown_v2"], "capabilities": ["page_ack"]}
def test_validate_welcome_rejects_row_format():   # selectedResultFormat "structured_rows_v1" -> RuntimeError
def test_validate_job_contract_rejects_wrong_schema():  # resultSchemaVersion 1 -> RuntimeError
def test_validate_pages_requires_each_page_once():  # pages 1,1,3 of 3 -> InvalidPageResult
def test_page_size_limit_counts_utf8_bytes():
    md = "ệ" * (350 * 1024)          # 1,075,200 bytes, ~350k chars
    with pytest.raises(w.InvalidPageResult):
        w.validate_pages([w.OCRPage(1, md)], 1)
def test_document_size_limit():      # 21 pages of 1,000,000 ASCII bytes -> InvalidPageResult
```

```python
@pytest.mark.anyio
async def test_send_page_waits_for_ack():
    # incoming: page_ack status stored -> returns ack; sent[-1] == page_result with
    # schemaVersion 2, page, pageCount, markdown (Vietnamese preserved)
async def test_send_page_retries_identical_after_ack_timeout(monkeypatch):
    # PAGE_ACK_TIMEOUT_SECONDS -> 0.01; first recv times out, second gives already_stored
    # -> two identical page_result frames sent
async def test_send_page_retries_on_persistence_failure():   # page_rejected retryable true, then ack
async def test_send_page_conflict_is_terminal():            # page_rejected page_conflict retryable false -> raises
async def test_finalize_repairs_missing_pages():
    # result_incomplete missingPages [2] -> resend page 2 (ack) -> result_end again -> result_ack returned
async def test_finalize_gives_up_after_repair_rounds():     # 4x result_incomplete -> RuntimeError
async def test_process_job_happy_path(tmp_path):
    # job header + PDF chunks + job_end; fake ocr returns 2 pages; acks; result_ack
    # assert order: progress..., page_result 1, page_result 2, result_end; returns text containing "review"
    # and the work folder under tmp_path is deleted
async def test_process_job_keep_work_keeps_folder(tmp_path):
async def test_hold_during_ocr_cancels_ocr(tmp_path):
    # fake ocr awaits forever; incoming job_control hold -> control_ack sent, ocr task cancelled,
    # returns "hold", no page_result sent
async def test_hold_during_page_send_stops_without_result_end(tmp_path):
    # page 1 ack, then job_control stop instead of page 2 ack -> control_ack, no result_end
async def test_invalid_pages_report_invalid_page_result(tmp_path):
    # fake ocr raises InvalidPageResult -> sent error frame errorCode "invalid_page_result", retryable False
async def test_parse_failure_reports_retryable(tmp_path):
    # fake ocr raises ParseFailed -> errorCode "worker_job_failed", retryable True
async def test_disconnect_mid_ocr_kills_subprocess_and_reconnects(tmp_path):
    # session 1: socket raises ConnectionClosed while fake ocr is running; assert ocr task cancelled
    # and work folder removed; run_forever opens session 2 (fake connect), read_code called twice,
    # sleep called with 1 before session 2; stop the loop by raising KeyboardInterrupt from session 2
async def test_backoff_doubles_to_30_and_resets_after_pairing():
    # connect fails 6x -> sleeps [1, 2, 4, 8, 16, 30]; a paired session resets to 1
def test_check_ocr_server_unreachable_exits():   # port with nothing listening -> SystemExit mentioning start_ocr_mac.sh
```

Inject the connection in `run_forever` with a `connect` parameter (default `websockets.connect`) so tests use fake sockets.

- [ ] **Step 2: Run** `.venv/bin/python -m pytest -q tests/test_ocr_worker_protocol.py` — expect failures.

- [ ] **Step 3: Implement.**
  - Module docstring: Mac worker, page protocol, start via `start_ocr_mac.sh`.
  - Pairing flow kept from the current worker (deny → re-ask code via `read_code`, which wraps `input` in `asyncio.to_thread`); then `validate_welcome`. Print `Paired. workerId=…` and reset backoff.
  - `process_job`: `validate_job_contract`; progress 10; `receive_pdf`; progress 20; create `work_root / job_id`; run `ocr(pdf_bytes, work_dir)` as a task while `recv_for_job` watches for control frames (same pattern as the current worker); progress 90; `validate_pages`; send each page with `send_page`; `finalize`; delete work folder unless `keep_work`; return `f"done — {n} pages, review {reviewId} ready"`. In `finally`: cancel the OCR task if still running and delete the work folder (unless `keep_work`).
  - Errors inside `run_session`'s job loop: `JobControl` → log action; `InvalidPageResult` → error frame `invalid_page_result`, retryable False; `ConnectionClosed` → re-raise; other exceptions → `worker_job_failed`, retryable True.
  - `run_forever`: loop `run_session`; on `OSError` / `websockets.ConnectionClosed` / `asyncio.TimeoutError` sleep backoff (1 → doubling → max 30), reset to 1 after a session that paired. `KeyboardInterrupt` exits.
  - `main()`: `check_ocr_server(args.ocr_url)` before connecting; `ocr = lambda pdf, wd: ocr_pdf_pages(pdf, wd, OCRConfig(...))`.

- [ ] **Step 4: Run tests** — expect pass. Then the whole backend suite: `.venv/bin/python -m pytest -q` — expect no new failures (compare with the count before the task).

- [ ] **Step 5: Checkpoint** — list both files. Do not commit.

---

### Task 4: Setup and start scripts

**Files:**
- Create: `Financial_analyze/scripts/setup_ocr_mac.sh`, `Financial_analyze/scripts/start_ocr_mac.sh`
- Modify: `.gitignore` (add `Financial_analyze/models/`)

**Interfaces:**
- Consumes: `serve_mlx.py` (`main`, `patch_model_config`), `ocr_selftest.py`, `ocr_worker.py` CLI.
- Produces: the two commands the owner runs.

- [ ] **Step 1: Write `setup_ocr_mac.sh`** (`set -euo pipefail`, paths from Global Constraints):
  1. Require `uname -m` = `arm64`, `uv` on PATH, ≥ 10 GB free (`df -g`).
  2. `uv venv .venv-ocr-mlx --python 3.11` + `uv pip install mlx-vlm==0.6.13`.
  3. `uv venv .venv-ocr-sdk --python 3.12 --seed` + `uv pip install "minicpm-ocr[all]==1.0.4" "paddlex==3.4.2" "paddlepaddle==3.2.1" "pypdfium2>=4" websockets pypdf`; `uv pip check`.
  4. Download weights: `.venv-ocr-mlx/bin/hf download openbmb/MiniCPM-OCR-1.0 --revision b2890ab4ce9d18c7f75b90966b76a972b6c9ac58 --local-dir models/ocr/minicpm-ocr-1.0` (skip if `model.safetensors` exists).
  5. `.venv-ocr-mlx/bin/python scripts/serve_mlx.py --patch-config-only` (add this flag to `serve_mlx.main`: calls `patch_model_config` and exits 0).
  6. Fetch layout + upright models: with `OCR_ASSETS_DIR=models/ocr` (absolute) run the SDK once on `scripts/assets/ocr_selftest.png` **while the MLX server is running** (start it in the background, wait for `/v1/models`, run `minicpmvocr parse … --input scripts/assets/ocr_selftest.png --output /tmp…`, stop it). Do **not** set `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK` in this step only.
  7. Print the start command.
  Idempotent: rerunning skips finished steps.

- [ ] **Step 2: Write `start_ocr_mac.sh`**:
  1. Fail with "run scripts/setup_ocr_mac.sh first" if either venv or `models/ocr/minicpm-ocr-1.0/config.orig.json` is missing.
  2. Export `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`, `HF_HUB_OFFLINE=1`, `OCR_ASSETS_DIR=<abs models/ocr>`.
  3. Start `serve_mlx.py` in the background (log to `models/ocr/logs/mlx-server.log`), `trap` EXIT/INT/TERM to kill it.
  4. Wait up to 120 s for `curl --noproxy 127.0.0.1 -fsS http://127.0.0.1:18499/v1/models`.
  5. Run `ocr_selftest.py`; on failure print the log tail and exit 1.
  6. Run the worker in the foreground with `"$@"` passed through.

- [ ] **Step 3: Verify:** `bash -n` both scripts; `shellcheck` if installed (no errors).

- [ ] **Step 4: Run `setup_ocr_mac.sh` for real** (network allowed — one-time downloads). Expect it to finish and be quick on a second run.

- [ ] **Step 5: Stop the spike server** (`pkill -f "spikes/ocr-mac.*serve_mlx.py"` or the spike's background task), then start the real one: `scripts/start_ocr_mac.sh --help` must print worker usage after a passing self-test. Then check `lsof -nP -iTCP:18499 -sTCP:LISTEN` shows `127.0.0.1:18499` only.

- [ ] **Step 6: Checkpoint** — list the scripts and `.gitignore`. Do not commit.

---

### Task 5: Acceptance harness and runs

**Files:**
- Create: `spikes/ocr-mac/run_worker_path.py`

**Interfaces:**
- Consumes: `ocr_mac_pages.ocr_pdf_pages`, `OCRConfig`; spike inputs `spikes/ocr-mac/engines/minicpm-sdk-pdf/src/{doc}.pdf` and `{doc}.keys.json`.
- Produces: `spikes/ocr-mac/engines/worker-path/<key>.md`.

- [ ] **Step 1: Implement `run_worker_path.py`:** imports `ocr_mac_pages` from `Financial_analyze/scripts`; for each `{doc}.pdf` runs `ocr_pdf_pages` with the real `OCRConfig` (venv B `minicpmvocr`, `http://127.0.0.1:18499`, `models/ocr`), maps pages to keys by order, writes `<key>.md`. Run with `Financial_analyze/.venv-ocr-sdk/bin/python`.

- [ ] **Step 2: Run it** with `start_ocr_mac.sh` running (server side), then `spikes/ocr-mac/.venv/bin/python score.py engines/worker-path`. **Pass:** TOTAL num_recall ≥ 99.5%, invented ≤ 1, placed ≥ 98%. Also `grep -c "<otsl>\|!\[" engines/worker-path/*.md` → all 0.

- [ ] **Step 3: Core end-to-end (needs the owner):** with Core running and `start_ocr_mac.sh` paired (owner types the pairing code from the Sync page), upload `docs/archive/MBB_Baocaotaichinh_Q3_2026_Hopnhat.pdf` in the OCR Inbox. **Pass:** review reaches `ready_for_review` with 61 pages; `GET /api/ocr-inbox/reviews/{id}/markdown?source=raw` contains no `<otsl>` and no `![`; peak RSS of server + SDK (sample `ps -o rss=` every 2 s) < 8 GB.

- [ ] **Step 4: Offline check (owner):** owner turns Wi-Fi off, restarts `start_ocr_mac.sh`, OCRs one PDF. **Pass:** self-test and job succeed.

- [ ] **Step 5: Checkpoint** — list `run_worker_path.py` and the measured numbers. Do not commit.

---

### Task 6: Retire the laptop in docs

**Files:**
- Delete: `Financial_analyze/scripts/setup_laptop.sh`
- Modify: `README.md`, `docs/PLAN.md`, `docs/design/SYNC_WORKER_GUIDE.md`, `docs/design/OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md` (top note only), `Financial_analyze/scripts/setup_mac.sh` (only if it mentions the laptop worker)

- [ ] **Step 1:** `grep -rn "setup_laptop\|vllm\|WSL\|GPU laptop\|PaddleOCR-VL" README.md docs/PLAN.md docs/design Financial_analyze/scripts` — list hits.
- [ ] **Step 2:** Replace laptop instructions with: run `Financial_analyze/scripts/setup_ocr_mac.sh` once, then `Financial_analyze/scripts/start_ocr_mac.sh` and enter the Sync-page code. In `PLAN.md` Phase 2, change the first bullet to "Run the Mac OCR worker (MiniCPM-OCR-1.0 on MLX + layout SDK) — see the 2026-11-05 design" and tick it once Task 5 Step 3 passed. Add a one-line note at the top of the upgrade doc that the Mac worker implements it. Leave `docs/plans/` history untouched.
- [ ] **Step 3:** Re-run the Step 1 grep — remaining hits only in history/protocol context.
- [ ] **Step 4: Checkpoint** — list changed files and suggest the commit message:
  `feat(ocr): local Mac OCR worker (MiniCPM-OCR-1.0 on MLX + layout SDK), retire laptop worker`. Do not commit.
