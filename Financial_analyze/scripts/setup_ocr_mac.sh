#!/usr/bin/env bash
# Setup — Mac OCR worker (fully local MiniCPM-OCR on MLX + minicpm-ocr SDK).
# Run once: ./scripts/setup_ocr_mac.sh   (idempotent; reruns skip finished steps)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCR_HOME="$ROOT/models/ocr"
MODEL_DIR="$OCR_HOME/minicpm-ocr-1.0"
VENV_MLX="$ROOT/.venv-ocr-mlx"
VENV_SDK="$ROOT/.venv-ocr-sdk"
MODEL_REV="b2890ab4ce9d18c7f75b90966b76a972b6c9ac58"
PORT=18499
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "== Mac OCR worker setup =="
echo "Root: $ROOT"

# 1. Preconditions
[ "$(uname -m)" = "arm64" ] || { echo "ERROR: needs Apple Silicon (arm64)." >&2; exit 1; }
command -v uv >/dev/null 2>&1 || { echo "ERROR: 'uv' not on PATH (brew install uv)." >&2; exit 1; }
FREE_GB="$(df -g "$ROOT" | awk 'NR==2 {print $4}')"
if [ "${FREE_GB:-0}" -lt 10 ]; then
  echo "ERROR: need >= 10 GB free, have ${FREE_GB} GB." >&2
  exit 1
fi
mkdir -p "$OCR_HOME/logs"

# 2. venv A: MLX server (py3.11)
if [ ! -x "$VENV_MLX/bin/python" ]; then
  echo "-- Creating $VENV_MLX --"
  uv venv "$VENV_MLX" --python 3.11
fi
if ! "$VENV_MLX/bin/python" -c "import mlx_vlm" >/dev/null 2>&1; then
  echo "-- Installing mlx-vlm==0.6.13 --"
  uv pip install --python "$VENV_MLX/bin/python" "mlx-vlm==0.6.13"
else
  echo "-- mlx-vlm already installed --"
fi

# 3. venv B: SDK + worker deps (py3.12)
if [ ! -x "$VENV_SDK/bin/python" ]; then
  echo "-- Creating $VENV_SDK --"
  uv venv "$VENV_SDK" --python 3.12 --seed
fi
if [ ! -x "$VENV_SDK/bin/minicpmvocr" ] || ! "$VENV_SDK/bin/python" -c "import websockets, pypdf, pypdfium2, paddle" >/dev/null 2>&1; then
  echo "-- Installing SDK packages --"
  uv pip install --python "$VENV_SDK/bin/python" \
    "minicpm-ocr[all]==1.0.4" "paddlex==3.4.2" "paddlepaddle==3.2.1" \
    "pypdfium2>=4" "websockets>=16" pypdf
else
  echo "-- SDK packages already installed --"
fi
uv pip check --python "$VENV_SDK/bin/python"

# 4. Weights
if [ -f "$MODEL_DIR/model.safetensors" ]; then
  echo "-- Weights already present --"
else
  echo "-- Downloading openbmb/MiniCPM-OCR-1.0 @ $MODEL_REV (~2.4 GB) --"
  "$VENV_MLX/bin/hf" download openbmb/MiniCPM-OCR-1.0 --revision "$MODEL_REV" --local-dir "$MODEL_DIR"
fi

# 5. Patch config.json for mlx-vlm
"$VENV_MLX/bin/python" "$ROOT/scripts/serve_mlx.py" --model-dir "$MODEL_DIR" --patch-config-only
echo "-- Model config patched --"

# 6. Layout + upright models (downloaded by the SDK on first parse; needs the MLX server up)
if [ -f "$OCR_HOME/PP-DocLayoutV3_infer/inference.pdiparams" ] && [ -d "$OCR_HOME/paddle_upright" ]; then
  echo "-- Layout/upright models already present --"
else
  echo "-- Fetching layout/upright models (one-time network) --"
  if curl --noproxy 127.0.0.1 -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
    echo "ERROR: something is already listening on 127.0.0.1:$PORT; stop it and rerun." >&2
    exit 1
  fi
  "$VENV_MLX/bin/python" "$ROOT/scripts/serve_mlx.py" --model-dir "$MODEL_DIR" \
    >"$OCR_HOME/logs/setup-mlx-server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    curl --noproxy 127.0.0.1 -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "ERROR: MLX server died; see $OCR_HOME/logs/setup-mlx-server.log" >&2; exit 1; }
    sleep 1
  done
  TMP="$(mktemp -d)"
  # No --layout-model: an explicit one disables the SDK auto-download into OCR_ASSETS_DIR.
  # PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK deliberately unset here: this is the only networked run.
  env -u PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK OCR_ASSETS_DIR="$OCR_HOME" OCR_RUN_ROOT="$TMP/runs" \
    "$VENV_SDK/bin/minicpmvocr" parse \
      --backend openai --server-url "http://127.0.0.1:$PORT" --model "$MODEL_DIR" \
      --device cpu --workers 1 \
      --set engine.max_model_len=40960 \
      --input "$ROOT/scripts/assets/ocr_selftest.png" --output "$TMP/out.md"
  rm -rf "$TMP"
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  [ -f "$OCR_HOME/PP-DocLayoutV3_infer/inference.pdiparams" ] && [ -d "$OCR_HOME/paddle_upright" ] \
    || { echo "ERROR: layout/upright models not found under $OCR_HOME after parse." >&2; exit 1; }
fi

# 7. Final self-test (fully offline run of the real pipeline)
echo "-- Final self-test --"
if curl --noproxy 127.0.0.1 -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
  echo "ERROR: something is already listening on 127.0.0.1:$PORT; stop it and rerun." >&2
  exit 1
fi
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True HF_HUB_OFFLINE=1 OCR_ASSETS_DIR="$OCR_HOME"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
"$VENV_MLX/bin/python" "$ROOT/scripts/serve_mlx.py" --model-dir "$MODEL_DIR" \
  >"$OCR_HOME/logs/setup-mlx-server.log" 2>&1 &
SERVER_PID=$!
READY=0
for _ in $(seq 1 120); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  if curl --noproxy 127.0.0.1 -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "ERROR: MLX server did not become ready; see $OCR_HOME/logs/setup-mlx-server.log" >&2
  exit 1
fi
if ! "$VENV_SDK/bin/python" "$ROOT/scripts/ocr_selftest.py" --ocr-url "http://127.0.0.1:$PORT" --model "$MODEL_DIR"; then
  echo "ERROR: OCR self-test failed; see $OCR_HOME/logs/setup-mlx-server.log" >&2
  exit 1
fi
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo
echo "== Setup complete. Start the worker with: =="
echo "   $ROOT/scripts/start_ocr_mac.sh"
