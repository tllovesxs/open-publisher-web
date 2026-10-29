"""RAG API：资料入库 / 检索测试台 / 索引管理。

检索测试台可演示：查询 → 向量+BM25 混合召回 → RRF 融合 → bge-reranker 重排
→ 带来源编号的命中片段（对应传智杯"检索策略、生成质量提升"考察点）。
"""

import hashlib

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import require_user
from app.db.session import get_db
from app.models.project import Project
from app.models.user import AppUser
from app.services.rag_service import RAGUnavailable, RagService, get_rag_service, parse_document

router = APIRouter(prefix="/rag", tags=["rag"])


def _user_index(project_id: str, user: AppUser, db: Session) -> str:
    """Never expose an unscoped index, including the personal default library."""
    project = None
    if project_id != "global":
        project = db.get(Project, project_id)
        if project is None or project.owner_user_id not in (None, user.id):
            raise HTTPException(status_code=404, detail="项目不存在")
    identity = hashlib.sha256(
        f"{user.id}\0{project_id}".encode("utf-8"),
    ).hexdigest()
    index = f"user-{identity}"
    if project is not None and project.owner_user_id == user.id:
        try:
            get_rag_service().adopt_legacy_index(project_id, index)
        except RAGUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
    return index


class DocumentIngestRequest(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=2_000_000)
    projectId: str = Field(default="global", min_length=1, max_length=64)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    projectId: str = Field(default="global", min_length=1, max_length=64)
    topK: int = Field(default=5, ge=1, le=20)


@router.post("/documents", status_code=201)
def ingest_document(
    body: DocumentIngestRequest,
    user: AppUser = Depends(require_user),
    db: Session = Depends(get_db),
):
    index = _user_index(body.projectId, user, db)
    try:
        result = get_rag_service().ingest(index, body.name, body.text)
        return {**result, "indexId": body.projectId}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@router.post("/documents/upload", status_code=201)
def upload_document(
    file: UploadFile = File(...),
    projectId: str = Query(default="global", min_length=1, max_length=64),
    user: AppUser = Depends(require_user),
    db: Session = Depends(get_db),
):
    index = _user_index(projectId, user, db)
    data = file.file.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件超过 20MB 上限")
    try:
        text = parse_document(file.filename or "untitled.txt", data)
        result = get_rag_service().ingest(index, file.filename or "untitled.txt", text)
        return {**result, "indexId": projectId}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@router.get("/documents")
def list_documents(
    projectId: str = Query(default="global", min_length=1, max_length=64),
    user: AppUser = Depends(require_user),
    db: Session = Depends(get_db),
):
    index = _user_index(projectId, user, db)
    try:
        result = get_rag_service().stats(index)
        return {**result, "indexId": projectId}
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@router.delete("/documents/{doc_name:path}")
def delete_document(
    doc_name: str,
    projectId: str = Query(default="global", min_length=1, max_length=64),
    user: AppUser = Depends(require_user),
    db: Session = Depends(get_db),
):
    index = _user_index(projectId, user, db)
    try:
        if not get_rag_service().remove_document(index, doc_name):
            raise HTTPException(status_code=404, detail="文档不存在")
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    return {"deleted": doc_name}


@router.post("/search")
def search(
    body: SearchRequest,
    user: AppUser = Depends(require_user),
    db: Session = Depends(get_db),
):
    index = _user_index(body.projectId, user, db)
    try:
        return get_rag_service().search([index], body.query, top_k=body.topK)
    except RAGUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


__all__ = ["router", "RagService"]
