"""Convert MiniCPM-OCR raw output (<think> block + <otsl> tables) to page markdown
with HTML tables, the format the Core's page_markdown_v2 protocol and score.py use.

OTSL tokens: <fcel> filled cell, <ecel> empty cell, <lcel> merged-left,
<ucel> merged-up, <xcel> merged both, <nl> end of row.

Usage: python otsl_to_html.py <engine_dir>   (reads raw/*.txt, writes *.md)
"""
import html
import re
import sys
from pathlib import Path

TOKEN = re.compile(r"<(fcel|ecel|lcel|ucel|xcel|nl)>")


def otsl_table(body: str) -> str:
    rows, row = [], []
    parts = TOKEN.split(body)
    # parts: [lead, tok, text, tok, text, ...]
    for tok, text in zip(parts[1::2], parts[2::2]):
        if tok == "nl":
            rows.append(row)
            row = []
        elif tok in ("fcel", "ecel"):
            row.append(text.strip() if tok == "fcel" else "")
        # lcel/ucel/xcel: cell covered by a span; no own <td>
    if row:
        rows.append(row)
    trs = "".join(
        "<tr>" + "".join(f"<td>{html.escape(html.unescape(c)).replace(chr(10), ' ')}</td>" for c in r) + "</tr>"
        for r in rows
    )
    return f"<table>{trs}</table>"


def convert(raw: str) -> str:
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.S).strip()
    return re.sub(r"<otsl>(.*?)(?:</otsl>|$)", lambda m: otsl_table(m.group(1)), raw, flags=re.S)


if __name__ == "__main__":
    d = Path(sys.argv[1])
    for f in sorted((d / "raw").glob("*.txt")):
        (d / f"{f.stem}.md").write_text(convert(f.read_text()))
    print("converted", len(list((d / "raw").glob("*.txt"))), "pages")
