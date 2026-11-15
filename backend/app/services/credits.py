"""Credit grants, daily check-ins, and chat consumption rules."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.credit import CreditLedger
from app.models.user import AppUser


INITIAL_SIGNUP_CREDITS = 10
DAILY_CHECKIN_CREDITS = 1
CHAT_CREDIT_COST = 1


class InsufficientCreditsError(Exception):
    pass


class AlreadyCheckedInError(Exception):
    pass


@dataclass(frozen=True)
class CreditGrant:
    amount: int
    balance_after: int
    source: str


def vip_active(user: AppUser) -> bool:
    if not user.is_vip:
        return False
    if user.vip_expires_at is None:
        return True
    expires_at = user.vip_expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at >= datetime.now(timezone.utc)


def chat_is_free(user: AppUser) -> bool:
    """VIP and explicitly whitelisted test accounts bypass credits."""
    return bool(user.unlimited_credits) or vip_active(user)


def ensure_chat_credit(db: Session, user: AppUser) -> None:
    """Fail before an LLM call when a normal user has no usable balance."""
    row = db.get(AppUser, str(user.id), with_for_update=True)
    if row is None:
        return
    if chat_is_free(row):
        return
    if row.credit_balance < CHAT_CREDIT_COST:
        raise InsufficientCreditsError("积分不足，请先完成今日签到")


def _local_checkin_date() -> Any:
    return datetime.now(timezone.utc).astimezone(
        timezone(timedelta(hours=8))
    ).date()


def grant_signup_credits(db: Session, user: AppUser) -> CreditGrant | None:
    """Create the signup ledger row exactly once after a new user is flushed."""
    existing = db.scalar(
        select(CreditLedger).where(
            CreditLedger.user_id == user.id, CreditLedger.source == "signup"
        )
    )
    if existing is not None:
        return None
    return _grant(
        db,
        user_id=user.id,
        amount=INITIAL_SIGNUP_CREDITS,
        source="signup",
        reason="注册赠送积分",
    )


def daily_checkin(db: Session, user: AppUser) -> tuple[CreditLedger, bool]:
    """Grant the daily bonus at most once per Asia/Shanghai calendar day."""
    checkin_date = _local_checkin_date()
    existing = db.scalar(
        select(CreditLedger).where(
            CreditLedger.user_id == user.id,
            CreditLedger.source == "checkin",
            CreditLedger.checkin_date == checkin_date,
        )
    )
    if existing is not None:
        raise AlreadyCheckedInError("今日已签到")
    ledger = _grant(
        db,
        user_id=user.id,
        amount=DAILY_CHECKIN_CREDITS,
        source="checkin",
        reason="每日签到奖励",
        checkin_date=checkin_date,
    )
    return ledger, True


def spend_chat_credit(db: Session, user: AppUser) -> CreditLedger | None:
    """Charge one credit after a successful chat call."""
    row = db.get(AppUser, str(user.id), with_for_update=True)
    if row is None:
        # Test doubles and public mock transports may not have an AppUser row.
        return None
    if chat_is_free(row):
        return None
    if row.credit_balance < CHAT_CREDIT_COST:
        raise InsufficientCreditsError("积分不足，请先完成今日签到")
    ledger = _grant(
        db,
        user_id=row.id,
        amount=-CHAT_CREDIT_COST,
        source="chat",
        reason="编辑助手对话",
        details={"operation": "assistant.chat"},
    )
    return ledger


def adjust_balance(
    db: Session, *, user_id: str, amount: int, reason: str
) -> CreditGrant:
    return _grant(
        db,
        user_id=user_id,
        amount=amount,
        source="admin_adjust",
        reason=reason,
    )


def _grant(
    db: Session,
    *,
    user_id: str,
    amount: int,
    source: str,
    reason: str | None = None,
    checkin_date: Any = None,
    details: dict[str, Any] | None = None,
) -> CreditGrant:
    row = db.get(AppUser, str(user_id), with_for_update=True)
    if row is None:
        raise ValueError("用户不存在")
    target_balance = row.credit_balance + amount
    if target_balance < 0:
        raise InsufficientCreditsError("积分余额不足")
    row.credit_balance = target_balance
    db.add(
        CreditLedger(
            id=str(uuid4()),
            user_id=row.id,
            amount=amount,
            balance_after=target_balance,
            source=source,
            reason=reason,
            checkin_date=checkin_date,
            details=details,
        )
    )
    db.commit()
    db.refresh(row)
    return CreditGrant(amount=amount, balance_after=target_balance, source=source)
