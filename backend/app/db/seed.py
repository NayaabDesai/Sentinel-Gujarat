"""Seed default police command-center accounts."""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.db.models import User, UserRole

logger = logging.getLogger("sentinel.seed")

DEFAULT_USERS = [
    {
        "email": "admin@police.gujarat.gov.in",
        "password": "Sentinel@2026",
        "full_name": "State Command Admin",
        "department_code": "POLICE",
        "role": UserRole.ADMIN,
    },
    {
        "email": "amc.traffic@gujarat.gov.in",
        "password": "Sentinel@2026",
        "full_name": "AMC Traffic Operator",
        "department_code": "TRAFFIC",
        "role": UserRole.OPERATOR,
    },
    {
        "email": "viewer@police.gujarat.gov.in",
        "password": "Sentinel@2026",
        "full_name": "District Viewer",
        "department_code": "POLICE",
        "role": UserRole.VIEWER,
    },
]


async def seed_users(db: AsyncSession) -> None:
    for spec in DEFAULT_USERS:
        email = spec["email"].lower()
        existing = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if existing:
            continue
        db.add(
            User(
                email=email,
                hashed_password=hash_password(spec["password"]),
                full_name=spec["full_name"],
                department_code=spec["department_code"],
                role=spec["role"],
                is_active=True,
            )
        )
        logger.info("Seeded user %s (%s)", email, spec["role"].value)
    await db.commit()
