"""Background worker polling cctv.corp8.cloud/cameras.json — dynamic catalog discovery."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from geoalchemy2.elements import WKTElement
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import Camera, CameraStatus, Department
from app.db.session import AsyncSessionLocal

logger = logging.getLogger("sentinel.catalog_sync")


# ---------------------------------------------------------------------------
# Session-cookie auth helpers
# ---------------------------------------------------------------------------

async def _logout(client: httpx.AsyncClient) -> None:
    """
    Release the sandbox web session so the browser can use the portal.
    Sandbox rule: one session per IP — leaving a logged-in cookie blocks
    https://cctv.corp8.cloud in the browser.
    """
    base = f"https://{settings.SANDBOX_HOST}"
    for path in ("/auth/logout", "/logout", "/auth/signout"):
        try:
            resp = await client.get(f"{base}{path}", follow_redirects=False)
            if resp.status_code in (200, 301, 302, 303, 307, 308):
                client.cookies.clear()
                logger.info("Released sandbox session via %s (HTTP %s)", path, resp.status_code)
                return
        except Exception as e:
            logger.debug("Logout attempt %s failed: %s", path, e)
    client.cookies.clear()
    logger.warning("Could not hit a known logout URL — cleared local cookies only")


async def _authenticated_client() -> httpx.AsyncClient:
    """
    Return an httpx AsyncClient that has a valid session cookie for
    cctv.corp8.cloud.  Raises RuntimeError if login fails.
    """
    login_url = f"https://{settings.SANDBOX_HOST}/auth/login"
    # Do NOT follow redirects on login — a 302 + sentinel cookie means success.
    client = httpx.AsyncClient(timeout=30.0, follow_redirects=False)

    try:
        await client.get(login_url)

        form_data: dict[str, str] = {
            "email":    settings.SANDBOX_EMAIL,
            "password": settings.SANDBOX_PASSWORD,
        }
        login_resp = await client.post(login_url, data=form_data)

        has_cookie = "sentinel" in client.cookies
        redirected = login_resp.status_code in (301, 302, 303, 307, 308)
        location = login_resp.headers.get("location", "")

        if not has_cookie:
            body = login_resp.text[:200]
            raise RuntimeError(
                f"Login failed (HTTP {login_resp.status_code}). "
                f"Check SANDBOX_EMAIL / SANDBOX_PASSWORD. Body hint: {body!r}"
            )

        logger.info(
            "Authenticated with cctv.corp8.cloud (status=%s location=%s cookie=%s)",
            login_resp.status_code, location, has_cookie or redirected,
        )
        return client

    except Exception:
        await client.aclose()
        raise


# ---------------------------------------------------------------------------
# Catalog fetch
# ---------------------------------------------------------------------------

async def fetch_sandbox_catalog() -> list[dict[str, Any]]:
    """
    Log in → fetch cameras.json → log out immediately.

    Logout is mandatory: the sandbox allows only ONE web session per IP.
    Holding the session blocks the browser portal (shows "one session per IP").
    """
    url = settings.SANDBOX_INGEST_URL

    if not settings.SANDBOX_EMAIL or not settings.SANDBOX_PASSWORD:
        logger.warning(
            "SANDBOX_EMAIL / SANDBOX_PASSWORD not set — fetching catalog without auth"
        )
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return _normalize(resp.json())

    client = await _authenticated_client()
    try:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "")
        if "json" not in ctype and not resp.text.lstrip().startswith(("[", "{")):
            raise RuntimeError(
                f"Expected JSON from {url} but got content-type={ctype!r}. "
                "Session may be invalid."
            )
        return _normalize(resp.json())
    finally:
        # Always free the IP session for the browser portal
        try:
            await _logout(client)
        except Exception as e:
            logger.warning("Logout after catalog fetch failed: %s", e)
        await client.aclose()


def _normalize(data: Any) -> list[dict[str, Any]]:
    """Coerce the catalog payload to a flat list."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("cameras", "streams", "data", "items", "results"):
            if key in data and isinstance(data[key], list):
                return data[key]
        if "id" in data or "camera_id" in data:
            return [data]
    logger.warning("Unexpected catalog payload type: %s", type(data))
    return []


# ---------------------------------------------------------------------------
# Approximate Gujarat geocoding for sandbox cameras
# cameras.json only returns {id, name} — no coordinates. Map pins need lat/lon,
# so we infer approximate locations from place names in the camera title.
# ---------------------------------------------------------------------------

_LOCATION_HINTS: list[tuple[str, float, float]] = [
    # (substring in name.lower(), lat, lon)
    ("paldi", 23.0116, 72.5622),
    ("janpath", 23.0225, 72.5714),
    ("chiman", 23.0360, 72.5610),
    ("ongc", 23.0395, 72.5660),
    ("visat", 23.0750, 72.5790),
    ("cn vidhyalaya", 23.0400, 72.5500),
    ("delight", 23.0280, 72.5580),
    ("suvidha", 23.0450, 72.5400),
    ("adalaj", 23.1645, 72.5802),
    ("timbavadi", 21.5222, 70.4579),
    ("majewadi", 21.5300, 70.4500),
    ("dolatpara", 21.5100, 70.4700),
    ("char-chowk", 21.5220, 70.4580),
    ("junagadh", 21.5222, 70.4579),
    ("gir-somnath", 20.8880, 70.4013),
    ("gir somnath", 20.8880, 70.4013),
    ("rajkot", 22.3039, 70.8022),
    ("navsari", 20.9467, 72.9520),
    ("gandevi", 20.7750, 72.9980),
    ("khaparia", 20.7800, 72.9900),
    ("patan", 23.8493, 72.1266),
    ("dehgam", 23.1700, 72.8200),
    ("dhanori", 23.1900, 72.7500),
    ("bilimora", 20.5347, 72.9750),
    ("gandhidham", 23.0753, 70.1337),
    ("rambaugh", 23.0753, 70.1337),
    ("mohanpura", 23.0300, 72.5800),
    ("mervada", 23.8500, 72.1300),
    ("kheram", 23.2000, 72.6000),
    ("tankal", 20.9000, 72.9000),
]


def _approx_coords(cam_id: str, name: str) -> tuple[float, float]:
    """Return (lat, lon) from place-name hints, or a stable offset around Ahmedabad."""
    lower = name.lower()
    for hint, lat, lon in _LOCATION_HINTS:
        if hint in lower:
            return lat, lon
    # Spread unknown cams around Gujarat centre so they don't stack on one pin
    digits = "".join(ch for ch in cam_id if ch.isdigit()) or "0"
    n = int(digits)
    return 22.5 + (n % 10) * 0.08, 71.2 + (n % 7) * 0.12


# ---------------------------------------------------------------------------
# Camera record extraction
# ---------------------------------------------------------------------------

def _extract(item: dict[str, Any]) -> dict[str, Any]:
    """
    Parse one camera record from cameras.json and build all stream URLs.
    The sandbox catalog returns camera IDs (cam01 … cam30); stream URLs
    are assembled here from the configured credentials and host settings.
    """
    cam_id = str(
        item.get("id") or item.get("camera_id") or item.get("stream_id") or item.get("name") or ""
    ).strip()
    name = str(item.get("name") or item.get("label") or cam_id)

    rtsp = item.get("rtsp_url") or item.get("rtsp")
    if not rtsp and cam_id:
        rtsp = settings.rtsp_url(cam_id)

    whep_path = item.get("whep") or item.get("whep_path") or cam_id
    hls_path  = item.get("hls")  or item.get("hls_path")  or cam_id

    lat  = item.get("latitude")  or item.get("lat")
    lon  = item.get("longitude") or item.get("lon")
    geo_inferred = False
    # Sandbox cameras.json has no coordinates — infer approximate Gujarat locations
    if lat is None or lon is None:
        lat, lon = _approx_coords(cam_id, name)
        geo_inferred = True

    dept = item.get("department") or item.get("department_code") or item.get("dept") or "SANDBOX"

    known = {
        "id", "camera_id", "stream_id", "name", "label",
        "rtsp_url", "rtsp", "url", "whep", "whep_path", "hls", "hls_path",
        "latitude", "lat", "longitude", "lon", "department", "department_code", "dept",
    }
    meta = {k: v for k, v in item.items() if k not in known}
    if geo_inferred:
        meta = {**(meta or {}), "geo_source": "inferred", "geo_disclaimer": "Approx. from camera title"}

    return {
        "external_id":      cam_id,
        "name":             name,
        "rtsp_url":         str(rtsp) if rtsp else None,
        "whep_path":        str(whep_path),
        "hls_path":         str(hls_path),
        "latitude":         float(lat)  if lat  is not None else None,
        "longitude":        float(lon)  if lon  is not None else None,
        "department_code":  str(dept).upper() if dept else None,
        "meta":             meta or None,
    }


# ---------------------------------------------------------------------------
# Sync worker
# ---------------------------------------------------------------------------

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
                    existing.name         = parsed["name"] or existing.name
                    if parsed["rtsp_url"]:
                        existing.rtsp_url = parsed["rtsp_url"]
                    existing.whep_path    = parsed["whep_path"]
                    existing.hls_path     = parsed["hls_path"]
                    if parsed["latitude"]  is not None:
                        existing.latitude  = parsed["latitude"]
                    if parsed["longitude"] is not None:
                        existing.longitude = parsed["longitude"]
                    if dept:
                        existing.department_id = dept.id
                    existing.last_seen_at = now
                    existing.status       = CameraStatus.ONLINE
                    if existing.longitude is not None and existing.latitude is not None:
                        existing.location = WKTElement(
                            f"POINT({existing.longitude} {existing.latitude})", srid=4326
                        )
                    if parsed["meta"]:
                        existing.meta = {**(existing.meta or {}), **parsed["meta"]}
                    updated += 1
                else:
                    cam = Camera(
                        external_id   = parsed["external_id"],
                        name          = parsed["name"],
                        department_id = dept.id if dept else None,
                        rtsp_url      = parsed["rtsp_url"],
                        whep_path     = parsed["whep_path"],
                        hls_path      = parsed["hls_path"],
                        latitude      = parsed["latitude"],
                        longitude     = parsed["longitude"],
                        status        = CameraStatus.ONLINE,
                        last_seen_at  = now,
                        meta          = parsed["meta"] or None,
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
            len(catalog), created, updated, errors,
        )
        return {"fetched": len(catalog), "created": created, "updated": updated, "errors": errors}

    async def run(self) -> None:
        """
        Background loop.  By default does ONE sync at startup then sleeps
        forever (manual Sync button still works via POST /ingest/sync).

        Set CATALOG_AUTO_SYNC=true to re-poll every CATALOG_REFRESH_SECONDS.
        Keep it false: each login steals the only session allowed per IP.
        """
        # One-shot sync at boot so the map has cameras without manual click
        try:
            async with AsyncSessionLocal() as db:
                await self.sync_once(db)
        except Exception as e:
            logger.exception("Initial catalog sync error: %s", e)

        if not settings.CATALOG_AUTO_SYNC:
            logger.info(
                "Catalog auto-sync OFF (one session per IP). "
                "Use the UI 'Sync sandbox catalog' button to refresh."
            )
            await self._stop.wait()
            return

        while not self._stop.is_set():
            try:
                await asyncio.wait_for(
                    self._stop.wait(), timeout=settings.CATALOG_REFRESH_SECONDS
                )
                break
            except asyncio.TimeoutError:
                pass
            try:
                async with AsyncSessionLocal() as db:
                    await self.sync_once(db)
            except Exception as e:
                logger.exception("Catalog sync loop error: %s", e)
