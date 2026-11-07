"""Run the Mac OCR worker page pipeline (ocr_mac_pages) on the spike PDFs; write <key>.md for score.py.

Usage: Financial_analyze/.venv-ocr-sdk/bin/python spikes/ocr-mac/run_worker_path.py
Needs the MLX server on 127.0.0.1:18499 (serve_mlx.py).
"""
import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ROOT = REPO / "Financial_analyze"
sys.path.insert(0, str(ROOT / "scripts"))
import ocr_mac_pages as om  # noqa: E402

SRC = Path(__file__).resolve().parent / "engines" / "minicpm-sdk-pdf" / "src"
OUT = Path(__file__).resolve().parent / "engines" / "worker-path"
OCR_HOME = ROOT / "models" / "ocr"
CFG = om.OCRConfig(
    sdk_bin=ROOT / ".venv-ocr-sdk" / "bin" / "minicpmvocr",
    ocr_url="http://127.0.0.1:18499",
    model=str(OCR_HOME / "minicpm-ocr-1.0"),
    ocr_home=OCR_HOME,
)


async def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for pdf in sorted(SRC.glob("*.pdf")):
        keys = json.loads((SRC / f"{pdf.stem}.keys.json").read_text())
        t0 = time.time()
        with tempfile.TemporaryDirectory() as wd:
            pages = await om.ocr_pdf_pages(pdf.read_bytes(), Path(wd), CFG)
        if len(pages) != len(keys):
            print(f"{pdf.stem}: {len(pages)} pages vs {len(keys)} keys", file=sys.stderr)
            return 1
        for key, pg in zip(keys, pages):
            (OUT / f"{key}.md").write_text(pg.markdown, encoding="utf-8")
        print(f"{pdf.stem}: {len(pages)} pages in {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
