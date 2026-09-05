"""User / auth Pydantic schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.db.models import UserRole


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenPayload(BaseModel):
    sub: str | None = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str = Field(min_length=4)


class UserOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    full_name: str | None = None
    department_code: str | None = None
    role: UserRole
    is_active: bool
    created_at: datetime | None = None

    model_config = {"from_attributes": True}
