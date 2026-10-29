from app.services.writer_stream import markdown_prefix


def test_markdown_prefix_reads_only_complete_top_level_string():
    assert markdown_prefix(
        '{"title":"标题","markdown":"# 标题\\n\\n正文。","reason":"'
    ) == "# 标题\n\n正文。"


def test_markdown_prefix_unescapes_quotes_and_backslashes():
    assert markdown_prefix(
        '{"markdown":"路径\\\\文件和\\"引用\\"'
    ) == '路径\\文件和"引用"'


def test_markdown_prefix_omits_incomplete_escape():
    assert markdown_prefix('{"markdown":"内容\\u4e2d\\uD83D') == "内容中"


def test_markdown_prefix_does_not_expose_other_tool_fields():
    assert markdown_prefix('{"title":"标题","reason":"说明","markdown":"正文') == "正文"
    assert markdown_prefix('{"title":"标题","reason":"说明"}') == ""


def test_openai_sdk_tool_stream_records_usage_without_exposing_reasoning():
    import json
    import httpx
    from openai import OpenAI
    from app.agents.llm_client import LLMClient
    received = []
    def handler(request):
        received.append(json.loads(request.content))
        chunks = [
            {"choices": [{"index": 0, "delta": {"reasoning_content": "private reasoning"}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call1", "type": "function", "function": {"name": "write_article", "arguments": '{"title":"t","markdown":"# t'}}]}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "length"}]},
            {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 100, "total_tokens": 120, "completion_tokens_details": {"reasoning_tokens": 60}}},
        ]
        body = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})
    client = object.__new__(LLMClient)
    client.model = "GLM-5.3-Flash"
    client.capabilities = {}
    client.call_count = 0
    client._client = OpenAI(api_key="test-only", base_url="https://mock.invalid/v1", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    events = list(client.stream_chat("system", [{"role": "user", "content": "x"}]))
    assert received[0]["max_tokens"] == 16384
    assert received[0]["thinking"]["type"] == "disabled"
    assert events[-1]["usage"]["reasoningTokens"] == 60
    assert events[-1]["finishReason"] == "length"
    assert events[-1]["reasoningChars"] == len("private reasoning")
    assert "private reasoning" not in str(events)
    assert any(event["type"] == "tool_delta" for event in events)
