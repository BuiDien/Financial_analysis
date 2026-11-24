"""FastAPI app entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from .config import get_settings
from .db import init_db
from .jobs import lifecycle as jobs_lifecycle
from .services.errors import ServiceError
from .routes import (
    market,
    fundamentals,
    portfolio,
    filings,
    ai,
    news,
    sync,
    notes,
    screener,
    ocr_inbox,
    history,
    gmail,
    backtest,
    alerts,
    jobs,
)

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    # Restart recovery (jobs, OCR sync attempts, portfolio jobs) + periodic loops.
    jobs_lifecycle.startup(settings)
    try:
        yield
    finally:
        jobs_lifecycle.shutdown()


app = FastAPI(
    title="Helix Backend",
    description="Financial markets analysis API",
    version="0.1.0",
    lifespan=lifespan,
)

class OriginGuardMiddleware:
    """Reject browser requests (HTTP and WebSocket) from foreign origins.

    The API has no auth: it is a single-user, loopback-only app. CORS alone
    only stops a foreign page from *reading* responses — simple POSTs and
    WebSocket handshakes still reach the handlers. Any request that carries
    an Origin header not on the allowlist is refused before routing.
    Native clients (curl, the OCR worker, the MCP server) send no Origin
    header and are unaffected.
    """

    def __init__(self, app, allowed_origins):
        self.app = app
        self.allowed = {origin.rstrip("/") for origin in allowed_origins}

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            origin = None
            for key, value in scope.get("headers") or ():
                if key == b"origin":
                    origin = value.decode("latin-1").strip().rstrip("/")
                    break
            if origin is not None and origin not in self.allowed:
                if scope["type"] == "websocket":
                    # Closing before accept → HTTP 403 on the handshake.
                    await receive()  # websocket.connect
                    await send({"type": "websocket.close", "code": 1008})
                    return
                response = JSONResponse(
                    {"detail": "Origin not allowed"}, status_code=403
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Added last → outermost: runs before CORS and routing.
app.add_middleware(OriginGuardMiddleware, allowed_origins=settings.origins_list)


@app.exception_handler(ServiceError)
async def service_error_handler(request, exc: ServiceError):
    """Render a domain ServiceError exactly as FastAPI renders HTTPException
    (same handler: detail body, status, headers; no body for 204/304)."""
    return await http_exception_handler(request, exc)


@app.get("/")
def root():
    return {"name": "Helix Backend", "version": "0.1.0", "docs": "/docs"}


@app.get("/health")
def health():
    return {"status": "ok"}


# Register routers
# history before market: market defines /history/{ticker}, which would shadow /history/companies
app.include_router(history.router, prefix="/api", tags=["history"])
app.include_router(market.router, prefix="/api", tags=["market"])
app.include_router(fundamentals.router, prefix="/api", tags=["fundamentals"])
app.include_router(portfolio.router, prefix="/api", tags=["portfolio"])
app.include_router(filings.router, prefix="/api", tags=["filings"])
app.include_router(ai.router, prefix="/api", tags=["ai"])
app.include_router(news.router, prefix="/api", tags=["news"])
app.include_router(sync.router, tags=["sync"])  # defines its own /ws and /api paths
app.include_router(screener.router, prefix="/api", tags=["screener"])
app.include_router(notes.router, prefix="/api", tags=["notes"])
app.include_router(ocr_inbox.router, prefix="/api", tags=["ocr-inbox"])
app.include_router(gmail.router, prefix="/api", tags=["gmail"])
app.include_router(backtest.router, prefix="/api", tags=["backtest"])
app.include_router(alerts.router, prefix="/api", tags=["alerts"])
app.include_router(jobs.router, prefix="/api", tags=["jobs"])
