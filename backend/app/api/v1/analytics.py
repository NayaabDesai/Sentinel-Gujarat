"""Spatial gap analysis & uptime reporting."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.db.models import User
from app.db.session import get_db
from app.services.gap_analysis import aging_infrastructure_report, blind_spot_analysis, uptime_summary

router = APIRouter(dependencies=[Depends(get_current_active_user)])


@router.get("/gaps")
async def gaps(
    grid_size_m: float = Query(500, ge=100, le=5000),
    bbox: str | None = Query(
        None,
        description="min_lon,min_lat,max_lon,max_lat (defaults to Gujarat approx)",
    ),
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    return await blind_spot_analysis(db, grid_size_m=grid_size_m, bbox=bbox)


@router.get("/uptime")
async def uptime(
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    return await uptime_summary(db)


@router.get("/aging")
async def aging(
    years: int = Query(5, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    return await aging_infrastructure_report(db, years=years)
