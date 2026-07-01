#!/usr/bin/env bash
# Setup — GPU laptop (OCR worker: PaddleOCR-VL served via vLLM, RTX 4070 8GB target).
# Linux + NVIDIA/CUDA assumed (vLLM's supported path). Run once per machine:
#   ./scripts/setup_laptop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT/scripts"
VENV="$ROOT/.venv-ocr"

echo "== Helix / Financial Analyze — OCR worker (laptop) setup =="

# ── 1. GPU sanity check ───────────────────────────────────────────────
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "ERROR: nvidia-smi not found. vLLM needs a CUDA-visible NVIDIA GPU (RTX 4070 per PLAN.md)." >&2
  exit 1
fi
echo "-- GPU:"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader

# ── 2. Python venv ─────────────────────────────────────────────────────
PY="${PYTHON_BIN:-python3}"
if [ ! -d "$VENV" ]; then
  echo "-- Creating $VENV --"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --upgrade pip

# ── 3. vLLM + worker client deps ──────────────────────────────────────
# PaddleOCR-VL is a 0.9B VLM — comfortably fits an 8GB card via vLLM.
# (PaddlePaddle/PaddleOCR-VL on Hugging Face; officially vLLM-supported.)
echo "-- Installing vLLM + worker deps (this pulls torch/CUDA wheels, large) --"
"$VENV/bin/pip" install -q vllm websockets pypdf

MODEL="${OCR_MODEL:-PaddlePaddle/PaddleOCR-VL}"
echo
echo "== Laptop setup done =="
echo "1) Start the OCR model server (separate terminal, leave running):"
echo "     $VENV/bin/vllm serve $MODEL --trust-remote-code --gpu-memory-utilization 0.85 --port 8001"
echo "2) Start the worker (dials the Mac, pass the pairing code shown on its Sync page):"
echo "     $VENV/bin/python \"$WORKER_DIR/ocr_worker.py\" --connect ws://<mac-host>:8000/ws/ocr --code ABC-DEF --vllm-url http://localhost:8001"
echo
echo "Notes:"
echo "  - <mac-host> = the Mac's LAN hostname/IP shown on the Sync page (page-sync.jsx)."
echo "  - --gpu-memory-utilization 0.85 leaves headroom on an 8GB card; lower it if vLLM OOMs."
echo "  - ocr_worker.py's row-extraction (PaddleOCR-VL output -> TT200 Ma so rows) is a stub —"
echo "    see the TODO in that file. Wiring real table->row parsing is unscheduled (PLAN.md Stage 8)."
