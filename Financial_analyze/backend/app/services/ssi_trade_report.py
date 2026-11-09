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
                    try:
                        rep.trades.append(_parse_row(tokens))
                    except (ValueError, IndexError, ArithmeticError) as e:
                        rep.errors.append(f"row {tokens[0]}: {e} :: {line}")
                elif tokens and tokens[0] == "Total" and len(tokens) == 1:
                    pass
    # Cross-check with the Total line: sum of matched values.
    if rep.trades and not rep.errors:
        rep.total_value = sum((t.value for t in rep.trades), Decimal(0))
    if not rep.trades and not rep.errors:
        rep.errors.append("no trade rows found")
    return rep
