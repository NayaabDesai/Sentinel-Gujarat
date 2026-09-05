"""Environment variables & sandbox host configuration."""

from __future__ import annotations

from functools import lru_cache
from urllib.parse import urlparse, urlunparse

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Database & Cache ---
    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/sentinel_db"
    REDIS_URL: str = "redis://localhost:6379/0"

    # --- Sandbox: catalog ---
    SANDBOX_HOST: str = "cctv.corp8.cloud"
    SANDBOX_INGEST_URL: str = "https://cctv.corp8.cloud/cameras.json"

    # --- Sandbox: stream bases (credentials injected at runtime) ---
    SANDBOX_HLS_BASE: str = "https://cctv.corp8.cloud"
    SANDBOX_WHEP_BASE: str = "http://103.250.160.189:8889/stream"
    SANDBOX_RTSP_HOST: str = "103.250.160.189:8554"

    # --- Sandbox: credentials (register at cctv.corp8.cloud) ---
    SANDBOX_EMAIL: str = ""
    SANDBOX_PASSWORD: str = ""

    # --- Timing ---
    # Keep AUTO_SYNC false: sandbox allows one web session per IP.
    CATALOG_AUTO_SYNC: bool = False
    CATALOG_REFRESH_SECONDS: int = 3600
    STREAM_IDLE_SECONDS: int = 120

    # --- API ---
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"
    OPENCV_FFMPEG_CAPTURE_OPTIONS: str = "rtsp_transport;tcp"

    # -------------------------------------------------------------------------
    # Derived helpers
    # -------------------------------------------------------------------------

    @property
    def sandbox_email_encoded(self) -> str:
        """Percent-encode the @ in an email for embedding in URLs."""
        return self.SANDBOX_EMAIL.replace("@", "%40")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    def rtsp_url(self, cam_id: str) -> str:
        """
        Build a credentialed RTSP URL for a camera.
        rtsp://user%40domain.com:password@103.250.160.189:8554/stream/cam01
        """
        if self.SANDBOX_EMAIL and self.SANDBOX_PASSWORD:
            return (
                f"rtsp://{self.sandbox_email_encoded}:{self.SANDBOX_PASSWORD}"
                f"@{self.SANDBOX_RTSP_HOST}/stream/{cam_id}"
            )
        # No credentials configured — return unauthenticated (will fail on sandbox)
        return f"rtsp://{self.SANDBOX_RTSP_HOST}/stream/{cam_id}"

    def whep_url(self, cam_id: str) -> str:
        """
        Build a credentialed WHEP URL.
        http://user%40domain:password@103.250.160.189:8889/stream/cam01/whep
        """
        base = self.SANDBOX_WHEP_BASE.rstrip("/")
        if self.SANDBOX_EMAIL and self.SANDBOX_PASSWORD:
            parsed = urlparse(base)
            netloc = f"{self.sandbox_email_encoded}:{self.SANDBOX_PASSWORD}@{parsed.netloc}"
            base = urlunparse(parsed._replace(netloc=netloc))
        return f"{base}/{cam_id}/whep"

    def hls_url(self, cam_id: str) -> str:
        """
        Build an HLS playlist URL.
        https://cctv.corp8.cloud/cam01/index.m3u8
        HLS is served via CDN — no credentials in the URL, password is a
        session cookie set after login on cctv.corp8.cloud.
        """
        return f"{self.SANDBOX_HLS_BASE.rstrip('/')}/{cam_id}/index.m3u8"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
