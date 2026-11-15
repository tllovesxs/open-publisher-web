import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.user import AppUser
from app.models.credit import CreditLedger


@pytest.fixture()
def users_client():
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
    with TestClient(app) as client:
        yield client, factory
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()


def seed_user(factory, user_id: str, username: str):
    with factory() as db:
        db.add(AppUser(
            id=user_id, username=username, display_name=username,
            hashed_password="hashed", role="admin", is_active=True,
        ))
        db.commit()


@pytest.mark.parametrize("changes", [{"role": "user"}, {"isActive": False}])
def test_cannot_remove_the_last_active_admin_access(users_client, changes):
    client, factory = users_client
    seed_user(factory, "u-only-admin", "only-admin")

    response = client.patch("/api/admin/users/u-only-admin", json=changes)

    assert response.status_code == 409
    assert response.json()["detail"] == "至少保留一个可用管理员账号"
    with factory() as db:
        user = db.get(AppUser, "u-only-admin")
        assert user.role == "admin"
        assert user.is_active is True


def test_admin_can_demote_user_when_another_active_admin_remains(users_client):
    client, factory = users_client
    seed_user(factory, "u-admin", "actor")
    seed_user(factory, "u-second-admin", "target")

    response = client.patch("/api/admin/users/u-second-admin", json={"role": "user"})

    assert response.status_code == 200
    assert response.json()["role"] == "user"


def test_admin_updates_credit_and_privilege_flags(users_client):
    client, factory = users_client
    seed_user(factory, "u-target", "target")

    response = client.patch("/api/admin/users/u-target", json={
        "creditBalance": 25,
        "isVip": True,
        "unlimitedCredits": True,
    })

    assert response.status_code == 200
    body = response.json()
    assert body["creditBalance"] == 25
    assert body["isVip"] is True
    assert body["unlimitedCredits"] is True
    with factory() as db:
        ledger = db.scalars(
            select(CreditLedger).where(CreditLedger.source == "admin_adjust")
        ).all()
        assert [row.amount for row in ledger] == [15]
