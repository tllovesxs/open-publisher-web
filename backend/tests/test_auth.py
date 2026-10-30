"""认证 API：注册、登录、管理员登录与状态读取。"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.core.users import password_helper
from app.models.user import AppUser
from app.main import app


@pytest.fixture()
def client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()


def test_register_login_and_me(client):
    res = client.post(
        "/api/auth/register",
        json={"username": "alice", "password": "secret-pass-1", "displayName": "Alice"},
    )
    assert res.status_code == 201
    token = res.json()["token"]
    assert res.json()["user"]["role"] == "user"

    res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert res.json()["username"] == "alice"

    res = client.post("/api/auth/login", json={"username": "alice", "password": "secret-pass-1"})
    assert res.status_code == 200
    assert "opw_access_token" in res.cookies

    res = client.post("/api/auth/login", json={"username": "alice", "password": "bad-password"})
    assert res.status_code == 401


def test_admin_login_requires_admin_role(client):
    client.post("/api/auth/register", json={"username": "normal", "password": "secret-pass-1"})
    res = client.post("/api/auth/admin/login", json={"username": "normal", "password": "secret-pass-1"})
    assert res.status_code == 403

def test_legacy_pbkdf2_login_upgrades_and_issues_jwt():
    """存量 PBKDF2 用户登录成功；新令牌为标准 JWT（三段式）。"""
    from app.core.security import verify_legacy_pbkdf2

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    with factory() as db:
        db.add(
            AppUser(
                id="u-legacy0000000000000000000000000",
                username="legacy",
                display_name="Legacy",
                hashed_password=password_helper.hash("legacy-pass-1"),
                role="user",
                is_active=True,
            )
        )
        db.commit()

    app.dependency_overrides[get_db] = override_get_db
    try:
        client = TestClient(app)
        res = client.post(
            "/api/auth/login", json={"username": "legacy", "password": "legacy-pass-1"}
        )
        assert res.status_code == 200
        token = res.json()["token"]
        assert token.count(".") == 2  # 标准 JWT：header.payload.signature

        # 登录后散列应已升级为 Argon2/Bcrypt（不再是旧 PBKDF2）
        with factory() as db:
            row = db.get(AppUser, "u-legacy0000000000000000000000000")
            assert not row.hashed_password.startswith("pbkdf2_sha256$")

        # 新令牌可继续访问 /me
        res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert res.status_code == 200
        assert res.json()["username"] == "legacy"
    finally:
        app.dependency_overrides.pop(get_db, None)
        engine.dispose()

    assert verify_legacy_pbkdf2("x", "pbkdf2_sha256$390000$00$00") is False



def test_profile_update_is_persistent_and_scoped_to_current_user(client):
    assert client.patch("/api/auth/me", json={"displayName": "新昵称"}).status_code == 401
    other = client.post("/api/auth/register", json={"username": "other", "password": "secret-pass-1"}).json()
    owner = client.post("/api/auth/register", json={"username": "owner", "password": "secret-pass-1"}).json()
    headers = {"Authorization": f"Bearer {owner['token']}"}
    response = client.patch("/api/auth/me", headers=headers, json={"displayName": "  新昵称  "})
    assert response.status_code == 200
    assert response.json()["displayName"] == "新昵称"
    assert response.json()["username"] == "owner"
    assert client.get("/api/auth/me", headers=headers).json()["displayName"] == "新昵称"
    other_headers = {"Authorization": f"Bearer {other['token']}"}
    assert client.get("/api/auth/me", headers=other_headers).json()["displayName"] == "other"
    for payload in [{"displayName": " "}, {"displayName": "x" * 121}, {"displayName": "x", "role": "admin"}]:
        assert client.patch("/api/auth/me", headers=headers, json=payload).status_code == 422
    assert client.get("/api/auth/me", headers=headers).json()["role"] == "user"
