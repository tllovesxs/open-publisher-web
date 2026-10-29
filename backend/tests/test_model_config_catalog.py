"""Named model configurations must not overwrite unrelated/default configurations."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.main import app
from app.db.base import Base
from app.db.session import get_db
from app.models.settings_profile import ImageConfig, WorkspacePreference
from app.services.model_profile_service import resolve_image_config
from app.services.workspace_settings import read_preferences, write_preferences


@pytest.fixture()
def setup():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    def override():
        with factory() as db:
            yield db
    app.dependency_overrides[get_db] = override
    with TestClient(app) as client:
        yield client, factory
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()


def payload(name, kind):
    return {"name": name, "baseUrl": "https://example.test/v1", "modelId": name + "-model", "timeoutSeconds": 60 if kind == "image" else 5, "protocol": "compatible" if kind == "rerank" else "auto"}


@pytest.mark.parametrize("base,model,reason", [
    ("https://cloud.siliconflow.cn/me/models", "Qwen/Qwen-Image", "控制台"),
    ("https://api.siliconflow.cn/v1/images/generations", "Qwen/Qwen-Image", "/v1"),
    ("https://api.siliconflow.cn/v1", "Qwen/Qwen-Image-Edit", "图片编辑模型"),
])
def test_image_config_rejects_console_and_edit_models(setup, base, model, reason):
    client, _ = setup
    response = client.post("/api/settings/model-configs/image", json={**payload("bad-image", "image"), "baseUrl": base, "modelId": model})
    assert response.status_code == 400
    assert reason in response.json()["detail"]
    assert client.get("/api/settings/model-configs/image").json()["profiles"] == []


def test_image_generation_config_valid_api(setup):
    client, _ = setup
    response = client.post("/api/settings/model-configs/image", json={**payload("image", "image"), "baseUrl": "https://api.siliconflow.cn/v1", "modelId": "Qwen/Qwen-Image"})
    assert response.status_code == 201


@pytest.mark.parametrize("kind", ["image", "embedding", "rerank"])
def test_create_edit_activate_delete_and_validation(setup, kind):
    client, factory = setup
    root = "/api/settings/model-configs/" + kind
    assert client.get(root).json() == {"profiles": [], "activeId": None}
    first_response = client.post(root, json=payload("one", kind))
    assert first_response.status_code == 201
    first = first_response.json()
    second = client.post(root, json=payload("two", kind)).json()
    catalog = client.get(root).json()
    assert catalog["activeId"] == first["id"]
    assert len(catalog["profiles"]) == 2
    assert client.patch(root + "/" + second["id"], json=payload("edited", kind)).status_code == 200
    assert client.get(root).json()["activeId"] == first["id"]
    assert client.post(root + "/" + second["id"] + "/activate").status_code == 200
    with factory() as db:
        if kind == "image":
            resolved = resolve_image_config(db)
            assert resolved["model"] == "edited-model"
            assert resolve_image_config(db, profile_id=first["id"])["model"] == "one-model"
        else:
            assert read_preferences(db, "admin:rag")[kind + "Model"] == "edited-model"
    assert client.delete(root + "/" + second["id"]).status_code == 409
    assert client.delete(root + "/" + first["id"]).status_code == 204
    assert client.get(root).json()["profiles"][0]["name"] == "edited"
    assert client.post(root, json=payload("edited", kind)).status_code == 409
    assert client.post(root, json={**payload("bad", kind), "modelId": "   "}).status_code == 422
    assert client.post(root, json={**payload("bad", kind), "baseUrl": "https://secret:password@example.test"}).status_code == 400
    assert client.post(root + "/missing/activate").status_code == 404
    assert client.patch(root + "/missing", json=payload("missing", kind)).status_code == 404


def test_legacy_image_preserved_until_explicit_activation_and_reset(setup):
    client, factory = setup
    with factory() as db:
        db.add(ImageConfig(id="global", base_url="https://old.test/v1", model_id="original", timeout_seconds=60))
        db.commit()
    root = "/api/settings/model-configs/image"
    assert client.get(root).json()["activeId"] == "global"
    new = client.post(root, json=payload("new", "image")).json()
    with factory() as db:
        assert resolve_image_config(db)["model"] == "original"
    client.post(root + "/" + new["id"] + "/activate")
    with factory() as db:
        assert resolve_image_config(db)["model"] == "new-model"
    names = client.get("/api/settings/image-models").json()["models"]
    assert any(p["id"] == new["id"] and p["name"] == "new" and p["isDefault"] for p in names)
    # Legacy API edits the actual active record and keeps the named catalog in sync.
    assert client.put("/api/settings/image", json={"baseUrl": "https://edit.test/v1", "modelId": "updated", "timeoutSeconds": 90}).status_code == 200
    assert next(p for p in client.get(root).json()["profiles"] if p["id"] == new["id"])["modelId"] == "updated"
    assert client.delete("/api/settings/image").status_code == 200
    catalog = client.get(root).json()
    assert catalog["activeId"] is None
    assert [p["id"] for p in catalog["profiles"]] == [new["id"]]
    with factory() as db:
        assert db.get(ImageConfig, new["id"]) is not None
        assert resolve_image_config(db)["source"] == "fallback"


def test_rag_kinds_preserve_each_other_and_existing_settings(setup):
    client, factory = setup
    original = {"embeddingBaseUrl": "https://embed-old.test", "embeddingModel": "embed-old", "rerankBaseUrl": "https://rank-old.test", "rerankModel": "rank-old", "rerankTimeoutSeconds": 7}
    with factory() as db:
        write_preferences(db, "admin:rag", original)
    root = "/api/settings/model-configs/"
    embed = client.post(root + "embedding", json=payload("embed-new", "embedding")).json()
    rank = client.post(root + "rerank", json=payload("rank-new", "rerank")).json()
    with factory() as db:
        assert read_preferences(db, "admin:rag") == original
    client.post(root + "rerank/" + rank["id"] + "/activate")
    with factory() as db:
        current = read_preferences(db, "admin:rag")
        assert current["embeddingModel"] == "embed-old"
        assert current["embeddingBaseUrl"] == original["embeddingBaseUrl"]
        assert current["rerankModel"] == "rank-new-model"
    client.post(root + "embedding/" + embed["id"] + "/activate")
    with factory() as db:
        current = read_preferences(db, "admin:rag")
        assert current["embeddingModel"] == "embed-new-model"
        assert current["rerankModel"] == "rank-new-model"
        # Configuration storage contains only public fields; key storage is unchanged.
        assert all("apiKey" not in str(row.value) for row in db.query(WorkspacePreference))


def test_catalog_requires_admin_and_rejects_unknown_kind(setup):
    from app.core.auth import require_admin
    from fastapi import HTTPException
    client, _ = setup
    assert client.get("/api/settings/model-configs/other").status_code == 422
    original = app.dependency_overrides[require_admin]
    def forbidden():
        raise HTTPException(status_code=403)
    app.dependency_overrides[require_admin] = forbidden
    try:
        assert client.get("/api/settings/model-configs/image").status_code == 403
        assert client.post("/api/settings/model-configs/image", json=payload("bad", "image")).status_code == 403
    finally:
        app.dependency_overrides[require_admin] = original


def test_legacy_rag_edit_and_reset_keep_catalogs_consistent(setup):
    client, factory = setup
    profiles = {kind: client.post("/api/settings/model-configs/" + kind, json=payload(kind, kind)).json() for kind in ("embedding", "rerank")}
    result = client.put("/api/settings/rag", json={"embeddingModel": "changed-embedding", "rerankModel": "changed-rerank", "rerankBaseUrl": "https://rank.test", "rerankTimeoutSeconds": 9})
    assert result.status_code == 200
    for kind in profiles:
        catalog = client.get("/api/settings/model-configs/" + kind).json()
        assert catalog["profiles"][0]["modelId"] == "changed-" + kind
        assert catalog["activeId"] == profiles[kind]["id"]
    assert client.delete("/api/settings/rag").status_code == 200
    for kind in profiles:
        catalog = client.get("/api/settings/model-configs/" + kind).json()
        assert catalog["activeId"] is None
        assert len(catalog["profiles"]) == 1


def test_configuration_invalid_url_and_timeout_rejected(setup):
    client, _ = setup
    root = "/api/settings/model-configs/rerank"
    assert client.post(root, json={**payload("bad", "rerank"), "baseUrl": "https://[invalid"}).status_code == 400
    assert client.post(root, json={**payload("bad", "rerank"), "timeoutSeconds": 121}).status_code == 400
    assert client.post("/api/settings/model-configs/embedding", json={**payload("valid", "embedding"), "baseUrl": ""}).status_code == 201


@pytest.mark.parametrize("kind", ["image", "embedding", "rerank"])
def test_configuration_credentials_are_encrypted_isolated_and_removed(setup, kind):
    from app.models.app_secret import AppSecret, SecretAudit
    from app.services import secret_store
    from app.services.model_config_catalog import config_secret_id, resolve_rag_config
    client, factory = setup
    root = "/api/settings/model-configs/" + kind
    with factory() as db:
        secret_store.set_secret(db, "image:global", "legacy-global-image-secret")
        secret_store.set_secret(db, "llm:global", "legacy-global-text-secret")
    first = client.post(root, json={**payload("one", kind), "apiKey": "test-only-first-secret"}).json()
    second = client.post(root, json=payload("two", kind)).json()
    assert second["keyConfigured"] is False  # No sibling/global inheritance for new configs.
    key_url = root + "/" + second["id"] + "/key"
    response = client.put(key_url, json={"apiKey": "test-only-second-secret"})
    assert response.status_code == 200
    assert response.json()["keyConfigured"] is True
    assert client.get(root).json()["activeId"] == first["id"]
    assert client.patch(root + "/" + second["id"], json=payload("edited", kind)).status_code == 200
    with factory() as db:
        own = db.get(AppSecret, config_secret_id(kind, second["id"]))
        assert own.ciphertext != "test-only-second-secret"
        assert secret_store.get_secret(db, own.id) == "test-only-second-secret"
        resolve = lambda pid: resolve_image_config(db, profile_id=pid) if kind == "image" else resolve_rag_config(db, kind, pid)
        assert resolve(first["id"])["api_key"] == "test-only-first-secret"
        assert resolve(second["id"])["api_key"] == "test-only-second-secret"
        assert all("apiKey" not in str(row.value) and "test-only" not in str(row.value) for row in db.query(WorkspacePreference))
    for response_text in (str(first), client.get(root).text, response.text):
        assert "test-only-first-secret" not in response_text and "test-only-second-secret" not in response_text
    assert client.delete(key_url).json()["keyConfigured"] is False
    with factory() as db:
        resolve = resolve_image_config(db, profile_id=second["id"]) if kind == "image" else resolve_rag_config(db, kind, second["id"])
        assert resolve["api_key"] == ""  # Removal must not revive legacy globals.
    client.put(key_url, json={"apiKey": "test-only-replacement-secret"})
    assert client.delete(root + "/" + second["id"]).status_code == 204
    with factory() as db:
        assert db.get(AppSecret, config_secret_id(kind, second["id"])) is None
        assert db.query(SecretAudit).filter_by(secret_id=config_secret_id(kind, second["id"]), action="delete").count() == 2
        assert secret_store.get_secret(db, config_secret_id(kind, first["id"])) == "test-only-first-secret"


@pytest.mark.parametrize("kind", ["image", "embedding", "rerank"])
def test_legacy_key_stays_with_original_configuration_after_default_changes(setup, kind):
    from app.services import secret_store
    from app.services.model_config_catalog import resolve_rag_config
    client, factory = setup
    root = "/api/settings/model-configs/" + kind
    with factory() as db:
        # Simulate catalogs saved by the previous version without credential metadata.
        write_preferences(db, "admin:model-configs:" + kind, {"profiles": [{"id": "old", **payload("old", kind)}, {"id": "inactive", **payload("inactive", kind)}], "activeId": "old"})
        if kind == "image":
            db.add(ImageConfig(id="old", base_url="https://example.test/v1", model_id="old-model", timeout_seconds=60))
            db.add(ImageConfig(id="inactive", base_url="https://example.test/v1", model_id="inactive-model", timeout_seconds=60))
        secret_store.set_secret(db, "image:global" if kind == "image" else "llm:global", "test-only-legacy-secret")
    old = client.get(root).json()["profiles"]
    assert old[0]["keyConfigured"] is (kind != "rerank")
    assert old[1]["keyConfigured"] is False
    client.post(root + "/inactive/activate")
    with factory() as db:
        old_config = resolve_image_config(db, profile_id="old") if kind == "image" else resolve_rag_config(db, kind, "old")
        new_config = resolve_image_config(db) if kind == "image" else resolve_rag_config(db, kind)
        assert old_config["api_key"] == ("test-only-legacy-secret" if kind != "rerank" else "")
        assert new_config["api_key"] == ""
    assert client.delete(root + "/old/key").json()["keyConfigured"] is False
    # Legacy image edits must preserve explicit removal metadata.
    if kind == "image":
        client.post(root + "/old/activate")
        client.put("/api/settings/image", json={"baseUrl": "https://example.test/v1", "modelId": "old", "timeoutSeconds": 60})
        with factory() as db:
            assert resolve_image_config(db)["api_key"] == ""


def test_configuration_and_key_save_roll_back_together_when_encryption_fails(setup, monkeypatch):
    from app.core import secret_box
    from app.models.app_secret import AppSecret
    client, factory = setup
    def unavailable(_):
        raise secret_box.SecretBoxError("unavailable")
    monkeypatch.setattr(secret_box, "encrypt", unavailable)
    response = client.post("/api/settings/model-configs/image", json={**payload("one", "image"), "apiKey": "test-only-not-stored"})
    assert response.status_code == 503
    assert "test-only-not-stored" not in response.text
    assert client.get("/api/settings/model-configs/image").json()["profiles"] == []
    with factory() as db:
        assert db.query(AppSecret).count() == 0


@pytest.mark.parametrize("kind", ["image", "embedding", "rerank", "text"])
def test_connection_test_uses_selected_configuration_without_activating_it(setup, monkeypatch, kind):
    from types import SimpleNamespace as NS
    from unittest.mock import MagicMock
    import json
    import openai
    import urllib.request
    from app.services import model_profile_service
    client, factory = setup
    monkeypatch.setattr(model_profile_service, "SessionLocal", factory)
    root = "/api/settings/profiles" if kind == "text" else "/api/settings/model-configs/" + kind
    first = client.post(root, json=payload("one", "image" if kind == "text" else kind)).json()
    second = client.post(root, json=payload("two", "image" if kind == "text" else kind)).json()
    key_url = root + "/" + second["id"] + "/key"
    assert client.put(key_url, json={"apiKey": "test-only-selected-secret"}).status_code == 200
    observed = {}
    def create(**kwargs):
        observed["model"] = kwargs.get("model")
        return NS(data=[NS(embedding=[1.0], index=i, b64_json="test", url=None) for i in range(len(kwargs.get("input", [0])))])
    def fake_client(**kwargs):
        observed.update(kwargs)
        return NS(embeddings=NS(create=create), images=NS(generate=create), models=NS(list=lambda: [NS(id="available")]))
    monkeypatch.setattr(openai, "OpenAI", fake_client)
    if kind == "text":
        from app.agents import llm_client
        class FakeLLM:
            def __init__(self, config):
                observed.update(config)
                self._api_key, self.model, self.profile_name = config["api_key"], config["model"], config["profileName"]
            def complete(self, *args, **kwargs):
                return "正常"
        monkeypatch.setattr(llm_client, "LLMClient", FakeLLM)
    response = MagicMock()
    response.__enter__.return_value.read.return_value = b'{"results": [{"index": 0, "relevance_score": 1}]}'
    def rank(request, timeout):
        observed.update(api_key=request.get_header("Authorization").removeprefix("Bearer "), model=json.loads(request.data)["model"])
        return response
    monkeypatch.setattr(urllib.request, "urlopen", rank)
    endpoint = "/api/settings/model/test" if kind == "text" else "/api/settings/image/test" if kind == "image" else "/api/settings/rag/test?target=" + kind
    result = client.post(endpoint, params={"profileId": second["id"], **({"target": kind} if kind in ("embedding", "rerank") else {})})
    assert result.status_code == 200
    assert result.json().get(kind, result.json())["ok"] is True
    assert observed["api_key"] == "test-only-selected-secret"
    assert observed["model"] == "two-model"
    if kind == "text":
        assert client.get("/api/settings/models", params={"profileId": second["id"]}).json() == {"models": ["available"]}
        assert client.get(root).json()["profiles"][0]["isDefault"] is True
    else:
        assert client.get(root).json()["activeId"] == first["id"]
    assert client.post(endpoint, params={"profileId": "missing", **({"target": kind} if kind in ("embedding", "rerank") else {})}).status_code == 404


def test_llm_profile_key_precedes_global_for_runtime_and_selected_profiles(setup, monkeypatch):
    from app.services import model_profile_service, secret_store
    client, factory = setup
    monkeypatch.setattr(model_profile_service, "SessionLocal", factory)
    profile = client.post("/api/settings/profiles", json=payload("one", "image")).json()
    with factory() as db:
        secret_store.set_secret(db, "llm:global", "test-only-global-secret")
        secret_store.set_secret(db, secret_store.profile_secret_id(profile["id"]), "test-only-profile-secret")
    assert model_profile_service.resolve_llm_config()["api_key"] == "test-only-profile-secret"


@pytest.mark.parametrize("kind", ["embedding", "rerank"])
def test_rag_runtime_sends_active_configuration_credential(setup, monkeypatch, tmp_path, kind):
    from app.db import session
    from app.services import rag_service
    from types import SimpleNamespace as NS
    from unittest.mock import MagicMock
    client, factory = setup
    monkeypatch.setattr(session, "SessionLocal", factory)
    root = "/api/settings/model-configs/" + kind
    first = client.post(root, json={**payload("one", kind), "apiKey": "test-only-first-secret"}).json()
    second = client.post(root, json={**payload("two", kind), "apiKey": "test-only-second-secret"}).json()
    observed = {}
    def fake_client(**kwargs):
        observed.update(kwargs)
        def embed(**data):
            observed.update(model=data["model"])
            return NS(data=[NS(index=0, embedding=[1.0])])
        return NS(embeddings=NS(create=embed))
    monkeypatch.setattr(rag_service, "OpenAI", fake_client)
    response = MagicMock()
    response.__enter__.return_value.read.return_value = b'{"results": [{"index": 0, "relevance_score": 1}]}'
    def rank(request, timeout):
        import json
        observed.update(api_key=request.get_header("Authorization").removeprefix("Bearer "), model=json.loads(request.data)["model"])
        return response
    monkeypatch.setattr(rag_service.urllib.request, "urlopen", rank)
    rag = rag_service.RagService(index_dir=str(tmp_path))
    for profile, key in ((first, "test-only-first-secret"), (second, "test-only-second-secret")):
        client.post(root + "/" + profile["id"] + "/activate")
        result = rag._embed(["test"]) if kind == "embedding" else rag._rerank("query", ["test"])
        assert result
        assert observed["api_key"] == key
        assert observed["model"] == profile["modelId"]



def test_text_form_saves_own_credential_and_preserves_it_on_details_edit(setup):
    from app.services import secret_store
    from app.models.app_secret import AppSecret
    client, factory = setup
    root = "/api/settings/profiles"
    profile = client.post(root, json={**payload("text", "image"), "apiKey": "test-only-text-form-secret"}).json()
    assert profile["keyConfigured"] is True
    assert "test-only-text-form-secret" not in str(profile)
    assert client.patch(root + "/" + profile["id"], json={"name": "edited"}).status_code == 200
    with factory() as db:
        sid = secret_store.profile_secret_id(profile["id"])
        assert secret_store.get_secret(db, sid) == "test-only-text-form-secret"
        assert "test-only-text-form-secret" not in db.get(AppSecret, sid).ciphertext
    assert client.delete(root + "/" + profile["id"]).status_code == 204
    with factory() as db:
        assert db.get(AppSecret, sid) is None


@pytest.mark.parametrize("kind", ["embedding", "rerank"])
def test_tei_protocol_and_timeout_used_by_probe_and_runtime(setup, monkeypatch, tmp_path, kind):
    import json
    from unittest.mock import MagicMock
    from app.db import session
    from app.services.rag_service import RagService
    from app.services import retrieval_models
    client, factory = setup
    monkeypatch.setattr(session, "SessionLocal", factory)
    root = "/api/settings/model-configs/" + kind
    profile = client.post(root, json={**payload("local", kind), "protocol": "tei", "baseUrl": "http://tei:8080", "timeoutSeconds": 45}).json()
    assert profile["protocol"] == "tei"
    assert client.get(root).json()["profiles"][0]["protocol"] == "tei"
    seen = []
    def request(req, timeout):
        body = json.loads(req.data)
        seen.append((req.full_url, timeout, req.get_header("Authorization")))
        result = MagicMock()
        response = [[0.2, 0.8] for _ in body["inputs"]] if kind == "embedding" else [{"index": i, "score": 1 / (i + 1)} for i in range(len(body["texts"]))]
        result.__enter__.return_value.read.return_value = json.dumps(response).encode()
        return result
    monkeypatch.setattr(retrieval_models.urllib.request, "urlopen", request)
    tested = client.post("/api/settings/rag/test", params={"target": kind, "profileId": profile["id"]})
    assert tested.json()[kind]["ok"] is True
    rag = RagService(index_dir=str(tmp_path))
    assert (rag._embed(["test"]) if kind == "embedding" else rag._rerank("query", ["test"]))
    assert seen == [("http://tei:8080/" + ("embed" if kind == "embedding" else "rerank"), 45, None)] * 2
