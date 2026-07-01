"""AI sidebar chat — context-aware proxy to Claude."""
from fastapi import APIRouter
from pydantic import BaseModel
from ..services import ai

router = APIRouter()


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatIn(BaseModel):
    page: str = "dashboard"
    page_context: dict | None = None
    messages: list[ChatMessage]


@router.post("/ai/chat")
def chat(payload: ChatIn):
    answer = ai.page_chat(
        page=payload.page,
        page_context=payload.page_context or {},
        messages=[m.model_dump() for m in payload.messages],
    )
    return {"answer": answer}
