"""PostGIS blind-spot & coverage query engine."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# Approximate Gujarat bounding box (WGS84)
DEFAULT_BBOX = (68.0, 20.0, 74.5, 24.8)  # min_lon, min_lat, max_lon, max_lat


def _parse_bbox(bbox: str | None) -> tuple[float, float, float, float]:
    if not bbox:
        return DEFAULT_BBOX
    parts = [float(x.strip()) for x in bbox.split(",")]
    if len(parts) != 4:
        return DEFAULT_BBOX
    return parts[0], parts[1], parts[2], parts[3]


async def blind_spot_analysis(
    db: AsyncSession,
    grid_size_m: float = 500,
    bbox: str | None = None,
) -> dict[str, Any]:
    """
    Generate a fishnet over the AOI and flag cells with no overlapping FOV
    (or no camera within range). Uses PostGIS geography for metre accuracy.
    """
    min_lon, min_lat, max_lon, max_lat = _parse_bbox(bbox)

    # Degree step approx from metres at mid-latitude
    mid_lat = (min_lat + max_lat) / 2.0
    deg_lat = grid_size_m / 111_320.0
    deg_lon = grid_size_m / (111_320.0 * max(__import__("math").cos(__import__("math").radians(mid_lat)), 0.01))

    sql = text(
        """
        WITH bounds AS (
          SELECT
            ST_SetSRID(ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat), 4326) AS geom
        ),
        grid AS (
          SELECT (ST_SquareGrid(:deg_lon, (SELECT geom FROM bounds))).*
        ),
        cells AS (
          SELECT
            row_number() OVER () AS cell_id,
            ST_Centroid(geom) AS centroid,
            geom
          FROM grid
          WHERE ST_Intersects(geom, (SELECT geom FROM bounds))
        ),
        covered AS (
          SELECT c.cell_id,
                 CASE
                   WHEN EXISTS (
                     SELECT 1 FROM cameras cam
                     WHERE cam.is_active = true
                       AND (
                         (cam.fov_polygon IS NOT NULL AND ST_Intersects(cam.fov_polygon, c.geom))
                         OR (
                           cam.location IS NOT NULL
                           AND ST_DWithin(
                             cam.location::geography,
                             c.centroid::geography,
                             COALESCE(cam.range_m, 200)
                           )
                         )
                       )
                   ) THEN true
                   ELSE false
                 END AS is_covered
          FROM cells c
        )
        SELECT
          (SELECT count(*) FROM covered) AS total_cells,
          (SELECT count(*) FROM covered WHERE is_covered) AS covered_cells,
          (SELECT count(*) FROM covered WHERE NOT is_covered) AS gap_cells,
          (
            SELECT json_agg(json_build_object(
              'cell_id', c.cell_id,
              'lon', ST_X(c.centroid),
              'lat', ST_Y(c.centroid)
            ))
            FROM cells c
            JOIN covered cv ON cv.cell_id = c.cell_id
            WHERE NOT cv.is_covered
            LIMIT 500
          ) AS gap_centroids
        """
    )

    # ST_SquareGrid size is in degrees when CRS is 4326 — use avg of deg steps
    cell_deg = (deg_lat + deg_lon) / 2.0

    try:
        row = (
            await db.execute(
                sql,
                {
                    "min_lon": min_lon,
                    "min_lat": min_lat,
                    "max_lon": max_lon,
                    "max_lat": max_lat,
                    "deg_lon": cell_deg,
                },
            )
        ).mappings().one()
    except Exception:
        # Fallback for PostGIS versions / missing cameras: simple distance-based sampling
        fallback = text(
            """
            SELECT
              count(*) FILTER (WHERE location IS NOT NULL) AS cameras_with_location,
              count(*) AS total_cameras
            FROM cameras
            WHERE is_active = true
            """
        )
        stats = (await db.execute(fallback)).mappings().one()
        return {
            "mode": "fallback",
            "bbox": [min_lon, min_lat, max_lon, max_lat],
            "grid_size_m": grid_size_m,
            "cameras_with_location": stats["cameras_with_location"],
            "total_cameras": stats["total_cameras"],
            "gap_cells": None,
            "message": "Full fishnet unavailable; ensure PostGIS 3.1+ (ST_SquareGrid) and FOV data.",
            "gaps": [],
        }

    total = row["total_cells"] or 0
    covered = row["covered_cells"] or 0
    gaps = row["gap_cells"] or 0
    coverage_pct = round(100.0 * covered / total, 2) if total else 0.0

    return {
        "mode": "fishnet",
        "bbox": [min_lon, min_lat, max_lon, max_lat],
        "grid_size_m": grid_size_m,
        "total_cells": total,
        "covered_cells": covered,
        "gap_cells": gaps,
        "coverage_pct": coverage_pct,
        "gaps": row["gap_centroids"] or [],
    }


async def uptime_summary(db: AsyncSession) -> dict[str, Any]:
    sql = text(
        """
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE status = 'online') AS online,
          count(*) FILTER (WHERE status = 'offline') AS offline,
          count(*) FILTER (WHERE status = 'degraded') AS degraded,
          count(*) FILTER (WHERE status = 'unknown') AS unknown
        FROM cameras
        WHERE is_active = true
        """
    )
    row = (await db.execute(sql)).mappings().one()
    total = row["total"] or 0
    online = row["online"] or 0
    return {
        **dict(row),
        "uptime_pct": round(100.0 * online / total, 2) if total else 0.0,
    }


async def aging_infrastructure_report(db: AsyncSession, years: int = 5) -> dict[str, Any]:
    sql = text(
        """
        SELECT
          count(*) FILTER (
            WHERE installed_at IS NOT NULL
              AND installed_at < now() - make_interval(years => :years)
          ) AS aging_count,
          count(*) FILTER (WHERE installed_at IS NOT NULL) AS with_install_date,
          count(*) FILTER (WHERE installed_at IS NULL) AS missing_install_date,
          (
            SELECT json_agg(json_build_object(
              'id', id::text,
              'external_id', external_id,
              'name', name,
              'installed_at', installed_at,
              'age_years', EXTRACT(YEAR FROM age(now(), installed_at))
            ) ORDER BY installed_at ASC)
            FROM cameras
            WHERE is_active = true
              AND installed_at IS NOT NULL
              AND installed_at < now() - make_interval(years => :years)
            LIMIT 100
          ) AS aging_cameras
        FROM cameras
        WHERE is_active = true
        """
    )
    row = (await db.execute(sql, {"years": years})).mappings().one()
    return {
        "threshold_years": years,
        "aging_count": row["aging_count"] or 0,
        "with_install_date": row["with_install_date"] or 0,
        "missing_install_date": row["missing_install_date"] or 0,
        "cameras": row["aging_cameras"] or [],
    }
