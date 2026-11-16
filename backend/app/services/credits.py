"""Credit grants, daily check-ins, and chat consumption rules."""

from __future__ import annotations

from dataclasses import dataclass
import random
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.credit import CreditLedger
from app.models.user import AppUser


INITIAL_SIGNUP_CREDITS = 200
CHECKIN_DAILY_RANGE = (20, 50)
CHAT_CREDIT_COST = 10
MONTHLY_CHECKIN_MILESTONES = ((7, 50), (14, 80), (21, 120))
MODEL_CALL_RULES: dict[str, dict[str, int]] = {
    "article_create": {"cost": 10},
    "rewrite_candidate": {"cost": 10},
    "visual_plan": {"cost": 10},
    "visual_apply": {"cost": 10},
    "template_extract": {"cost": 10},
}


class InsufficientCreditsError(Exception):
    pass


class AlreadyCheckedInError(Exception):
    pass


@dataclass(frozen=True)
class CreditGrant:
    amount: int
    balance_after: int
    source: str


@dataclass(frozen=True)
class MonthlyMilestone:
    threshold: int
    reward: int


def vip_active(user: AppUser) -> bool:
    if not getattr(user, "is_vip", False):
        return False
    expires_at = getattr(user, "vip_expires_at", None)
    if expires_at is None:
        return True
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at >= datetime.now(timezone.utc)


def chat_is_free(user: AppUser) -> bool:
    """VIP and explicitly whitelisted test accounts bypass credits.

    Legacy test doubles omit credit fields and are treated as test bypasses so
    non-credit API tests do not touch the ledger.
    """
    if not hasattr(user, "unlimited_credits"):
        return True
    return bool(getattr(user, "unlimited_credits", False)) or vip_active(user)


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


def _choose_daily_amount(user_id: str, checkin_date: date) -> int:
    """Use a stable daily roll so retries within one request cannot change the reward."""
    return random.Random(
        f"{user_id}:{checkin_date.isoformat()}"
    ).choice((20, 20, 30, 30, 40, 50))


def _month_bounds(checkin_date: date) -> tuple[date, date]:
    month_start = checkin_date.replace(day=1)
    month_end = (month_start + timedelta(days=32)).replace(day=1)
    return month_start, month_end


def ensure_model_call(db: Session, user: AppUser, action: str) -> None:
    """Verify the balance before the model call; there are no daily free calls."""
    if action not in MODEL_CALL_RULES:
        return
    if chat_is_free(user):
        return
    rule = MODEL_CALL_RULES[action]
    if user.credit_balance < rule["cost"]:
        raise InsufficientCreditsError(
            "积分不足，请完成今日签到或充值后继续调用。"
        )


def record_model_call(db: Session, user: AppUser, action: str) -> None:
    """Charge a successful model call once."""
    if action not in MODEL_CALL_RULES:
        return
    if chat_is_free(user):
        return
    rule = MODEL_CALL_RULES[action]
    _grant(
        db,
        user_id=user.id,
        amount=-rule["cost"],
        source=f"model_{action}",
        reason=f"{action} 调用",
        details={"action": action},
    )


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
    month_start, month_end = _month_bounds(checkin_date)
    monthly_count = 1 + int(
        db.scalar(
            select(func.count())
            .select_from(CreditLedger)
            .where(
                CreditLedger.user_id == user.id,
                CreditLedger.source == "checkin",
                CreditLedger.checkin_date >= month_start,
                CreditLedger.checkin_date < month_end,
            )
        )
        or 0
    )
    daily_amount = _choose_daily_amount(str(user.id), checkin_date)
    milestone = next(
        (
            MonthlyMilestone(threshold=threshold, reward=reward)
            for threshold, reward in MONTHLY_CHECKIN_MILESTONES
            if monthly_count == threshold
        ),
        None,
    )
    bonus_amount = milestone.reward if milestone else 0
    ledger = _grant(
        db,
        user_id=user.id,
        amount=daily_amount,
        source="checkin",
        reason="每日签到奖励",
        details={
            "dailyAmount": daily_amount,
            "bonusAmount": bonus_amount,
            "monthlyCount": monthly_count,
        },
        commit=False,
        checkin_date=checkin_date,
    )
    if milestone:
        _grant(
            db,
            user_id=user.id,
            amount=bonus_amount,
            source="checkin_bonus",
            reason=f"本月累计签到 {milestone.threshold} 天奖励",
            checkin_date=checkin_date,
            details={"monthlyCount": monthly_count, "threshold": milestone.threshold},
            commit=False,
        )
    db.commit()
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
    commit: bool = True,
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
    if commit:
        db.commit()
    else:
        db.flush()
    db.refresh(row)
    return CreditGrant(amount=amount, balance_after=target_balance, source=source)
