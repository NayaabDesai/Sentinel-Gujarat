"""Spatial gap analysis, uptime reporting, and Model 1 exports."""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_active_user
from app.db.models import Camera, User
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


@router.get("/export/csv")
async def export_cameras_csv(
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    """One-click standardized CCTV metadata export for Model 1 deliverables."""
    cams = (
        await db.execute(
            select(Camera).options(selectinload(Camera.department)).where(Camera.is_active.is_(True))
        )
    ).scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "external_id",
            "name",
            "department",
            "status",
            "latitude",
            "longitude",
            "heading_deg",
            "fov_deg",
            "range_m",
            "geo_source",
            "last_seen_at",
            "installed_at",
        ]
    )
    for c in cams:
        meta = c.meta or {}
        writer.writerow(
            [
                c.external_id,
                c.name,
                c.department.code if c.department else "",
                c.status.value if hasattr(c.status, "value") else c.status,
                c.latitude,
                c.longitude,
                c.heading_deg,
                c.fov_deg,
                c.range_m,
                meta.get("geo_source", "survey"),
                c.last_seen_at.isoformat() if c.last_seen_at else "",
                c.installed_at.isoformat() if c.installed_at else "",
            ]
        )

    buf.seek(0)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="sentinel_cameras_{stamp}.csv"'},
    )


@router.get("/export/gaps-csv")
async def export_gaps_csv(
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    """Gap-analysis summary CSV: coverage, uptime by status, aging ratio."""
    gaps = await blind_spot_analysis(db)
    uptime = await uptime_summary(db)
    aging = await aging_infrastructure_report(db)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["metric", "value", "notes"])
    writer.writerow(["coverage_pct", gaps.get("coverage_pct", ""), "PostGIS fishnet coverage"])
    writer.writerow(["covered_cells", gaps.get("covered_cells", ""), ""])
    writer.writerow(["gap_cells", gaps.get("gap_cells", ""), "Uncovered / blind-spot cells"])
    writer.writerow(["uptime_pct", uptime.get("uptime_pct", ""), "Fleet online ratio"])
    writer.writerow(["online", uptime.get("online", ""), ""])
    writer.writerow(["offline", uptime.get("offline", ""), ""])
    writer.writerow(["degraded", uptime.get("degraded", ""), ""])
    writer.writerow(["unknown", uptime.get("unknown", ""), ""])
    writer.writerow(["total_cameras", uptime.get("total", ""), ""])
    writer.writerow(["aging_count", aging.get("aging_count", aging.get("count", "")), "Assets past age threshold"])
    writer.writerow(["aging_years_threshold", aging.get("years", 5), ""])
    writer.writerow(["report_generated_utc", datetime.now(timezone.utc).isoformat(), "Sentinel Gujarat Model 1"])

    # Optional per-department offline breakdown if present
    by_dept = uptime.get("by_department") or gaps.get("by_department") or {}
    if isinstance(by_dept, dict):
        for dept, val in by_dept.items():
            writer.writerow([f"dept_{dept}", val, "department breakdown"])

    buf.seek(0)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="sentinel_gap_report_{stamp}.csv"'},
    )
