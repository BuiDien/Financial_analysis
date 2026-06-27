"""FastAPI app entry point."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import init_db
from .routes import market, fundamentals, portfolio, filings, ai, news, sync

settings = get_settings()

app = FastAPI(
    title="Helix Backend",
    description="Financial markets analysis API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/")
def root():
    return {"name": "Helix Backend", "version": "0.1.0", "docs": "/docs"}


@app.get("/health")
def health():
    return {"status": "ok"}


# Register routers
app.include_router(market.router, prefix="/api", tags=["market"])
app.include_router(fundamentals.router, prefix="/api", tags=["fundamentals"])
app.include_router(portfolio.router, prefix="/api", tags=["portfolio"])
app.include_router(filings.router, prefix="/api", tags=["filings"])
app.include_router(ai.router, prefix="/api", tags=["ai"])
app.include_router(news.router, prefix="/api", tags=["news"])
app.include_router(sync.router, tags=["sync"])  # defines its own /ws and /api paths
