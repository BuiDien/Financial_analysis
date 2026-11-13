"""AI provider adapters and prompt templates.

Hermes Agent remains the default provider for general AI features. OCR label
correction uses Ollama directly so the model receives only the correction
prompt and one user-marked label.
"""

import json
import logging
import subprocess
from typing import Literal

import httpx
from anthropic import Anthropic

from ..config import get_settings

settings = get_settings()
_client: Anthropic | None = None
logger = logging.getLogger("uvicorn.error")

MODEL = "claude-sonnet-4-5"
MAX_TEXT_CHARS = 80_000

Provider = Literal["hermes", "cloud"]

OLLAMA_LABEL_FORMAT = {
    "type": "object",
    "properties": {
        "corrected_label": {"type": "string"},
        "confidence": {
            "type": "string",
            "enum": ["high", "medium", "low"],
        },
    },
    "required": ["corrected_label", "confidence"],
    "additionalProperties": False,
}


def client() -> Anthropic:
    global _client
    if not settings.enable_cloud_ai:
        raise RuntimeError("Cloud AI is disabled; use the local Hermes provider")
    if not settings.anthropic_api_key:
        raise RuntimeError("Cloud AI is enabled but ANTHROPIC_API_KEY is not configured")
    if _client is None:
        _client = Anthropic(api_key=settings.anthropic_api_key)
    return _client


_hermes_key_cache: str = ""


def _read_local_hermes_api_key() -> str:
    try:
        result = subprocess.run(
            ["hermes", "config", "get", "gateway.api_server.key"],
            capture_output=True,
            check=False,
            text=True,
            timeout=2.0,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    key = result.stdout.strip() if result.returncode == 0 else ""
    return "" if key == "null" else key


def _local_hermes_api_key() -> str:
    """Read the local gateway key without copying it into the project.

    Only a found key is cached: if Hermes was not installed/configured yet
    when first asked, the next request tries again instead of staying
    unauthenticated until the backend restarts.
    """
    global _hermes_key_cache
    if not _hermes_key_cache:
        _hermes_key_cache = _read_local_hermes_api_key()
    return _hermes_key_cache


def _hermes_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    api_key = settings.hermes_api_key.strip() or _local_hermes_api_key()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _hermes_url(path: str) -> str:
    return f"{settings.hermes_api_url.rstrip('/')}/{path.lstrip('/')}"


def _hermes_error(response: httpx.Response) -> RuntimeError:
    if response.status_code in {401, 403}:
        return RuntimeError("Hermes Agent rejected the configured API key")
    return RuntimeError(f"Hermes Agent returned HTTP {response.status_code}")


def hermes_status() -> dict:
    """Return a small, secret-free readiness payload for the Helix UI."""
    try:
        response = httpx.get(
            _hermes_url("/v1/models"),
            headers=_hermes_headers(),
            timeout=3.0,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(
            "Hermes Agent is unreachable; start it with `hermes gateway run`"
        ) from exc
    if not response.is_success:
        raise _hermes_error(response)

    try:
        models = response.json().get("data", [])
    except ValueError as exc:
        raise RuntimeError("Hermes Agent returned an invalid models response") from exc
    model = models[0].get("id") if models and isinstance(models[0], dict) else settings.hermes_model
    return {"status": "ok", "provider": "hermes", "model": model or settings.hermes_model}


def hermes_complete(
    system: str,
    messages: list[dict],
    max_tokens: int = 1024,
    timeout_seconds: float | None = None,
    session_key: str | None = None,
) -> str:
    headers = _hermes_headers()
    if session_key:
        headers["X-Hermes-Session-Key"] = session_key
    payload = {
        "model": settings.hermes_model,
        "messages": [{"role": "system", "content": system}, *messages],
        "max_tokens": max_tokens,
        "stream": False,
    }
    try:
        response = httpx.post(
            _hermes_url("/v1/chat/completions"),
            headers=headers,
            json=payload,
            timeout=timeout_seconds or settings.hermes_timeout_seconds,
        )
    except httpx.TimeoutException as exc:
        timeout = timeout_seconds or settings.hermes_timeout_seconds
        raise RuntimeError(
            f"Hermes Agent did not finish within {timeout:g} seconds"
        ) from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(
            "Hermes Agent is unreachable; start it with `hermes gateway start`"
        ) from exc
    if not response.is_success:
        raise _hermes_error(response)

    try:
        content = response.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise RuntimeError("Hermes Agent returned an invalid chat response") from exc
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Hermes Agent returned an empty chat response")
    return content


def ollama_label_complete(
    system: str,
    message: str,
    *,
    timeout_seconds: float | None = None,
) -> str:
    """Correct one OCR label through Ollama's local chat API."""
    timeout = (
        timeout_seconds
        if timeout_seconds is not None
        else settings.ollama_timeout_seconds
    )
    endpoint = f"{settings.ollama_api_url.rstrip('/')}/api/chat"
    payload = {
        "model": settings.ollama_ocr_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": message},
        ],
        "stream": False,
        "think": False,
        "format": OLLAMA_LABEL_FORMAT,
        "options": {
            "temperature": 0,
            "num_ctx": settings.ollama_ocr_num_ctx,
        },
    }
    logger.info(
        "Ollama OCR label request:\n%s",
        json.dumps(
            {"endpoint": endpoint, "body": payload},
            ensure_ascii=False,
            indent=2,
        ),
    )
    try:
        response = httpx.post(
            endpoint,
            headers={"Content-Type": "application/json"},
            json=payload,
            timeout=timeout,
        )
    except httpx.TimeoutException as exc:
        raise RuntimeError(
            f"Ollama did not finish within {timeout:g} seconds"
        ) from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(
            "Ollama is unreachable; start it with `ollama serve`"
        ) from exc
    logger.info("Ollama OCR label raw response:\n%s", response.text)
    if not response.is_success:
        raise RuntimeError(f"Ollama returned HTTP {response.status_code}")

    try:
        content = response.json()["message"]["content"]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError("Ollama returned an invalid chat response") from exc
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Ollama returned an empty chat response")
    return content


def cloud_complete(system: str, messages: list[dict], max_tokens: int = 1024) -> str:
    msg = client().messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=messages,
    )
    return msg.content[0].text


def complete(
    system: str,
    messages: list[dict],
    *,
    provider: Provider | None = None,
    max_tokens: int = 1024,
    timeout_seconds: float | None = None,
    session_key: str | None = None,
) -> str:
    selected = provider or settings.ai_provider
    if selected == "hermes":
        kwargs = {"max_tokens": max_tokens}
        if timeout_seconds is not None:
            kwargs["timeout_seconds"] = timeout_seconds
        if session_key is not None:
            kwargs["session_key"] = session_key
        return hermes_complete(system, messages, **kwargs)
    if selected == "cloud":
        return cloud_complete(system, messages, max_tokens=max_tokens)
    raise RuntimeError(f"Unsupported AI provider: {selected}")


def analyze_filing(text: str, ticker: str, filing_type: str, period: str) -> str:
    system = "You are Helix, a precise financial filing analyst."
    prompt = (
        f"You are reviewing a {filing_type} financial filing for {ticker} ({period}). "
        f"Extract the 5 most important findings an analyst should know. Use this format strictly:\n\n"
        f"**Bottom line:** [one sentence verdict]\n\n"
        f"**Key findings:**\n- [finding 1, with specific numbers]\n- [finding 2]\n"
        f"- [finding 3]\n- [finding 4]\n- [finding 5]\n\n"
        f"**Watch list:** [2-3 risks or things to monitor]\n\n"
        f"Be specific, numerical, direct. No fluff.\n\n"
        f"--- FILING TEXT ---\n{text[:MAX_TEXT_CHARS]}"
    )
    return complete(system, [{"role": "user", "content": prompt}], max_tokens=1500)


def ask_about_filing(text: str, question: str, ticker: str, section: str | None = None) -> str:
    section_note = f' The reader is currently viewing the "{section}" section.' if section else ""
    system = "You are Helix, an expert financial analyst helping a reader understand a filing."
    prompt = (
        f"You are an expert financial analyst helping a reader understand a filing for {ticker}."
        f"{section_note} Answer using only information in the filing. Quote specific numbers. "
        f"If the answer isn't in the filing, say so. Use **bold** for key numbers. Be concise.\n\n"
        f"QUESTION: {question}\n\n"
        f"--- FILING TEXT ---\n{text[:MAX_TEXT_CHARS]}"
    )
    return complete(system, [{"role": "user", "content": prompt}], max_tokens=1000)


PAGE_SYSTEM_PROMPTS = {
    "dashboard":  "You're Helix, an AI assistant inside a financial markets workspace. The user is on the dashboard (indices, watchlist, sector heatmap, macro). Be concise and numerical. Use **bold** for key figures, *italic* for tickers. No disclaimers, no emoji.",
    "detail":     "You're Helix. The user is viewing an asset detail page (chart, technicals, ratios, analyst consensus). Be concise, numerical, direct.",
    "portfolio":  "You're Helix. The user is reviewing their portfolio. Be candid about concentration and underperformers.",
    "screener":   "You're Helix. The user is screening for stocks. Suggest concrete filter criteria.",
    "statements": "You're Helix. The user is analyzing financial statements. Focus on margins, growth, balance-sheet quality, red flags.",
    "filings":    "You're Helix. The user is reviewing PDF filings. Help extract findings and compare periods.",
    "news":       "You're Helix. The user is reading market news. Separate signal from noise.",
}


def page_chat(
    page: str,
    page_context: dict,
    messages: list[dict],
    provider: Provider = "hermes",
) -> str:
    system = PAGE_SYSTEM_PROMPTS.get(page, PAGE_SYSTEM_PROMPTS["dashboard"])
    if page_context:
        system += "\n\nCurrent context: " + ", ".join(f"{k}={v}" for k, v in page_context.items())
    return complete(system, messages, provider=provider, max_tokens=1024)
