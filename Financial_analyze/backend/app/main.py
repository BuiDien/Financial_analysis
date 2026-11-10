"""FastAPI app entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import init_db
from .routes import (
    market,
    fundamentals,
    portfolio,
    filings,
    ai,
    news,
    sync,
    scan,
    ocr_inbox,
    history,
    gmail,
    backtest,
)

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    sync.recover_interrupted_attempts()
    portfolio.recover_jobs()
    if settings.enable_scheduler:
        from .services import scheduler

        scheduler.start()
    if settings.enable_gmail_poller:
        from .services import gmail_poller

        gmail_poller.start()
    try:
        yield
    finally:
        if settings.enable_scheduler:
            scheduler.shutdown()
        if settings.enable_gmail_poller:
            gmail_poller.shutdown()


app = FastAPI(
    title="Helix Backend",
    description="Financial markets analysis API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
app.include_router(scan.router, prefix="/api", tags=["scanner"])
app.include_router(ocr_inbox.router, prefix="/api", tags=["ocr-inbox"])
app.include_router(gmail.router, prefix="/api", tags=["gmail"])
app.include_router(backtest.router, prefix="/api", tags=["backtest"])
