"""Request schemas for the portfolio ledger API."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class TransactionIn(BaseModel):
    type: Literal["BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "FEE", "TAX"]
    effective_at: datetime
    ticker: str | None = Field(
        default=None, max_length=32, pattern=r"^[A-Za-z0-9.^:_=-]+$"
    )
    quantity: Decimal | None = Field(default=None, gt=0)
    unit_price: Decimal | None = Field(default=None, ge=0)
    cash_amount: Decimal | None = Field(default=None, gt=0)
    currency: str = Field(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$")
    fees: Decimal = Field(default=Decimal("0"), ge=0)
    taxes: Decimal = Field(default=Decimal("0"), ge=0)
    note: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="manual", max_length=32)
    external_id: str | None = Field(default=None, max_length=160)

    @field_validator("ticker", mode="before")
    @classmethod
    def normalize_ticker(cls, value):
        return str(value).strip().upper() if value else None

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, value):
        return str(value).strip().upper()

    @field_validator("effective_at")
    @classmethod
    def normalize_effective_at(cls, value: datetime):
        # Stored as UTC; the ledger's day is derived in Asia/Ho_Chi_Minh
        # (engine.local_day). A naive timestamp is taken to be UTC.
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)

    @model_validator(mode="after")
    def validate_shape(self):
        if self.type in {"BUY", "SELL"} and (
            not self.ticker or self.quantity is None or self.unit_price is None
        ):
            raise ValueError("Trades require ticker, quantity, and unit_price")
        if (
            self.type in {"DIVIDEND", "DEPOSIT", "WITHDRAWAL", "FEE", "TAX"}
            and self.cash_amount is None
        ):
            raise ValueError(f"{self.type} requires cash_amount")
        return self


class HoldingIn(BaseModel):
    ticker: str = Field(min_length=1, max_length=20, pattern=r"^[A-Z0-9.^_-]+$")
    shares: float = Field(gt=0)
    cost_basis: float = Field(ge=0)

    @field_validator("ticker", mode="before")
    @classmethod
    def normalize_ticker(cls, value):
        return str(value).strip().upper()


class PreferenceIn(BaseModel):
    display_currency: str = Field(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$")

    @field_validator("display_currency", mode="before")
    @classmethod
    def normalize(cls, value):
        return str(value).strip().upper()


class ImportMapping(BaseModel):
    mapping: dict[str, str]



class PasteIn(BaseModel):
    """Text copied from an SSI "Thông báo kết quả giao dịch" email/PDF."""

    text: str = Field(min_length=1, max_length=200_000)


class PasteCommitIn(PasteIn):
    keys: list[str] = Field(max_length=2000)
