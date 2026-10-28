"""RAG API：资料入库 / 检索测试台 / 索引管理。

检索测试台可演示：查询 → 向量+BM25 混合召回 → RRF 融合 → bge-reranker 重排
→ 带来源编号的命中片段（对应传智杯"检索策略、生成质量提升"考察点）。
"""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel, Field

from app.core.auth import require_user
from app.models.user import AppUser
from app.services.rag_service import RAGUnavailable, RagService, get_rag_service, parse_document

router = APIRouter(prefix="/rag", tags=["rag"])


class DocumentIngestRequest(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=2_000_000)
    projectId: str = Field(default="global", max_length=64)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    projectId: str = Field(default="global", max_length=64)
    topK: int = Field(default=5, ge=1, le=20)


@router.post("/documents", status_code=201)
def ingest_document(
    body: DocumentIngestRequest,
    user: AppUser = Depends(require_user),
):
    del user  # 登录即可；索引文件按 projectId 隔离
    try:
        return get_rag_service().ingest(body.projectId, body.name, body.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@router.post("/documents/upload", status_code=201)
def upload_document(
    file: UploadFile = File(...),
    projectId: str = "global",
    user: AppUser = Depends(require_user),
):
    del user
    data = file.file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件超过 20MB 上限")
    try:
        text = parse_document(file.filename or "untitled.txt", data)
        return get_rag_service().ingest(projectId, file.filename or "untitled.txt", text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@router.get("/documents")
def list_documents(
    projectId: str = "global",
    user: AppUser = Depends(require_user),
):
    del user
    return get_rag_service().stats(projectId)


@router.delete("/documents/{doc_name:path}")
def delete_document(
    doc_name: str,
    projectId: str = "global",
    user: AppUser = Depends(require_user),
):
    del user
    if not get_rag_service().remove_document(projectId, doc_name):
        raise HTTPException(status_code=404, detail="文档不存在")
    return {"deleted": doc_name}


@router.post("/search")
def search(
    body: SearchRequest,
    user: AppUser = Depends(require_user),
):
    del user
    try:
        return get_rag_service().search([body.projectId], body.query, top_k=body.topK)
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


__all__ = ["router", "RagService"]
