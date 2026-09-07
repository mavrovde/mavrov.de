"""Recruiter communication hub (#69).

Public: ``POST /interactions/contact`` — the site's contact/inquiry form.
Admin:  ``GET /admin/interactions`` (filterable inbox) and
        ``PATCH /admin/interactions/{id}`` (status workflow).

Every inbound recruiter touch lands as an ``Interaction`` row; source-specific
records (e.g. ``CvRequest``) keep their own tables and link via
``source``/``source_ref``. Email notification reuses the existing SMTP flow
and — like the CV path — is a background task that never blocks intake.
"""

import re
import uuid
from math import ceil
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.logger import logger
from app.models.interaction import (
    INTERACTION_SOURCES,
    INTERACTION_STATUSES,
    Interaction,
)
from app.models.user import User
from app.services.auth import get_current_admin_user
from app.services.notifications import OwnerNotification, notify_owner
from app.services.rate_limit import SlidingWindowRateLimiter, rate_limit_dependency
from app.services.translation import translate_interaction

router = APIRouter(prefix="/interactions", tags=["interactions"])
admin_router = APIRouter(prefix="/admin/interactions", tags=["admin-interactions"])


# The contact form is a public, unauthenticated WRITE: every request costs a DB
# row and an outbound owner email, so it gets the same per-client-IP limiter the
# public profile GETs use, with a much tighter budget (see `app.services.rate_limit`).
def _build_contact_limiter() -> SlidingWindowRateLimiter:
    # Factory so tests can pin the settings wiring with SENTINEL values —
    # asserting equality against unmodified defaults pins nothing (§25).
    return SlidingWindowRateLimiter(
        max_requests=settings.contact_rate_limit_requests,
        window_seconds=settings.contact_rate_limit_window_seconds,
    )


contact_rate_limiter = _build_contact_limiter()
_enforce_contact_rate_limit = rate_limit_dependency(contact_rate_limiter)

_LINE_BREAKS = re.compile(r"[\r\n\x0b\x0c\u2028\u2029]+")


class ContactRequest(BaseModel):
    # Length bounds mirror the frontend form validators (contact-form.component.ts)
    # and are checked AFTER normalization, so whitespace-only padding can't satisfy them.
    name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    company: str | None = Field(default=None, max_length=200)
    message: str = Field(min_length=5, max_length=10_000)

    @field_validator("name", "company", mode="before")
    @classmethod
    def _single_line(cls, v: object) -> object:
        # Header-bound fields: a line break in `name` reaches the notification's
        # Subject and makes the stdlib refuse the whole email — fold to spaces.
        if isinstance(v, str):
            v = _LINE_BREAKS.sub(" ", v).strip()
            return v or None
        return v

    @field_validator("message", mode="before")
    @classmethod
    def _strip_message(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v


class InteractionOut(BaseModel):
    id: uuid.UUID
    source: str
    status: str
    name: str
    email: str
    company: str | None
    message: str
    payload: dict[str, Any] | None
    detected_language: str | None
    translated_message: str | None
    translated_to: str | None
    translation_status: str | None
    created_at: str
    updated_at: str

    @classmethod
    def from_model(cls, i: Interaction) -> "InteractionOut":
        return cls(
            id=i.id,
            source=i.source,
            status=i.status,
            name=i.name,
            email=i.email,
            company=i.company,
            message=i.message,
            payload=i.payload,
            detected_language=i.detected_language,
            translated_message=i.translated_message,
            translated_to=i.translated_to,
            translation_status=i.translation_status,
            created_at=i.created_at.isoformat(),
            updated_at=i.updated_at.isoformat(),
        )


class InteractionPage(BaseModel):
    items: list[InteractionOut]
    total: int
    page: int
    pages: int


class StatusPatch(BaseModel):
    status: str


def _notify(name: str, email: str, company: str | None, message: str) -> None:
    try:
        notify_owner(
            OwnerNotification.build(
                source="contact_form",
                name=name,
                email=email,
                company=company,
                message=message,
            )
        )
    except Exception as e:  # never let notification failures surface anywhere
        logger.error(f"Interaction notification failed: {type(e).__name__}")


@router.post(
    "/contact",
    status_code=201,
    response_model=InteractionOut,
    dependencies=[Depends(_enforce_contact_rate_limit)],
)
async def submit_contact(
    body: ContactRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> InteractionOut:
    """Public contact/inquiry form — creates a source=contact_form interaction."""
    interaction = Interaction(
        source="contact_form",
        status="new",
        name=body.name,
        email=body.email,
        company=body.company,
        message=body.message,
    )
    db.add(interaction)
    await db.commit()
    await db.refresh(interaction)
    background_tasks.add_task(
        _notify, body.name, body.email, body.company, body.message
    )
    # Transparent translation (#248): background, after the response — intake
    # never blocks on it, and the task records its own status on the row.
    if settings.translation_enabled:
        background_tasks.add_task(translate_interaction, interaction.id)
    return InteractionOut.from_model(interaction)


@admin_router.get("", response_model=InteractionPage)
async def list_interactions(
    status: str | None = Query(default=None),
    source: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin_user),
) -> InteractionPage:
    """Admin inbox: newest first, filterable by status and source."""
    if status is not None and status not in INTERACTION_STATUSES:
        raise HTTPException(status_code=422, detail=f"Unknown status '{status}'")
    if source is not None and source not in INTERACTION_SOURCES:
        raise HTTPException(status_code=422, detail=f"Unknown source '{source}'")

    query = select(Interaction)
    count_query = select(func.count(Interaction.id))
    if status is not None:
        query = query.where(Interaction.status == status)
        count_query = count_query.where(Interaction.status == status)
    if source is not None:
        query = query.where(Interaction.source == source)
        count_query = count_query.where(Interaction.source == source)

    total = (await db.execute(count_query)).scalar_one()
    rows = (
        (
            await db.execute(
                query.order_by(Interaction.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        )
        .scalars()
        .all()
    )
    return InteractionPage(
        items=[InteractionOut.from_model(i) for i in rows],
        total=total,
        page=page,
        pages=max(1, ceil(total / page_size)),
    )


@admin_router.patch("/{interaction_id}", response_model=InteractionOut)
async def update_status(
    interaction_id: uuid.UUID,
    body: StatusPatch,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin_user),
) -> InteractionOut:
    """Move an interaction through the status workflow (new → ... → closed)."""
    if body.status not in INTERACTION_STATUSES:
        raise HTTPException(status_code=422, detail=f"Unknown status '{body.status}'")
    interaction = (
        (await db.execute(select(Interaction).where(Interaction.id == interaction_id)))
        .scalars()
        .first()
    )
    if interaction is None:
        raise HTTPException(status_code=404, detail="Interaction not found")
    interaction.status = body.status
    await db.commit()
    await db.refresh(interaction)
    return InteractionOut.from_model(interaction)


@admin_router.post("/{interaction_id}/translate", response_model=InteractionOut)
async def rerun_translation(
    interaction_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin_user),
) -> InteractionOut:
    """Re-run translation on demand (#248: translated_* are separate and
    re-runnable — e.g. after fixing the model config, or for rows that predate
    the feature). Resets status to 'pending' so the UI can show progress; the
    background task overwrites only the translated_* columns, never `message`."""
    if not settings.translation_enabled:
        raise HTTPException(status_code=409, detail="Translation is disabled")
    interaction = await db.get(Interaction, interaction_id)
    if interaction is None:
        raise HTTPException(status_code=404, detail="Interaction not found")
    interaction.translation_status = "pending"
    await db.commit()
    await db.refresh(interaction)
    background_tasks.add_task(translate_interaction, interaction.id)
    return InteractionOut.from_model(interaction)
