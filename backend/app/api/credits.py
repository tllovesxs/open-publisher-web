"""User-facing credit status, check-in, and recent ledger."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
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
    return {
        "balance": user.credit_balance,
        "unlimited": bool(user.unlimited_credits),
        "isVip": credits.vip_active(user),
        "vipExpiresAt": user.vip_expires_at.isoformat() if user.vip_expires_at else None,
        "checkedInToday": checked_in,
        "dailyCheckinBonus": credits.DAILY_CHECKIN_CREDITS,
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
