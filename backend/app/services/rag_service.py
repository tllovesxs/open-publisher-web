"""RAG 检索服务：文档解析 + 分块 + 嵌入 + 混合检索 + 重排 + 引用上下文。

实现逻辑参考高星开源项目（只复用思路，不复制代码）：
- LangChain text-splitters：标题感知分块 + 滑窗重叠（ragflow/llama_index 同思路）
- rank_bm25：BM25 关键词检索；中文按二元组（bigram）切词，兼容无 jieba 环境
- RRF（Reciprocal Rank Fusion）：向量排名与 BM25 排名倒数融合，Qdrant/Milvus 混合检索同思路
- HuggingFace TEI /rerank：bge-reranker 重排，兼容现有 tei-rerank 容器
- RAGFlow 引用溯源：检索片段编号入上下文，正文可回溯来源

索引按 index_id（项目 ID 或 run:<id>）分文件存 JSON，轻量起步，无重型依赖。
嵌入调用 OpenAI 兼容 /embeddings（复用 LLM 档案的 base_url 与数据库密钥）。
"""

from __future__ import annotations

import io
import json
import re
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from openai import OpenAI

from app.core.config import get_settings
from app.services.model_profile_service import resolve_llm_config

RRF_K = 60
_CJK_RUN = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]+")
_ASCII_WORD = re.compile(r"[a-zA-Z0-9_]+")


class RAGUnavailable(Exception):
    """RAG 依赖不可用（嵌入接口失败/索引为空等），调用方应优雅降级。"""


# ---------- 分词（BM25 用） ----------

def tokenize(text: str) -> list[str]:
    """中文 bigram + 英文单词的轻量分词。"""
    tokens: list[str] = []
    lowered = text.lower()
    for run in _CJK_RUN.findall(lowered):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    tokens.extend(_ASCII_WORD.findall(lowered))
    return tokens


# ---------- 分块（标题感知 + 重叠） ----------

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


def chunk_markdown(text: str, chunk_chars: int = 600, overlap_chars: int = 100) -> list[dict]:
    """按标题切大段，段内按段落聚合到 chunk_chars，保留尾部重叠。"""
    sections: list[tuple[str, list[str]]] = []
    heading = ""
    buffer: list[str] = []
    for line in text.splitlines():
        m = _HEADING.match(line.strip())
        if m:
            if buffer:
                sections.append((heading, buffer))
                buffer = []
            heading = m.group(2).strip()[:100]
        else:
            buffer.append(line)
    if buffer:
        sections.append((heading, buffer))

    chunks: list[dict] = []

    def flush(tail: list[str], sec_heading: str) -> None:
        body = "\n\n".join(tail).strip()
        if body:
            chunks.append({"text": body, "heading": sec_heading})

    for sec_heading, lines in sections:
        paragraphs = [p.strip() for p in "\n".join(lines).split("\n\n") if p.strip()]
        current: list[str] = []
        size = 0
        for para in paragraphs:
            if size + len(para) > chunk_chars and current:
                flush(current, sec_heading)
                tail: list[str] = []
                tail_size = 0
                for prev in reversed(current):
                    if tail_size + len(prev) > overlap_chars:
                        break
                    tail.insert(0, prev)
                    tail_size += len(prev)
                current = tail
                size = tail_size
            current.append(para)
            size += len(para)
        flush(current, sec_heading)
    return chunks


# ---------- 文档解析 ----------

def parse_document(filename: str, data: bytes) -> str:
    """md/txt 直读；PDF 用 pypdf；docx 抽取 document.xml 文本。"""
    lower = filename.lower()
    if lower.endswith(".pdf"):
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            return "\n\n".join(
                (page.extract_text() or "").strip() for page in reader.pages
            ).strip()
        except ImportError as exc:
            raise RAGUnavailable("服务端未安装 pypdf，无法解析 PDF") from exc
    if lower.endswith(".docx"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                xml = zf.read("word/document.xml").decode("utf-8", errors="ignore")
        except (KeyError, zipfile.BadZipFile) as exc:
            raise RAGUnavailable("docx 文件损坏或格式不支持") from exc
        xml = re.sub(r"</w:p>", "\n\n", xml)
        return re.sub(r"<[^>]+>", "", xml).strip()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("gbk", errors="ignore")


# ---------- RRF 融合 ----------

def rrf_fuse(rankings: list[list[int]]) -> dict[int, float]:
    """多路排名融合：score = Σ 1/(k + rank)。输入每路按相关性降序的 chunk 下标。"""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, key in enumerate(ranking):
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank + 1)
    return scores


def _cosine_top(query_vec: list[float], vectors: list[list[float]], top_n: int) -> list[int]:
    if not vectors:
        return []
    q = np.asarray(query_vec, dtype=np.float32)
    m = np.asarray(vectors, dtype=np.float32)
    q_norm = float(np.linalg.norm(q))
    if q_norm == 0:
        return []
    sims = m @ q / (np.linalg.norm(m, axis=1) * q_norm + 1e-9)
    return [int(i) for i in np.argsort(-sims)[:top_n]]


class RagService:
    """按 index_id 管理向量+BM25 混合索引；写操作覆盖保存（单进程内足够）。"""

    def __init__(self, index_dir: str | None = None) -> None:
        self.settings = get_settings()
        self.index_dir = Path(index_dir or self.settings.rag_index_dir)
        self.index_dir.mkdir(parents=True, exist_ok=True)

    # ---- 索引读写 ----

    def _path(self, index_id: str) -> Path:
        safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", index_id)
        return self.index_dir / f"{safe}.json"

    def _load(self, index_ids: list[str]) -> dict:
        chunks: list[dict] = []
        vectors: list[list[float]] = []
        for index_id in index_ids:
            path = self._path(index_id)
            if not path.exists():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            chunks.extend(data.get("chunks", []))
            vectors.extend(data.get("vectors", []))
        return {"chunks": chunks, "vectors": vectors}

    def _save(self, index_id: str, data: dict) -> None:
        self._path(index_id).write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8",
        )

    def stats(self, index_id: str) -> dict:
        data = self._load([index_id])
        docs: dict[str, int] = {}
        for chunk in data["chunks"]:
            docs[chunk.get("source", "")] = docs.get(chunk.get("source", ""), 0) + 1
        return {"indexId": index_id, "chunks": len(data["chunks"]), "documents": docs}

    def remove_document(self, index_id: str, doc_name: str) -> bool:
        data = self._load([index_id])
        kept = [
            (chunk, vec)
            for chunk, vec in zip(data["chunks"], data["vectors"])
            if chunk.get("source") != doc_name
        ]
        if len(kept) == len(data["chunks"]):
            return False
        self._save(
            index_id,
            {"chunks": [c for c, _ in kept], "vectors": [v for _, v in kept]},
        )
        return True

    # ---- 嵌入 ----

    def _embedding_config(self) -> tuple[str, str]:
        """解析嵌入配置：管理端 /settings/rag 保存的偏好优先，默认走全局设置。"""
        model = self.settings.rag_embedding_model
        base_url = ""
        try:
            from app.db.session import SessionLocal
            from app.services.workspace_settings import read_preferences

            with SessionLocal() as db:
                saved = read_preferences(db, "admin:rag") or {}
            model = saved.get("embeddingModel") or model
            base_url = saved.get("embeddingBaseUrl") or ""
        except Exception:  # noqa: BLE001 - 偏好表不可用时按默认配置
            pass
        return model, base_url

    def _embed(self, texts: list[str]) -> list[list[float]]:
        config = resolve_llm_config()
        if not config.get("api_key"):
            raise RAGUnavailable("未配置嵌入模型 API Key（存于管理端密钥库）")
        model, base_override = self._embedding_config()
        client = OpenAI(
            api_key=config["api_key"],
            base_url=base_override or config["base_url"],
            timeout=30,
        )
        out: list[list[float]] = []
        try:
            for start in range(0, len(texts), 32):
                batch = texts[start : start + 32]
                resp = client.embeddings.create(model=model, input=batch)
                out.extend([d.embedding for d in resp.data])
        except Exception as exc:  # noqa: BLE001
            raise RAGUnavailable(f"嵌入接口调用失败：{exc}") from exc
        return out

    # ---- 写入 / 检索 ----

    def ingest(self, index_id: str, source: str, text: str) -> dict:
        cleaned = text.strip()
        if not cleaned:
            raise ValueError("文档内容为空")
        chunks = chunk_markdown(cleaned, self.settings.rag_chunk_chars)
        if not chunks:
            raise ValueError("文档解析后无可索引内容")
        vectors = self._embed([c["text"] for c in chunks])
        data = self._load([index_id])
        for chunk, vec in zip(chunks, vectors):
            data["chunks"].append({"source": source, **chunk})
            data["vectors"].append(vec)
        self._save(index_id, data)
        return {"indexId": index_id, "source": source, "chunks": len(chunks)}

    def search(
        self,
        index_ids: list[str],
        query: str,
        *,
        top_k: int | None = None,
        use_rerank: bool = True,
    ) -> dict:
        """混合检索：向量 top-N + BM25 top-N → RRF → 可选重排 → top_k。"""
        top_k = top_k or self.settings.rag_top_k
        data = self._load(index_ids)
        chunks = data["chunks"]
        if not chunks or not query.strip():
            return {"hits": [], "rerankUsed": False, "candidates": 0}

        recall_n = max(top_k * 4, 20)
        query_vec = self._embed([query.strip()])[0]
        vec_rank = _cosine_top(query_vec, data["vectors"], recall_n)

        from rank_bm25 import BM25Okapi

        corpus = [tokenize(c["text"]) for c in chunks]
        bm25 = BM25Okapi(corpus)
        bm25_rank = [int(i) for i in np.argsort(-bm25.get_scores(tokenize(query)))[:recall_n]]

        rrf = rrf_fuse([vec_rank, bm25_rank])
        fused = sorted(rrf, key=rrf.get, reverse=True)[: max(top_k * 2, 10)]
        candidates = [chunks[i] for i in fused]

        rerank_used = False
        if use_rerank:
            reranked = self._rerank(query, [c["text"] for c in candidates])
            if reranked:
                candidates = [candidates[i] for i, _ in reranked]
                rerank_used = True
        hits = [
            {"text": c["text"], "source": c.get("source", ""), "heading": c.get("heading", "")}
            for c in candidates[:top_k]
        ]
        return {"hits": hits, "rerankUsed": rerank_used, "candidates": len(candidates)}

    def _rerank(self, query: str, texts: list[str]) -> list[tuple[int, float]] | None:
        """TEI /rerank（bge-reranker）；服务未启动或超时返回 None，跳过重排。"""
        rerank_base = self.settings.rerank_base_url
        try:
            from app.db.session import SessionLocal
            from app.services.workspace_settings import read_preferences

            with SessionLocal() as db:
                saved = read_preferences(db, "admin:rag") or {}
            rerank_base = saved.get("rerankBaseUrl") or rerank_base
        except Exception:  # noqa: BLE001
            pass
        base = rerank_base.rstrip("/")
        if not base:
            return None
        body = json.dumps({"query": query, "texts": texts, "raw_scores": False}).encode()
        req = urllib.request.Request(
            f"{base}/rerank", data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.settings.rerank_timeout_seconds) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            results = payload.get("data") or payload.get("results") or []
            ranked = [(int(r["index"]), float(r["score"])) for r in results]
            return sorted(ranked, key=lambda x: -x[1]) or None
        except Exception:  # noqa: BLE001 - 重排失败直接跳过
            return None

    # ---- 上下文组装（引用溯源） ----

    def build_context(self, hits: list[dict]) -> str:
        """编号引用块：供写作 Prompt 注入，正文以 [n] 角标回溯来源。"""
        lines = ["以下资料来自 RAG 检索，写作时可引用，格式为 [编号]：", ""]
        for i, hit in enumerate(hits, 1):
            heading = f" · {hit['heading']}" if hit.get("heading") else ""
            lines.append(f"[{i}] 来源：{hit.get('source', '未知')}{heading}")
            lines.append(hit["text"][:1200])
            lines.append("")
        return "\n".join(lines).strip()


_service: RagService | None = None


def get_rag_service() -> RagService:
    global _service
    if _service is None:
        _service = RagService()
    return _service
