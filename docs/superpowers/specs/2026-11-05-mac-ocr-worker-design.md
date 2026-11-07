# Mac OCR Worker — Design

Date: 2026-11-05
Status: draft for review
Spike evidence: `spikes/ocr-mac/` (scoring harness, engine outputs, `serve_mlx.py`)

## 1. Intent

Replace the GPU laptop (WSL + vLLM + PaddleOCR-VL) with an OCR worker that runs on the Mac
(M2 Max, 64 GB) next to Core. The owner wants:

- **Fully local.** No cloud service at runtime. One-time downloads (pip packages, model weights)
  are fine; afterwards OCR must work with the network off.
- **Low resource use.** The Mac also runs Core, Hermes and the owner's daily work.
- **Better OCR than the laptop**, measured, not assumed.

The spike settled the engine: the `minicpm-ocr` SDK (layout detection with PP-DocLayoutV3,
then region recognition) with **MiniCPM-OCR-1.0 running on MLX**. On the 9 human-reviewed
answer-key pages and the 61-page MBB Q3 2026 statement:

| Engine | Number recall | Invented numbers | Placed in the right row | CER | Speed | Memory |
|---|---|---|---|---|---|---|
| Laptop (current) | 99.0% | 2 | 89.7% | 0.031* | — | GPU laptop |
| **SDK + layout + MLX (chosen)** | 99.5% | 1 | 98.5% | 0.115 | 9.8 s/page | ~3.1 GB server + ~2.0 GB SDK |

\* The answer key was made by correcting the laptop's own output, so laptop CER is biased low.

The row above was measured on page images pre-rendered at 200 DPI. The worker's route — the SDK
rendering the PDF itself — was measured too, on single-page PDFs cut from the three source
documents (`spikes/ocr-mac/engines/minicpm-sdk-pdf/`): identical number results (99.5% / 1 / 98.5%),
CER 0.138 (slightly worse text on the cover page).

On the 61-page document there were no failed pages or regions, and every balance-sheet total
(assets = liabilities + equity, both columns) was present and consistent.

## 2. Goals

1. A worker on the Mac that connects to Core's existing WebSocket (`/ws/ocr`) and speaks the
   existing `page_markdown_v2` protocol exactly as documented in `docs/design/OCR_PROTOCOL.md`.
2. **No change to Core**: OCR Inbox, page review, Hermes label correction and Obsidian keep
   working unchanged.
3. One command starts the whole OCR side by hand; Ctrl+C stops all of it.
4. Accuracy on the answer-key pages at least as good as the spike (section 9).

## 3. Non-goals (this version)

- Starting automatically (launchd or Core starting it). The owner said: by hand first, automatic
  start in a later version.
- Structured TT200 rows or `Ma so` placement — still Phase 2 of `PLAN.md`, a later stage.
- Quality scoring with MiniCPM-OCR Jev — a possible later addition for flagging pages.
- Fine-tuning (e.g. Unsloth) on corrected pages.
- Authentication and CORS work in Core (`PLAN.md` Phase 0 items, separate).

## 4. Anti-goals (failure even if it "works")

- Anything that sends document content or page images off the Mac.
- Any server listening on an address other than `127.0.0.1`.
- Invented numbers or fake row fields (`code`, `id`, `bbox`) — the page protocol has none.
- Silent edits to OCR text. Cleanup is limited to the rules in section 6.4.
- Breaking Core's legacy `structured_rows_v1` support (Core stays as is).

## 5. Decided by the owner

| Decision | Source |
|---|---|
| Replace the laptop completely; no laptop fallback | owner |
| Fully local runtime | owner |
| MLX, not Ollama | owner |
| MiniCPM-OCR-1.0 official weights | owner |
| SDK + local server route ("OpenAI-format" server on 127.0.0.1) | owner |
| Start by hand for now; automatic start later | owner |
| Remaining choices played back and accepted ("ok") | owner, 2026-11-05 |

## 6. Design

### 6.1 Processes

```
start_ocr_mac.sh (one command, by hand)
 ├─ MLX model server   serve_mlx.py       127.0.0.1:18499   venv A (Python 3.11, mlx-vlm)
 └─ OCR worker         ocr_worker.py      → ws://127.0.0.1:8000/ws/ocr   venv B (Python 3.12, SDK)
                         └─ per job: minicpmvocr parse … (subprocess, venv B)
```

- The start script launches the MLX server, waits until `GET /v1/models` answers, runs a
  one-crop self-test (section 6.3), then starts the worker in the foreground. Ctrl+C stops both.
- *(Design call.)* A dropped WebSocket or a Core restart does **not** stop the OCR side. Core makes
  a new pairing code on every start, so the worker reconnects with backoff (1 s doubling to 30 s),
  then asks for the code again. The MLX server stays loaded. A job that was mid-parse or mid-upload
  is abandoned: the SDK subprocess is killed and the work folder deleted. Core already fails that
  attempt and may retry it once.
- Two virtual environments are required: MLX needs the 3.11 venv the spike used; the SDK requires
  Python ≥3.10 with PaddlePaddle 3.2.1 (3.12 used in the spike). The SDK documentation itself
  says to keep it separate from the inference environment.
- The worker handles one job at a time. Core already queues further jobs.

### 6.2 Pinned components

| Component | Version |
|---|---|
| `mlx-vlm` (pulls `mlx`) | 0.6.13 (mlx 0.32.4) |
| MiniCPM-OCR-1.0 weights | `openbmb/MiniCPM-OCR-1.0` revision `b2890ab4ce9d18c7f75b90966b76a972b6c9ac58` |
| `minicpm-ocr` SDK | 1.0.4, extra `[all]` |
| `paddlepaddle` (CPU) / `paddlex` | 3.2.1 / 3.4.2 |
| Layout models | `PP-DocLayoutV3_infer`, `paddle_upright` (downloaded once by the SDK) |

Model config: `mlx-vlm` 0.6.13 has no `minicpm_ocr` type. The local `config.json` points
`model_type` at `minicpmv4_6` and `vision_config.model_type` at `minicpmv4_6_vision` and adds
`eos_token_id: [248044, 248046]` from `generation_config.json`. The original stays as
`config.orig.json`. Loading is strict: a weight that does not fit aborts. Setup applies this
edit, never by hand.

### 6.3 MLX server (`serve_mlx.py`)

Carried over from the spike. It wraps `mlx_vlm.server` and:

- binds `127.0.0.1:18499`, sets `HF_HUB_OFFLINE=1`, preloads the local model, `--max-tokens 8192`;
- **fixes the empty-answer bug**: the model starts every answer with a stray `<think>` it never
  closes, so `mlx-vlm` files the whole answer under `reasoning_content` and the SDK (which reads
  `content`) gets nothing. The wrapper strips one unclosed leading `<think>` before the server's
  thinking split. (Banning the token with `logit_bias` was tried and rejected: it corrupted the
  start of the text.)

This patch touches `mlx-vlm` internals (`mlx_vlm.server.app._split_thinking_text`), so it is tied
to the pinned version. The start script's **self-test** guards it: send one fixed test crop and
fail start-up loudly if `content` is empty or does not contain the expected text.

### 6.4 OCR worker (`Financial_analyze/scripts/ocr_worker.py`)

The repository reference worker is rewritten in place into the Mac page worker. Transport code
that already works is kept (binary PDF receive with byte-count check, hold/stop handling, pairing
with code re-entry). The row/v1 parts and the stub `run_ocr()` are removed.

**Protocol:** exactly `docs/design/OCR_WORKER_PAGE_MARKDOWN_V2_UPGRADE.md` — hello with
`resultFormats: ["page_markdown_v2"]` and `capabilities: ["page_ack"]`, strict welcome and job
header checks, one `page_result` per page with a durable `page_ack` before moving on, identical
retries on a lost ack, `result_end`, repair of `result_incomplete` pages, completion only after
`result_ack`. Constants and limits as listed in that document.

**Defaults:** `--connect ws://127.0.0.1:8000/ws/ocr`, `--name "Mac OCR (MLX)"`,
`--ocr-url http://127.0.0.1:18499`. Pairing stays as Core requires: the worker asks for the code
shown on the Sync page.

**OCR step per job:**

1. Write the received PDF into a per-job work folder and count pages with `pypdf`.
2. Run `minicpmvocr parse --backend openai --server-url <ocr-url> --model <model path>
   --device cpu --workers 1 --set engine.max_model_len=40960 --layout-model <local dir>
   --page-delimiter "<per-job random marker>" --output <file>.md` as a subprocess, with
   `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True` so PaddleX does not contact model hosts.
   Do **not** pass `--no-merge-pages`: in SDK 1.0.4 it fails on every multi-page PDF
   (`cli.py`: "Multiple pages generated; remove --no-merge-pages…"). Pass
   `--set pipeline.merge_cross_page_tables=false` explicitly (the 1.0.4 default): when on, the SDK
   joins tables across pages, which would move content off its source page.
3. *(Design call.)* Split the merged Markdown on the per-job random marker (e.g.
   `<!-- MACOCR-PAGE-<uuid4> -->`). It must yield exactly one part per PDF page `1..N`; otherwise
   the job fails (no guessing page boundaries from headings). This source was chosen over the
   `--json` `pages[]` because the merged Markdown has already been through the SDK's table
   post-processing, while the JSON page content is raw model output (OTSL). On the answer-key
   pages both scored identically.
4. Clean each page's Markdown (only these rules):
   - remove image links `![…](imgs/…)` — Core cannot show those files;
   - convert a well-formed `<otsl>…` block that the SDK left unconverted to an HTML `<table>`
     (same rules as the spike's `otsl_to_html.py`);
   - drop a stray `<otsl>` tag that has no OTSL cell tokens after it, keeping the text.
   The 61-page spike run had 6 such leftovers; the rules were derived from them.
5. Send pages through the protocol. The worker sends progress while parsing (based on pages done,
   if the SDK reports it; otherwise coarse steps).
6. After `result_ack`, delete the work folder (`--keep-work` keeps it for diagnosis).

**Hold/stop:** a `job_control` message kills the SDK subprocess, sends `control_ack`, and frees the
work folder.

**Failures:**

| Case | Worker reports |
|---|---|
| MLX server not reachable at start | exits before pairing, with a clear message |
| SDK subprocess fails or times out | `error`, `worker_job_failed`, retryable |
| SDK reports failed pages/regions | `error`, `worker_job_failed`, retryable |
| Page count from SDK ≠ PDF page count | `error`, `invalid_page_result`, not retryable |
| Page over 1 MiB / document over 20 MiB | `error`, `invalid_page_result`, not retryable |

*(Design call.)* `invalid_page_result` matches Core's own page contract
(`ocr_page_contract.py`) instead of the row path's `invalid_result`.

### 6.5 Setup (`Financial_analyze/scripts/setup_ocr_mac.sh`)

Run once, needs the network:

- check Apple Silicon, `uv`, free disk (~10 GB);
- create venv A (`.venv-ocr-mlx`, Python 3.11) and venv B (`.venv-ocr-sdk`, Python 3.12) with the
  pinned packages;
- download the model at the pinned revision into `Financial_analyze/models/ocr/`, write the
  config edit, keep `config.orig.json`;
- run the SDK once to fetch the layout models into the same folder;
- finish with the self-test of section 6.3.

Models and venvs are gitignored. `start_ocr_mac.sh` never downloads anything.

### 6.6 Retiring the laptop

- Delete `Financial_analyze/scripts/setup_laptop.sh`.
- Update `README.md`, `docs/PLAN.md` (Phase 2 OCR line), `docs/design/SYNC_WORKER_GUIDE.md` and
  the worker upgrade documents to describe the Mac worker. Old plans in `docs/plans/` stay as
  history.
- Core's `structured_rows_v1` code stays (out of scope; Core is not changed).

## 7. What the spike keeps

The `spikes/ocr-mac/` harness stays as the accuracy check: `score.py`, `test_score.py`,
`export_truth.py`, `render_pages.py`. It gets one new helper or flag so it can score Markdown
produced by the real worker path (section 9).

## 8. Testing

- **Unit (Core test suite, `backend/tests/test_ocr_worker_protocol.py`, rewritten):** receive and
  byte-count checks; hello/welcome/job-header contract checks; page sending with ack, lost-ack
  retry, `page_rejected`, `result_incomplete` repair, `result_ack`; hold/stop kills the
  subprocess; SDK JSON → pages mapping including blank pages and count mismatch; each cleanup
  rule.
- **Wrapper:** a test that the stray-`<think>` fix turns `"<think>\n\ntext"` into content `"text"`
  and leaves closed think blocks and plain text alone.
- **No network in unit tests**; the SDK subprocess is faked.

## 9. Acceptance

1. On the 9 answer-key pages: number recall ≥ 99.5%, invented numbers ≤ 1, placed ≥ 98%.
   "Real worker path" means the worker's own OCR step and cleanup (section 6.4 steps 2–4) run on
   the single-page PDFs cut from the source documents, without Core — the same inputs as
   `spikes/ocr-mac/engines/minicpm-sdk-pdf/src/`. The harness gets a small script that does this
   and writes `<key>.md` files for `score.py`. Core end-to-end is covered by item 2.
2. The 61-page MBB Q3 2026 PDF uploaded in the OCR Inbox ends `ready_for_review` with 61 pages,
   with no `<otsl>` or `![` left in any page.
3. **Offline run:** with Wi-Fi off, the start script and one full job succeed. (The owner switches
   Wi-Fi off; the builder cannot.)
4. `lsof -iTCP -sTCP:LISTEN` shows the MLX server only on `127.0.0.1`.
5. Peak memory of server plus SDK under 8 GB during the 61-page job.
6. Backend tests pass.

## 10. Left to the builder

- Exact file layout of the worker module (one file or a small package), as long as the test file
  can import it.
- How progress is derived from the SDK.
- Subprocess timeout values (suggested: 60 s per page, minimum 5 min).
- The fixed test crop for the self-test (a small Vietnamese text crop committed under
  `Financial_analyze/scripts/` or generated from a test PDF).
