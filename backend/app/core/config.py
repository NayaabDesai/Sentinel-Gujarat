"""Environment variables & sandbox host configuration."""



from __future__ import annotations



import base64

from functools import lru_cache

from urllib.parse import quote, unquote, urlparse, urlunparse



from pydantic_settings import BaseSettings, SettingsConfigDict





class Settings(BaseSettings):

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")



    DATABASE_URL: str = "postgresql+asyncpg://sentinel:sentinel@localhost:5432/sentinel_gujarat"

    REDIS_URL: str = "redis://localhost:6379/0"



    # Sandbox contracts — never hardcode individual camera URLs

    SANDBOX_HOST: str = "cctv.corp8.cloud"

    SANDBOX_INGEST_URL: str = "https://cctv.corp8.cloud/cameras.json"

    SANDBOX_WHEP_BASE: str = "http://103.250.160.189:8889/stream"

    SANDBOX_HLS_BASE: str = "https://cctv.corp8.cloud"

    SANDBOX_RTSP_BASE: str = "rtsp://103.250.160.189:8554/stream"

    SANDBOX_MEDIA_IP: str = "103.250.160.189"



    # Portal credentials — embedded in RTSP/WHEP URLs; Basic auth for HTTP

    SANDBOX_EMAIL: str = ""

    SANDBOX_PASSWORD: str = ""



    CATALOG_REFRESH_SECONDS: int = 60

    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"



    # Forced RTSP-over-TCP for any OpenCV/FFmpeg path in this process

    OPENCV_FFMPEG_CAPTURE_OPTIONS: str = "rtsp_transport;tcp"



    # Stream session idle timeout (seconds) before tearing down on-demand ingest

    STREAM_IDLE_SECONDS: int = 120



    @property

    def cors_origin_list(self) -> list[str]:

        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]



    @property

    def sandbox_email_raw(self) -> str:

        """Decode %40 → @ so we can re-encode safely for URL userinfo."""

        return unquote(self.SANDBOX_EMAIL.strip())



    @property

    def has_sandbox_auth(self) -> bool:

        return bool(self.sandbox_email_raw and self.SANDBOX_PASSWORD)



    @property

    def sandbox_userinfo(self) -> str:

        """email:password with @ → %40 and other reserved chars quoted."""

        if not self.has_sandbox_auth:

            return ""

        user = quote(self.sandbox_email_raw, safe="")

        password = quote(self.SANDBOX_PASSWORD, safe="")

        return f"{user}:{password}"



    @property

    def media_auth_header(self) -> str | None:

        """HTTP Basic Authorization value for WHEP / catalog / HLS xhr."""

        if not self.has_sandbox_auth:

            return None

        token = base64.b64encode(

            f"{self.sandbox_email_raw}:{self.SANDBOX_PASSWORD}".encode()

        ).decode()

        return f"Basic {token}"



    def _with_userinfo(self, base: str, stream_id: str, suffix: str = "") -> str:

        """Inject credentials into URL authority when configured."""

        sid = stream_id.strip().strip("/")

        path_tail = f"{sid}{suffix}"

        raw = f"{base.rstrip('/')}/{path_tail}"

        if not self.has_sandbox_auth:

            return raw

        parsed = urlparse(raw)

        host = parsed.hostname or self.SANDBOX_MEDIA_IP

        port = f":{parsed.port}" if parsed.port else ""

        netloc = f"{self.sandbox_userinfo}@{host}{port}"

        return urlunparse(

            (parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, parsed.fragment)

        )



    def whep_url(self, stream_id: str, *, embed_auth: bool = True) -> str:

        """http://[email:pass@]103.250.160.189:8889/stream/<id>/whep"""

        if embed_auth:

            return self._with_userinfo(self.SANDBOX_WHEP_BASE, stream_id, "/whep")

        return f"{self.SANDBOX_WHEP_BASE.rstrip('/')}/{stream_id.strip().strip('/')}/whep"



    def hls_url(self, stream_id: str, *, embed_auth: bool = False) -> str:

        """https://cctv.corp8.cloud/<id>/index.m3u8"""

        if embed_auth:

            return self._with_userinfo(self.SANDBOX_HLS_BASE, stream_id, "/index.m3u8")

        return f"{self.SANDBOX_HLS_BASE.rstrip('/')}/{stream_id.strip().strip('/')}/index.m3u8"



    def rtsp_url(self, stream_id: str) -> str:

        """rtsp://email:password@103.250.160.189:8554/stream/<id>"""

        return self._with_userinfo(self.SANDBOX_RTSP_BASE, stream_id)





@lru_cache

def get_settings() -> Settings:

    return Settings()





settings = get_settings()

