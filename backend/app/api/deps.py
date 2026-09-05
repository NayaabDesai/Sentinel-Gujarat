"""FastAPI auth dependencies."""

from __future__ import annotations

import uuid

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import User
from app.db.session import get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


async def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
    x_service_key: str | None = Header(default=None, alias="X-Service-Key"),
) -> User | None:
    """
    Accept either a JWT Bearer token (UI users) or the internal service key
    (capture worker).  Returns None only when neither is present — callers
    that require a user should use get_current_active_user.
    """
    # Worker / internal services
    if x_service_key and x_service_key == settings.INTERNAL_SERVICE_KEY:
        return None  # signal: service auth OK (no User object)

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_access_token(token)
        sub = payload.get("sub")
        if not sub:
            raise credentials_exc
        user_id = uuid.UUID(str(sub))
    except (ValueError, TypeError):
        raise credentials_exc from None

    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None:
        raise credentials_exc
    return user


async def get_current_active_user(
    current_user: User | None = Depends(get_current_user),
    x_service_key: str | None = Header(default=None, alias="X-Service-Key"),
) -> User | None:
    """Require JWT user OR valid internal service key."""
    if x_service_key and x_service_key == settings.INTERNAL_SERVICE_KEY:
        return None
    if current_user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    if not current_user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user")
    return current_user
