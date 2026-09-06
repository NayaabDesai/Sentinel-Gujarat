"""Active stream session supervisor — on-demand ingest only."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_active_user
from app.core.config import settings
from app.db.models import Camera, StreamSession, User
from app.db.session import get_db

router = APIRouter()


class SessionStart(BaseModel):
    camera_id: uuid.UUID
    client_id: str = Field(..., min_length=1, max_length=128)
    protocol: str = Field("whep", pattern="^(whep|hls|rtsp)$")


class SessionHeartbeat(BaseModel):
    session_id: uuid.UUID
    client_id: str


class SessionOut(BaseModel):
    session_id: uuid.UUID
    camera_id: uuid.UUID
    external_id: str
    protocol: str
    whep_url: str
    hls_url: str
    rtsp_url: str | None
    active: bool


@router.post("/sessions", response_model=SessionOut)
async def start_session(
    payload: SessionStart,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    """Open an on-demand stream session. RTSP/WHEP is only used while sessions are active."""
    q = select(Camera).options(selectinload(Camera.department)).where(
        Camera.id == payload.camera_id, Camera.is_active.is_(True)
    )
    cam = (await db.execute(q)).scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    # Reuse existing active session for same client+camera
    existing = (
        await db.execute(
            select(StreamSession).where(
                StreamSession.camera_id == cam.id,
                StreamSession.client_id == payload.client_id,
                StreamSession.active.is_(True),
            )
        )
    ).scalar_one_or_none()

    if existing:
        existing.last_heartbeat_at = datetime.now(timezone.utc)
        existing.ref_count += 1
        existing.protocol = payload.protocol
        session = existing
    else:
        session = StreamSession(
            camera_id=cam.id,
            client_id=payload.client_id,
            protocol=payload.protocol,
            active=True,
        )
        db.add(session)
        await db.flush()

    stream_id = cam.whep_path or cam.external_id
    return SessionOut(
        session_id=session.id,
        camera_id=cam.id,
        external_id=cam.external_id,
        protocol=session.protocol,
        whep_url=settings.whep_url(stream_id),
        hls_url=settings.hls_url(stream_id),
        rtsp_url=cam.rtsp_url or settings.rtsp_url(stream_id),
        active=True,
    )


@router.post("/sessions/heartbeat")
async def heartbeat(
    payload: SessionHeartbeat,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    session = (
        await db.execute(
            select(StreamSession).where(
                StreamSession.id == payload.session_id,
                StreamSession.client_id == payload.client_id,
            )
        )
    ).scalar_one_or_none()
    if not session or not session.active:
        raise HTTPException(404, "Session not found or inactive")
    session.last_heartbeat_at = datetime.now(timezone.utc)
    return {"ok": True, "last_heartbeat_at": session.last_heartbeat_at.isoformat()}


@router.delete("/sessions/{session_id}")
async def end_session(
    session_id: uuid.UUID,
    client_id: str,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    session = (
        await db.execute(
            select(StreamSession).where(
                StreamSession.id == session_id,
                StreamSession.client_id == client_id,
            )
        )
    ).scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Session not found")
    session.ref_count = max(0, session.ref_count - 1)
    if session.ref_count == 0:
        session.active = False
        session.ended_at = datetime.now(timezone.utc)
    return {"ok": True, "active": session.active, "ref_count": session.ref_count}


@router.get("/active")
async def list_active(
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    """Workers poll this to know which cameras need RTSP/WHEP open."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.STREAM_IDLE_SECONDS)
    # Expire stale sessions
    stale = (
        await db.execute(
            select(StreamSession).where(
                StreamSession.active.is_(True),
                StreamSession.last_heartbeat_at < cutoff,
            )
        )
    ).scalars().all()
    for s in stale:
        s.active = False
        s.ended_at = datetime.now(timezone.utc)

    rows = (
        await db.execute(
            select(StreamSession, Camera)
            .join(Camera, Camera.id == StreamSession.camera_id)
            .where(StreamSession.active.is_(True))
        )
    ).all()

    by_camera: dict[str, dict] = {}
    for session, cam in rows:
        key = str(cam.id)
        if key not in by_camera:
            stream_id = cam.whep_path or cam.external_id
            by_camera[key] = {
                "camera_id": key,
                "external_id": cam.external_id,
                "rtsp_url": cam.rtsp_url,
                "whep_url": settings.whep_url(stream_id),
                "hls_url": settings.hls_url(stream_id),
                "session_count": 0,
            }
        by_camera[key]["session_count"] += 1

    return {"active_cameras": list(by_camera.values()), "count": len(by_camera)}


# ---------------------------------------------------------------------------
# Authenticated HLS proxy — prefers cookie-free CDN fetch; falls back to a
# brief sandbox portal session only if the CDN returns 401/403.
# ---------------------------------------------------------------------------

async def _fetch_hls_bytes(url: str) -> tuple[bytes, str, int]:
    """Return (body, content_type, status). Tries plain GET first, then portal session."""
    import httpx

    from app.services.catalog_sync import _authenticated_client, _logout

    async with httpx.AsyncClient(timeout=25.0, follow_redirects=True) as plain:
        resp = await plain.get(url)
        if resp.status_code < 400:
            return resp.content, resp.headers.get("content-type", "application/octet-stream"), resp.status_code
        if resp.status_code not in (401, 403, 302):
            return resp.content, resp.headers.get("content-type", "application/octet-stream"), resp.status_code

    client = None
    try:
        client = await _authenticated_client()
        resp = await client.get(url, follow_redirects=True)
        return resp.content, resp.headers.get("content-type", "application/octet-stream"), resp.status_code
    finally:
        if client is not None:
            try:
                await _logout(client)
            except Exception:
                pass
            await client.aclose()


@router.get("/proxy/{camera_id}/index.m3u8")
async def proxy_hls_playlist(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    """Proxy m3u8 playlist; keep segment names relative so hls.js resolves under this path."""
    from fastapi.responses import Response

    cam = (
        await db.execute(select(Camera).where(Camera.id == camera_id, Camera.is_active.is_(True)))
    ).scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    stream_id = cam.hls_path or cam.whep_path or cam.external_id
    upstream = settings.hls_url(stream_id)
    body, _ctype, status_code = await _fetch_hls_bytes(upstream)
    if status_code >= 400:
        raise HTTPException(502, f"Upstream HLS playlist failed ({status_code})")

    text_body = body.decode("utf-8", errors="replace")
    lines_out: list[str] = []
    for line in text_body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            lines_out.append(line)
            continue
        # Strip query / path → filename only (relative to this proxy route)
        seg = stripped.split("?")[0].rsplit("/", 1)[-1]
        lines_out.append(seg)
    rewritten = "\n".join(lines_out) + "\n"
    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
    )


@router.get("/proxy/{camera_id}/{segment}")
async def proxy_hls_segment(
    camera_id: uuid.UUID,
    segment: str,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    """Proxy a single HLS media segment from the CDN."""
    from fastapi.responses import Response

    if ".." in segment or "/" in segment or "\\" in segment:
        raise HTTPException(400, "Invalid segment name")

    cam = (
        await db.execute(select(Camera).where(Camera.id == camera_id, Camera.is_active.is_(True)))
    ).scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    stream_id = cam.hls_path or cam.whep_path or cam.external_id
    upstream = f"{settings.SANDBOX_HLS_BASE.rstrip('/')}/{stream_id}/{segment}"
    body, ctype, status_code = await _fetch_hls_bytes(upstream)
    if status_code >= 400:
        raise HTTPException(502, f"Upstream segment failed ({status_code})")
    return Response(
        content=body,
        media_type=ctype or "video/MP2T",
        headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
    )
