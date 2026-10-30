"""Public resources must not weaken the authentication of private libraries."""
import pytest
from fastapi.testclient import TestClient

from app.core.auth import require_admin, require_user
from app.main import app


@pytest.fixture()
def anonymous_client():
    overrides = app.dependency_overrides.copy()
    app.dependency_overrides.pop(require_user, None)
    app.dependency_overrides.pop(require_admin, None)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(overrides)


@pytest.mark.parametrize("kind", ["articles", "templates", "media"])
def test_examples_are_public_and_read_only(anonymous_client, kind):
    response = anonymous_client.get(f"/api/examples/{kind}")
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["id"].startswith("example-")
    assert "ownerUserId" not in items[0]
    assert anonymous_client.post(f"/api/examples/{kind}", json={}).status_code == 405


@pytest.mark.parametrize("path", ["articles", "templates", "media", "projects", "assistant/sessions", "settings/preferences", "settings/model-configs/image"])
def test_private_libraries_still_require_login(anonymous_client, path):
    assert anonymous_client.get(f"/api/{path}").status_code == 401


def test_example_path_cannot_read_arbitrary_files(anonymous_client):
    assert anonymous_client.get("/api/examples/secrets").status_code == 404
