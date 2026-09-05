"""Active stream session supervisor — on-demand ingest only."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.db.models import Camera, StreamSession
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
async def start_session(payload: SessionStart, db: AsyncSession = Depends(get_db)):
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
        rtsp_url=cam.rtsp_url,
        active=True,
    )


@router.post("/sessions/heartbeat")
async def heartbeat(payload: SessionHeartbeat, db: AsyncSession = Depends(get_db)):
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
async def end_session(session_id: uuid.UUID, client_id: str, db: AsyncSession = Depends(get_db)):
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
async def list_active(db: AsyncSession = Depends(get_db)):
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
