"""Parse SSI "Thông báo kết quả giao dịch" (Matched Order Report) PDFs.

The PDF has a real text layer (Crystal Reports). pypdf glues neighbouring
cells together, so we use pdfplumber words (with x positions) instead.

A data row reads, left to right:
    STT  trade_date  settle_date  Mua|Bán  TICKER  qty price value fee
         [sell_tax] [pit_qty pit_price pit_amount pit_tax]  amount
Empty cells are simply absent, so the optional groups are told apart by
how many numbers the row has, then every row is verified arithmetically:
    value  == qty * price
    amount == value + fee                        (buy: cash paid)
    amount == value - fee - sell_tax - pit_tax   (sell: cash received)
A row that fails a check is reported, never guessed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
NUM_RE = re.compile(r"^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$")
TICKER_RE = re.compile(r"^[A-Z0-9]{3,10}$")
SIDES = {"Mua": "BUY", "Bán": "SELL"}


@dataclass
class Trade:
    no: int
    trade_date: date
    settle_date: date | None
    side: str  # BUY | SELL
    ticker: str
    quantity: Decimal
    price: Decimal
    value: Decimal
    fee: Decimal
    sell_tax: Decimal = Decimal(0)
    pit_quantity: Decimal = Decimal(0)
    pit_price: Decimal = Decimal(0)
    pit_amount: Decimal = Decimal(0)
    pit_tax: Decimal = Decimal(0)
    amount: Decimal = Decimal(0)

    @property
    def taxes(self) -> Decimal:
        return self.sell_tax + self.pit_tax

    def to_dict(self) -> dict:
        d = asdict(self)
        d["trade_date"] = self.trade_date.isoformat()
        d["settle_date"] = self.settle_date.isoformat() if self.settle_date else None
        return {k: (float(v) if isinstance(v, Decimal) else v) for k, v in d.items()}


@dataclass
class Report:
    account: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    trades: list[Trade] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    total_value: Decimal | None = None


def _num(s: str) -> Decimal:
    return Decimal(s.replace(",", ""))


def _date(s: str) -> date:
    return datetime.strptime(s, "%d/%m/%Y").date()


def _rows(page):
    words = page.extract_words(x_tolerance=1.5, y_tolerance=2)
    rows: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if rows and abs(rows[-1][0]["top"] - w["top"]) <= 2.5:
            rows[-1].append(w)
        else:
            rows.append([w])
    return [[w["text"] for w in sorted(r, key=lambda w: w["x0"])] for r in rows]


def _parse_row(tokens: list[str]) -> Trade:
    no, td, sd, side_vn, ticker, *nums = tokens
    side = SIDES[side_vn]
    if not all(NUM_RE.match(n) for n in nums):
        raise ValueError(f"unexpected cells {nums}")
    n = [_num(x) for x in nums]
    t = Trade(no=int(no), trade_date=_date(td), settle_date=_date(sd) if DATE_RE.match(sd) else None,
              side=side, ticker=ticker, quantity=n[0], price=n[1], value=n[2], fee=n[3])
    rest = n[4:]
    if len(rest) == 1:                    # amount
        t.amount = rest[0]
    elif len(rest) == 2:                  # sell_tax amount
        t.sell_tax, t.amount = rest
    elif len(rest) == 3 and rest[0] == 0:  # Oct-Nov 2023 layout: "0 10,000" = empty PIT qty + par price
        t.pit_price, t.amount = rest[1], rest[2]
    elif len(rest) == 4 and rest[1] == 0:  # same, with sell_tax
        t.sell_tax, t.pit_price, t.amount = rest[0], rest[2], rest[3]
    elif len(rest) == 5:                  # pit group + amount (no sell tax)
        t.pit_quantity, t.pit_price, t.pit_amount, t.pit_tax, t.amount = rest
    elif len(rest) == 6:                  # sell_tax + pit group + amount
        t.sell_tax, t.pit_quantity, t.pit_price, t.pit_amount, t.pit_tax, t.amount = rest
    else:
        raise ValueError(f"unexpected number of cells ({len(nums)}): {nums}")
    _verify(t)
    return t


def _verify(t: Trade) -> None:
    if t.quantity <= 0:
        raise ValueError("quantity must be positive")
    if abs(t.quantity * t.price - t.value) > 1:
        raise ValueError(f"value {t.value} != {t.quantity} x {t.price}")
    expect = t.value + t.fee + t.taxes if t.side == "BUY" else t.value - t.fee - t.taxes
    if abs(expect - t.amount) > 1:
        raise ValueError(f"amount {t.amount} != expected {expect} ({t.side})")


def _add_row(rep: Report, tokens: list[str], line: str) -> None:
    """Parse + verify one row; a failing row becomes an error, never a guess."""
    try:
        rep.trades.append(_parse_row(tokens))
    except (ValueError, IndexError, ArithmeticError) as e:
        rep.errors.append(f"row {tokens[0]}: {e} :: {line}")


def parse_report(path: str | Path) -> Report:
    import pdfplumber

    rep = Report()
    try:
        pdf = pdfplumber.open(str(path))
    except Exception as e:  # not a PDF / corrupt / encrypted
        rep.errors.append(f"cannot read PDF: {e}")
        return rep
    with pdf:
        for page in pdf.pages:
            for tokens in _rows(page):
                line = " ".join(tokens)
                if rep.account is None:
                    m = re.search(r"\b(\d{3}C\d{6,7})\b", line)
                    if m:
                        rep.account = m.group(1)
                if rep.date_from is None and "(from)" in line:
                    ds = [t for t in tokens if DATE_RE.match(t)]
                    if ds:
                        rep.date_from, rep.date_to = _date(ds[0]), _date(ds[-1])
                if (len(tokens) >= 9 and tokens[0].isdigit() and DATE_RE.match(tokens[1])
                        and tokens[3] in SIDES):
                    _add_row(rep, tokens, line)
                elif tokens and tokens[0] == "Total" and len(tokens) == 1:
                    pass
    # Cross-check with the Total line: sum of matched values.
    if rep.trades and not rep.errors:
        rep.total_value = sum((t.value for t in rep.trades), Decimal(0))
    if not rep.trades and not rep.errors:
        rep.errors.append("no trade rows found")
    return rep


# ── Pasted text ────────────────────────────────────────────────────────
#
# The same rows copied out of the email/PDF into a text box. Copying loses
# the layout: cells come tab- or space-separated, a row may wrap over several
# lines or several rows may share one line, and macOS may hand over "Bán" in
# decomposed (NFD) form. So the text is NFC-normalised, split into tokens,
# and scanned for row starts:  STT dd/mm/yyyy [dd/mm/yyyy] Mua|Bán TICKER.
# A row's cells are the numbers that follow, up to the next row start or the
# first token that is not a number. Each row then goes through the very same
# _parse_row + _verify as the PDF path.

_SIDE_TOKENS = {k.lower(): k for k in SIDES}


def _row_start(tokens: list[str], i: int) -> tuple[str, str, str, str, int] | None:
    """(trade_date, settle_date|"", side, ticker, first cell index) if a row starts at i."""
    if not (tokens[i].isdigit() and i + 3 < len(tokens) and DATE_RE.match(tokens[i + 1])):
        return None
    j, settle = i + 2, ""
    if DATE_RE.match(tokens[j]):
        settle, j = tokens[j], j + 1
    if j + 1 >= len(tokens):
        return None
    side = _SIDE_TOKENS.get(tokens[j].lower())
    if side is None or not TICKER_RE.match(tokens[j + 1]):
        return None
    return tokens[i + 1], settle, side, tokens[j + 1], j + 2


DOT_GROUPED_RE = re.compile(r"^-?\d{1,3}(\.\d{3})+$")  # 9.000 / 1.234.567 (vi-VN grouping)


def _accounts(text: str) -> list[str]:
    """Distinct account numbers in order; a sub-account (main + one digit,
    e.g. 003C1786441) counts as its main account."""
    out: list[str] = []
    for a in re.findall(r"\b(\d{3}C\d{6,7})\b", text):
        if not any(a.startswith(b) or b.startswith(a) for b in out):
            out.append(a)
    return out


def parse_text(text: str) -> Report:
    import unicodedata

    text = unicodedata.normalize("NFC", text or "").replace("\u00a0", " ")
    rep = Report()
    accounts = _accounts(text)
    if len(accounts) > 1:
        rep.errors.append(f"the text holds several accounts ({', '.join(accounts)}); "
                          "paste one account's report at a time")
        return rep
    rep.account = accounts[0] if accounts else None
    tokens = text.split()
    i = 0
    while i < len(tokens):
        start = _row_start(tokens, i)
        if start is None:
            i += 1
            continue
        td, sd, side, ticker, k = start
        cells = []
        while (k < len(tokens) and (NUM_RE.match(tokens[k]) or DOT_GROUPED_RE.match(tokens[k]))
               and _row_start(tokens, k) is None):
            cells.append(tokens[k])
            k += 1
        line = " ".join(tokens[i:k])
        dotted = [c for c in cells if DOT_GROUPED_RE.match(c)]
        if dotted:
            # "9.000" would read as 9 and still pass the arithmetic check once
            # every cell is scaled the same way: never guess, refuse the row.
            rep.errors.append(f"row {tokens[i]}: '.' thousands separator not supported "
                              f"({', '.join(dotted[:3])}); copy the SSI report with ',' grouping "
                              f"or add the trade by hand :: {line}")
        else:
            _add_row(rep, [tokens[i], td, sd, side, ticker, *cells], line)
        i = k
    if not rep.trades and not rep.errors:
        rep.errors.append("no trade rows found")
    return rep
