"""Session login against cctv.corp8.cloud form auth (cookie), then GET cameras.json."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from app.core.config import settings

logger = logging.getLogger("sentinel.sandbox_auth")


def _login_url() -> str:
    parsed = urlparse(settings.SANDBOX_INGEST_URL)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return urljoin(origin, "/auth/login")


async def fetch_authenticated_json(url: str) -> Any:
    """
    Portal catalog is cookie-gated (302 → /auth/login).
    POST email/password to /auth/login, keep Set-Cookie, then GET catalog.
    Do not follow the post-login redirect to `/` (Cloudflare may 403 that hop).
    """
    if not settings.has_sandbox_auth:
        raise RuntimeError("SANDBOX_EMAIL and SANDBOX_PASSWORD are required for catalog access")

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=False) as client:
        login = await client.post(
            _login_url(),
            data={
                "email": settings.sandbox_email_raw,
                "password": settings.SANDBOX_PASSWORD,
            },
        )
        if login.status_code == 200 and "Email or access password is incorrect" in login.text:
            raise RuntimeError("Sandbox login failed: email or access password is incorrect")
        if login.status_code not in (200, 302, 303):
            login.raise_for_status()

        resp = await client.get(url)
        # One hop if catalog itself redirects
        if resp.status_code in (301, 302, 303) and resp.headers.get("location"):
            resp = await client.get(urljoin(url, resp.headers["location"]))
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "")
        if "json" not in ctype and resp.text.lstrip().startswith("<"):
            raise RuntimeError(
                f"Catalog still returned HTML from {url} after login — check credentials / access list"
            )
        return resp.json()
