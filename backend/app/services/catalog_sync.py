"""Background worker polling https://cctv.corp8.cloud/cameras.json — dynamic catalog."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from geoalchemy2.elements import WKTElement
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import Camera, CameraStatus, Department
from app.db.session import AsyncSessionLocal
from app.services.sandbox_auth import fetch_authenticated_json

logger = logging.getLogger("sentinel.catalog_sync")


def _normalize_catalog(data: Any) -> list[dict[str, Any]]:
    """Accept list/dict/cameras.json shapes; always return list of dicts with at least id."""
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = None
        for key in ("cameras", "streams", "data", "items", "results"):
            if key in data and isinstance(data[key], list):
                items = data[key]
                break
        if items is None:
            if "id" in data or "camera_id" in data:
                items = [data]
            else:
                items = [
                    ({"id": k, **v} if isinstance(v, dict) else {"id": k})
                    for k, v in data.items()
                    if not str(k).startswith("_")
                ]
    else:
        logger.warning("Unexpected ingest payload type: %s", type(data))
        return []

    out: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, str):
            out.append({"id": item.strip()})
        elif isinstance(item, dict):
            out.append(item)
    return out


async def fetch_sandbox_catalog() -> list[dict[str, Any]]:
    """Query sandbox cameras.json via portal session login. Never hardcode camera URLs."""
    data = await fetch_authenticated_json(settings.SANDBOX_INGEST_URL)
    return _normalize_catalog(data)


def _extract(item: dict[str, Any]) -> dict[str, Any]:
    external_id = str(
        item.get("id") or item.get("camera_id") or item.get("stream_id") or item.get("name") or ""
    ).strip()
    name = str(item.get("name") or item.get("label") or external_id)
    rtsp = item.get("rtsp_url") or item.get("rtsp") or item.get("url")
    if not rtsp and external_id:
        rtsp = settings.rtsp_url(external_id)
    elif rtsp and settings.has_sandbox_auth and "@" not in str(rtsp).split("://", 1)[-1].split("/", 1)[0]:
        rtsp = settings.rtsp_url(external_id)

    whep = item.get("whep") or item.get("whep_path") or external_id
    hls = item.get("hls") or item.get("hls_path") or external_id
    lat = item.get("latitude", item.get("lat"))
    lon = item.get("longitude", item.get("lon"))
    dept = item.get("department") or item.get("department_code") or item.get("dept")
    return {
        "external_id": external_id,
        "name": name,
        "rtsp_url": str(rtsp) if rtsp else None,
        "whep_path": str(whep) if whep else external_id,
        "hls_path": str(hls) if hls else external_id,
        "latitude": float(lat) if lat is not None else None,
        "longitude": float(lon) if lon is not None else None,
        "department_code": str(dept).upper() if dept else None,
        "meta": {
            k: v
            for k, v in item.items()
            if k
            not in {
                "id",
                "camera_id",
                "stream_id",
                "name",
                "label",
                "rtsp_url",
                "rtsp",
                "url",
                "whep",
                "whep_path",
                "hls",
                "hls_path",
                "latitude",
                "lat",
                "longitude",
                "lon",
                "department",
                "department_code",
                "dept",
            }
        },
    }


class CatalogSyncWorker:
    def __init__(self) -> None:
        self._stop = asyncio.Event()

    async def stop(self) -> None:
        self._stop.set()

    async def sync_once(self, db: AsyncSession) -> dict[str, int]:
        try:
            catalog = await fetch_sandbox_catalog()
        except Exception as e:
            logger.error("Catalog fetch failed from %s: %s", settings.SANDBOX_INGEST_URL, e)
            return {"fetched": 0, "created": 0, "updated": 0, "errors": 1}

        created = updated = errors = 0
        now = datetime.now(timezone.utc)

        for item in catalog:
            try:
                parsed = _extract(item if isinstance(item, dict) else {})
                if not parsed["external_id"]:
                    errors += 1
                    continue

                dept = None
                if parsed["department_code"]:
                    result = await db.execute(
                        select(Department).where(Department.code == parsed["department_code"])
                    )
                    dept = result.scalar_one_or_none()
                    if not dept:
                        dept = Department(
                            code=parsed["department_code"],
                            name=parsed["department_code"].replace("_", " ").title(),
                        )
                        db.add(dept)
                        await db.flush()

                existing = (
                    await db.execute(
                        select(Camera).where(Camera.external_id == parsed["external_id"])
                    )
                ).scalar_one_or_none()

                if existing:
                    existing.name = parsed["name"] or existing.name
                    if parsed["rtsp_url"]:
                        existing.rtsp_url = parsed["rtsp_url"]
                    existing.whep_path = parsed["whep_path"]
                    existing.hls_path = parsed["hls_path"]
                    if parsed["latitude"] is not None:
                        existing.latitude = parsed["latitude"]
                    if parsed["longitude"] is not None:
                        existing.longitude = parsed["longitude"]
                    if dept:
                        existing.department_id = dept.id
                    existing.last_seen_at = now
                    existing.status = CameraStatus.ONLINE
                    if existing.longitude is not None and existing.latitude is not None:
                        existing.location = WKTElement(
                            f"POINT({existing.longitude} {existing.latitude})", srid=4326
                        )
                    if parsed["meta"]:
                        existing.meta = {**(existing.meta or {}), **parsed["meta"]}
                    updated += 1
                else:
                    cam = Camera(
                        external_id=parsed["external_id"],
                        name=parsed["name"],
                        department_id=dept.id if dept else None,
                        rtsp_url=parsed["rtsp_url"],
                        whep_path=parsed["whep_path"],
                        hls_path=parsed["hls_path"],
                        latitude=parsed["latitude"],
                        longitude=parsed["longitude"],
                        status=CameraStatus.ONLINE,
                        last_seen_at=now,
                        meta=parsed["meta"] or None,
                    )
                    if cam.longitude is not None and cam.latitude is not None:
                        cam.location = WKTElement(
                            f"POINT({cam.longitude} {cam.latitude})", srid=4326
                        )
                    db.add(cam)
                    created += 1
            except Exception as e:
                logger.warning("Skip catalog item: %s", e)
                errors += 1

        await db.commit()
        logger.info(
            "Catalog sync: fetched=%s created=%s updated=%s errors=%s",
            len(catalog),
            created,
            updated,
            errors,
        )
        return {"fetched": len(catalog), "created": created, "updated": updated, "errors": errors}

    async def run(self) -> None:
        while not self._stop.is_set():
            try:
                async with AsyncSessionLocal() as db:
                    await self.sync_once(db)
            except Exception as e:
                logger.exception("Catalog sync loop error: %s", e)
            try:
                await asyncio.wait_for(
                    self._stop.wait(), timeout=settings.CATALOG_REFRESH_SECONDS
                )
            except asyncio.TimeoutError:
                continue
