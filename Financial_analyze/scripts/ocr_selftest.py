"""Send one image crop through the minicpm-ocr SDK client and check the OCR server answers sanely."""
import argparse
import sys
import unicodedata
from pathlib import Path

EXPECTED_TEXT = "CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM"
REQUIRED_FRAGMENTS = ("CỘNG HOÀ XÃ HỘI", "VIỆT NAM")
ASSET = Path(__file__).resolve().parent / "assets" / "ocr_selftest.png"


def _norm(text: str) -> str:
    t = unicodedata.normalize("NFC", text).upper()
    return t.replace("HÒA", "HOA").replace("HOÀ", "HOA")


def check_selftest_text(text: str) -> None:
    if not text or not text.strip():
        raise RuntimeError("OCR self-test returned empty text")
    n = _norm(text)
    if not all(_norm(f) in n for f in REQUIRED_FRAGMENTS):
        raise RuntimeError(f"OCR self-test text did not match expected {EXPECTED_TEXT!r}: {text!r}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ocr-url", default="http://127.0.0.1:18499")
    parser.add_argument("--model", required=True)
    args = parser.parse_args(argv)
    text = ""
    try:
        from minicpmvocr import create_backend
        from PIL import Image

        cfg = {"engine": {"type": "openai", "server_url": args.ocr_url, "model_name": args.model,
                          "max_model_len": 40960, "startup_timeout_sec": 60}}
        backend = create_backend(cfg)
        backend.wait_ready(60)
        with Image.open(ASSET) as img:
            image = img.convert("RGB")
        result = backend.recognize(image, "Text Recognition:", max_new_tokens=2048)
        text = result.get("text") or ""
        check_selftest_text(text)
    except Exception as exc:
        print(f"OCR self-test FAILED: {exc}", file=sys.stderr)
        if text:
            print(text, file=sys.stderr)
        return 1
    print("OCR self-test OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
