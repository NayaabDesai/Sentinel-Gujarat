"""Proxy / sync endpoints for sandbox GET /api/ingest."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_db
from app.services.catalog_sync import CatalogSyncWorker, fetch_sandbox_catalog

router = APIRouter()


@router.get("")
async def proxy_ingest():
    """Forward to sandbox catalog — camera IDs/URLs are a dynamic contract."""
    cameras = await fetch_sandbox_catalog()
    return {
        "source": settings.SANDBOX_INGEST_URL,
        "count": len(cameras),
        "cameras": cameras,
    }


@router.post("/sync")
async def trigger_sync(db: AsyncSession = Depends(get_db)):
    worker = CatalogSyncWorker()
    result = await worker.sync_once(db)
    return {"ok": True, **result}
