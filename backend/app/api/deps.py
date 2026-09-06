"""FastAPI auth dependencies + RBAC helpers."""

from __future__ import annotations

import uuid

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.models import User, UserRole
from app.db.session import get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


async def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
    x_service_key: str | None = Header(default=None, alias="X-Service-Key"),
) -> User | None:
    if x_service_key and x_service_key == settings.INTERNAL_SERVICE_KEY:
        return None

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


def require_human_user(user: User | None) -> User:
    """Reject service-key callers for user-facing write actions."""
    if user is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Human user required")
    return user


def require_write(user: User | None) -> User:
    """ADMIN and OPERATOR may write; VIEWER is read-only."""
    u = require_human_user(user)
    if u.role == UserRole.VIEWER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="VIEWER role is read-only",
        )
    return u


def require_admin(user: User | None) -> User:
    u = require_human_user(user)
    if u.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="ADMIN role required")
    return u


def assert_operator_department(user: User, department_code: str | None) -> None:
    """OPERATOR may only mutate cameras in their assigned department."""
    if user.role != UserRole.OPERATOR:
        return
    if not user.department_code:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="OPERATOR has no assigned department",
        )
    code = (department_code or "").strip().upper()
    if code != user.department_code.upper():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"OPERATOR may only modify department {user.department_code}",
        )
