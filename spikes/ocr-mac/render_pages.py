"""Render every manifest page to pages/<key>.png at 200 DPI."""
import json
from pathlib import Path
import pypdfium2 as pdfium

for m in json.loads(Path("manifest.json").read_text()):
    pdf = pdfium.PdfDocument(m["pdf"])
    img = pdf[m["page"] - 1].render(scale=200 / 72).to_pil()
    img.save(f"pages/{m['key']}.png")
    print(m["key"], img.size)
