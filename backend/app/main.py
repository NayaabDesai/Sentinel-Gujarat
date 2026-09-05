"""Sentinel Gujarat — FastAPI entry point."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import analytics, auth, cameras, ingest, stream
from app.core.config import settings
from app.db.seed import seed_users
from app.db.session import AsyncSessionLocal, engine, init_db
from app.services.catalog_sync import CatalogSyncWorker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("sentinel")

catalog_worker = CatalogSyncWorker()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    async with AsyncSessionLocal() as db:
        await seed_users(db)
    task = asyncio.create_task(catalog_worker.run())
    logger.info("Sentinel Gujarat API started (sandbox=%s)", settings.SANDBOX_HOST)
    yield
    await catalog_worker.stop()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    await engine.dispose()


app = FastAPI(
    title="Sentinel Gujarat",
    description="Unified CCTV registry & video integration platform (Model 1)",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(cameras.router, prefix="/api/v1/cameras", tags=["cameras"])
app.include_router(ingest.router, prefix="/api/v1/ingest", tags=["ingest"])
app.include_router(analytics.router, prefix="/api/v1/analytics", tags=["analytics"])
app.include_router(stream.router, prefix="/api/v1/stream", tags=["stream"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "sentinel-gujarat", "sandbox": settings.SANDBOX_HOST}
