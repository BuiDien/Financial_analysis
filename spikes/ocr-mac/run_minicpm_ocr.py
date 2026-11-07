"""Run openbmb/MiniCPM-OCR-1.0 (official BF16 weights) with MLX on page images.

mlx-vlm 0.6.13 has no "minicpm_ocr" model type; the local config is pointed at
its MiniCPM-V 4.6 architecture code (the base the OCR model was trained on).
Original config kept as models/minicpm-ocr-1.0/config.orig.json. Loads strict:
any weight that does not fit the architecture aborts the run.

Usage: .venv/bin/python run_minicpm_ocr.py <out_dir> <prompt> <png> [<png> ...]
  prompt e.g. "Text Recognition:" or "Table Recognition:" (model card prompts)
Writes <out_dir>/raw/<stem>.txt and appends to <out_dir>/timing.tsv.
"""
import sys
import time
from pathlib import Path

import mlx.core as mx
from mlx_vlm import generate, load
from mlx_vlm.prompt_utils import apply_chat_template

MODEL_DIR = Path(__file__).parent / "models" / "minicpm-ocr-1.0"

out, prompt_text, pngs = Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
(out / "raw").mkdir(parents=True, exist_ok=True)
timing = out / "timing.tsv"
if not timing.exists():
    timing.write_text("page\tprompt\tseconds\tprompt_tokens\tgen_tokens\tgen_tps\tpeak_gb\n")

t0 = time.time()
model, processor = load(str(MODEL_DIR))  # strict=True
print(f"model loaded in {time.time() - t0:.1f}s", flush=True)
prompt = apply_chat_template(processor, model.config, prompt_text, num_images=1,
                             enable_thinking=False)

for png in map(Path, pngs):
    mx.reset_peak_memory()
    t = time.time()
    res = generate(model, processor, prompt, image=[str(png)],
                   max_tokens=8192, temperature=0.0, verbose=False)
    secs = time.time() - t
    (out / "raw" / f"{png.stem}.txt").write_text(res.text)
    with timing.open("a") as f:
        f.write(f"{png.stem}\t{prompt_text}\t{secs:.1f}\t{res.prompt_tokens}\t"
                f"{res.generation_tokens}\t{res.generation_tps:.1f}\t"
                f"{mx.get_peak_memory() / 1e9:.2f}\n")
    print(f"{png.stem}: {secs:.1f}s, {res.generation_tokens} tok", flush=True)
