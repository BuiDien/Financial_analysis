"""Local OpenAI-format server for MiniCPM-OCR-1.0 on MLX (mlx-vlm), for the minicpm-ocr SDK.

Why a wrapper: with thinking disabled, the chat template already closes the think block, but
the model still starts its answer with a stray "<think>\\n\\n" and never closes it. mlx-vlm's
splitter then files the whole answer under `reasoning_content`, and the SDK (which reads
`content`) gets an empty string. This strips one unclosed leading "<think>" before the split.
Non-streaming responses only (the SDK sends stream=False). See design spec section 6.3.

Binds 127.0.0.1:18499 only. mlx_vlm is imported lazily so this module loads without it.
"""
import argparse
import json
import os
import sys
from pathlib import Path

HOST = "127.0.0.1"
PORT = 18499
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / "ocr" / "minicpm-ocr-1.0"


def strip_stray_think(text: str) -> str:
    """Drop one unclosed leading <think> tag; leave closed blocks and plain text alone."""
    if text:
        head = text.lstrip()
        if head.startswith("<think>") and "</think>" not in head:
            return head[len("<think>"):].lstrip()
    return text


def patch_model_config(model_dir: Path) -> bool:
    """Make the checkpoint loadable by mlx-vlm. Returns True if config.json changed."""
    model_dir = Path(model_dir)
    cfg_path = model_dir / "config.json"
    original = cfg_path.read_text()
    cfg = json.loads(original)
    orig_path = model_dir / "config.orig.json"
    if not orig_path.exists():
        orig_path.write_text(original)
    cfg["model_type"] = "minicpmv4_6"
    cfg.setdefault("vision_config", {})["model_type"] = "minicpmv4_6_vision"
    gen_path = model_dir / "generation_config.json"
    if gen_path.exists():
        eos = json.loads(gen_path.read_text()).get("eos_token_id")
        if eos is not None:
            cfg["eos_token_id"] = eos
    if cfg == json.loads(original):
        return False
    cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
    return True


def install_patch() -> None:
    import mlx_vlm.server.app  # noqa: F401  (load the module; the package attr is the FastAPI app)

    app_mod = sys.modules["mlx_vlm.server.app"]
    orig_split = app_mod._split_thinking_text

    def split_without_stray_think(text, *args, **kwargs):
        return orig_split(strip_stray_think(text), *args, **kwargs)

    app_mod._split_thinking_text = split_without_stray_think


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--patch-config-only", action="store_true",
                        help="patch config.json for mlx-vlm and exit (used by setup)")
    args = parser.parse_args(argv)
    os.environ["HF_HUB_OFFLINE"] = "1"
    patch_model_config(args.model_dir)
    if args.patch_config_only:
        return 0
    install_patch()
    from mlx_vlm.server.cli import main as mlx_main

    sys.argv = [sys.argv[0], "--host", HOST, "--port", str(PORT),
                "--model", str(args.model_dir), "--max-tokens", "8192"]
    return mlx_main() or 0


if __name__ == "__main__":
    sys.exit(main())
