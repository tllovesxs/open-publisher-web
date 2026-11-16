"""User-facing credit status, check-in, and recent ledger."""

from fastapi import APIRouter, Depends, HTTPException
from datetime import timedelta
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import require_user
from app.db.session import get_db
from app.models.credit import CreditLedger
from app.models.user import AppUser
from app.services import credits


router = APIRouter(tags=["credits"])


def _ledger_out(row: CreditLedger) -> dict:
    return {
        "id": row.id,
        "amount": row.amount,
        "balanceAfter": row.balance_after,
        "source": row.source,
        "reason": row.reason,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
    }


def _credits_out(db: Session, user: AppUser) -> dict:
    rows = db.scalars(
        select(CreditLedger)
        .where(CreditLedger.user_id == user.id)
        .order_by(CreditLedger.created_at.desc(), CreditLedger.id.desc())
        .limit(20)
    ).all()
    checked_in = db.scalar(
        select(CreditLedger.id).where(
            CreditLedger.user_id == user.id,
            CreditLedger.source == "checkin",
            CreditLedger.checkin_date == credits._local_checkin_date(),
        )
    ) is not None
    today = credits._local_checkin_date()
    month_start, month_end = credits._month_bounds(today)
    monthly_rows = db.scalars(
        select(CreditLedger)
        .where(
            CreditLedger.user_id == user.id,
            CreditLedger.source == "checkin",
            CreditLedger.checkin_date >= month_start,
            CreditLedger.checkin_date < month_end,
        )
        .order_by(CreditLedger.checkin_date.asc())
    ).all()
    monthly_bonus_rows = db.scalars(
        select(CreditLedger)
        .where(
            CreditLedger.user_id == user.id,
            CreditLedger.source == "checkin_bonus",
            CreditLedger.checkin_date >= month_start,
            CreditLedger.checkin_date < month_end,
        )
    ).all()
    bonus_by_date = {}
    for row in monthly_bonus_rows:
        if row.checkin_date:
            bonus_by_date[row.checkin_date.isoformat()] = bonus_by_date.get(
                row.checkin_date.isoformat(), 0
            ) + row.amount
    monthly_count = len(monthly_rows)
    monthly_checkin_by_date = {
        row.checkin_date.isoformat(): row
        for row in monthly_rows
        if row.checkin_date
    }
    month_days = []
    for day_number in range(1, (month_end - month_start).days + 1):
        day = month_start + timedelta(days=day_number - 1)
        date_label = day.isoformat()
        row = monthly_checkin_by_date.get(date_label)
        daily_amount = row.amount if row else credits._choose_daily_amount(
            str(user.id), day
        )
        bonus_amount = bonus_by_date.get(date_label, 0)
        month_days.append({
            "date": date_label,
            "dailyAmount": daily_amount,
            "bonusAmount": bonus_amount,
            "amount": daily_amount + bonus_amount,
            "checked": row is not None,
        })
    milestones = [
        {
            "threshold": threshold,
            "reward": reward,
            "achieved": monthly_count >= threshold,
        }
        for threshold, reward in credits.MONTHLY_CHECKIN_MILESTONES
    ]
    last_checkin = db.scalar(
        select(CreditLedger)
        .where(
            CreditLedger.user_id == user.id,
            CreditLedger.source == "checkin",
            CreditLedger.checkin_date == today,
        )
        .order_by(CreditLedger.created_at.desc(), CreditLedger.id.desc())
    )
    last_checkin_details = dict(last_checkin.details or {}) if last_checkin else {}
    return {
        "balance": user.credit_balance,
        "unlimited": bool(user.unlimited_credits),
        "isVip": credits.vip_active(user),
        "vipExpiresAt": user.vip_expires_at.isoformat() if user.vip_expires_at else None,
        "checkedInToday": checked_in,
        "dailyCheckinBonus": credits.CHECKIN_DAILY_RANGE[1],
        "dailyCheckinRange": list(credits.CHECKIN_DAILY_RANGE),
        "chatCreditCost": credits.CHAT_CREDIT_COST,
        "unlimitedCalls": credits.chat_is_free(user),
        "modelCallCosts": {
            action: rule["cost"]
            for action, rule in credits.MODEL_CALL_RULES.items()
        },
        "month": {
            "year": today.year,
            "month": today.month,
            "count": monthly_count,
            "checkedDates": [
                row.checkin_date.isoformat()
                for row in monthly_rows
                if row.checkin_date
            ],
            "days": month_days,
            "milestones": milestones,
        },
        "lastCheckin": {
            "dailyAmount": (
                int(last_checkin_details.get("dailyAmount", last_checkin.amount))
                if last_checkin
                else 0
            ),
            "bonusAmount": (
                int(last_checkin_details.get("bonusAmount", 0))
            ),
            "monthlyCount": (
                int(last_checkin_details.get("monthlyCount", monthly_count))
            ),
        } if last_checkin else None,
        "ledger": [_ledger_out(row) for row in rows],
    }


@router.get("/me/credits")
def get_credits(
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    return _credits_out(db, user)


@router.post("/me/checkin")
def checkin(
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    try:
        _, granted = credits.daily_checkin(db, user)
    except credits.AlreadyCheckedInError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    row = db.get(AppUser, str(user.id))
    return {"ok": granted, **_credits_out(db, row)}
