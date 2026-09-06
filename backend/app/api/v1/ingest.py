"""Proxy / sync endpoints for sandbox catalog."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user, require_admin, require_write
from app.core.config import settings
from app.db.models import User
from app.db.session import get_db
from app.services.catalog_sync import CatalogSyncWorker, fetch_sandbox_catalog

router = APIRouter(dependencies=[Depends(get_current_active_user)])


@router.get("")
async def proxy_ingest(user: User | None = Depends(get_current_active_user)):
    """Forward to sandbox catalog — write roles only (sandbox session cost)."""
    require_write(user)
    cameras = await fetch_sandbox_catalog()
    return {
        "source": settings.SANDBOX_INGEST_URL,
        "count": len(cameras),
        "cameras": cameras,
    }


@router.post("/sync")
async def trigger_sync(
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_active_user),
):
    """Sandbox catalog sync — ADMIN only (one session per IP)."""
    require_admin(user)
    worker = CatalogSyncWorker()
    result = await worker.sync_once(db)
    return {"ok": True, **result}
