"""AI sidebar chat — context-aware proxy to Hermes or optional cloud AI."""
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services import ai

router = APIRouter()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8_000)


class ChatIn(BaseModel):
    provider: Literal["hermes", "cloud"] = "hermes"
    page: str = Field(default="dashboard", max_length=40)
    page_context: dict | None = None
    messages: list[ChatMessage] = Field(min_length=1, max_length=50)


@router.post("/ai/chat")
def chat(payload: ChatIn):
    try:
        answer = ai.page_chat(
            page=payload.page,
            page_context=payload.page_context or {},
            messages=[m.model_dump() for m in payload.messages],
            provider=payload.provider,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"answer": answer}


@router.get("/ai/health")
def health():
    try:
        return ai.hermes_status()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
