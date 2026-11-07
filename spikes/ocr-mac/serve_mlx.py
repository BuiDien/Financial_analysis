"""Local OpenAI-format server for MiniCPM-OCR-1.0 on MLX (mlx-vlm 0.6.13), for the minicpm-ocr SDK.

Why a wrapper: with thinking disabled, the chat template already closes the think block, but
the model still starts its answer with a stray "<think>\n\n" and never closes it. mlx-vlm's
splitter then files the whole answer under `reasoning_content`, and the SDK (which reads
`content`) gets an empty string. This strips one unclosed leading "<think>" before the split.
Non-streaming responses only (the SDK sends stream=False).

Usage: .venv/bin/python serve_mlx.py   (binds 127.0.0.1:18499 only)
"""
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")

import mlx_vlm.server.app  # noqa: E402,F401  (load the module; the package attr is the FastAPI app)

app_mod = sys.modules["mlx_vlm.server.app"]
_orig_split = app_mod._split_thinking_text


def _split_without_stray_think(text, *args, **kwargs):
    if text:
        head = text.lstrip()
        if head.startswith("<think>") and "</think>" not in head:
            text = head[len("<think>"):].lstrip()
    return _orig_split(text, *args, **kwargs)


app_mod._split_thinking_text = _split_without_stray_think

from mlx_vlm.server.cli import main  # noqa: E402

MODEL_DIR = Path(__file__).resolve().parent / "models" / "minicpm-ocr-1.0"
sys.argv = [sys.argv[0], "--host", "127.0.0.1", "--port", "18499",
            "--model", str(MODEL_DIR), "--max-tokens", "8192", *sys.argv[1:]]
sys.exit(main())
