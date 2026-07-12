from pydantic import BaseModel, ConfigDict, Field, model_validator


OCR_RESULT_SCHEMA_VERSION = 1
MAX_RESULT_ROWS = 5000
MAX_RESULT_BYTES = 5 * 1024 * 1024


class OCRBBox(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def stays_on_page(self):
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError("bounding box extends beyond the page")
        return self


class OCRResultRow(BaseModel):
    model_config = ConfigDict(extra="allow")

    code: str | None = Field(default=None, max_length=80)
    id: str | None = Field(default=None, max_length=80)
    label: str | None = Field(default=None, max_length=500)
    metric: str | None = Field(default=None, max_length=500)
    section: str | None = Field(default=None, max_length=80)
    curr: str = Field(max_length=120)
    prev: str | None = Field(default=None, max_length=120)
    page: int = Field(ge=1, le=10000)
    confidence: int = Field(ge=0, le=100)
    bbox: OCRBBox
    rawText: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def has_identity_and_label(self):
        if not self.code and not self.id:
            raise ValueError("row requires code or id")
        if not self.label and not self.metric:
            raise ValueError("row requires label or metric")
        return self


class OCRWorkerResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str
    jobId: str = Field(min_length=1, max_length=64)
    schemaVersion: int
    rows: list[OCRResultRow] = Field(min_length=1, max_length=MAX_RESULT_ROWS)

    @model_validator(mode="after")
    def supported_version(self):
        if self.type != "result":
            raise ValueError("message type must be result")
        if self.schemaVersion != OCR_RESULT_SCHEMA_VERSION:
            raise ValueError(f"unsupported schemaVersion {self.schemaVersion}")
        return self
