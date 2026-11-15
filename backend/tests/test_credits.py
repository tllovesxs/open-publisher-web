"""Credit signup, check-in, consumption, and admin adjustment tests."""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
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
        "username": "credit-user", "password": "secret-pass-1", "displayName": "Credit",
    })
    assert response.status_code == 201
    assert response.json()["user"]["creditBalance"] == 10
    with factory() as db:
        row = db.scalar(select(CreditLedger).where(CreditLedger.source == "signup"))
        assert row is not None
        assert row.user_id == response.json()["user"]["id"]
        assert row.amount == 10
        assert row.balance_after == 10


def test_checkin_once_per_day_and_reports_balance(client):
    test_client, factory = client
    user = test_client.post("/api/auth/register", json={
        "username": "checkin-user", "password": "secret-pass-1",
    }).json()["user"]
    app.dependency_overrides[require_user] = lambda: SimpleNamespace(id=user["id"])

    first = test_client.post("/api/me/checkin")
    assert first.status_code == 200
    assert first.json()["balance"] == 11
    assert first.json()["checkedInToday"] is True

    second = test_client.post("/api/me/checkin")
    assert second.status_code == 409
    assert second.json()["detail"] == "今日已签到"


def test_chat_spends_one_credit_and_requires_balance(db_session_factory):
    with db_session_factory() as db:
        user = AppUser(id="u-chat", username="chat", display_name="chat",
                       hashed_password="hashed", role="user", is_active=True,
                       credit_balance=2)
        db.add(user)
        db.commit()

        credits.grant_signup_credits(db, user)
        assert user.credit_balance == 12

        credits.spend_chat_credit(db, user)
        assert user.credit_balance == 11

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
