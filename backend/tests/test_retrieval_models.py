"""Wire contracts and malformed response checks without external model calls."""
import json
from types import SimpleNamespace as NS
from unittest.mock import MagicMock

import pytest

from app.services import retrieval_models as models


def config(**changes):
    return {"base_url": "https://api.siliconflow.cn/v1", "model": "Qwen/Qwen3-Reranker-8B", "api_key": "test-only-key", "timeout_seconds": 30, **changes}


def response(monkeypatch, body):
    seen = {}
    result = MagicMock()
    result.__enter__.return_value.read.return_value = json.dumps(body).encode()
    def request(req, timeout):
        seen.update(url=req.full_url, body=json.loads(req.data), timeout=timeout, auth=req.get_header("Authorization"))
        return result
    monkeypatch.setattr(models.urllib.request, "urlopen", request)
    return seen


@pytest.mark.parametrize("base", ["https://api.siliconflow.cn", "https://api.siliconflow.cn/v1/", "https://api.siliconflow.cn/v1/rerank"])
def test_siliconflow_contract_and_endpoint(monkeypatch, base):
    seen = response(monkeypatch, {"results": [{"index": 0, "relevance_score": 0.2}, {"index": 1, "relevance_score": 0.9}]})
    assert models.rerank(config(base_url=base), "fruit", ["car", "apple"]) == [(1, 0.9), (0, 0.2)]
    assert seen == {"url": "https://api.siliconflow.cn/v1/rerank", "body": {"query": "fruit", "model": "Qwen/Qwen3-Reranker-8B", "documents": ["car", "apple"], "top_n": 2}, "timeout": 30, "auth": "Bearer test-only-key"}


def test_tei_contract_without_cloud_key(monkeypatch):
    seen = response(monkeypatch, [{"index": 0, "score": 0.8}])
    assert models.rerank(config(base_url="http://tei:8080", api_key="", protocol="tei"), "fruit", ["apple"]) == [(0, 0.8)]
    assert seen["body"] == {"query": "fruit", "texts": ["apple"], "raw_scores": False}
    assert seen["auth"] is None


@pytest.mark.parametrize("rows", [None, {}, {"results": []}, {"results": [{"index": 0}]}, {"results": [{"index": 4, "relevance_score": 1}]}, {"results": [{"index": 0, "relevance_score": float("nan")}]}, {"results": [{"index": 0, "relevance_score": True}]}, {"results": [{"index": 0, "relevance_score": 1}, {"index": 0, "relevance_score": 0}]}])
def test_invalid_rerank_response_is_not_success(monkeypatch, rows):
    response(monkeypatch, rows)
    with pytest.raises(models.RetrievalModelError):
        models.rerank(config(), "fruit", ["apple"])


@pytest.mark.parametrize("base,expected", [("https://api.siliconflow.cn/v1/embeddings", "https://api.siliconflow.cn/v1"), ("https://embedding.example.test", "https://embedding.example.test/v1"), ("https://embedding.example.test/custom/embeddings/", "https://embedding.example.test/custom")])
def test_openai_embedding_batches_and_restores_order(base, expected):
    seen = []
    def create(**kwargs):
        seen.append(kwargs)
        return NS(data=[NS(index=i, embedding=[float(i + 1), 1.0]) for i in reversed(range(len(kwargs["input"])))])
    client = NS(embeddings=NS(create=create), close=MagicMock())
    def factory(**kwargs):
        assert kwargs["base_url"] == expected
        assert kwargs["max_retries"] == 0
        return client
    values = models.embed(config(model="Qwen/Qwen3-Embedding-8B", base_url=base), ["text"] * 33, client_factory=factory)
    assert len(values) == 33 and values[0] == [1.0, 1.0]
    assert [len(call["input"]) for call in seen] == [32, 1]
    assert all(call["encoding_format"] == "float" for call in seen)
    client.close.assert_called_once()


@pytest.mark.parametrize("rows", [[], [NS(index=1, embedding=[1.0])], [NS(index=0, embedding=[])], [NS(index=0, embedding=[0.0])], [NS(index=0, embedding=[float("inf")])], [NS(index=0, embedding=[True])]])
def test_invalid_embeddings_rejected(rows):
    client = NS(embeddings=NS(create=lambda **kwargs: NS(data=rows)), close=MagicMock())
    with pytest.raises(models.RetrievalModelError):
        models.embed(config(model="embedding"), ["text"], client_factory=lambda **kwargs: client)
    client.close.assert_called_once()


def test_native_tei_embeddings(monkeypatch):
    seen = response(monkeypatch, [[0.2, 0.8], [0.7, 0.3]])
    assert len(models.embed(config(base_url="http://tei:8080/embed", model="bge-m3", api_key="", protocol="tei"), ["one", "two"])) == 2
    assert seen["url"] == "http://tei:8080/embed"
    assert seen["body"] == {"inputs": ["one", "two"]}


def test_embedding_dimension_mismatch(monkeypatch):
    response(monkeypatch, [[0.2, 0.8], [0.7]])
    with pytest.raises(models.RetrievalModelError, match="维度"):
        models.embed(config(base_url="http://tei:8080", model="bge-m3", protocol="tei"), ["one", "two"])


@pytest.mark.parametrize("kind,changes", [("rerank", {"base_url": "https://cloud.siliconflow.cn/me/models"}), ("embedding", {"model": "Qwen/Qwen3-Reranker-8B"}), ("rerank", {"model": "Qwen/Qwen3-Embedding-8B"}), ("embedding", {"protocol": "compatible"})])
def test_bad_config_rejected_before_request(kind, changes):
    with pytest.raises(models.RetrievalModelError):
        models.validate_config(config(**changes), kind)


def test_provider_exception_does_not_expose_credentials():
    assert "secret-value" not in models.error_detail(RuntimeError("Authorization secret-value"))
