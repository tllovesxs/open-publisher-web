"""供应商参数拒绝回归：通过真实 SDK 验证请求、降级与重试边界。"""

import json

import httpx
import pytest
from openai import OpenAI

from app.agents.llm_client import LLMClient, LLMError


def make_client(handler, *, reasoning=True):
    client = object.__new__(LLMClient)
    client.model = "GLM-5.3-Flash"
    client.capabilities = {"reasoning": reasoning, "vision": True}
    client.call_count = 0
    client._client = OpenAI(
        api_key="test-only", base_url="https://mock.invalid/v1", max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    return client


def success(body):
    if body.get("stream"):
        chunks = [
            {"choices": [{"index": 0, "delta": {"content": "{}"}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        ]
        stream = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
        return httpx.Response(200, text=stream + "data: [DONE]\n\n",
                              headers={"content-type": "text/event-stream"})
    return httpx.Response(200, json={
        "id": "test", "created": 0, "object": "chat.completion", "model": "GLM-5.3-Flash",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "{}"},
                     "finish_reason": "stop"}],
    })


def invoke(client, mode):
    if mode == "agent":
        return list(client.stream_chat("system", [{"role": "user", "content": "test"}],
                                       tools=[{"type": "function", "function": {
                                           "name": "write_article", "parameters": {"type": "object"},
                                       }}], tool_choice="auto"))
    if mode == "text":
        return list(client.stream_complete("system", "test"))
    if mode == "vision":
        return client.complete_json("system", "test", images=["data:image/png;base64,test"])
    return client.complete_json("system", "test")


@pytest.mark.parametrize("mode", ["agent", "text", "json", "vision"])
def test_default_glm_request_works_when_provider_rejects_disabled_thinking(mode):
    received = []

    def handler(request):
        body = json.loads(request.content)
        received.append(body)
        if body.get("thinking", {}).get("type") == "disabled":
            return httpx.Response(400, json={"error": {
                "message": "thinking.type `disabled` is not supported by this model",
            }})
        return success(body)

    client = make_client(handler, reasoning=False)
    invoke(client, mode)
    assert len(received) == 1
    assert "thinking" not in received[0]
    assert received[0]["max_tokens"] == 16384
    assert client.call_count == 1


@pytest.mark.parametrize("mode", ["agent", "text", "json", "vision"])
def test_explicitly_rejected_thinking_retries_once_and_remembers_for_next_call(mode):
    received = []

    def handler(request):
        body = json.loads(request.content)
        received.append(body)
        if "thinking" in body:
            return httpx.Response(400, json={"error": {
                "message": "thinking.type is not supported by this model",
            }})
        return success(body)

    client = make_client(handler)
    invoke(client, mode)
    assert len(received) == 2
    assert received[0]["thinking"] == {"type": "enabled"}
    assert received[1] == {key: value for key, value in received[0].items() if key != "thinking"}
    invoke(client, mode)
    assert len(received) == 3
    assert "thinking" not in received[2]
    assert client.call_count == 2


@pytest.mark.parametrize("status,message", [
    (400, "max_tokens is not supported by this model"),
    (400, "thinking.type has an invalid value"),
    (401, "thinking is not supported"),
    (429, "rate limit reached"),
])
def test_unrelated_errors_do_not_trigger_parameter_fallback(status, message):
    received = []

    def handler(request):
        received.append(json.loads(request.content))
        return httpx.Response(status, json={"error": {"message": message}})

    client = make_client(handler)
    with pytest.raises(LLMError):
        invoke(client, "agent")
    assert len(received) == 1
    assert not getattr(client, "_thinking_rejected", False)


def test_fallback_failure_does_not_repeat_forever():
    received = []

    def handler(request):
        received.append(json.loads(request.content))
        return httpx.Response(400, json={"error": {"message": "thinking is not supported"}})

    client = make_client(handler)
    with pytest.raises(LLMError):
        invoke(client, "agent")
    assert len(received) == 2
    assert client.call_count == 0
