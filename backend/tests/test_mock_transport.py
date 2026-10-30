"""Exercise the shipped HTTP mock with the real OpenAI streaming client."""
import threading
from http.server import ThreadingHTTPServer

import pytest
from openai import OpenAI

from mock.mock_llm_server import MockHandler


@pytest.fixture
def client():
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with OpenAI(api_key="mock-local-only", base_url=f"http://127.0.0.1:{server.server_port}/v1", max_retries=0) as client:
        yield client
    server.shutdown()
    server.server_close()
    thread.join()


def test_real_sdk_streaming_tool_call(client):
    chunks = list(client.chat.completions.create(model="mock", stream=True,
        messages=[{"role": "system", "content": "writer"}],
        tools=[{"type": "function", "function": {"name": "write_article",
            "parameters": {"type": "object", "properties": {}}}}]))
    assert chunks[0].choices[0].delta.tool_calls[0].function.name == "write_article"
    assert chunks[-1].choices[0].finish_reason == "tool_calls"


def test_text_stream_and_structured_checks(client):
    result = client.chat.completions.create(model="mock", messages=[{"role": "system", "content": "[RiskCheck]"}])
    assert '"level": "low"' in result.choices[0].message.content
    stream = client.chat.completions.create(model="mock", stream=True, messages=[{"role": "system", "content": "Writer Agent"}])
    assert "Mock" in "".join(c.choices[0].delta.content or "" for c in stream)
    optimized = client.chat.completions.create(model="mock", messages=[{"role": "user", "content": "optimize"}])
    import json
    assert "content" in json.loads(optimized.choices[0].message.content)
