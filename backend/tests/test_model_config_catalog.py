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
    return {"name": name, "baseUrl": "https://example.test/v1", "modelId": name + "-model", "timeoutSeconds": 60 if kind == "image" else 5}


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
