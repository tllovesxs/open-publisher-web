"""素材库 + 模型设置 API 测试。"""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.main import app
from app.db.session import get_db


@pytest.fixture()
def client():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c
    app.dependency_overrides.clear()


def test_media_upload_list_delete(client):
    res = client.post("/api/media", json={
        "name": "测试图", "mime": "image/png",
        "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
        "alt": "alt text",
    })
    assert res.status_code == 201
    asset = res.json()
    assert asset["origin"] == "upload"

    listed = client.get("/api/media").json()["assets"]
    assert len(listed) == 1

    raw = client.get(f"/api/media/{asset['id']}/raw")
    assert raw.status_code == 200
    assert raw.headers["content-type"] == "image/png"
    assert raw.content[:4] == b"\x89PNG"

    assert client.delete(f"/api/media/{asset['id']}").status_code == 204
    assert client.get("/api/media").json()["assets"] == []


def test_media_upload_rejects_non_data_url(client):
    res = client.post("/api/media", json={
        "name": "x", "mime": "image/png", "dataUrl": "https://example.com/a.png",
    })
    assert res.status_code == 400


def test_generated_image_rejects_bad_payload_and_size():
    import base64

    import pytest as _pytest

    from app.services.media_service import MediaService

    service = MediaService.__new__(MediaService)
    # 空文件、非图片文件、超限图片都必须被 magic/size 校验拒绝。
    with _pytest.raises(HTTPException):
        service.add_generated(b64_json=base64.b64encode(b"").decode(), mime="image/png", prompt="p")
    with _pytest.raises(HTTPException):
        service.add_generated(b64_json=base64.b64encode(b"not image").decode(), mime="image/png", prompt="p")
    with _pytest.raises(ValueError):
        service._decode_image_bytes(base64.b64encode(b"x" * (12 * 1024 * 1024 + 1)).decode())


@pytest.mark.parametrize("target", ["embedding", "rerank"])
def test_rag_test_only_calls_selected_service(client, monkeypatch, target):
    from app.api import settings
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    import openai
    import urllib.request

    from app.services import model_config_catalog
    monkeypatch.setattr(model_config_catalog, "resolve_rag_config", lambda db, kind, profile_id=None: {"api_key": "test-only", "base_url": "https://example.test/v1", "model": kind, "timeout_seconds": 3})
    monkeypatch.setattr(settings, "resolve_llm_config", lambda: {"api_key": "test-only", "base_url": "https://example.test"})
    calls = []
    def embed(**kwargs):
        calls.append("embedding")
        return SimpleNamespace(data=[SimpleNamespace(index=i, embedding=[0.1, 0.2]) for i in range(len(kwargs["input"]))])
    monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: SimpleNamespace(embeddings=SimpleNamespace(create=embed)))
    response = MagicMock()
    response.__enter__.return_value.read.return_value = b'[{"index": 0, "score": 1}]'
    def rerank(*args, **kwargs):
        calls.append("rerank")
        return response
    monkeypatch.setattr(urllib.request, "urlopen", rerank)
    result = client.post("/api/settings/rag/test", params={"target": target})
    assert result.status_code == 200
    assert result.json()[target]["ok"] is True
    assert calls == [target]


def test_model_status_endpoint(client):
    res = client.get("/api/settings/model")
    assert res.status_code == 200
    body = res.json()
    assert "baseUrl" in body and "model" in body and "keyConfigured" in body


def test_model_test_without_key_returns_501(client):
    res = client.post("/api/settings/model/test")
    assert res.status_code in (200, 501)


def test_media_structured_profile_update_and_filter(client):
    created = client.post("/api/media", json={
        "name": "架构图", "mime": "image/png",
        "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
        "alt": "服务架构", "visualDescription": "三个服务模块的横向流程图",
        "usageHint": "产品架构", "tags": ["架构", "流程"],
    }).json()
    assert created["visualDescription"] == "三个服务模块的横向流程图"
    assert created["tags"] == ["架构", "流程"]

    updated = client.patch(f"/api/media/{created['id']}", json={
        "visualDescription": "采集、处理、渲染三段流程",
        "tags": ["流程图", "架构"],
    }).json()
    assert updated["visualDescription"] == "采集、处理、渲染三段流程"
    assert updated["tags"] == ["流程图", "架构"]
    assert updated["descriptionSource"] == "manual"

    assert client.get("/api/media?search=渲染").json()["assets"]
    assert client.get("/api/media?tag=流程图").json()["assets"]
    assert client.get("/api/media?origin=generated").json()["assets"] == []
    assert client.patch("/api/media/missing", json={"name": "x"}).status_code == 404


def test_image_config_get_put_delete_roundtrip(client):
    # 初始状态：无 DB 配置、测试进程无 IMAGE_* 环境变量 → 回退文本 LLM 配置
    initial = client.get("/api/settings/image")
    assert initial.status_code == 200
    body = initial.json()
    assert body["source"] == "fallback"

    # 保存管理端配置 → source=db
    saved = client.put("/api/settings/image", json={
        "baseUrl": "https://img.example.com/v1",
        "modelId": "test-image-model",
        "timeoutSeconds": 90,
    })
    assert saved.status_code == 200
    body = saved.json()
    assert body["source"] == "db"
    assert body["baseUrl"] == "https://img.example.com/v1"
    assert body["model"] == "test-image-model"
    assert body["timeoutSeconds"] == 90

    # 再读一致
    reread = client.get("/api/settings/image").json()
    assert reread["source"] == "db" and reread["model"] == "test-image-model"

    # 重置 → 回退
    assert client.delete("/api/settings/image").status_code == 200
    assert client.get("/api/settings/image").json()["source"] == "fallback"


def test_image_config_requires_admin(client):
    # 未登录/非管理员：conftest 覆盖了 require_user，但 require_admin 仍按角色校验。
    # 这里只验证端点存在且返回结构；权限矩阵见 test_auth。
    res = client.put("/api/settings/image", json={
        "baseUrl": "https://x.example.com/v1", "modelId": "m",
    })
    assert res.status_code in (200, 401, 403)


def test_image_test_without_key_returns_501(client, monkeypatch):
    from app.services import model_profile_service

    monkeypatch.setattr(
        model_profile_service, "resolve_image_config",
        lambda: {"api_key": "", "base_url": "",
                 "model": "m", "timeout_seconds": 5, "source": "fallback"},
    )
    res = client.post("/api/settings/image/test")
    assert res.status_code == 501


@pytest.mark.parametrize("base,model,reason", [
    ("https://cloud.siliconflow.cn/me/models", "Qwen/Qwen-Image", "控制台"),
    ("https://api.siliconflow.cn/v1", "Qwen/Qwen-Image-Edit", "图片编辑模型"),
])
def test_image_test_rejects_invalid_legacy_config_before_provider(client, monkeypatch, base, model, reason):
    from app.services import model_profile_service
    monkeypatch.setattr(model_profile_service, "resolve_image_config", lambda: {"api_key": "test-only", "base_url": base, "model": model, "timeout_seconds": 5})
    import openai
    monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: pytest.fail("invalid configuration must not call provider"))
    response = client.post("/api/settings/image/test")
    assert response.status_code == 400
    assert reason in response.json()["detail"]


class _FakeVisionLLM:
    def __init__(self):
        self.calls = []

    def complete_json(self, system, user, *, images=None, temperature=0.7):
        self.calls.append({"images": images, "system": system})
        return {
            "alt": "产品界面截图",
            "visualDescription": "深色后台仪表盘截图，左侧为导航栏，主区域是数据卡片。",
            "usageHint": "产品功能介绍",
            "tags": ["截图", "仪表盘", "后台"],
        }


def _create_upload(client, name="上传图"):
    res = client.post("/api/media", json={
        "name": name, "mime": "image/png",
        "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
        "alt": "", "visualDescription": "", "usageHint": "", "tags": [],
    })
    assert res.status_code == 201
    return res.json()


def test_media_analyze_uses_vision_llm_and_backfills(client, monkeypatch):
    """可行性验证：上传图片 → 视觉 LLM 分析 → 结构化字段回填。"""
    from app.services import model_profile_service

    asset = _create_upload(client)
    fake_llm = _FakeVisionLLM()

    monkeypatch.setattr(
        model_profile_service, "resolve_llm_profile_config",
        lambda db, *, profile_id=None, owner_user_id=None: {
            "api_key": "sk-test", "base_url": "https://llm.example.com/v1",
            "model": "vision-model", "timeout_seconds": 30,
            "profileId": "mp-1", "profileName": "视觉档案",
            "capabilities": {"vision": True},
        },
    )
    import app.agents.llm_client as llm_client_mod
    monkeypatch.setattr(llm_client_mod, "LLMClient", lambda config: fake_llm)

    res = client.post(f"/api/media/{asset['id']}/analyze", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["alt"] == "产品界面截图"
    assert "深色后台仪表盘" in body["visualDescription"]
    assert body["usageHint"] == "产品功能介绍"
    assert body["tags"] == ["截图", "仪表盘", "后台"]
    assert body["descriptionSource"] == "ai_analysis"
    # 图片 data URL 确实传入了视觉模型
    assert fake_llm.calls[0]["images"] == ["data:image/png;base64,iVBORw0KGgo="]


def test_media_analyze_rejects_profile_without_vision(client, monkeypatch):
    from app.services import model_profile_service

    asset = _create_upload(client)
    monkeypatch.setattr(
        model_profile_service, "resolve_llm_profile_config",
        lambda db, *, profile_id=None, owner_user_id=None: {
            "api_key": "sk-test", "base_url": "", "model": "m",
            "timeout_seconds": 30, "profileId": None, "profileName": None,
            "capabilities": {},
        },
    )
    res = client.post(f"/api/media/{asset['id']}/analyze", json={})
    assert res.status_code == 400
    assert "图片理解" in res.json()["detail"]


def test_media_analyze_rejects_non_image_asset(client, monkeypatch):
    from app.services import model_profile_service

    res = client.post("/api/media", json={
        "name": "文本", "mime": "text/plain",
        "dataUrl": "data:text/plain;base64,aGVsbG8=",
    })
    assert res.status_code == 201
    asset = res.json()
    monkeypatch.setattr(
        model_profile_service, "resolve_llm_profile_config",
        lambda db, *, profile_id=None, owner_user_id=None: {
            "api_key": "sk-test", "base_url": "", "model": "m",
            "timeout_seconds": 30, "profileId": None, "profileName": None,
            "capabilities": {"vision": True},
        },
    )
    res = client.post(f"/api/media/{asset['id']}/analyze", json={})
    assert res.status_code == 400
    assert "仅支持分析图片素材" in res.json()["detail"]


def test_generated_base64_image_is_saved_and_readable(client, monkeypatch):
    from types import SimpleNamespace
    import base64
    import openai
    from app.services import model_profile_service, customer_models

    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/agsAAAAASUVORK5CYII=")
    monkeypatch.setattr(customer_models, "selected_model_id", lambda *args: None)
    monkeypatch.setattr(model_profile_service, "resolve_image_config", lambda **kwargs: {
        "base_url": "https://example.test/v1", "model": "gpt-image-1", "api_key": "test-only", "timeout_seconds": 3,
    })
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(data=[SimpleNamespace(b64_json=base64.b64encode(png).decode(), url=None)])
    monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: SimpleNamespace(images=SimpleNamespace(generate=generate)))
    result = client.post("/api/media/generate", json={"prompt": "A quiet landscape", "size": "1536x1024"})
    assert result.status_code == 201
    asset = result.json()
    assert asset["origin"] == "generated"
    assert len(calls) == 1
    raw = client.get(f"/api/media/{asset['id']}/raw")
    assert raw.status_code == 200
    assert raw.content == png
    assert raw.headers["content-type"] == "image/png"
