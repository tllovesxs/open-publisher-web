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
        yield {
            "type": "message",
            "content": turn.get("content"),
            "toolCalls": turn.get("toolCalls", []),
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

@pytest.mark.parametrize("node", NODES)
def test_disabled_node_is_not_started(db, node):
    service = WriterService(db, llm=FakeLLM())
    run = service.start_article_create(article_id="disable-" + node, prompt="x", creation={"disabledNodeIds": [node]})
    assert _wait_terminal(service.journal, run["id"])["status"] == "completed"
    events = service.journal.events_after(run["id"], 0)
    assert not any(e["type"] == "node.started" and e["payload"]["nodeId"] == node for e in events)
    skipped = [e for e in events if e["type"] == "node.completed" and e["payload"]["nodeId"] == node]
    assert skipped[0]["payload"]["reason"] == "disabled"
    if node == "draft":
        assert service.store.read("disable-" + node) is None


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


@pytest.mark.parametrize("node", NODES)
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
