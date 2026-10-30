"""推文版本 API：版本历史查询、用户编辑保存新版本、AI 一键优化。

设计原则（继承蓝本）：TweetRevision 是权威稿。
用户编辑与 AI 优化都不修改旧版本，而是产生新版本。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.agents.llm_client import LLMClient
from app.core.config import get_settings
from app.db.session import get_db
from app.api.projects import _owned_project_or_404
from app.models.project import Project
from app.models.user import AppUser
from app.core.auth import require_user
from app.models.revision import TweetRevision
from app.schemas.revision import RevisionCreateRequest, RevisionOptimizeRequest
from app.schemas.run import RevisionOut

router = APIRouter(tags=["revisions"])

# 优化方向 → 指令（不放 Prompt 细节，只表达方向；具体风格由模型把握）
_OPTIMIZE_DIRECTIONS: dict[str, str] = {
    "shorter": "把推文改得更精简，删除冗余表达，保留核心信息与行动号召。",
    "punchier": "让推文更有冲击力，强化开头钩子，但不得夸大或编造事实。",
    "founder": "改写为更像创始人的第一人称口吻，真诚、具体、有细节。",
    "professional": "改写为更专业严谨的语气，适合面向技术受众。",
}


def get_llm_client(db: Session = Depends(get_db), user: AppUser = Depends(require_user)) -> LLMClient:
    """LLM 客户端依赖（测试时可 dependency_overrides 替换）。"""
    from app.services.model_profile_service import resolve_llm_profile_config
    from app.services.usage import UsageRecorder
    config = resolve_llm_profile_config(db, profile_id=None, owner_user_id=user.id)
    return LLMClient(
        config=config,
        usage_recorder=UsageRecorder(db, user_id=user.id, operation="revision-optimize", service_type="text", provider=config.get("provider", "custom")),
        usage_operation="revision-optimize",
    )


def _get_revision_or_404(revision_id: str, db: Session) -> TweetRevision:
    revision = db.get(TweetRevision, revision_id)
    if revision is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Revision not found"
        )
    return revision


def _next_version(project_id: str, db: Session) -> int:
    max_version = (
        db.query(func.max(TweetRevision.version))
        .filter(TweetRevision.project_id == project_id)
        .scalar()
    ) or 0
    return max_version + 1


@router.get(
    "/projects/{project_id}/revisions",
    response_model=list[RevisionOut],
)
def list_revisions(
    project_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """按项目查询版本历史（新版本在前）。"""
    _owned_project_or_404(project_id, db, user)
    return (
        db.query(TweetRevision)
        .filter(TweetRevision.project_id == project_id)
        .order_by(TweetRevision.version.desc())
        .all()
    )


@router.post(
    "/projects/{project_id}/revisions",
    response_model=RevisionOut,
    status_code=status.HTTP_201_CREATED,
)
def create_revision(
    project_id: str,
    payload: RevisionCreateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """用户编辑内容后保存为新版本（版本号 = 当前最大版本 + 1）。"""
    _owned_project_or_404(project_id, db, user)
    revision = TweetRevision(
        project_id=project_id,
        content=payload.content,
        platform=payload.platform,
        tone=payload.tone,
        version=_next_version(project_id, db),
        source="user_edited",
    )
    db.add(revision)
    db.commit()
    db.refresh(revision)
    return revision


@router.get("/revisions/{revision_id}", response_model=RevisionOut)
def get_revision(
    revision_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    revision = _get_revision_or_404(revision_id, db)
    _owned_project_or_404(revision.project_id, db, user)
    return revision


@router.post(
    "/revisions/{revision_id}/optimize",
    response_model=RevisionOut,
    status_code=status.HTTP_201_CREATED,
)
def optimize_revision(
    revision_id: str,
    payload: RevisionOptimizeRequest | None = None,
    db: Session = Depends(get_db),
    llm: LLMClient = Depends(get_llm_client),
    user: AppUser = Depends(require_user),
):
    """AI 一键优化：按方向改写指定版本，产出新版本（source="ai_optimized"）。"""
    direction = (payload.direction if payload else "shorter").strip().lower()
    instruction = _OPTIMIZE_DIRECTIONS.get(direction)
    if instruction is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"未知的优化方向：{direction}，可选值：{sorted(_OPTIMIZE_DIRECTIONS)}",
        )

    if not llm.api_key_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="未配置 LLM API Key（数据库加密存储），无法使用 AI 优化。",
        )

    source = _get_revision_or_404(revision_id, db)
    _owned_project_or_404(source.project_id, db, user)

    system = (
        "你是资深产品推文写手。根据优化指令改写推文，"
        "保持事实准确，不编造数据。只输出 JSON："
        '{"content": "改写后的推文", "notes": "一句话改动说明"}'
    )
    user = f"优化方向：{instruction}\n\n原文：\n{source.content}"

    result = llm.complete_json(system, user, temperature=0.7)
    new_content = str(result.get("content") or "").strip()
    if not new_content:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="模型未返回有效内容，请重试。",
        )

    revision = TweetRevision(
        project_id=source.project_id,
        content=new_content,
        platform=source.platform,
        tone=source.tone,
        version=_next_version(source.project_id, db),
        source="ai_optimized",
    )
    db.add(revision)
    db.commit()
    db.refresh(revision)
    return revision
