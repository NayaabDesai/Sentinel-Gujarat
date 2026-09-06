"""Active stream session supervisor — on-demand ingest only."""

from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_active_user, get_stream_viewer
from app.core.config import settings
from app.db.models import Camera, StreamSession, User
from app.db.session import get_db

logger = logging.getLogger("sentinel.stream")
router = APIRouter()

# At most one on-demand FFmpeg MJPEG process per camera (sandbox-friendly).
_mjpeg_procs: dict[str, asyncio.subprocess.Process] = {}


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
    mjpeg_url: str | None = None
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
    # Never return credentialed WHEP URLs to the browser (Chrome strips userinfo).
    return SessionOut(
        session_id=session.id,
        camera_id=cam.id,
        external_id=cam.external_id,
        protocol=session.protocol,
        whep_url=settings.whep_public_url(stream_id),
        hls_url=settings.hls_url(stream_id),
        rtsp_url=cam.rtsp_url or settings.rtsp_url(stream_id),
        mjpeg_url=f"/api/v1/stream/proxy/{cam.id}/mjpeg",
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
                StreamSession.active.is_(True),
            )
        )
    ).scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Session not found")
    session.last_heartbeat_at = datetime.now(timezone.utc)
    return {"ok": True}


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
        return Response(status_code=204)
    session.ref_count = max(0, session.ref_count - 1)
    if session.ref_count <= 0:
        session.active = False
        cam_key = str(session.camera_id)
        proc = _mjpeg_procs.pop(cam_key, None)
        if proc and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    return Response(status_code=204)


@router.get("/active")
async def active_streams(
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.STREAM_IDLE_SECONDS)
    rows = (
        await db.execute(
            select(StreamSession)
            .options(selectinload(StreamSession.camera))
            .where(StreamSession.active.is_(True), StreamSession.last_heartbeat_at >= cutoff)
        )
    ).scalars().all()

    by_camera: dict[str, dict] = {}
    for s in rows:
        if not s.camera:
            continue
        key = str(s.camera_id)
        if key not in by_camera:
            by_camera[key] = {
                "camera_id": key,
                "external_id": s.camera.external_id,
                "session_count": 0,
            }
        by_camera[key]["session_count"] += 1

    return {"active_cameras": list(by_camera.values()), "count": len(by_camera)}


# ---------------------------------------------------------------------------
# WHEP signaling proxy — MediaMTX Basic Auth stays server-side
# ---------------------------------------------------------------------------

@router.post("/whep/{camera_id}")
async def whep_signaling_proxy(
    camera_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_current_active_user),
):
    """Relay browser SDP offer to MediaMTX with sandbox Basic Auth (never expose password)."""
    cam = (
        await db.execute(select(Camera).where(Camera.id == camera_id, Camera.is_active.is_(True)))
    ).scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    stream_id = cam.whep_path or cam.external_id
    upstream = settings.whep_public_url(stream_id)
    offer = await request.body()
    if not offer:
        raise HTTPException(400, "Empty SDP offer")

    headers = {"Content-Type": "application/sdp"}
    if settings.SANDBOX_EMAIL and settings.SANDBOX_PASSWORD:
        token = base64.b64encode(
            f"{settings.SANDBOX_EMAIL}:{settings.SANDBOX_PASSWORD}".encode()
        ).decode()
        headers["Authorization"] = f"Basic {token}"

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(upstream, content=offer, headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"WHEP upstream unreachable: {e}") from e

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/sdp"),
    )


# ---------------------------------------------------------------------------
# HLS proxy (CDN only — NO portal login; login causes single-IP lockouts)
# ---------------------------------------------------------------------------

async def _fetch_hls_bytes(url: str) -> tuple[bytes, str, int]:
    """Plain CDN fetch only. Never open a Corp8 web session here."""
    async with httpx.AsyncClient(
        timeout=15.0,
        follow_redirects=True,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; SentinelGujarat/1.0)",
            "Accept": "*/*",
        },
    ) as plain:
        try:
            resp = await plain.get(url)
        except httpx.HTTPError:
            return b"", "application/octet-stream", 502
        return (
            resp.content,
            resp.headers.get("content-type", "application/octet-stream"),
            resp.status_code,
        )


@router.get("/proxy/{camera_id}/index.m3u8")
async def proxy_hls_playlist(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_stream_viewer),
):
    """Proxy m3u8 playlist; keep segment names relative so hls.js resolves under this path."""
    cam = (
        await db.execute(select(Camera).where(Camera.id == camera_id, Camera.is_active.is_(True)))
    ).scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    stream_id = cam.hls_path or cam.whep_path or cam.external_id
    upstream = settings.hls_url(stream_id)
    body, _ctype, status_code = await _fetch_hls_bytes(upstream)
    if status_code >= 400 or not body.lstrip().startswith(b"#EXTM3U"):
        raise HTTPException(502, f"Upstream HLS playlist unavailable ({status_code})")

    text_body = body.decode("utf-8", errors="replace")
    lines_out: list[str] = []
    for line in text_body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            lines_out.append(line)
            continue
        seg = stripped.split("?")[0].rsplit("/", 1)[-1]
        lines_out.append(seg)
    rewritten = "\n".join(lines_out) + "\n"
    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
    )


@router.get("/proxy/{camera_id}/mjpeg")
async def proxy_mjpeg(
    camera_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_stream_viewer),
):
    """
    On-demand RTSP → MJPEG relay (ONE camera at a time).
    Corp8 HLS returns 'browser required'; RTSP from Docker works — this is the reliable UI path.
    """
    cam = (
        await db.execute(select(Camera).where(Camera.id == camera_id, Camera.is_active.is_(True)))
    ).scalar_one_or_none()
    if not cam:
        raise HTTPException(404, "Camera not found")

    stream_id = cam.whep_path or cam.external_id
    rtsp = cam.rtsp_url or settings.rtsp_url(stream_id)
    cam_key = str(camera_id)

    prev = _mjpeg_procs.pop(cam_key, None)
    if prev and prev.returncode is None:
        try:
            prev.kill()
        except ProcessLookupError:
            pass

    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-i",
            rtsp,
            "-an",
            "-vf",
            "scale=960:-2",
            "-q:v",
            "7",
            "-r",
            "8",
            "-f",
            "mpjpeg",
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        raise HTTPException(500, "ffmpeg not installed in backend image — rebuild") from e

    _mjpeg_procs[cam_key] = proc

    async def frame_gen():
        try:
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(16384)
                if not chunk:
                    break
                yield chunk
        finally:
            if _mjpeg_procs.get(cam_key) is proc:
                _mjpeg_procs.pop(cam_key, None)
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            try:
                await proc.wait()
            except Exception:
                pass

    return StreamingResponse(
        frame_gen(),
        media_type="multipart/x-mixed-replace; boundary=ffmpeg",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Access-Control-Allow-Origin": "*",
        },
    )


@router.get("/proxy/{camera_id}/{segment}")
async def proxy_hls_segment(
    camera_id: uuid.UUID,
    segment: str,
    db: AsyncSession = Depends(get_db),
    _user: User | None = Depends(get_stream_viewer),
):
    """Proxy a single HLS media segment from the CDN."""
    if segment in ("mjpeg", "index.m3u8"):
        raise HTTPException(404, "Not found")
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
