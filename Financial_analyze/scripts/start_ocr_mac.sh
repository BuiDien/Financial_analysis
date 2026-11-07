#!/usr/bin/env bash
# Start — Mac OCR worker: local MLX server + self-test + worker (foreground).
# Usage: ./scripts/start_ocr_mac.sh [worker args, e.g. --connect ws://host:8000/ws/ocr]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCR_HOME="$ROOT/models/ocr"
MODEL_DIR="$OCR_HOME/minicpm-ocr-1.0"
VENV_MLX="$ROOT/.venv-ocr-mlx"
VENV_SDK="$ROOT/.venv-ocr-sdk"
LOG_DIR="$OCR_HOME/logs"
LOG="$LOG_DIR/mlx-server.log"
URL="http://127.0.0.1:18499"

if [ ! -x "$VENV_MLX/bin/python" ] || [ ! -x "$VENV_SDK/bin/python" ] || [ ! -f "$MODEL_DIR/config.orig.json" ] \
   || [ ! -f "$OCR_HOME/PP-DocLayoutV3_infer/inference.pdiparams" ] || [ ! -d "$OCR_HOME/paddle_upright" ]; then
  echo "ERROR: OCR runtime not installed - run scripts/setup_ocr_mac.sh first." >&2
  exit 1
fi

export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
export HF_HUB_OFFLINE=1
export OCR_ASSETS_DIR="$OCR_HOME"
export NO_PROXY=127.0.0.1,localhost
export no_proxy=127.0.0.1,localhost

if curl --noproxy 127.0.0.1 -fsS "$URL/v1/models" >/dev/null 2>&1; then
  echo "ERROR: something is already listening on 127.0.0.1:18499 (another start_ocr_mac.sh?)" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

"$VENV_MLX/bin/python" "$ROOT/scripts/serve_mlx.py" --model-dir "$MODEL_DIR" >"$LOG" 2>&1 &
SERVER_PID=$!

echo "-- Waiting for MLX server (up to 120 s) --"
READY=0
for _ in $(seq 1 120); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  if curl --noproxy 127.0.0.1 -fsS "$URL/v1/models" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "ERROR: MLX server did not become ready. Log tail:" >&2
  tail -n 30 "$LOG" >&2
  exit 1
fi

echo "-- Self-test --"
if ! "$VENV_SDK/bin/python" "$ROOT/scripts/ocr_selftest.py" --ocr-url "$URL" --model "$MODEL_DIR"; then
  echo "ERROR: OCR self-test failed. Log tail:" >&2
  tail -n 30 "$LOG" >&2
  exit 1
fi

# Not exec: the trap must stay alive to stop the MLX server when the worker exits.
"$VENV_SDK/bin/python" "$ROOT/scripts/ocr_worker.py" \
  --ocr-url "$URL" --model "$MODEL_DIR" --ocr-home "$OCR_HOME" --sdk-bin "$VENV_SDK/bin/minicpmvocr" "$@"
