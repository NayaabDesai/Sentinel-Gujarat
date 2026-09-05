"""Pydantic schemas for camera registration & bulk onboarding."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class CameraStatusEnum(str, Enum):
    online = "online"
    offline = "offline"
    degraded = "degraded"
    unknown = "unknown"


class CameraCreate(BaseModel):
    external_id: str = Field(..., min_length=1, max_length=128)
    name: str = Field(..., min_length=1, max_length=255)
    department_code: str | None = None
    latitude: float | None = Field(None, ge=-90, le=90)
    longitude: float | None = Field(None, ge=-180, le=180)
    altitude_m: float | None = None
    heading_deg: float | None = Field(None, ge=0, le=360)
    fov_deg: float | None = Field(None, gt=0, le=360)
    range_m: float | None = Field(None, gt=0)
    rtsp_url: str | None = None
    whep_path: str | None = None
    hls_path: str | None = None
    installed_at: datetime | None = None
    meta: dict[str, Any] | None = None

    @field_validator("external_id")
    @classmethod
    def strip_id(cls, v: str) -> str:
        return v.strip()


class CameraUpdate(BaseModel):
    name: str | None = None
    department_code: str | None = None
    latitude: float | None = Field(None, ge=-90, le=90)
    longitude: float | None = Field(None, ge=-180, le=180)
    altitude_m: float | None = None
    heading_deg: float | None = Field(None, ge=0, le=360)
    fov_deg: float | None = Field(None, gt=0, le=360)
    range_m: float | None = Field(None, gt=0)
    rtsp_url: str | None = None
    whep_path: str | None = None
    hls_path: str | None = None
    status: CameraStatusEnum | None = None
    is_active: bool | None = None
    meta: dict[str, Any] | None = None


class CameraOut(BaseModel):
    id: UUID
    external_id: str
    name: str
    department_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    altitude_m: float | None = None
    heading_deg: float | None = None
    fov_deg: float | None = None
    range_m: float | None = None
    status: CameraStatusEnum
    is_active: bool
    whep_url: str | None = None
    hls_url: str | None = None
    last_seen_at: datetime | None = None
    installed_at: datetime | None = None
    meta: dict[str, Any] | None = None

    model_config = {"from_attributes": True}


class BulkCameraItem(CameraCreate):
    """Single row from CSV / Excel / GeoJSON feature properties."""

    pass


class BulkUploadResult(BaseModel):
    total: int
    created: int
    updated: int
    errors: list[dict[str, Any]] = Field(default_factory=list)


class SpatialSearchParams(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    radius_m: float = Field(1000, gt=0, le=100_000)
    department_code: str | None = None
    status: CameraStatusEnum | None = None
    limit: int = Field(200, ge=1, le=2000)


class DepartmentOut(BaseModel):
    id: UUID
    code: str
    name: str
    camera_count: int = 0

    model_config = {"from_attributes": True}


class IngestCameraItem(BaseModel):
    """Loose schema for sandbox /api/ingest payloads."""

    id: str | None = None
    camera_id: str | None = None
    name: str | None = None
    rtsp: str | None = None
    rtsp_url: str | None = None
    url: str | None = None
    whep: str | None = None
    hls: str | None = None
    lat: float | None = None
    lon: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    department: str | None = None
    meta: dict[str, Any] | None = None

    def resolve_external_id(self) -> str:
        return (self.id or self.camera_id or self.name or "unknown").strip()

    def resolve_rtsp(self) -> str | None:
        return self.rtsp_url or self.rtsp or self.url

    def resolve_lat(self) -> float | None:
        return self.latitude if self.latitude is not None else self.lat

    def resolve_lon(self) -> float | None:
        return self.longitude if self.longitude is not None else self.lon
