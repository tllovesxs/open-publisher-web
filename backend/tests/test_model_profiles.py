"""模型档案（model-profile）API 与解析测试。"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.settings_profile import ModelProfile
from app.services.model_profile_service import resolve_llm_config


@pytest.fixture()
def profile_engine():
    """StaticPool 内存库：TestClient 工作线程与主线程共享同一连接。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def client(profile_engine):
    test_sessionmaker = sessionmaker(bind=profile_engine, autoflush=False, autocommit=False)

    def override_get_db():
        db = test_sessionmaker()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_profile_crud_and_activation(client):
    # 初始为空：走全局配置
    res = client.get("/api/settings/profiles")
    assert res.status_code == 200
    assert res.json() == {"profiles": []}

    # 创建第一个档案：自动成为默认
    res = client.post(
        "/api/settings/profiles",
        json={
            "name": "DeepSeek 官方",
            "baseUrl": "https://api.deepseek.com/v1",
            "modelId": "deepseek-chat",
        },
    )
    assert res.status_code == 201
    first = res.json()
    assert first["isDefault"] is True
    assert first["keyConfigured"] is False  # 密钥本体不在环境里，档案只存变量名

    # 创建第二个档案：不自动默认
    res = client.post(
        "/api/settings/profiles",
        json={
            "name": "SiliconFlow",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "modelId": "Qwen/Qwen2.5-72B-Instruct",
        },
    )
    second = res.json()
    assert second["isDefault"] is False

    # 激活第二个
    res = client.post(f"/api/settings/profiles/{second['id']}/activate")
    assert res.status_code == 200
    assert res.json()["isDefault"] is True

    # 激活状态互斥
    statuses = {p["name"]: p["isDefault"] for p in client.get("/api/settings/profiles").json()["profiles"]}
    assert statuses == {"DeepSeek 官方": False, "SiliconFlow": True}

    # 更新
    res = client.patch(
        f"/api/settings/profiles/{second['id']}",
        json={"timeoutSeconds": 60},
    )
    assert res.status_code == 200
    assert res.json()["timeoutSeconds"] == 60

    # 删除默认档案后自动回落到剩余最新档案
    res = client.delete(f"/api/settings/profiles/{second['id']}")
    assert res.status_code == 204
    profiles = client.get("/api/settings/profiles").json()["profiles"]
    assert len(profiles) == 1
    assert profiles[0]["isDefault"] is True

    # 同名冲突 409
    res = client.post(
        "/api/settings/profiles",
        json={"name": "DeepSeek 官方", "baseUrl": "https://x/v1", "modelId": "m"},
    )
    assert res.status_code == 409


def test_resolve_llm_config_prefers_active_profile(profile_engine):
    import app.services.model_profile_service as svc
    from app.services import secret_store

    # 注入测试 session 工厂
    from sqlalchemy.orm import sessionmaker as _sm

    test_factory = _sm(bind=profile_engine)
    svc.SessionLocal = lambda: test_factory()

    session = _sm(bind=profile_engine)()
    profile = ModelProfile(
        id="mp-test",
        name="测试档案",
        base_url="https://profile.example/v1",
        model_id="profile-model",
        timeout_seconds=30,
        is_default=True,
    )
    session.add(profile)
    session.commit()

    secret_store.set_secret(
        session, secret_store.profile_secret_id("mp-test"), "pk-test-123"
    )
    config = resolve_llm_config()
    assert config["profileId"] == "mp-test"
    assert config["base_url"] == "https://profile.example/v1"
    assert config["model"] == "profile-model"
    assert config["api_key"] == "pk-test-123"
    assert config["keySource"] == "db"
    assert config["timeout_seconds"] == 30

    # 档案密钥删除后，没有全局数据库密钥就是未配置。
    secret_store.delete_secret(session, secret_store.profile_secret_id("mp-test"))
    config = resolve_llm_config()
    assert config["api_key"] == ""
    assert config["keySource"] == "none"
    session.close()


def test_node_model_preferences_roundtrip_validation_and_user_scope(client):
    from app.core.auth import require_user
    first = client.post("/api/settings/profiles", json={"name": "默认模型", "baseUrl": "https://example.test/v1", "modelId": "first"}).json()
    second = client.post("/api/settings/profiles", json={"name": "审阅模型", "baseUrl": "https://example.test/v1", "modelId": "second"}).json()
    preferences = {"profileId": first["id"], "nodeProfileIds": {"draft": first["id"], "review": second["id"], "visual": second["id"]}, "webSearchMode": "off", "disabledNodeIds": ["risk"], "imageModelId": None, "embeddingModelId": None, "rerankModelId": None}
    assert client.put("/api/settings/preferences", json=preferences).status_code == 200
    assert client.get("/api/settings/preferences").json() == preferences
    assert client.put("/api/settings/preferences", json={**preferences, "nodeProfileIds": {"draft": "missing"}}).status_code == 400
    assert client.put("/api/settings/preferences", json={**preferences, "nodeProfileIds": {"unknown": first["id"]}}).status_code == 422
    assert client.get("/api/settings/preferences").json() == preferences
    original = app.dependency_overrides[require_user]
    app.dependency_overrides[require_user] = lambda: type("OtherUser", (), {"id": "u-other", "role": "user"})()
    try:
        assert client.get("/api/settings/preferences").json()["nodeProfileIds"] == {}
    finally:
        app.dependency_overrides[require_user] = original


def test_preferred_profile_falls_back_after_admin_deletion(profile_engine):
    from app.services.model_profile_service import preferred_profile_id
    with sessionmaker(bind=profile_engine)() as db:
        db.add(ModelProfile(id="default", name="默认", base_url="https://example.test/v1", model_id="default"))
        db.commit()
        assert preferred_profile_id(db, {"profileId": "default", "nodeProfileIds": {"draft": "deleted"}}, "draft") == "default"
        assert preferred_profile_id(db, {"profileId": "deleted"}, "draft") is None


def test_article_run_resolves_each_node_and_explicit_override(client, monkeypatch):
    from app.api import agent_runs
    from app.agents import llm_client
    captured = []
    class CaptureLLM:
        def __init__(self, config):
            self.config = config
    class CaptureWriter:
        def __init__(self, db, **kwargs):
            captured.append(kwargs)
        def start_article_create(self, **kwargs):
            return {"id": "captured", "status": "pending"}
    monkeypatch.setattr(llm_client, "LLMClient", CaptureLLM)
    monkeypatch.setattr(agent_runs, "WriterService", CaptureWriter)
    profiles = [client.post("/api/settings/profiles", json={"name": name, "baseUrl": "https://example.test/v1", "modelId": name}).json() for name in ["base", "draft", "review"]]
    client.put("/api/settings/preferences", json={"profileId": profiles[0]["id"], "nodeProfileIds": {"draft": profiles[1]["id"], "review": profiles[2]["id"]}})
    assert client.post("/api/agent-runs/article-create", json={"articleId": "a", "prompt": "test"}).status_code == 202
    assert captured[-1]["llm"].config["model"] == "base"
    assert captured[-1]["node_llms"]["draft"].config["model"] == "draft"
    assert captured[-1]["node_llms"]["review"].config["model"] == "review"
    assert client.post("/api/agent-runs/article-create", json={"articleId": "b", "prompt": "test", "profileId": profiles[2]["id"]}).status_code == 202
    assert captured[-1]["node_llms"] == {}
    assert captured[-1]["llm"].config["model"] == "review"
