"""Immutable credit ledger events for signups, check-ins, and consumption."""

import uuid

from sqlalchemy import CHAR, Date, DateTime, Integer, JSON, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class CreditLedger(Base):
    __tablename__ = "credit_ledgers"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "source", "checkin_date",
            name="uq_credit_ledgers_user_source_date",
        ),
    )

    id: Mapped[str] = mapped_column(
        CHAR(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    checkin_date: Mapped[object | None] = mapped_column(Date, nullable=True, index=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[object] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP"), nullable=False, index=True
    )
