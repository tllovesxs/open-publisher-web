"""Image provider policy parity with the internal blueprint; no network calls."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.media_service import MediaService


@pytest.mark.parametrize("model, wording, schema_reject, expected_calls", [
    ("glm-image", [], False, 1),
    ("glm-image", [], True, 2),
    ("gpt-image-1", [], False, 1),
    ("glm-image", ["正文标签"], False, 1),
])
def test_image_provider_matches_blueprint(monkeypatch, model, wording, schema_reject, expected_calls):
    import json
    import openai
    from app.services import model_profile_service

    calls = []
    client_options = []

    class SchemaError(Exception):
        status_code = 422

    def generate(**kwargs):
        calls.append(kwargs)
        if schema_reject and len(calls) == 1:
            raise SchemaError("optional negative_prompt rejected")
        return SimpleNamespace(data=[SimpleNamespace(b64_json="mock-image", url=None)])

    def client(**kwargs):
        client_options.append(kwargs)
        return SimpleNamespace(images=SimpleNamespace(generate=generate))

    monkeypatch.setattr(openai, "OpenAI", client)
    monkeypatch.setattr(model_profile_service, "resolve_image_config", lambda **kwargs: {
        "api_key": "test-only", "base_url": "https://image.example/v1", "model": model,
        "timeout_seconds": 60,
    })
    service = MediaService(None)
    saved = []
    service.add_generated = lambda **kwargs: saved.append(kwargs) or {"id": "generated"}
    prompt = "OPEN_PUBLISHER_VISIBLE_TEXT_JSON:" + json.dumps(wording) + "\nAn editorial illustration."
    assert service.generate(prompt=prompt, size="1536x1024", owner_user_id="owner", image_profile_id="selected-model") == {"id": "generated"}
    assert len(calls) == expected_calls
    assert client_options[0]["max_retries"] == 0
    for request in calls:
        assert request["size"] == "1536x1024"
        assert request["response_format"] == "b64_json"
        assert "OPEN_PUBLISHER_VISIBLE_TEXT_JSON" not in request["prompt"]
        assert "private rendering instructions" in request["prompt"]
    assert ("extra_body" in calls[0]) == (model == "glm-image" and not wording)
    if schema_reject:
        assert "extra_body" not in calls[1]
    assert saved[0]["owner_user_id"] == "owner"
    assert saved[0]["prompt"] == prompt


def test_image_timeout_not_retried(monkeypatch):
    import openai
    from app.services import model_profile_service
    calls = []

    def generate(**kwargs):
        calls.append(kwargs)
        raise TimeoutError("simulated provider timeout")

    monkeypatch.setattr(openai, "OpenAI", lambda **kwargs: SimpleNamespace(images=SimpleNamespace(generate=generate)))
    monkeypatch.setattr(model_profile_service, "resolve_image_config", lambda **kwargs: {
        "api_key": "test-only", "base_url": "https://image.example/v1", "model": "glm-image", "timeout_seconds": 60,
    })
    with pytest.raises(HTTPException) as error:
        MediaService(None).generate(prompt="An illustration.")
    assert error.value.status_code == 502
    assert len(calls) == 1
