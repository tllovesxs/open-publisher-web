"""Agent 运行 API：蓝本 /v2/runs 契约的 FastAPI 移植。

- POST /agent-runs/article-create   发起文章创作 run（异步后台执行）
- GET  /agent-runs/{run_id}         run 状态
- GET  /agent-runs/{run_id}/events   事件流（SSE，支持断线续读）
- POST /agent-runs/{run_id}/stop    请求停止
"""

import json
import time
from collections.abc import Generator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import require_user
from app.db.session import get_db
from app.models.user import AppUser
from app.services.article_store import ArticleStore
from app.services.run_journal import RunJournal, RunJournalError
from app.services.writer_service import WriterLocked, WriterService

router = APIRouter(prefix="/agent-runs", tags=["agent-runs"])

_POLL_SECONDS = 0.5
_STREAM_MAX_SECONDS = 1800
_TERMINAL = {"completed", "failed", "stopped", "interrupted"}


class CreationTemplate(BaseModel):
    mode: str = "scaffold"
    referenceMarkdown: str | None = Field(default=None, max_length=2_000_000)
    sourceFingerprint: str | None = None
    id: str | None = None
    name: str | None = None
    markdown: str | None = None
    usageInstructions: str | None = None
    styleProfile: dict | None = None
    structureProfile: dict | None = None
    layoutProfile: dict | None = None
    fixedBlocks: list[dict] | None = None
    variables: list[str] | None = None


class ImagePlan(BaseModel):
    targetCount: int = Field(default=0, ge=0, le=6)
    imageModelId: str | None = Field(default=None, max_length=64)


class ArticleCreateRequest(BaseModel):
    profileId: str | None = None
    articleId: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=100_000)
    tone: str | None = None
    lengthPreset: str = "medium"
    customLength: str | None = None
    humanize: bool = False
    title: str | None = Field(default=None, max_length=300)
    references: str | None = Field(default=None, max_length=300_000)
    template: CreationTemplate | None = None
    imageAssets: list[str] = Field(default_factory=list, max_length=20)
    inputImages: list[str] = Field(default_factory=list, max_length=10)
    imagePlan: ImagePlan | None = None
    webSearchMode: str | None = Field(default=None, pattern="^(auto|off)$")
    taskMode: str | None = Field(default=None, max_length=40)
    disabledNodeIds: list[str] = Field(default_factory=list, max_length=20)
    materialMatchThreshold: int = Field(default=40, ge=0, le=100)


def _journal(db: Session) -> RunJournal:
    return RunJournal(db)


def _assert_run_owner(run: dict, user: AppUser) -> None:
    owner = run.get("ownerUserId") or run.get("owner_user_id")
    if owner and owner != user.id:
        raise HTTPException(status_code=404, detail={"code": "RUN_NOT_FOUND"})


def _get_run_or_404(run_id: str, db: Session) -> dict:
    run = _journal(db).get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail={"code": "RUN_NOT_FOUND",
                                                     "message": "Run was not found"})
    return run


@router.post("/article-create", status_code=status.HTTP_202_ACCEPTED)
def create_article_run(
    body: ArticleCreateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    store = ArticleStore(db)
    article = store.read(body.articleId, user.id)
    if article and article.get("ownerId") not in (None, user.id):
        raise HTTPException(status_code=404, detail={"code": "ARTICLE_NOT_FOUND"})
    from app.services.workspace_settings import read_preferences
    from app.services.model_profile_service import preferred_profile_id, resolve_llm_profile_config
    from app.agents.llm_client import LLMClient
    prefs = read_preferences(db, "user:" + user.id)
    config = resolve_llm_profile_config(db, profile_id=body.profileId or preferred_profile_id(db, prefs), owner_user_id=user.id)
    node_llms = {}
    if not body.profileId:
        for node_id in (prefs.get("nodeProfileIds") or {}):
            node_config = resolve_llm_profile_config(db, profile_id=preferred_profile_id(db, prefs, node_id), owner_user_id=user.id)
            node_llms[node_id] = LLMClient(config=node_config)
    service = WriterService(db, llm=LLMClient(config=config), node_llms=node_llms)
    creation = {
        "_ownerUserId": user.id,
        "modelSelections": {key: prefs.get(key) for key in ("embeddingModelId", "rerankModelId")},
        "title": body.title,
        "references": body.references,
        "template": body.template.model_dump() if body.template else None,
        "imageAssets": body.imageAssets,
        "inputImages": body.inputImages,
        "imagePlan": body.imagePlan.model_dump() if body.imagePlan else None,
        "webSearchMode": body.webSearchMode or prefs.get("webSearchMode", "auto"),
        "taskMode": body.taskMode,
        "disabledNodeIds": body.disabledNodeIds if "disabledNodeIds" in body.model_fields_set else prefs.get("disabledNodeIds", []),
        "materialMatchThreshold": body.materialMatchThreshold,
    }
    from app.services.workspace_settings import normalize_disabled_nodes
    creation["disabledNodeIds"] = normalize_disabled_nodes(creation["disabledNodeIds"])
    try:
        return service.start_article_create(
        article_id=body.articleId,
        prompt=body.prompt,
        tone=body.tone,
        length_preset=body.lengthPreset,
        custom_length=body.customLength,
        humanize=body.humanize,
        base_revision_id=article["currentRevisionId"] if article else None,
        base_content_hash=article["contentHash"] if article else None,
        owner_user_id=user.id,
        creation=creation,
        )
    except WriterLocked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "WRITER_RUN_LOCKED", "message": "同一文章已有进行中的写作任务", "retryable": True},
        ) from None


class RewriteCandidateRequest(BaseModel):
    profileId: str | None = None
    inputImages: list[str] = Field(default_factory=list, max_length=4)
    articleId: str = Field(min_length=1, max_length=200)
    markdown: str = Field(min_length=1, max_length=200_000)
    instruction: str = Field(min_length=1, max_length=20_000)
    selectedTexts: list[str] = Field(default_factory=list, max_length=32)
    conversation: list[dict] = Field(default_factory=list, max_length=40)


@router.post("/rewrite-candidate", status_code=status.HTTP_202_ACCEPTED)
def create_rewrite_candidate(
    body: RewriteCandidateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    from app.services.rewrite_service import RewriteService

    from app.services.model_profile_service import resolve_llm_profile_config
    from app.agents.llm_client import LLMClient
    config = resolve_llm_profile_config(db, profile_id=body.profileId, owner_user_id=user.id)
    service = RewriteService(db, llm=LLMClient(config=config))
    try:
        return service.start_rewrite(
            article_id=body.articleId, markdown=body.markdown,
            instruction=body.instruction, selected_texts=body.selectedTexts,
            conversation=body.conversation, owner_user_id=user.id, input_images=body.inputImages,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.get("/{run_id}")
def get_agent_run(
    run_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    run = _get_run_or_404(run_id, db)
    _assert_run_owner(run, user)
    return run


@router.post("/{run_id}/stop", status_code=status.HTTP_202_ACCEPTED)
def stop_agent_run(
    run_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    run = _get_run_or_404(run_id, db)
    _assert_run_owner(run, user)
    service = WriterService(db)
    try:
        return service.request_stop(run_id)
    except RunJournalError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.get("/{run_id}/events")
def stream_agent_run_events(
    run_id: str,
    request: Request,
    after: int | None = Query(default=None, ge=0),
    cursor: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    run = _get_run_or_404(run_id, db)
    _assert_run_owner(run, user)

    # after=0 是前端 REST 轮询/补读入口；不传参数保持原有 SSE 语义。
    if after is not None:
        return RunJournal(db).events_after(run_id, after)

    def event_stream() -> Generator[str, None, None]:
        # 独立会话：长连接不占用请求级 session。
        # 注意：MySQL REPEATABLE READ 下长事务首查后的快照不会更新，
        # 必须每轮轮询使用全新会话，否则新建 run 的事件永远不可见。
        from app.db.session import SessionLocal

        try:
            after = max(cursor, int(request.headers.get("last-event-id", "0")))
        except ValueError:
            after = cursor
        deadline = time.monotonic() + _STREAM_MAX_SECONDS
        yield ": stream connected\n\n"
        while True:
            with SessionLocal() as poll_db:
                journal = RunJournal(poll_db)
                events = journal.events_after(run_id, after)
                for event in events:
                    after = event["sequence"]
                    yield f"id: {after}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                run = journal.get_run(run_id)
            if run and run["status"] in _TERMINAL and not events:
                yield f"data: {json.dumps({'type': 'stream.end', 'status': run['status']})}\n\n"
                return
            if time.monotonic() > deadline:
                yield 'data: {"type": "stream.timeout"}\n\n'
                return
            time.sleep(_POLL_SECONDS)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
