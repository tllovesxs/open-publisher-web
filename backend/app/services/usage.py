"""Usage ledger helpers shared by provider adapters and the admin console."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable
from uuid import uuid4

from sqlalchemy import and_, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.usage import AdminAuditLog, ModelPricing, UsageEvent
from app.services.official_pricing import official_price_for


def _number(value: Any) -> int | None:
    try:
        return max(0, int(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


def _decimal(value: Any) -> Decimal | None:
    try:
        return Decimal(str(value)) if value is not None else None
    except (TypeError, ValueError, ArithmeticError):
        return None


def _pricing(db: Session, service_type: str, provider: str, model_id: str) -> ModelPricing | None:
    return db.scalar(
        select(ModelPricing).where(
            and_(
                ModelPricing.service_type == service_type,
                ModelPricing.provider == provider,
                ModelPricing.model_id == model_id,
            )
        )
    )


def _cost(pricing: ModelPricing | dict | None, input_tokens: int | None, output_tokens: int | None, image_count: int, request_count: int) -> tuple[Decimal | None, dict | None]:
    if pricing is None:
        return None, None
    get = pricing.get if isinstance(pricing, dict) else lambda key: getattr(pricing, key)
    input_price = _decimal(get("inputPricePerMillion") if isinstance(pricing, dict) else get("input_price_per_million"))
    output_price = _decimal(get("outputPricePerMillion") if isinstance(pricing, dict) else get("output_price_per_million"))
    image_price = _decimal(get("imagePrice") if isinstance(pricing, dict) else get("image_price"))
    request_price = _decimal(get("requestPrice") if isinstance(pricing, dict) else get("request_price"))
    cost = Decimal("0")
    priced = False
    if input_tokens and input_price is not None:
        cost += Decimal(input_tokens) / Decimal(1_000_000) * input_price
        priced = True
    if output_tokens and output_price is not None:
        cost += Decimal(output_tokens) / Decimal(1_000_000) * output_price
        priced = True
    if image_count and image_price is not None:
        cost += Decimal(image_count) * image_price
        priced = True
    if request_count and request_price is not None:
        cost += Decimal(request_count) * request_price
        priced = True
    snapshot = {
        "inputPricePerMillion": str(input_price) if input_price is not None else None,
        "outputPricePerMillion": str(output_price) if output_price is not None else None,
        "imagePrice": str(image_price) if image_price is not None else None,
        "requestPrice": str(request_price) if request_price is not None else None,
        "currency": get("currency"),
        "source": "official" if isinstance(pricing, dict) else "custom",
        "sourceUrl": get("sourceUrl") if isinstance(pricing, dict) else None,
        "effectiveDate": get("effectiveDate") if isinstance(pricing, dict) else None,
    }
    return (cost if priced else None), snapshot


def record_usage(
    db: Session,
    *,
    user_id: str,
    service_type: str,
    operation: str,
    model_id: str,
    provider: str = "unknown",
    profile_id: str | None = None,
    run_id: str | None = None,
    resource_id: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    image_count: int = 0,
    request_count: int = 1,
    status: str = "succeeded",
    latency_ms: int | None = None,
) -> UsageEvent:
    """Append one immutable usage event and calculate a price snapshot."""
    input_tokens = _number(input_tokens)
    output_tokens = _number(output_tokens)
    image_count = _number(image_count) or 0
    request_count = _number(request_count) or 0
    pricing = _pricing(db, service_type, provider, model_id)
    if pricing is None:
        pricing = official_price_for(service_type, provider, model_id)
    cost, snapshot = _cost(pricing, input_tokens, output_tokens, image_count, request_count)
    event = UsageEvent(
        id=str(uuid4()), user_id=user_id, run_id=run_id, resource_id=resource_id,
        operation=operation, service_type=service_type, provider=provider,
        model_id=model_id, profile_id=profile_id, input_tokens=input_tokens,
        output_tokens=output_tokens, image_count=image_count, status=status,
        latency_ms=latency_ms, estimated_cost=cost,
        currency=(pricing.get("currency") if isinstance(pricing, dict) else pricing.currency) if pricing and cost is not None else None,
        pricing_snapshot=snapshot,
    )
    db.add(event)
    db.commit()
    return event


class UsageRecorder:
    """Thread-safe recorder: each event uses a short-lived independent session."""

    def __init__(self, db: Session, *, user_id: str, operation: str, service_type: str = "text", run_id: str | None = None, resource_id: str | None = None, provider: str = "unknown") -> None:
        self.factory = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)
        self.user_id = user_id
        self.operation = operation
        self.service_type = service_type
        self.run_id = run_id
        self.resource_id = resource_id
        self.provider = provider

    def __call__(self, payload: dict[str, Any]) -> None:
        try:
            with self.factory() as session:
                record_usage(
                    session, user_id=self.user_id,
                    service_type=str(payload.get("serviceType") or self.service_type),
                    operation=str(payload.get("operation") or self.operation),
                    model_id=str(payload.get("modelId") or "unknown"),
                    provider=str(payload.get("provider") or self.provider),
                    profile_id=payload.get("profileId"),
                    run_id=payload.get("runId") or self.run_id,
                    resource_id=payload.get("resourceId") or self.resource_id,
                    input_tokens=payload.get("inputTokens"),
                    output_tokens=payload.get("outputTokens"),
                    image_count=payload.get("imageCount", 0),
                    request_count=payload.get("requestCount", 1),
                    status=str(payload.get("status") or "succeeded"),
                    latency_ms=payload.get("latencyMs"),
                )
        except Exception:
            # A metrics write must never turn a successful customer request into a failure.
            return


def audit(db: Session, *, actor_user_id: str, action: str, subject_type: str, subject_id: str, changes: dict) -> None:
    db.add(AdminAuditLog(
        actor_user_id=actor_user_id, action=action, subject_type=subject_type,
        subject_id=subject_id, changes=changes,
    ))
