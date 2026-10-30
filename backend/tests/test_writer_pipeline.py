"""蓝本 Writer 运行管线测试：RunJournal 状态机 + WriterService 全流程。"""

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.services.run_journal import RunJournal, RunJournalError
from app.services.writer_service import WriterService


@pytest.fixture()
def db(tmp_path):
    """SQLite 文件库；后台线程与测试线程可以并发访问。"""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'writer.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    session = factory()
    yield session
    session.close()


class FakeLLM:
    def __init__(self, markdown="# 测试文章\n\n正文。", fail=False):
        self.markdown = markdown
        self.fail = fail
        self.call_count = 0

    def complete(self, system, user, **kwargs):
        self.call_count += 1
        if self.fail:
            raise RuntimeError("模型超时")
        return self.markdown


class FakeStreamingLLM:
    """模拟 OpenAI 兼容流式接口。"""

    def __init__(self, chunks=("# 测试文章\n\n", "正文。")):
        self.chunks = chunks
        self.call_count = 0

    def stream_complete(self, system, user, *, temperature=0.7, **kwargs):
        for chunk in self.chunks:
            yield chunk
        self.call_count += 1


def _wait_terminal(journal, run_id, timeout=5.0):
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = journal.get_run(run_id)
        if run and run["status"] in ("completed", "failed", "stopped", "interrupted"):
            return run
        time.sleep(0.02)
    raise AssertionError("run did not finish in time")


def test_run_journal_state_machine(db):
    journal = RunJournal(db)
    run = journal.create_run(article_id=None, agent_id="writer", operation="article-create")
    assert run["status"] == "pending"

    journal.transition(run["id"], "running")
    journal.append(run["id"], "run.started", {})
    journal.append(run["id"], "agent.message_delta", {"text": "a"})
    journal.append(run["id"], "agent.message_delta", {"text": "b"})

    events = journal.events_after(run["id"], 0)
    assert [e["sequence"] for e in events] == [1, 2, 3]

    # 断线续读：after=1 只拿后面的事件
    tail = journal.events_after(run["id"], 1)
    assert [e["sequence"] for e in tail] == [2, 3]

    journal.transition(run["id"], "completed")
    # 终态不允许再转换
    with pytest.raises(RunJournalError):
        journal.transition(run["id"], "running")


def test_writer_article_create_full_flow(db):
    llm = FakeLLM()
    service = WriterService(db, llm=llm)
    run = service.start_article_create(
        article_id="w1", prompt="写一篇关于本地优先软件的文章",
        length_preset="short",
    )
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "completed"

    article = service.store.read("w1")
    assert article is not None
    assert article["markdown"].startswith("# 测试文章")
    assert article["title"] == "测试文章"

    types = [e["type"] for e in journal.events_after(run["id"], 0)]
    assert "run.started" in types
    assert "article.checkpointed" in types
    assert "revision.committed" in types
    assert types[-1] == "run.completed"

    # 方案2：节点化工作流事件（前端 WorkflowWorkspace 时间线数据源）
    node_ids = [
        e["payload"]["nodeId"]
        for e in journal.events_after(run["id"], 0)
        if e["type"] == "node.completed"
    ]
    # 蓝本 8 节点：research → outline → draft → natural-style → review →
    # reference-safety → risk（visual 由前端配图阶段驱动，后端只发 node.started）
    assert node_ids == ["research", "outline", "draft", "natural-style", "review", "reference-safety", "risk", "visual"]
    assert "node.completed" in types


def test_writer_streams_model_deltas(db):
    llm = FakeStreamingLLM()
    service = WriterService(db, llm=llm)
    run = service.start_article_create(article_id="w-stream", prompt="x")
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "completed"
    assert llm.call_count == 1

    deltas = [
        e for e in journal.events_after(run["id"], 0)
        if e["type"] == "agent.message_delta" and e["payload"].get("stage") == "content"
    ]
    assert deltas
    assert "".join(e["payload"]["delta"] for e in deltas) == "# 测试文章\n\n正文。"
    assert deltas[-1]["payload"]["totalChars"] == len("# 测试文章\n\n正文。")

    article = service.store.read("w-stream")
    assert article is not None
    assert article["markdown"] == "# 测试文章\n\n正文。"


def test_writer_failure_marks_run_failed(db):
    service = WriterService(db, llm=FakeLLM(fail=True))
    run = service.start_article_create(article_id="w2", prompt="x")
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "failed"
    assert final["error"]["code"] == "WRITER_RUN_FAILED"
    # 失败不落版本
    assert service.store.read("w2") is None


def test_writer_stop_before_model(db):
    # stop 请求在执行前：pending -> stopping 合法，执行线程发现后转 stopped
    llm = FakeLLM()
    service = WriterService(db, llm=llm)
    run = service.start_article_create(article_id="w3", prompt="x")
    journal = RunJournal(db)
    # 竞速：可能已经 running；stop 语义两种入口都合法
    try:
        service.request_stop(run["id"])
    except RunJournalError:
        pass
    final = _wait_terminal(journal, run["id"])
    assert final["status"] in ("stopped", "completed")



def test_writer_article_run_lock(db):
    journal = RunJournal(db)
    journal.create_run(article_id="locked", agent_id="writer", operation="article-create")
    active = journal.active_run_for_article("locked")
    assert active is not None
    journal.transition(active["id"], "running")
    service = WriterService(db, llm=FakeLLM())
    with pytest.raises(Exception, match="已有进行中"):
        service.start_article_create(article_id="locked", prompt="x")


class FakeAgentLLM:
    """支持 stream_chat 的测试替身：按预设轮次返回工具调用。"""

    def __init__(self, turns):
        self.turns = list(turns)
        self.call_count = 0
        self.timeout_seconds = 120
        self.calls: list[dict] = []

    def stream_chat(self, system, messages, *, tools=None, temperature=0.7):
        self.calls.append({
            "system": system,
            "messages": [dict(m) for m in messages],
            "tools": tools,
        })
        turn = self.turns[min(self.call_count, len(self.turns) - 1)]
        self.call_count += 1
        for delta in turn.get("textDeltas", []):
            yield {"type": "text", "delta": delta}
        for event in turn.get("streamEvents", []):
            yield event
        yield {
            "type": "message",
            "content": turn.get("content"),
            "toolCalls": turn.get("toolCalls", []),
            "finishReason": turn.get("finishReason"),
        }


def test_writer_agent_loop_commits_via_write_article(db):
    llm = FakeAgentLLM([
        {"toolCalls": [{"id": "call_1", "name": "write_article",
                        "arguments": json.dumps({
                            "title": "工具提交的文章",
                            "markdown": "# 工具提交的文章\n\n正文。",
                            "reason": "依据用户资料写作",
                        })}]},
    ])
    service = WriterService(db, llm=llm)
    run = service.start_article_create(
        article_id="w-agent", prompt="写一篇测试文章", length_preset="short",
    )
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "completed"

    article = service.store.read("w-agent")
    assert article["title"] == "工具提交的文章"
    assert article["markdown"] == "# 工具提交的文章\n\n正文。"

    types = [e["type"] for e in journal.events_after(run["id"], 0)]
    assert "agent.tool_call" in types
    assert "agent.tool_result" in types
    assert types[-1] == "run.completed"

    # 工具契约确实下发给模型
    tool_names = [t["function"]["name"] for t in llm.calls[0]["tools"]]
    assert tool_names[0] == "write_article"


def test_writer_agent_loop_research_tool_then_write(db, monkeypatch):
    from app.services import writer_service as ws

    monkeypatch.setattr(
        ws, "_github_repository_summary",
        lambda repo: f"仓库资料：{repo}",
    )
    llm = FakeAgentLLM([
        {"toolCalls": [{"id": "call_1", "name": "github_repository",
                        "arguments": json.dumps({"repository": "tllovesxs/open-publisher"})}]},
        {"toolCalls": [{"id": "call_2", "name": "write_article",
                        "arguments": json.dumps({
                            "title": "研究后成文",
                            "markdown": "# 研究后成文\n\n正文。",
                            "reason": "结合仓库资料",
                        })}]},
    ])
    service = WriterService(db, llm=llm)
    run = service.start_article_create(
        article_id="w-agent2", prompt="介绍这个仓库", length_preset="short",
    )
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "completed"
    assert service.store.read("w-agent2")["markdown"] == "# 研究后成文\n\n正文。"

    # 第二轮对话包含研究工具结果（tool 消息）
    second = llm.calls[1]["messages"]
    assert any(
        m.get("role") == "tool" and "仓库资料" in (m.get("content") or "")
        for m in second
    )


def test_writer_agent_loop_rejects_dirty_markdown(db):
    llm = FakeAgentLLM([
        {"toolCalls": [{"id": "call_1", "name": "write_article",
                        "arguments": json.dumps({
                            "title": "脏提交",
                            "markdown": "<invoke name=\"x\">\n"
                                        "<parameter name=\"a\">1</parameter>\n"
                                        "正文不算",
                            "reason": "r",
                        })}]},
        {"toolCalls": [{"id": "call_2", "name": "write_article",
                        "arguments": json.dumps({
                            "title": "干净文章",
                            "markdown": "# 干净文章\n\n正文。",
                            "reason": "重试",
                        })}]},
    ])
    service = WriterService(db, llm=llm)
    run = service.start_article_create(
        article_id="w-agent3", prompt="写文章", length_preset="short",
    )
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "completed"

    article = service.store.read("w-agent3")
    assert article["markdown"] == "# 干净文章\n\n正文。"

    results = [
        e for e in journal.events_after(run["id"], 0)
        if e["type"] == "agent.tool_result"
    ]
    assert any("提交被拒绝" in e["payload"]["message"] for e in results)


def test_writer_fallback_strips_tool_markup(db):
    llm = FakeLLM(markdown=(
        '<invoke name="write_article">\n'
        '<parameter name="title">x</parameter>\n'
        "</invoke>\n\n# 干净回退文章\n\n正文。"
    ))
    service = WriterService(db, llm=llm)
    run = service.start_article_create(
        article_id="w-fb", prompt="写文章", length_preset="short",
    )
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "completed"

    article = service.store.read("w-fb")
    assert article["markdown"].startswith("# 干净回退文章")
    assert "<invoke" not in article["markdown"]
    assert article["title"] == "干净回退文章"


def test_writer_fallback_fails_on_only_markup(db):
    llm = FakeLLM(markdown=(
        '<invoke name="write_article">\n'
        '<parameter name="markdown"># x</parameter>\n'
        "</invoke>"
    ))
    service = WriterService(db, llm=llm)
    run = service.start_article_create(
        article_id="w-fb2", prompt="写文章", length_preset="short",
    )
    journal = RunJournal(db)
    final = _wait_terminal(journal, run["id"])
    assert final["status"] == "failed"
    assert service.store.read("w-fb2") is None


NODES = ["research", "outline", "draft", "natural-style", "review", "reference-safety", "risk", "visual"]

@pytest.mark.parametrize("node", [node for node in NODES if node != "draft"])
def test_disabled_node_is_not_started(db, node):
    service = WriterService(db, llm=FakeLLM())
    run = service.start_article_create(article_id="disable-" + node, prompt="x", creation={"disabledNodeIds": [node]})
    assert _wait_terminal(service.journal, run["id"])["status"] == "completed"
    events = service.journal.events_after(run["id"], 0)
    assert not any(e["type"] == "node.started" and e["payload"]["nodeId"] == node for e in events)
    skipped = [e for e in events if e["type"] == "node.completed" and e["payload"]["nodeId"] == node]
    assert skipped[0]["payload"]["reason"] == "disabled"
    assert service.store.read("disable-" + node)["markdown"]


def test_off_blocks_research_and_unsolicited_tool_calls(db, monkeypatch):
    from app.services import writer_service as ws
    calls = []
    monkeypatch.setattr(ws, "_web_search_summary", lambda q: calls.append(q))
    monkeypatch.setattr(ws, "_github_repository_summary", lambda q: calls.append(q))
    llm = FakeAgentLLM([
        {"toolCalls": [{"id": "web", "name": "web_search", "arguments": '{"query":"x"}'}]},
        {"toolCalls": [{"id": "git", "name": "github_repository", "arguments": '{"repository":"a/b"}'}]},
        {"toolCalls": [{"id": "write", "name": "write_article", "arguments": json.dumps({"title":"t", "markdown":"# t", "reason":"r"})}]},
    ])
    service = WriterService(db, llm=llm)
    run = service.start_article_create(article_id="offline", prompt="x", creation={"webSearchMode":"off", "references":"用户事实"})
    assert _wait_terminal(service.journal, run["id"])["status"] == "completed"
    assert calls == []
    assert [t["function"]["name"] for t in llm.calls[0]["tools"]] == ["write_article"]
    assert "用户事实" in str(llm.calls[0]["messages"])


@pytest.mark.parametrize("node", [node for node in NODES if node != "draft"])
def test_stop_at_each_stage_prevents_later_stages(db, monkeypatch, node):
    original = WriterService._node_started
    def stop_at(self, run_id, node_id):
        if node_id == node:
            self.request_stop(run_id)
        return original(self, run_id, node_id)
    monkeypatch.setattr(WriterService, "_node_started", stop_at)
    service = WriterService(db, llm=FakeLLM())
    run = service.start_article_create(article_id="stop-" + node, prompt="x")
    assert _wait_terminal(service.journal, run["id"])["status"] == "stopped"
    events = service.journal.events_after(run["id"], 0)
    assert events[-1]["type"] == "run.stopped"
    assert not any(e["type"] == "node.completed" and e["payload"]["nodeId"] == node for e in events)


def test_stop_during_llm_return_does_not_commit(db):
    class StopLLM(FakeLLM):
        def complete(self, *args, **kwargs):
            service.request_stop(run["id"])
            return "# 不应保存"
    service = WriterService(db, llm=StopLLM())
    run = service.journal.create_run(article_id="stop-return", agent_id="writer", operation="article-create")
    service._execute(run["id"], article_id="stop-return", prompt="x", tone=None, length_preset="short", custom_length=None, humanize=False, base_revision_id=None, base_content_hash=None, owner_user_id=None, creation={})
    assert service.journal.get_run(run["id"])["status"] == "stopped"
    assert service.store.read("stop-return") is None


@pytest.mark.parametrize("system,result", [
    ("[Review]", {"score": 101, "issues": [], "verdict": "pass"}),
    ("[Review]", {"score": 90, "issues": "bad", "verdict": "pass"}),
    ("[ReferenceSafety]", {"ok": "false", "issues": []}),
    ("[ReferenceSafety]", {}),
    ("[RiskCheck]", {"level": "safe", "issues": []}),
    ("[RiskCheck]", {}),
])
def test_malformed_check_results_are_never_treated_as_pass(db, system, result):
    class StructuredLLM:
        def complete_json(self, *args):
            return result
    service = WriterService(db, llm=StructuredLLM())
    run = service.journal.create_run(article_id="validation", agent_id="writer", operation="article-create")
    service._run_id = run["id"]
    with pytest.raises(ValueError, match="格式无效"):
        service._llm_json(system, "article")


def test_rag_success_does_not_duplicate_reference_text_in_draft(db, monkeypatch):
    from app.services import rag_service
    class FakeRag:
        def ingest(self, *args):
            return {"chunks": 5}
        def search(self, *args):
            return {"hits": [{"text": "SELECTED_EVIDENCE"}], "rerankUsed": True}
        def build_context(self, hits):
            return "[1] SELECTED_EVIDENCE"
    monkeypatch.setattr(rag_service, "get_rag_service", lambda: FakeRag())
    llm = FakeAgentLLM([{"toolCalls": [{"id": "write", "name": "write_article", "arguments": json.dumps({"title": "t", "markdown": "# t\n\nbody", "reason": "r"})}]}])
    service = WriterService(db, llm=llm)
    run = service.start_article_create(article_id="rag-evidence", prompt="task", creation={"references": "UNSELECTED_REFERENCE", "webSearchMode": "off"})
    assert _wait_terminal(service.journal, run["id"])["status"] == "completed"
    messages = str(llm.calls[0]["messages"])
    assert "SELECTED_EVIDENCE" in messages
    assert "UNSELECTED_REFERENCE" not in messages


def test_invalid_risk_response_reports_unknown_without_losing_article(db):
    class InvalidCheckLLM(FakeLLM):
        def complete_json(self, *args):
            return {}
    service = WriterService(db, llm=InvalidCheckLLM())
    run = service.start_article_create(article_id="invalid-risk", prompt="task")
    assert _wait_terminal(service.journal, run["id"])["status"] == "completed"
    risk = next(event["payload"] for event in service.journal.events_after(run["id"], 0) if event["type"] == "node.completed" and event["payload"]["nodeId"] == "risk")
    assert risk["level"] == "unknown"
    assert risk["skipped"] is True
    assert service.store.read("invalid-risk") is not None


def test_truncated_tool_stream_keeps_recoverable_body_without_revision(db):
    body = "# 草稿\n\n尚未完成的正文"
    raw = json.dumps({"title": "草稿", "markdown": body}, ensure_ascii=False)[:-2]
    llm = FakeAgentLLM([{
        "textDeltas": ["收到，现在提交文章。"],
        "streamEvents": [{"type": "tool_delta", "name": "write_article", "arguments": raw}],
        "finishReason": "length",
    }])
    service = WriterService(db, llm=llm)
    run = service.start_article_create(article_id="truncated-body", prompt="x")
    journal = RunJournal(db)
    assert _wait_terminal(journal, run["id"])["status"] == "failed"
    events = journal.events_after(run["id"], 0)
    deltas = [e["payload"]["delta"] for e in events if e["type"] == "agent.message_delta"]
    assert "".join(deltas) == body
    last_delta = max(e["sequence"] for e in events if e["type"] == "agent.message_delta")
    assert not any(e["type"] == "article.content_reset" and e["sequence"] > last_delta for e in events)
    assert any(e["type"] == "article.checkpointed" and e["payload"].get("recoverableDraft") for e in events)
    assert any(e["type"] == "agent.message_completed" and e["payload"]["finishReason"] == "length" for e in events)
    assert service.store.read("truncated-body") is None


def test_glm_options_preserve_native_thinking_and_use_blueprint_budget():
    from app.agents.llm_client import LLMClient
    client = object.__new__(LLMClient)
    client.model = "GLM-5.3-Flash"
    client.capabilities = {}
    options = client._options(0.7)
    assert options["max_tokens"] == 16384
    assert options["reasoning_effort"] == "low"
    assert "extra_body" not in options
    client.capabilities = {"reasoning": True, "thinkingLevel": "off"}
    assert "extra_body" not in client._options(0.7)
    client.capabilities = {"maxTokens": 24000, "reasoning": True, "thinkingLevel": "auto"}
    assert client._options(0.7)["extra_body"]["thinking"]["type"] == "enabled"
    assert client._options(0.7)["max_tokens"] == 24000


@pytest.mark.parametrize("legacy_request", [True, False])
def test_glm53_reasoning_only_length_failure_and_corrected_tool_commit(db, legacy_request):
    """回放这次失败的响应形态，并走 SDK→正文增量→文章保存完整链路。"""
    import httpx
    from openai import OpenAI
    from app.agents.llm_client import LLMClient

    body = "# 标题\n\n完整正文。"
    arguments = json.dumps({"title": "标题", "markdown": body, "reason": "依据要求"}, ensure_ascii=False)
    received = []

    def handler(request):
        payload = json.loads(request.content)
        received.append(payload)
        chunks = [{"choices": [{"index": 0, "delta": {"reasoning_content": "private reasoning"},
                                "finish_reason": None}]}]
        if payload.get("reasoning_effort") == "low":
            for i, fragment in enumerate([arguments[:-5], arguments[-5:]]):
                tool = {"index": 0, "function": {"arguments": fragment}}
                if i == 0:
                    tool.update(id="write1", type="function")
                    tool["function"]["name"] = "write_article"
                chunks.append({"choices": [{"index": 0, "delta": {"tool_calls": [tool]},
                                            "finish_reason": None}]})
            finish, output, reasoning = "tool_calls", 60, 10
        else:
            finish, output, reasoning = "length", 16384, 16306
        chunks.extend([
            {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
            {"choices": [], "usage": {"prompt_tokens": 2605, "completion_tokens": output,
                "total_tokens": 2605 + output, "completion_tokens_details": {"reasoning_tokens": reasoning}}},
        ])
        data = "".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=data, headers={"content-type": "text/event-stream"})

    client = object.__new__(LLMClient)
    client.model, client.capabilities, client.call_count = "GLM-5.3-Flash", {}, 0
    client._client = OpenAI(api_key="test-only", base_url="https://mock.invalid/v1", max_retries=0,
                            http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    if legacy_request:
        client._options = lambda temperature: {"temperature": temperature, "max_tokens": 16384}
    try:
        service = WriterService(db, llm=client)
        run = service.journal.create_run(article_id="glm53-budget", agent_id="writer", operation="article-create")
        service._execute(run["id"], article_id="glm53-budget", prompt="写一篇短文", tone=None,
            length_preset="short", custom_length=None, humanize=False, base_revision_id=None,
            base_content_hash=None, owner_user_id=None, creation={"disabledNodeIds": [
                "research", "outline", "natural-style", "review", "reference-safety", "risk",
            ]})
        events = service.journal.events_after(run["id"], 0)
        result = service.journal.get_run(run["id"])
        assert len(received) == 1  # 不在截断后偷偷重试，也不发起生图请求。
        assert "private reasoning" not in json.dumps(events)
        deltas = "".join(e["payload"]["delta"] for e in events if e["type"] == "agent.message_delta")
        metrics = next(e["payload"] for e in events if e["type"] == "agent.message_completed")
        if legacy_request:
            assert result["status"] == "failed"
            assert "尚未返回正文" in result["error"]["message"]
            assert metrics["usage"]["reasoningTokens"] == 16306
            assert service.store.read("glm53-budget") is None
            assert deltas == ""
        else:
            assert result["status"] == "completed"
            assert service.store.read("glm53-budget")["markdown"] == body
            assert deltas == body
            assert metrics["finishReason"] == "tool_calls"
    finally:
        client._client.close()


def test_agent_tiny_tool_fragments_are_batched_without_missing_body(db):
    body = "# 正文\n\n" + "中文😀内容。" * 300
    arguments = json.dumps({"title": "正文", "markdown": body, "reason": "依据资料"}, ensure_ascii=False)
    llm = FakeAgentLLM([{
        "streamEvents": [{"type": "tool_delta", "name": "write_article", "arguments": arguments[:i]}
                         for i in range(1, len(arguments) + 1)],
        "toolCalls": [{"id": "write", "name": "write_article", "arguments": arguments}],
    }])
    service = WriterService(db, llm=llm)
    run = service.start_article_create(article_id="batch-tool", prompt="x")
    assert _wait_terminal(service.journal, run["id"])["status"] == "completed"
    deltas = [e["payload"] for e in service.journal.events_after(run["id"], 0)
              if e["type"] == "agent.message_delta"]
    assert "".join(e["delta"] for e in deltas) == body
    assert len(deltas) < len(body) // 10
    assert deltas[-1]["totalChars"] == len(body)


def test_thinking_past_old_240_second_limit_can_still_commit(db, monkeypatch):
    from types import SimpleNamespace
    from app.services import writer_service
    clock = [0.0]
    monkeypatch.setattr(writer_service, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    arguments = json.dumps({"title": "正文", "markdown": "# 正文\n\n完整内容。", "reason": "r"})

    class SlowThinkingLLM(FakeAgentLLM):
        def stream_chat(self, *args, **kwargs):
            clock[0] = 250
            yield {"type": "progress", "phase": "reasoning", "elapsedMs": 250000, "reasoningChars": 100}
            yield from super().stream_chat(*args, **kwargs)

    service = WriterService(db, llm=SlowThinkingLLM([{
        "toolCalls": [{"id": "write", "name": "write_article", "arguments": arguments}],
    }]))
    run = service.journal.create_run(article_id="long-thinking", agent_id="writer", operation="article-create")
    service._execute(run["id"], article_id="long-thinking", prompt="x", tone=None,
                     length_preset="short", custom_length=None, humanize=False,
                     base_revision_id=None, base_content_hash=None, owner_user_id=None, creation={})
    assert service.journal.get_run(run["id"])["status"] == "completed"
    assert service.store.read("long-thinking")["markdown"] == "# 正文\n\n完整内容。"
    assert any(e["type"] == "agent.progress" for e in service.journal.events_after(run["id"], 0))


def test_total_deadline_keeps_unflushed_partial_body_without_revision(db, monkeypatch):
    from types import SimpleNamespace
    from app.services import writer_service
    clock = [0.0]
    monkeypatch.setattr(writer_service, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    body = "# 未完成\n\n小于批次阈值的尾段"
    arguments = json.dumps({"markdown": body}, ensure_ascii=False)[:-2]

    class DeadlineLLM:
        timeout_seconds = 120

        def stream_chat(self, *args, **kwargs):
            yield {"type": "tool_delta", "name": "write_article", "arguments": arguments}
            clock[0] = writer_service.get_settings().writer_generation_timeout_seconds + 1
            yield {"type": "progress", "phase": "responding"}

    service = WriterService(db, llm=DeadlineLLM())
    run = service.journal.create_run(article_id="deadline-tail", agent_id="writer", operation="article-create")
    service._execute(run["id"], article_id="deadline-tail", prompt="x", tone=None,
                     length_preset="short", custom_length=None, humanize=False,
                     base_revision_id=None, base_content_hash=None, owner_user_id=None, creation={})
    result = service.journal.get_run(run["id"])
    assert result["status"] == "failed"
    assert result["error"]["code"] == "WRITER_DEADLINE"
    events = service.journal.events_after(run["id"], 0)
    assert "".join(e["payload"]["delta"] for e in events if e["type"] == "agent.message_delta") == body
    assert any(e["type"] == "article.checkpointed" and e["payload"].get("recoverableDraft") for e in events)
    assert service.store.read("deadline-tail") is None


def test_node_models_reach_worker_and_restore_default(db, monkeypatch):
    base, outline, draft, review = [FakeLLM() for _ in range(4)]
    service = WriterService(db, llm=base, node_llms={"outline": outline, "draft": draft, "review": review})
    seen = []
    original = WriterService._node_started
    def capture(self, run_id, node_id):
        seen.append((node_id, self.llm))
        return original(self, run_id, node_id)
    monkeypatch.setattr(WriterService, "_node_started", capture)
    run = service.start_article_create(article_id="per-node", prompt="test", creation={"webSearchMode": "off"})
    assert _wait_terminal(RunJournal(db), run["id"])["status"] == "completed"
    used = dict(seen)
    assert used["outline"] is outline
    assert used["draft"] is draft
    assert used["review"] is review
    assert used["risk"] is base
    assert service.llm is base


@pytest.mark.parametrize("disabled", [["draft"], NODES])
def test_draft_is_required_even_for_legacy_disabled_preferences(db, disabled):
    service = WriterService(db, llm=FakeLLM())
    run = service.start_article_create(article_id="required-draft", prompt="x", creation={"disabledNodeIds": disabled})
    assert _wait_terminal(service.journal, run["id"])["status"] == "completed"
    assert service.store.read("required-draft")["markdown"]
    events = service.journal.events_after(run["id"], 0)
    assert any(e["type"] == "node.started" and e["payload"]["nodeId"] == "draft" for e in events)


def test_preferences_repair_legacy_disabled_draft():
    from app.api.settings import WritingPreferences
    assert WritingPreferences(disabledNodeIds=["draft", "risk", "risk"]).disabledNodeIds == ["risk"]


def test_same_title_generations_keep_separate_articles_and_revisions(db):
    first = WriterService(db, llm=FakeLLM(markdown="# 同名文章\n\n第一轮正文。"))
    run = first.start_article_create(article_id="same-title-first", prompt="写文章")
    assert _wait_terminal(first.journal, run["id"])["status"] == "completed"
    original = first.store.read("same-title-first")
    revisions = first.store.list_revisions("same-title-first")
    second = WriterService(db, llm=FakeLLM(markdown="# 同名文章\n\n第二轮正文。"))
    run = second.start_article_create(article_id="same-title-second", prompt="写文章")
    assert _wait_terminal(second.journal, run["id"])["status"] == "completed"
    assert second.store.read("same-title-first") == original
    assert second.store.list_revisions("same-title-first") == revisions
    newer = second.store.read("same-title-second")
    assert newer["title"] == original["title"] == "同名文章"
    assert newer["markdown"] != original["markdown"]
    assert {a["articleId"] for a in second.store.list()} == {"same-title-first", "same-title-second"}
