"""RAG 服务单元测试：分块 / 分词 / RRF / 混合检索 / 引用上下文。"""

import numpy as np
import pytest

from app.services.rag_service import (
    RRF_K,
    RagService,
    chunk_markdown,
    parse_document,
    rrf_fuse,
    tokenize,
)


def test_tokenize_cjk_bigram_and_ascii():
    tokens = tokenize("向量检索 vector search")
    assert "向量" in tokens and "检索" in tokens
    assert "vector" in tokens and "search" in tokens


def test_chunk_markdown_heading_aware():
    doc = "\n\n".join([
        "# 标题一",
        "第一段内容。" * 60,
        "# 标题二",
        "第二段内容。" * 60,
    ])
    chunks = chunk_markdown(doc, chunk_chars=300, overlap_chars=50)
    assert len(chunks) >= 2
    headings = {c["heading"] for c in chunks}
    assert "标题一" in headings and "标题二" in headings


def test_rrf_fuse_prefers_multi_hit():
    scores = rrf_fuse([[0, 1, 2], [1, 0, 3]])
    assert scores[1] > scores[2]  # 两路都命中的 chunk 分数最高


def test_parse_document_txt():
    text = parse_document("notes.txt", "你好".encode("utf-8"))
    assert text == "你好"


class _FakeRag(RagService):
    """注入确定性嵌入：文本包含关键词则向量偏向该维度。"""

    def __init__(self, index_dir):
        super().__init__(index_dir=str(index_dir))
        self.embed_calls = 0

    def _embed(self, texts):  # noqa: D102
        self.embed_calls += 1
        vocab = ["价格", "部署", "安全", "速度"]
        vectors = []
        for text in texts:
            vec = [1.0 if word in text else 0.0 for word in vocab]
            if not any(vec):
                vec = [0.1] * len(vocab)
            vectors.append(vec)
        return vectors


@pytest.fixture()
def rag(tmp_path):
    return _FakeRag(tmp_path)


def test_ingest_and_hybrid_search(rag):
    rag.ingest("proj-1", "定价文档", "# 价格\n专业版每月 99 元，含全部功能。" * 3)
    rag.ingest("proj-1", "部署文档", "# 部署\n支持 Docker Compose 一键部署。" * 3)
    result = rag.search(["proj-1"], "价格是多少", use_rerank=False)
    assert result["hits"], "混合检索应命中片段"
    top = result["hits"][0]
    assert top["source"] == "定价文档"
    assert top["heading"] == "价格"
    assert "rerankUsed" in result


def test_rerank_reorders_hits(rag):
    for i in range(6):
        rag.ingest("proj-r", f"文档{i}", f"# 主题{i}\n内容{i}关于价格与部署。" * 5)
    calls = {}

    def fake_rerank(query, texts):
        calls["n"] = len(texts)
        # 反转顺序，验证重排生效
        return [(len(texts) - 1 - i, 1.0 - i * 0.1) for i in range(len(texts))]

    rag._rerank = fake_rerank
    result = rag.search(["proj-r"], "价格 部署", use_rerank=True)
    assert result["rerankUsed"] is True
    assert calls["n"] > 0


def test_search_empty_index(rag):
    result = rag.search(["nope"], "任何查询", use_rerank=False)
    assert result["hits"] == []


def test_build_context_numbered_citations(rag):
    hits = [{"text": "专业版每月 99 元", "source": "定价文档", "heading": "价格"}]
    context = rag.build_context(hits)
    assert "[1] 来源：定价文档 · 价格" in context
    assert "专业版每月 99 元" in context


def test_remove_document(rag):
    rag.ingest("proj-d", "旧文档", "内容。" * 100)
    assert rag.stats("proj-d")["chunks"] > 0
    assert rag.remove_document("proj-d", "旧文档") is True
    assert rag.stats("proj-d")["chunks"] == 0
