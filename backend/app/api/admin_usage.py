"""Usage, pricing, overview, and audit endpoints for the admin console."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from app.core.auth import require_admin
from app.db.session import get_db
from app.models.usage import AdminAuditLog, ModelPricing, UsageEvent
from app.models.user import AppUser
from app.services.usage import audit

router = APIRouter(prefix="/admin", tags=["admin-console"])


def _parse_date(value: str | None, fallback: datetime) -> datetime:
    if not value:
        return fallback
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="日期格式无效") from exc


def _money(value) -> float | None:
    return float(value) if value is not None else None


def _usage_out(event: UsageEvent, username: str | None = None, display_name: str | None = None) -> dict:
    return {
        "id": event.id, "userId": event.user_id, "username": username,
        "displayName": display_name, "operation": event.operation,
        "serviceType": event.service_type, "provider": event.provider,
        "modelId": event.model_id, "profileId": event.profile_id,
        "inputTokens": event.input_tokens or 0, "outputTokens": event.output_tokens or 0,
        "imageCount": event.image_count or 0, "requestCount": event.request_count or 0,
        "status": event.status, "latencyMs": event.latency_ms,
        "estimatedCost": _money(event.estimated_cost), "currency": event.currency,
        "isPriced": event.estimated_cost is not None,
        "createdAt": event.created_at.isoformat() if event.created_at else None,
    }


def _usage_filters(start: datetime, end: datetime, user_id: str | None = None, service_type: str | None = None, status: str | None = None):
    filters = [UsageEvent.created_at >= start, UsageEvent.created_at < end]
    if user_id:
        filters.append(UsageEvent.user_id == user_id)
    if service_type:
        filters.append(UsageEvent.service_type == service_type)
    if status:
        filters.append(UsageEvent.status == status)
    return filters


@router.get("/overview")
def overview(days: int = Query(default=30, ge=7, le=365), db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    del admin
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    start = now - timedelta(days=days)
    users = db.scalar(select(func.count()).select_from(AppUser)) or 0
    active_users = db.scalar(select(func.count()).select_from(AppUser).where(AppUser.is_active.is_(True))) or 0
    new_users = db.scalar(select(func.count()).select_from(AppUser).where(AppUser.created_at >= start)) or 0
    calls, input_tokens, output_tokens, images, cost, failures = db.execute(
        select(
            func.sum(UsageEvent.request_count), func.sum(UsageEvent.input_tokens),
            func.sum(UsageEvent.output_tokens), func.sum(UsageEvent.image_count),
            func.sum(UsageEvent.estimated_cost),
            func.sum(case((UsageEvent.status == "failed", 1), else_=0)),
        ).where(UsageEvent.created_at >= start)
    ).one()
    daily = db.execute(
        select(
            func.date(UsageEvent.created_at).label("day"),
            func.sum(UsageEvent.request_count).label("calls"),
            func.sum(UsageEvent.input_tokens).label("input"),
            func.sum(UsageEvent.output_tokens).label("output"),
            func.sum(UsageEvent.image_count).label("images"),
            func.sum(UsageEvent.estimated_cost).label("cost"),
        ).where(UsageEvent.created_at >= start).group_by(func.date(UsageEvent.created_at)).order_by(func.date(UsageEvent.created_at))
    ).all()
    top_models = db.execute(
        select(UsageEvent.model_id, UsageEvent.service_type, func.sum(UsageEvent.request_count).label("calls"), func.sum(UsageEvent.input_tokens + UsageEvent.output_tokens).label("tokens"))
        .where(UsageEvent.created_at >= start).group_by(UsageEvent.model_id, UsageEvent.service_type).order_by(func.sum(UsageEvent.request_count).desc()).limit(8)
    ).all()
    return {
        "period": {"days": days, "start": start.isoformat(), "end": now.isoformat()},
        "users": {"total": users, "active": active_users, "new": new_users},
        "usage": {"calls": int(calls or 0), "inputTokens": int(input_tokens or 0), "outputTokens": int(output_tokens or 0), "images": int(images or 0), "estimatedCost": _money(cost), "failures": int(failures or 0)},
        "daily": [{"day": str(row.day), "calls": int(row.calls or 0), "inputTokens": int(row.input or 0), "outputTokens": int(row.output or 0), "images": int(row.images or 0), "estimatedCost": _money(row.cost)} for row in daily],
        "topModels": [{"modelId": row.model_id, "serviceType": row.service_type, "calls": int(row.calls or 0), "tokens": int(row.tokens or 0)} for row in top_models],
    }


@router.get("/usage")
def list_usage(
    start: str | None = None, end: str | None = None, userId: str | None = None,
    serviceType: str | None = None, status: str | None = Query(default=None, pattern="^(succeeded|failed)$"),
    page: int = Query(default=1, ge=1), perPage: int = Query(default=30, ge=1, le=100),
    db: Session = Depends(get_db), admin: AppUser = Depends(require_admin),
):
    del admin
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    start_dt = _parse_date(start, now - timedelta(days=30))
    end_dt = _parse_date(end, now + timedelta(seconds=1))
    filters = _usage_filters(start_dt, end_dt, userId, serviceType, status)
    total = db.scalar(select(func.count()).select_from(UsageEvent).where(*filters)) or 0
    rows = db.execute(
        select(UsageEvent, AppUser.username, AppUser.display_name)
        .join(AppUser, AppUser.id == UsageEvent.user_id)
        .where(*filters).order_by(UsageEvent.created_at.desc()).offset((page - 1) * perPage).limit(perPage)
    ).all()
    calls, input_tokens, output_tokens, images, cost = db.execute(
        select(func.sum(UsageEvent.request_count), func.sum(UsageEvent.input_tokens), func.sum(UsageEvent.output_tokens), func.sum(UsageEvent.image_count), func.sum(UsageEvent.estimated_cost)).where(*filters)
    ).one()
    return {"events": [_usage_out(event, username, display_name) for event, username, display_name in rows], "total": total, "page": page, "perPage": perPage, "pages": max(1, (total + perPage - 1) // perPage), "summary": {"calls": int(calls or 0), "inputTokens": int(input_tokens or 0), "outputTokens": int(output_tokens or 0), "images": int(images or 0), "estimatedCost": _money(cost)}}


class PricingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    serviceType: str = Field(pattern="^(text|vision|image|embedding|rerank|probe)$")
    provider: str = Field(min_length=1, max_length=160)
    modelId: str = Field(min_length=1, max_length=200)
    inputPricePerMillion: float | None = Field(default=None, ge=0, le=1_000_000)
    outputPricePerMillion: float | None = Field(default=None, ge=0, le=1_000_000)
    imagePrice: float | None = Field(default=None, ge=0, le=1_000_000)
    requestPrice: float | None = Field(default=None, ge=0, le=1_000_000)
    currency: str = Field(default="USD", min_length=3, max_length=8)


def _pricing_out(row: ModelPricing) -> dict:
    return {"id": row.id, "serviceType": row.service_type, "provider": row.provider, "modelId": row.model_id, "inputPricePerMillion": _money(row.input_price_per_million), "outputPricePerMillion": _money(row.output_price_per_million), "imagePrice": _money(row.image_price), "requestPrice": _money(row.request_price), "currency": row.currency, "updatedAt": row.updated_at.isoformat() if row.updated_at else None}


@router.get("/pricing")
def list_pricing(db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    del admin
    return {"pricing": [_pricing_out(row) for row in db.scalars(select(ModelPricing).order_by(ModelPricing.service_type, ModelPricing.provider, ModelPricing.model_id)).all()]}


@router.post("/pricing", status_code=201)
def create_pricing(body: PricingIn, db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    if db.scalar(select(ModelPricing.id).where(ModelPricing.service_type == body.serviceType, ModelPricing.provider == body.provider.strip(), ModelPricing.model_id == body.modelId.strip())):
        raise HTTPException(status_code=409, detail="该模型的价格配置已存在")
    row = ModelPricing(id="price-" + uuid4().hex, service_type=body.serviceType, provider=body.provider.strip(), model_id=body.modelId.strip(), input_price_per_million=body.inputPricePerMillion, output_price_per_million=body.outputPricePerMillion, image_price=body.imagePrice, request_price=body.requestPrice, currency=body.currency.upper(), updated_by=admin.id)
    db.add(row); audit(db, actor_user_id=admin.id, action="pricing.create", subject_type="pricing", subject_id=row.id, changes=_pricing_out(row)); db.commit(); db.refresh(row)
    return _pricing_out(row)


@router.put("/pricing/{pricing_id}")
def update_pricing(pricing_id: str, body: PricingIn, db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    row = db.get(ModelPricing, pricing_id)
    if row is None: raise HTTPException(status_code=404, detail="价格配置不存在")
    duplicate = db.scalar(select(ModelPricing.id).where(ModelPricing.id != pricing_id, ModelPricing.service_type == body.serviceType, ModelPricing.provider == body.provider.strip(), ModelPricing.model_id == body.modelId.strip()))
    if duplicate:
        raise HTTPException(status_code=409, detail="该模型的价格配置已存在")
    for key, column in {"serviceType": "service_type", "provider": "provider", "modelId": "model_id", "inputPricePerMillion": "input_price_per_million", "outputPricePerMillion": "output_price_per_million", "imagePrice": "image_price", "requestPrice": "request_price", "currency": "currency"}.items():
        value = getattr(body, key)
        setattr(row, column, value.strip().upper() if key == "currency" else value.strip() if key in {"provider", "modelId"} else value)
    row.updated_by = admin.id
    audit(db, actor_user_id=admin.id, action="pricing.update", subject_type="pricing", subject_id=row.id, changes=_pricing_out(row)); db.commit(); db.refresh(row)
    return _pricing_out(row)


@router.delete("/pricing/{pricing_id}", status_code=204)
def delete_pricing(pricing_id: str, db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    row = db.get(ModelPricing, pricing_id)
    if row is None: raise HTTPException(status_code=404, detail="价格配置不存在")
    audit(db, actor_user_id=admin.id, action="pricing.delete", subject_type="pricing", subject_id=row.id, changes={}); db.delete(row); db.commit()


@router.get("/audit")
def list_audit(page: int = Query(default=1, ge=1), perPage: int = Query(default=30, ge=1, le=100), db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    del admin
    rows = db.execute(select(AdminAuditLog, AppUser.username).join(AppUser, AppUser.id == AdminAuditLog.actor_user_id).order_by(AdminAuditLog.created_at.desc()).offset((page - 1) * perPage).limit(perPage)).all()
    return {"events": [{"id": event.id, "actorUserId": event.actor_user_id, "actorUsername": username, "action": event.action, "subjectType": event.subject_type, "subjectId": event.subject_id, "changes": event.changes, "createdAt": event.created_at.isoformat() if event.created_at else None} for event, username in rows]}
