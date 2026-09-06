"""PostGIS spatial helpers — nearby camera discovery."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def find_nearby_cameras(
    db: AsyncSession,
    *,
    lat: float,
    lon: float,
    radius_meters: float = 500.0,
    limit: int = 10,
    department: str | None = None,
) -> list[dict[str, Any]]:
    """
    Return cameras within radius_meters of (lat, lon), ordered by distance.
    Falls back to KNN nearest-neighbour if the radius returns zero hits.
    Uses `location` geography column (SRID 4326).
    """
    dept = department.upper() if department else None
    dept_clause = "AND d.code = :dept" if dept else ""

    sql = text(
        f"""
        SELECT
            c.id,
            c.external_id,
            c.name,
            d.code AS department_code,
            c.status::text AS status,
            c.latitude,
            c.longitude,
            c.heading_deg,
            c.fov_deg,
            c.range_m,
            c.whep_path,
            c.hls_path,
            c.meta,
            ST_Distance(
                c.location::geography,
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
            ) AS distance_meters
        FROM cameras c
        LEFT JOIN departments d ON d.id = c.department_id
        WHERE c.is_active = true
          AND c.location IS NOT NULL
          AND ST_DWithin(
                c.location::geography,
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
                :radius
              )
          {dept_clause}
        ORDER BY distance_meters ASC
        LIMIT :lim
        """
    )
    params: dict[str, Any] = {
        "lat": lat,
        "lon": lon,
        "radius": radius_meters,
        "lim": limit,
    }
    if dept:
        params["dept"] = dept

    rows = (await db.execute(sql, params)).mappings().all()
    if rows:
        return [dict(r) for r in rows]

    knn = text(
        f"""
        SELECT
            c.id,
            c.external_id,
            c.name,
            d.code AS department_code,
            c.status::text AS status,
            c.latitude,
            c.longitude,
            c.heading_deg,
            c.fov_deg,
            c.range_m,
            c.whep_path,
            c.hls_path,
            c.meta,
            ST_Distance(
                c.location::geography,
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
            ) AS distance_meters
        FROM cameras c
        LEFT JOIN departments d ON d.id = c.department_id
        WHERE c.is_active = true
          AND c.location IS NOT NULL
          {dept_clause}
        ORDER BY c.location <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)
        LIMIT :lim
        """
    )
    knn_params: dict[str, Any] = {"lat": lat, "lon": lon, "lim": limit}
    if dept:
        knn_params["dept"] = dept

    knn_rows = (await db.execute(knn, knn_params)).mappings().all()
    return [dict(r) for r in knn_rows]
