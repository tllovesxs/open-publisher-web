import json

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.agent_runtime import AgentRunEvent
from app.services.article_store import ArticleStore
from app.services.publish_safety import sync_safety
from app.services.run_journal import RunJournal


def production(**overrides):
    return Settings(_env_file=None, app_env="production", **{
        "auth_jwt_secret": "x" * 40, "auth_admin_password": "strong-test-password",
        "SECRET_ENCRYPTION_KEY": Fernet.generate_key().decode(), **overrides})


def test_production_accepts_explicit_configuration():
    production().validate_production()


@pytest.mark.parametrize("override,field", [
    ({"auth_jwt_secret": "dev-open-publisher-web-secret-change-me"}, "AUTH_JWT_SECRET"),
    ({"auth_jwt_secret": "short"}, "AUTH_JWT_SECRET"),
    ({"auth_admin_password": "change_me_admin_password"}, "AUTH_ADMIN_PASSWORD"),
    ({"SECRET_ENCRYPTION_KEY": "invalid"}, "SECRET_ENCRYPTION_KEY"),
])
def test_production_rejects_placeholders_without_echoing_secrets(override, field):
    with pytest.raises(RuntimeError) as failure:
        production(**override).validate_production()
    assert field in str(failure.value)
    assert str(next(iter(override.values()))) not in str(failure.value)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session
    engine.dispose()


def article(db):
    return ArticleStore(db).commit(article_id="safety-article", base_revision_id=None,
        base_content_hash=None, title="Test", markdown="# Test", reason="test", owner_user_id="u-test")


def risk(db, state, level):
    journal = RunJournal(db)
    run = journal.create_run(article_id=state["articleId"], agent_id="writer", operation="article-create")
    journal.append(run["id"], "node.completed", {"nodeId": "risk", "level": level,
        "checkedRevisionId": state["currentRevisionId"], "issueDetails": []})


@pytest.mark.parametrize("level,blocked,confirm", [("low", False, False), ("medium", False, True),
    ("high", True, True), ("unknown", False, True), ("invalid", False, True)])
def test_risk_levels(db, level, blocked, confirm):
    state = article(db)
    risk(db, state, level)
    status = sync_safety(db, state, state["markdown"])
    assert status["blocked"] is blocked
    assert status["requiresConfirmation"] is confirm


def test_unsaved_content_or_new_revision_invalidates_report(db):
    state = article(db)
    risk(db, state, "low")
    assert sync_safety(db, state, "edited")["level"] == "unknown"
    changed = ArticleStore(db).commit(article_id=state["articleId"], base_revision_id=state["currentRevisionId"],
        base_content_hash=state["contentHash"], title="Changed title", markdown=state["markdown"],
        reason="edit", owner_user_id="u-test")
    assert sync_safety(db, changed, changed["markdown"])["requiresConfirmation"]


def test_confirmation_audited_and_other_user_hidden(db):
    state = article(db)
    app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(app)
        response = client.post("/api/articles/safety-article/sync-preflight", json={"markdown": "# Test", "confirm": True})
        assert response.status_code == 200
        event = db.scalars(select(AgentRunEvent).where(AgentRunEvent.event_type == "sync.confirmed")).one()
        assert json.loads(event.payload_json)["contentHash"] == state["contentHash"]
        risk(db, state, "high")
        assert client.post("/api/articles/safety-article/sync-preflight", json={"markdown": "# Test", "confirm": True}).json()["blocked"]
        assert len(db.scalars(select(AgentRunEvent).where(AgentRunEvent.event_type == "sync.confirmed")).all()) == 1
        assert client.post("/api/articles/missing/sync-preflight", json={"markdown": "# Test"}).status_code == 404
        from app.core.auth import require_user
        previous = app.dependency_overrides[require_user]
        app.dependency_overrides[require_user] = lambda: type("User", (), {"id": "other-user", "role": "user"})()
        try:
            assert client.post("/api/articles/safety-article/sync-preflight", json={"markdown": "# Test"}).status_code == 404
        finally:
            app.dependency_overrides[require_user] = previous
    finally:
        app.dependency_overrides.pop(get_db, None)
