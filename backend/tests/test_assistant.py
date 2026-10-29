"""ArticleAssistant 会话持久化与模型选择 API 测试。"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.session import get_db
from app.main import app


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
    with TestClient(app, raise_server_exceptions=True) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def fake_reply(monkeypatch):
    calls = []

    def _fake(db, *, user, history, article_context, profile_id, **kwargs):
        calls.append({
            "history": [(m.role, m.content) for m in history],
            "context": article_context,
            "profileId": profile_id,
            "mode": kwargs.get("mode"),
            "attachments": kwargs.get("attachments"),
        })
        return "建议检查开头是否重复。", {"profileId": profile_id, "profileName": None}

    monkeypatch.setattr("app.api.assistant._llm_reply", _fake)
    return calls


def test_assistant_session_persists_messages(client, fake_reply):
    created = client.post("/api/assistant/sessions", json={
        "articleId": "a-1", "title": "测试助手",
    })
    assert created.status_code == 201
    session = created.json()
    assert session["articleId"] == "a-1"

    first = client.post(f"/api/assistant/sessions/{session['id']}/chat", json={
        "message": "检查开头", "articleContext": "# 文章", "profileId": "mp-test",
    })
    assert first.status_code == 200
    body = first.json()
    assert body["reply"] == "建议检查开头是否重复。"
    assert body["persisted"] is True
    assert body["activeProfileId"] == "mp-test"
    assert [(m["role"], m["text"]) for m in body["messages"]] == [
        ("user", "检查开头"), ("assistant", "建议检查开头是否重复。"),
    ]
    assert fake_reply[0]["context"] == "# 文章"

    listed = client.get("/api/assistant/sessions?articleId=a-1").json()["sessions"]
    assert len(listed) == 1
    assert len(listed[0]["messages"]) == 2


def test_stateless_assistant_chat_is_not_persisted(client, fake_reply):
    res = client.post("/api/assistant/chat", json={
        "messages": [{"role": "user", "text": "怎么改标题？"}],
        "articleContext": "# 标题",
    })
    assert res.status_code == 200
    assert res.json()["persisted"] is False
    assert client.get("/api/assistant/sessions").json()["sessions"] == []



def test_assistant_rewrite_mode_and_attachments_forwarded(client, fake_reply):
    created = client.post("/api/assistant/sessions", json={"articleId": "a-9"}).json()
    res = client.post(f"/api/assistant/sessions/{created['id']}/chat", json={
        "message": "改写：更精简", "articleContext": "# 文章",
        "mode": "rewrite", "attachments": [],
    })
    assert res.status_code == 200
    assert fake_reply[0]["mode"] == "rewrite"
    assert fake_reply[0]["attachments"] == []


def test_assistant_attachments_rejected_without_vision_profile(client):
    """默认（无档案/能力为空）时带附件应 400，而不是静默丢弃。"""
    res = client.post("/api/assistant/chat", json={
        "messages": [{"role": "user", "text": "这张图怎么了？"}],
        "attachments": ["data:image/png;base64,iVBORw0KGgo="],
    })
    assert res.status_code == 400
    assert "图片理解" in res.json()["detail"]


def test_assistant_image_attached_to_user_message_once(client, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from app.api import assistant
    config = {"api_key": "test-only", "base_url": "http://localhost/v1", "model": "test",
              "timeout_seconds": 1, "profileId": None, "profileName": None, "capabilities": {"vision": True}}
    monkeypatch.setattr(assistant, "resolve_llm_profile_config", lambda *args, **kwargs: config)
    mock = MagicMock()
    mock.chat.completions.create.return_value = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="reply"))])
    monkeypatch.setattr(assistant, "OpenAI", lambda **kwargs: mock)
    response = client.post("/api/assistant/chat", json={
        "messages": [{"role": "user", "text": "describe image"}],
        "attachments": ["data:image/png;base64,iVBORw0KGgo="],
    })
    assert response.status_code == 200
    messages = mock.chat.completions.create.call_args.kwargs["messages"]
    assert len(messages) == 2
    assert messages[-1]["content"][0] == {"type": "text", "text": "describe image"}
    assert messages[-1]["content"][1]["type"] == "image_url"
