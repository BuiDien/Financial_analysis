"""Anthropic client + prompt templates. Prompts mirror the frontend's."""
from anthropic import Anthropic
from ..config import get_settings

settings = get_settings()
_client: Anthropic | None = None

MODEL = "claude-sonnet-4-5"
MAX_TEXT_CHARS = 80_000


def client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(api_key=settings.anthropic_api_key)
    return _client


def analyze_filing(text: str, ticker: str, filing_type: str, period: str) -> str:
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
    msg = client().messages.create(model=MODEL, max_tokens=1500,
                                   messages=[{"role": "user", "content": prompt}])
    return msg.content[0].text


def ask_about_filing(text: str, question: str, ticker: str, section: str | None = None) -> str:
    section_note = f' The reader is currently viewing the "{section}" section.' if section else ""
    prompt = (
        f"You are an expert financial analyst helping a reader understand a filing for {ticker}."
        f"{section_note} Answer using only information in the filing. Quote specific numbers. "
        f"If the answer isn't in the filing, say so. Use **bold** for key numbers. Be concise.\n\n"
        f"QUESTION: {question}\n\n"
        f"--- FILING TEXT ---\n{text[:MAX_TEXT_CHARS]}"
    )
    msg = client().messages.create(model=MODEL, max_tokens=1000,
                                   messages=[{"role": "user", "content": prompt}])
    return msg.content[0].text


PAGE_SYSTEM_PROMPTS = {
    "dashboard":  "You're Helix, an AI assistant inside a financial markets workspace. The user is on the dashboard (indices, watchlist, sector heatmap, macro). Be concise and numerical. Use **bold** for key figures, *italic* for tickers. No disclaimers, no emoji.",
    "detail":     "You're Helix. The user is viewing an asset detail page (chart, technicals, ratios, analyst consensus). Be concise, numerical, direct.",
    "portfolio":  "You're Helix. The user is reviewing their portfolio. Be candid about concentration and underperformers.",
    "screener":   "You're Helix. The user is screening for stocks. Suggest concrete filter criteria.",
    "statements": "You're Helix. The user is analyzing financial statements. Focus on margins, growth, balance-sheet quality, red flags.",
    "filings":    "You're Helix. The user is reviewing PDF filings. Help extract findings and compare periods.",
    "news":       "You're Helix. The user is reading market news. Separate signal from noise.",
}


def page_chat(page: str, page_context: dict, messages: list[dict]) -> str:
    system = PAGE_SYSTEM_PROMPTS.get(page, PAGE_SYSTEM_PROMPTS["dashboard"])
    if page_context:
        system += "\n\nCurrent context: " + ", ".join(f"{k}={v}" for k, v in page_context.items())
    msg = client().messages.create(model=MODEL, max_tokens=1024,
                                   system=system, messages=messages)
    return msg.content[0].text
