"""多租户隔离回归测试：projects / runs / revisions 越权访问一律 404。

约定与既有模块一致：owner_user_id IS NULL 视为旧数据共享（所有登录用户可见），
新数据归属创建者；非归属用户访问他人资源返回 404（不泄露存在性）。
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.auth import require_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models.project import Project
from app.models.revision import TweetRevision
from app.models.run import TweetRun


class _User:
    def __init__(self, user_id: str, role: str = "user"):
        self.id = user_id
        self.role = role


@pytest.fixture()
def env():
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

    users = {"alice": _User("u-alice"), "bob": _User("u-bob")}

    def switch(name: str):
        app.dependency_overrides[require_user] = lambda: users[name]

    with TestClient(app) as client:
        yield client, factory, switch

    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(require_user, None)
    engine.dispose()


def _seed_bob_data(factory):
    """直接落库构造 bob 的项目 / run / revision（不触发工作流线程）。"""
    with factory() as db:
        project = Project(id="proj-bob", name="Bob 项目", owner_user_id="u-bob")
        shared = Project(id="proj-shared", name="旧共享项目", owner_user_id=None)
        db.add_all([project, shared])
        db.flush()
        run = TweetRun(
            id="run-bob-1",
            project_id="proj-bob",
            status="completed",
            input_snapshot={"project": {"id": "proj-bob"}},
        )
        revision = TweetRevision(
            id="rev-bob-1",
            project_id="proj-bob",
            content="bob 的推文",
            platform="twitter",
            tone="professional",
            version=1,
            source="user_edited",
        )
        db.add_all([run, revision])
        db.commit()


def test_project_create_assigns_owner(env):
    client, factory, switch = env
    client.get("/api/health")  # 触发 app 生命周期
    switch("alice")
    res = client.post("/api/projects", json={"name": "Alice 项目"})
    assert res.status_code == 201, res.text
    with factory() as db:
        assert db.get(Project, res.json()["id"]).owner_user_id == "u-alice"


def test_project_list_scoped_to_owner_plus_shared(env):
    client, factory, switch = env
    _seed_bob_data(factory)
    switch("alice")
    res = client.post("/api/projects", json={"name": "Alice 项目"})
    assert res.status_code == 201
    listed = {p["id"] for p in client.get("/api/projects").json()}
    assert "proj-bob" not in listed
    assert "proj-shared" in listed
    switch("bob")
    listed = {p["id"] for p in client.get("/api/projects").json()}
    assert "proj-shared" in listed


def test_project_cross_tenant_read_update_delete_404(env):
    client, factory, switch = env
    _seed_bob_data(factory)
    switch("alice")
    assert client.get("/api/projects/proj-bob").status_code == 404
    assert client.patch(
        "/api/projects/proj-bob", json={"name": "越权改名"}
    ).status_code == 404
    assert client.delete("/api/projects/proj-bob").status_code == 404
    # 越权删除后资源仍在
    with factory() as db:
        assert db.get(Project, "proj-bob") is not None


def test_run_endpoints_scoped(env):
    client, factory, switch = env
    _seed_bob_data(factory)
    switch("alice")
    # 对他人项目触发 run → 404（且不启动工作流）
    res = client.post("/api/projects/proj-bob/runs", json={"input": {}})
    assert res.status_code == 404
    # 读取他人 run → 404
    assert client.get("/api/runs/run-bob-1").status_code == 404
    switch("bob")
    assert client.get("/api/runs/run-bob-1").status_code == 200


def test_revision_endpoints_scoped(env):
    client, factory, switch = env
    _seed_bob_data(factory)
    switch("alice")
    assert client.get("/api/projects/proj-bob/revisions").status_code == 404
    assert client.post(
        "/api/projects/proj-bob/revisions", json={"content": "越权"}
    ).status_code == 404
    assert client.get("/api/revisions/rev-bob-1").status_code == 404
    switch("bob")
    assert client.get("/api/revisions/rev-bob-1").status_code == 200
    assert client.get("/api/projects/proj-bob/revisions").status_code == 200


def test_rag_all_project_operations_enforce_ownership(env):
    client, factory, switch = env
    _seed_bob_data(factory)
    switch("alice")
    assert client.post("/api/rag/documents", json={"projectId": "proj-bob", "name": "x", "text": "x"}).status_code == 404
    assert client.post("/api/rag/documents/upload?projectId=proj-bob", files={"file": ("x.txt", b"x")}).status_code == 404
    assert client.get("/api/rag/documents?projectId=proj-bob").status_code == 404
    assert client.delete("/api/rag/documents/x?projectId=proj-bob").status_code == 404
    assert client.post("/api/rag/search", json={"projectId": "proj-bob", "query": "x"}).status_code == 404


def test_rag_global_library_is_private_and_legacy_index_untouched(env, monkeypatch, tmp_path):
    from app.api import rag as rag_api
    from tests.test_rag_service import _FakeRag
    rag = _FakeRag(tmp_path)
    rag.ingest("global", "legacy", "历史归属未知资料")
    monkeypatch.setattr(rag_api, "get_rag_service", lambda **kwargs: rag)
    client, _, switch = env
    switch("alice")
    assert client.post("/api/rag/documents", json={"name": "private", "text": "价格 99 元"}).status_code == 201
    assert client.get("/api/rag/documents").json()["documents"] == {"private": 1}
    switch("bob")
    assert client.get("/api/rag/documents").json()["documents"] == {}
    assert client.post("/api/rag/search", json={"query": "价格"}).json()["hits"] == []
    assert client.delete("/api/rag/documents/private").status_code == 404
    assert rag.stats("global")["documents"] == {"legacy": 1}
    switch("alice")
    assert client.post("/api/rag/search", json={"query": "价格"}).json()["hits"][0]["source"] == "private"


def test_rag_legacy_project_index_is_preserved_for_verified_owner(env, monkeypatch, tmp_path):
    from app.api import rag as rag_api
    from tests.test_rag_service import _FakeRag
    rag = _FakeRag(tmp_path)
    rag.ingest("proj-bob", "legacy", "价格 99 元")
    monkeypatch.setattr(rag_api, "get_rag_service", lambda **kwargs: rag)
    client, factory, switch = env
    _seed_bob_data(factory)
    switch("alice")
    assert client.get("/api/rag/documents?projectId=proj-bob").status_code == 404
    switch("bob")
    assert client.get("/api/rag/documents?projectId=proj-bob").json()["documents"] == {"legacy": 1}
    assert client.delete("/api/rag/documents/legacy?projectId=proj-bob").status_code == 200
    assert client.get("/api/rag/documents?projectId=proj-bob").json()["documents"] == {}
    assert rag.stats("proj-bob")["documents"] == {"legacy": 1}

