"""PDF processing — text extraction + statement table parsing.

The parse_statements() output mirrors the frontend OCR dialog schema exactly,
so the Reader's "OCR Parse" review table can render backend results unchanged:

    [{"id": "rev", "section": "income", "metric": "Revenue",
      "curr": "130497", "prev": "60922", "page": 49, "confidence": 99}, ...]
"""
import re
import pdfplumber

# (tracker_id, section, metric label, regex for the line item)
STATEMENT_PATTERNS = [
    ("rev",     "income",   "Revenue",             r"(?:total\s+)?revenue|net\s+sales"),
    ("gp",      "income",   "Gross Profit",        r"gross\s+profit"),
    ("oi",      "income",   "Operating Income",    r"operating\s+income"),
    ("ni",      "income",   "Net Income",          r"net\s+income"),
    ("eps",     "income",   "EPS (diluted)",       r"diluted.{0,30}per\s+share|per\s+share.{0,30}diluted"),
    ("cash",    "balance",  "Cash & equivalents",  r"cash\s+and\s+cash\s+equivalents"),
    ("ta",      "balance",  "Total Assets",        r"total\s+assets"),
    ("ltd",     "balance",  "Long-Term Debt",      r"long.term\s+debt"),
    ("te",      "balance",  "Total Equity",        r"total\s+(?:stockholders.?|shareholders.?)\s+equity"),
    ("ocf",     "cashflow", "Operating Cash Flow", r"net\s+cash\s+(?:provided\s+by|from)\s+operating"),
    ("capex",   "cashflow", "CapEx",               r"purchases?\s+of\s+property\s+and\s+equipment"),
    ("buyback", "cashflow", "Buybacks",            r"repurchases?\s+of\s+common\s+stock"),
]

_NUM = r"(\(?\$?\s*[\d,]+(?:\.\d+)?\)?)"


def _parse_number(token: str) -> float:
    stripped = token.strip()
    negative = stripped.startswith("(") and stripped.endswith(")")
    number = float(re.sub(r"[^\d.]", "", stripped))
    return -number if negative else number


def _plain_number(token: str) -> str:
    value = _parse_number(token)
    return f"{value:g}"


def extract_text(path: str, max_pages: int | None = None) -> str:
    out = []
    with pdfplumber.open(path) as pdf:
        pages = pdf.pages if max_pages is None else pdf.pages[:max_pages]
        for page in pages:
            out.append(page.extract_text() or "")
    return "\n".join(out)


def quick_meta(path: str) -> dict:
    """First-pass on upload: page count + key numbers from the first pages."""
    with pdfplumber.open(path) as pdf:
        pages = len(pdf.pages)
        text = "\n".join((p.extract_text() or "") for p in pdf.pages[:8])
    rev = _first_amount(text, r"(?:total\s+)?revenue|net\s+sales")
    ni = _first_amount(text, r"net\s+income")
    return {
        "pages": pages,
        "extracted": {
            "revenue": rev or "", "netIncome": ni or "", "fcf": "",
            "notes": "Auto-extracted on upload. Run OCR Parse for full statement data.",
        },
    }


def page_count(path: str) -> int:
    """Validate a PDF and return its page count without extracting its contents."""
    with pdfplumber.open(path) as document:
        return len(document.pages)


def parse_statements(path: str) -> list[dict]:
    """Scan every page for known statement line items. Returns OCR-dialog rows."""
    rows = []
    found = set()
    with pdfplumber.open(path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            for tid, section, metric, pattern in STATEMENT_PATTERNS:
                if tid in found:
                    continue
                m = re.search(rf"({pattern})[^\n]*?{_NUM}\s+{_NUM}", text, re.IGNORECASE)
                if m:
                    curr, prev = m.group(2), m.group(3)
                    rows.append({
                        "id": tid, "section": section, "metric": metric,
                        "curr": _plain_number(curr),
                        "prev": _plain_number(prev),
                        "page": page_no,
                        # Confidence heuristic: machine text = high; tune with OCR engines
                        "confidence": 95 if len(curr) > 2 else 80,
                    })
                    found.add(tid)
    return rows


def _first_amount(text: str, label_pattern: str) -> str | None:
    m = re.search(rf"(?:{label_pattern})[^\n]*?{_NUM}", text, re.IGNORECASE)
    if not m:
        return None
    try:
        v = _parse_number(m.group(1))
        magnitude = abs(v)
        sign = "-" if v < 0 else ""
        if magnitude >= 1e9:
            return f"{sign}{magnitude/1e9:.1f}B"
        if magnitude >= 1e6:
            return f"{sign}{magnitude/1e6:.1f}M"
        if magnitude >= 1e3:
            return f"{sign}{magnitude/1e3:.1f}K"
        return f"{v:.0f}"
    except ValueError:
        return None
