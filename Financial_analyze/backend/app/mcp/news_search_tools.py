"""MCP tools — the "News/search context layer" from docs/design/HERMES_BRAIN.md
(the same 3 tools listed under docs/PLAN.md Stage 8): `search_news`, `get_latest_news`,
`read_article`. Camoufox (headless-browser fallback for hard-blocked sites) is
explicitly "reserved" in that doc, not scheduled — not built here.

Thin wrapper: all fetch logic lives in backend/app/services/news.py, shared
with the FastAPI routes (backend/app/routes/news.py). This file only adds the
`@mcp.tool()` LLM-facing surface (names, docstrings, argument shapes).

Standalone MCP server (own venv: backend/app/mcp/.venv) because the `mcp` SDK's
starlette dependency conflicts with the pinned fastapi in backend/requirements.txt.
Lives at the path HERMES_BRAIN.md designates for the Core's MCP server so it merges
naturally when the full financial MCP server (calc/data/obsidian tools) gets built.

Register with Hermes Agent:
    hermes mcp add news_search \\
      --command "<repo>/Financial_analyze/backend/app/mcp/.venv/bin/python" \\
      --args "<repo>/Financial_analyze/backend/app/mcp/news_search_tools.py"
"""
import os
import sys

from mcp.server.fastmcp import FastMCP

# backend/app/mcp/news_search_tools.py -> backend/ (two levels up) so
# `app.services.news` is importable when this runs as a standalone script.
_BACKEND_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

from app.services.news import fetch_vn_rss, search_web, read_article as _read_article  # noqa: E402

mcp = FastMCP("news_search")


@mcp.tool()
def search_news(query: str, count: int = 5) -> list[dict]:
    """Search the web via a local, self-hosted SearXNG instance.

    Args:
        query: search terms.
        count: max results to return (default 5).

    Returns a list of {title, url, content} dicts. Raises a clear error if
    SearXNG isn't running — start it with ./scripts/run_searxng.sh.
    """
    return search_web(query, count)


@mcp.tool()
def get_latest_news(symbol: str, count: int = 10) -> list[dict]:
    """Latest VN financial news mentioning a symbol/company name.

    Pulls CafeF's stock-market + doanh-nghiep RSS category feeds and keyword-
    filters entries whose title/summary contain `symbol` (case-insensitive).
    Vietnamese headlines usually name the company, not the ticker (e.g. VNM
    articles say "Vinamilk") — pass a company name for better recall if a bare
    ticker returns nothing.

    Args:
        symbol: ticker or company name to filter for, e.g. "VNM" or "Vinamilk".
        count: max results to return (default 10).

    Returns a list of {title, url, published, category} dicts, newest first.
    """
    return fetch_vn_rss(query=symbol, limit=count)


@mcp.tool()
def read_article(url: str) -> dict:
    """Fetch a URL and extract its clean full article text (via Trafilatura).

    Args:
        url: article URL, e.g. one returned by search_news or get_latest_news.

    Returns {url, title, text}. Raises a clear error if the page couldn't be
    fetched or no article content could be extracted (e.g. paywalled, JS-only,
    or hard-blocked — those need Camoufox, not built yet, see module docstring).
    """
    return _read_article(url)


if __name__ == "__main__":
    mcp.run(transport="stdio")
