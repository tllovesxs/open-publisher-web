"""Shared wire adapters for retrieval runtime and administrative probes."""
import json
import math
import urllib.request
from urllib.parse import urlsplit


class RetrievalModelError(ValueError):
    pass


def protocol_for(config: dict, kind: str) -> str:
    protocol = config.get("protocol", "auto")
    if protocol != "auto":
        return protocol
    if kind == "embedding":
        return "openai"
    host = urlsplit(config["base_url"]).hostname or ""
    return "compatible" if host in {"api.siliconflow.cn", "api.siliconflow.com"} else "tei"


def endpoint_base(base: str, suffix: str) -> str:
    base = base.strip().rstrip("/")
    url = urlsplit(base)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RetrievalModelError("检索服务地址需为不含密钥和查询参数的 HTTP(S) 地址")
    if url.hostname in {"cloud.siliconflow.cn", "cloud.siliconflow.com"}:
        raise RetrievalModelError("当前填写的是控制台地址，请改为 https://api.siliconflow.cn/v1")
    if base.endswith(suffix):
        base = base[:-len(suffix)]
    if url.hostname in {"api.siliconflow.cn", "api.siliconflow.com"} and not urlsplit(base).path:
        base += "/v1"
    return base


def validate_config(config: dict, kind: str) -> None:
    if config.get("base_url"):
        endpoint_base(config["base_url"], "/embeddings" if kind == "embedding" else "/rerank")
    protocol = protocol_for(config, kind)
    if protocol not in ({"openai", "tei"} if kind == "embedding" else {"compatible", "tei"}):
        raise RetrievalModelError("所选接口协议不适用于此模型类型")
    model = config.get("model", "").lower()
    if (kind == "embedding" and "rerank" in model) or (kind == "rerank" and "embedding" in model):
        raise RetrievalModelError("模型类型不匹配：资料检索请选择 Embedding 模型，排序请选择 Reranker 模型")


def error_detail(exc: Exception) -> str:
    if isinstance(exc, RetrievalModelError):
        return str(exc)
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if status in (401, 403):
        return "访问验证失败，请检查此配置的密钥及模型使用权限"
    if status == 404:
        return "检索接口或模型不存在，请检查服务地址、接口协议和模型名称"
    if status in (400, 422):
        return "检索服务拒绝请求参数，请检查接口协议和模型类型"
    if status == 429:
        return "检索服务限流或额度不足，请检查服务商账户后重试"
    if isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError) or "timeout" in type(exc).__name__.lower():
        return "检索服务响应超时，请增加等待时限后重试"
    return "检索连接失败，请检查服务地址、接口协议、模型和密钥"


def _post(url: str, config: dict, body: dict):
    headers = {"Content-Type": "application/json"}
    if config.get("api_key"):
        headers["Authorization"] = "Bearer " + config["api_key"]
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=config["timeout_seconds"]) as response:
        return json.loads(response.read().decode("utf-8"))


def embed(config: dict, texts: list[str], *, client_factory=None) -> list[list[float]]:
    validate_config(config, "embedding")
    if not texts:
        return []
    protocol = protocol_for(config, "embedding")
    base = endpoint_base(config["base_url"], "/embeddings" if protocol == "openai" else "/embed")
    if protocol == "openai" and not urlsplit(base).path:
        base += "/v1"
    client = None
    if protocol == "openai":
        if not config.get("api_key"):
            raise RetrievalModelError("未配置此检索模型的访问密钥")
        if client_factory is None:
            from openai import OpenAI
            client_factory = OpenAI
        client = client_factory(api_key=config["api_key"], base_url=base, timeout=config["timeout_seconds"], max_retries=0)
    vectors = []
    try:
        for start in range(0, len(texts), 32):
            batch = texts[start:start + 32]
            if client is not None:
                response = client.embeddings.create(model=config["model"], input=batch, encoding_format="float")
                ordered = sorted(response.data, key=lambda row: row.index)
                if any(type(row.index) is not int for row in ordered) or [row.index for row in ordered] != list(range(len(batch))):
                    raise RetrievalModelError("嵌入接口返回的向量索引无效")
                values = [row.embedding for row in ordered]
            else:
                values = _post(base + "/embed", config, {"inputs": batch})
            if not isinstance(values, list) or len(values) != len(batch):
                raise RetrievalModelError("嵌入接口返回的向量数量无效")
            for vector in values:
                if not isinstance(vector, list) or not vector or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector):
                    raise RetrievalModelError("嵌入接口返回的向量内容无效")
                if vectors and len(vector) != len(vectors[0]):
                    raise RetrievalModelError("嵌入向量维度不一致，请检查模型配置")
                if not any(v != 0 for v in vector):
                    raise RetrievalModelError("嵌入接口返回全零向量")
                vectors.append(vector)
    finally:
        if client is not None and callable(getattr(client, "close", None)):
            client.close()
    return vectors


def rerank(config: dict, query: str, texts: list[str]) -> list[tuple[int, float]]:
    validate_config(config, "rerank")
    if not texts:
        return []
    base = endpoint_base(config["base_url"], "/rerank")
    protocol = protocol_for(config, "rerank")
    body = {"query": query}
    if protocol == "tei":
        body.update(texts=texts, raw_scores=False)
    else:
        body.update(model=config["model"], documents=texts, top_n=len(texts))
    response = _post(base + "/rerank", config, body)
    rows = response if isinstance(response, list) else response.get("results", response.get("data")) if isinstance(response, dict) else None
    if not isinstance(rows, list) or not rows:
        raise RetrievalModelError("排序接口返回空结果或格式无效")
    ranked, seen = [], set()
    score_field = "score" if protocol == "tei" else "relevance_score"
    for row in rows:
        if not isinstance(row, dict):
            raise RetrievalModelError("排序接口返回的索引或分数无效")
        index, score = row.get("index"), row.get(score_field)
        if type(index) is not int or not 0 <= index < len(texts) or index in seen or isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
            raise RetrievalModelError("排序接口返回的索引或分数无效")
        seen.add(index)
        ranked.append((index, float(score)))
    return sorted(ranked, key=lambda item: -item[1])
