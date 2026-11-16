"""Credit signup, check-in, consumption, and admin adjustment tests."""

from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.auth import require_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.credit import CreditLedger
from app.models.user import AppUser
from app.services import credits


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as test_client:
        yield test_client, factory
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(require_user, None)
    engine.dispose()


def test_register_reports_initial_credits(client):
    test_client, factory = client
    response = test_client.post("/api/auth/register", json={
        "username": "credit-user", "password": "test-password", "displayName": "Credit",
    })
    assert response.status_code == 201
    assert response.json()["user"]["creditBalance"] == 200
    with factory() as db:
        row = db.scalar(select(CreditLedger).where(CreditLedger.source == "signup"))
        assert row is not None
        assert row.user_id == response.json()["user"]["id"]
        assert row.amount == 200
        assert row.balance_after == 200


def test_checkin_once_per_day_and_reports_balance(client, monkeypatch):
    test_client, factory = client
    monkeypatch.setattr(credits, "_choose_daily_amount", lambda user_id, checkin_date: 20)
    user = test_client.post("/api/auth/register", json={
        "username": "checkin-user", "password": "test-password",
    }).json()["user"]
    app.dependency_overrides[require_user] = lambda: SimpleNamespace(id=user["id"])

    first = test_client.post("/api/me/checkin")
    assert first.status_code == 200
    assert first.json()["balance"] == 220
    assert first.json()["checkedInToday"] is True
    assert first.json()["lastCheckin"]["dailyAmount"] == 20
    assert first.json()["lastCheckin"]["bonusAmount"] == 0
    assert first.json()["month"]["count"] == 1
    assert first.json()["month"]["checkedDates"] == [
        credits._local_checkin_date().isoformat()
    ]

    second = test_client.post("/api/me/checkin")
    assert second.status_code == 409
    assert second.json()["detail"] == "今日已签到"


def test_monthly_milestone_grants_extra_credits(db_session_factory, monkeypatch):
    monkeypatch.setattr(credits, "_local_checkin_date", lambda: date(2026, 11, 20))
    monkeypatch.setattr(credits, "_choose_daily_amount", lambda user_id, checkin_date: 20)
    with db_session_factory() as db:
        user = AppUser(id="u-milestone", username="milestone", display_name="milestone",
                       hashed_password="hashed", role="user", is_active=True,
                       credit_balance=160)
        db.add(user)
        for index in range(6):
            db.add(CreditLedger(
                id=f"prior-{index}", user_id=user.id, amount=1,
                balance_after=110 + index, source="checkin",
                checkin_date=date(2026, 11, 14) + timedelta(days=index),
            ))
        db.commit()

        ledger, granted = credits.daily_checkin(db, user)

        assert granted is True
        assert user.credit_balance == 230
        assert ledger.amount == 20
        bonus = db.scalar(select(CreditLedger).where(
            CreditLedger.user_id == user.id,
            CreditLedger.source == "checkin_bonus",
        ))
        assert bonus is not None
        assert bonus.amount == 50


def test_chat_spends_one_credit_and_requires_balance(db_session_factory):
    with db_session_factory() as db:
        user = AppUser(id="u-chat", username="chat", display_name="chat",
                       hashed_password="hashed", role="user", is_active=True,
                       credit_balance=100)
        db.add(user)
        db.commit()

        credits.grant_signup_credits(db, user)
        assert user.credit_balance == 300

        credits.spend_chat_credit(db, user)
        assert user.credit_balance == 290

        user.credit_balance = 0
        db.commit()
        with pytest.raises(credits.InsufficientCreditsError):
            credits.spend_chat_credit(db, user)


def test_vip_and_unlimited_users_do_not_spend(db_session_factory):
    with db_session_factory() as db:
        vip = AppUser(id="u-vip", username="vip", display_name="vip",
                      hashed_password="hashed", role="user", is_active=True,
                      credit_balance=0, is_vip=True)
        unlimited = AppUser(id="u-unlimited", username="video_user",
                            display_name="unlimited", hashed_password="hashed",
                            role="user", is_active=True, credit_balance=0,
                            unlimited_credits=True)
        db.add_all([vip, unlimited])
        db.commit()

        assert credits.spend_chat_credit(db, vip) is None
        assert credits.spend_chat_credit(db, unlimited) is None
        assert vip.credit_balance == 0
        assert unlimited.credit_balance == 0


def test_model_calls_charge_every_successful_call(db_session_factory):
    with db_session_factory() as db:
        user = AppUser(id="u-model", username="model", display_name="model",
                       hashed_password="hashed", role="user", is_active=True,
                       credit_balance=35)
        db.add(user)
        db.commit()

        credits.ensure_model_call(db, user, "rewrite_candidate")
        credits.record_model_call(db, user, "rewrite_candidate")
        assert user.credit_balance == 25

        sources = db.scalars(select(CreditLedger.source).where(
            CreditLedger.user_id == user.id,
            CreditLedger.source == "model_rewrite_candidate",
        )).all()
        assert sources == ["model_rewrite_candidate"]

        user.credit_balance = 20
        db.commit()
        credits.record_model_call(db, user, "rewrite_candidate")
        assert user.credit_balance == 10

        user.credit_balance = 9
        db.commit()
        with pytest.raises(credits.InsufficientCreditsError):
            credits.ensure_model_call(db, user, "rewrite_candidate")


def test_model_calls_do_not_leave_partial_charges(db_session_factory):
    with db_session_factory() as db:
        user = AppUser(id="u-model-low", username="model-low", display_name="model-low",
                       hashed_password="hashed", role="user", is_active=True,
                       credit_balance=9)
        db.add(user)
        db.commit()

        with pytest.raises(credits.InsufficientCreditsError):
            credits.record_model_call(db, user, "rewrite_candidate")
        assert user.credit_balance == 9
        assert db.scalar(select(func.count()).select_from(CreditLedger)) == 0


def test_vip_and_unlimited_model_calls_do_not_charge(db_session_factory):
    with db_session_factory() as db:
        user = AppUser(id="u-vip-model", username="vip-model", display_name="vip-model",
                       hashed_password="hashed", role="user", is_active=True,
                       credit_balance=0, is_vip=True)
        db.add(user)
        db.commit()

        credits.ensure_model_call(db, user, "article_create")
        credits.record_model_call(db, user, "article_create")
        credits.ensure_model_call(db, user, "article_create")
        credits.record_model_call(db, user, "article_create")
        assert user.credit_balance == 0

        unlimited = AppUser(id="u-unlimited-model", username="unlimited-model",
                            display_name="unlimited-model", hashed_password="hashed",
                            role="user", is_active=True, credit_balance=0,
                            unlimited_credits=True)
        db.add(unlimited)
        db.commit()
        credits.ensure_model_call(db, unlimited, "article_create")
        credits.record_model_call(db, unlimited, "article_create")
        assert unlimited.credit_balance == 0


def test_credits_api_returns_full_month_rewards(client):
    test_client, _ = client
    user = test_client.post("/api/auth/register", json={
        "username": "credit-month", "password": "test-password",
    }).json()["user"]
    app.dependency_overrides[require_user] = lambda: SimpleNamespace(
        id=user["id"],
        credit_balance=200,
        unlimited_credits=False,
        is_vip=False,
        vip_expires_at=None,
    )

    response = test_client.get("/api/me/credits")
    assert response.status_code == 200
    payload = response.json()
    assert payload["balance"] == 200
    assert "freeCalls" not in payload
    assert payload["modelCallCosts"] == {key: 10 for key in [
        "article_create", "rewrite_candidate", "visual_plan",
        "visual_apply", "template_extract",
    ]}
    days = payload["month"]["days"]
    today = credits._local_checkin_date()
    month_end = date(today.year + (today.month == 12), (today.month % 12) + 1, 1)
    assert len(days) == (month_end - date(today.year, today.month, 1)).days
    assert all(day["checked"] is False for day in days)
    assert all(20 <= day["dailyAmount"] <= 50 for day in days)
    assert all(day["amount"] == day["dailyAmount"] + day["bonusAmount"] for day in days)
