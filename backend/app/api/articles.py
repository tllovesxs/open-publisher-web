"""文章库 API：蓝本 /v2/articles 契约的 FastAPI 移植。

端点语义与蓝本 agent-runtime 一致：
- POST /articles            乐观并发写入（创建或新版本），冲突 409
- GET  /articles            列表
- GET  /articles/{id}       当前状态
- GET  /articles/{id}/revisions           版本列表
- GET  /articles/{id}/revisions/{rid}     单版本详情
- POST /articles/{id}/revisions/{rid}/restore  恢复旧版本（产生新版本）
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import require_user
from app.db.session import get_db
from app.models.user import AppUser
from app.schemas.blueprint import ArticleWriteRequest
from app.services.article_store import (
    ArticleConflictError,
    ArticlePermissionError,
    ArticleStore,
)

router = APIRouter(prefix="/articles", tags=["articles"])


def _store(db: Session) -> ArticleStore:
    return ArticleStore(db)


def _forbidden() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"code": "ARTICLE_FORBIDDEN", "message": "Article belongs to another user", "retryable": False},
    )


def _conflict() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "ARTICLE_CONFLICT", "message": "Article changed after this operation started",
                "retryable": True},
    )


@router.get("")
def list_articles(db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    return {"articles": _store(db).list(user.id)}


@router.post("", status_code=status.HTTP_201_CREATED)
def write_article(
    body: ArticleWriteRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    store = _store(db)
    try:
        return store.commit(
            article_id=body.articleId,
            base_revision_id=body.baseRevisionId,
            base_content_hash=body.baseContentHash,
            title=body.title,
            markdown=body.markdown,
            reason=body.reason,
            owner_user_id=user.id,
        )
    except ArticleConflictError:
        raise _conflict() from None
    except ArticlePermissionError:
        raise _forbidden() from None


@router.get("/{article_id}")
def read_article(
    article_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    article = _store(db).read(article_id, user.id)
    if article is None:
        raise HTTPException(status_code=404, detail={
            "code": "ARTICLE_NOT_FOUND", "message": "Article was not found", "retryable": False,
        })
    return article


@router.get("/{article_id}/revisions")
def list_article_revisions(
    article_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    revisions = _store(db).list_revisions(article_id, user.id)
    if revisions is None:
        raise HTTPException(status_code=404, detail={
            "code": "ARTICLE_NOT_FOUND", "message": "Article was not found", "retryable": False,
        })
    return {"revisions": revisions}


@router.get("/{article_id}/revisions/{revision_id}")
def read_article_revision(
    article_id: str,
    revision_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    revision = _store(db).read_revision(article_id, revision_id, user.id)
    if revision is None:
        raise HTTPException(status_code=404, detail={
            "code": "ARTICLE_REVISION_NOT_FOUND",
            "message": "Article revision was not found", "retryable": False,
        })
    return revision


@router.post("/{article_id}/revisions/{revision_id}/restore", status_code=201)
def restore_article_revision(
    article_id: str,
    revision_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    try:
        restored = _store(db).restore_revision(article_id, revision_id, user.id)
    except ArticleConflictError:
        raise _conflict() from None
    except ArticlePermissionError:
        raise _forbidden() from None
    if restored is None:
        raise HTTPException(status_code=404, detail={
            "code": "ARTICLE_REVISION_NOT_FOUND",
            "message": "Article revision was not found", "retryable": False,
        })
    return restored

class VisualPlanRequest(BaseModel):
    """蓝本 VisualCompositionRequest 的 Web 精简版：数量 + 素材 + 匹配阈值。"""

    targetCount: int = Field(default=2, ge=0, le=6)
    assetIds: list[str] = Field(default_factory=list, max_length=20)
    requiredAssetIds: list[str] = Field(default_factory=list, max_length=6)
    mode: str = Field(default="fixed", pattern="^(none|auto|fixed)$")
    materialMatchThreshold: int = Field(default=40, ge=0, le=100)


class VisualPlacementRequest(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    anchorHeading: str | None = Field(default=None, max_length=300)
    anchorExcerpt: str | None = Field(default=None, max_length=300)
    alt: str = Field(default="文章配图", max_length=200)
    source: str = Field(pattern="^(existing_asset|generate)$")
    assetId: str | None = None
    generationPrompt: str | None = Field(default=None, max_length=16_000)


class VisualApplyRequest(BaseModel):
    imageModelId: str | None = Field(default=None, max_length=64)
    baseRevisionId: str = Field(min_length=1)
    baseContentHash: str = Field(min_length=1)
    placements: list[VisualPlacementRequest] = Field(min_length=1, max_length=6)


@router.post("/{article_id}/visual-plan")
def plan_article_visual(
    article_id: str,
    body: VisualPlanRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """规划配图：只读操作，不产生图片或新版本（对应蓝本 /v2/visual/plan）。"""
    from app.services.visual_service import VisualService

    article = _store(db).read(article_id, user.id)
    if article is None:
        raise HTTPException(status_code=404, detail={
            "code": "ARTICLE_NOT_FOUND", "message": "Article was not found", "retryable": False,
        })
    try:
        plan = VisualService(db).plan(
            markdown=article["markdown"], target_count=body.targetCount,
            asset_ids=body.assetIds, material_match_threshold=body.materialMatchThreshold,
            owner_user_id=user.id, mode=body.mode, required_asset_ids=body.requiredAssetIds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return {
        **plan,
        "sourceRevisionId": article["currentRevisionId"],
        "sourceContentHash": article["contentHash"],
    }


@router.post("/{article_id}/visual-validate")
def validate_article_visual(
    article_id: str, body: VisualApplyRequest,
    db: Session = Depends(get_db), user: AppUser = Depends(require_user),
):
    """确认后、生图前校验全部位置及素材；不调用生图或修改正文。"""
    from app.services.visual_service import VisualService
    try:
        VisualService(db).validate(
            article_id=article_id, base_revision_id=body.baseRevisionId,
            base_content_hash=body.baseContentHash,
            placements=[p.model_dump() for p in body.placements], owner_user_id=user.id,
        )
    except ArticleConflictError:
        raise _conflict() from None
    except ArticlePermissionError:
        raise _forbidden() from None
    except KeyError:
        raise HTTPException(status_code=404, detail="Article was not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return {"valid": True}


@router.post("/{article_id}/visual-apply")
def apply_article_visual(
    article_id: str,
    body: VisualApplyRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """应用配图方案：生成缺图、插入 asset:// 引用并提交新版本。"""
    from app.services.visual_service import VisualService

    if _store(db).read(article_id, user.id) is None:
        raise HTTPException(status_code=404, detail={
            "code": "ARTICLE_NOT_FOUND", "message": "Article was not found", "retryable": False,
        })
    service = VisualService(db)
    try:
        result = service.apply(
            article_id=article_id,
            base_revision_id=body.baseRevisionId,
            base_content_hash=body.baseContentHash,
            placements=[p.model_dump() for p in body.placements],
            owner_user_id=user.id,
            image_model_id=body.imageModelId,
        )
    except ArticleConflictError:
        raise _conflict() from None
    except ArticlePermissionError:
        raise _forbidden() from None
    except KeyError:
        raise HTTPException(status_code=404, detail={
            "code": "ARTICLE_NOT_FOUND", "message": "Article was not found", "retryable": False,
        }) from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return result