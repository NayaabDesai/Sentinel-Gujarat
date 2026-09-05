"""Environment variables & sandbox host configuration."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql+asyncpg://sentinel:sentinel@localhost:5432/sentinel_gujarat"
    REDIS_URL: str = "redis://localhost:6379/0"

    # Sandbox contracts — never hardcode individual camera URLs
    SANDBOX_HOST: str = "localhost"
    SANDBOX_INGEST_URL: str = "http://localhost/api/ingest"
    SANDBOX_WHEP_BASE: str = "http://localhost:8889/stream"
    SANDBOX_HLS_BASE: str = "http://localhost/live/stream"

    CATALOG_REFRESH_SECONDS: int = 60
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    # Forced RTSP-over-TCP for any OpenCV/FFmpeg path in this process
    OPENCV_FFMPEG_CAPTURE_OPTIONS: str = "rtsp_transport;tcp"

    # Stream session idle timeout (seconds) before tearing down on-demand ingest
    STREAM_IDLE_SECONDS: int = 120

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    def whep_url(self, stream_id: str) -> str:
        return f"{self.SANDBOX_WHEP_BASE.rstrip('/')}/{stream_id}/whep"

    def hls_url(self, stream_id: str) -> str:
        return f"{self.SANDBOX_HLS_BASE.rstrip('/')}/{stream_id}/index.m3u8"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
