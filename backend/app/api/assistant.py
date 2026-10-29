"""ArticleAssistant API：会话持久化 + 模型档案切换。

- `POST /assistant/chat` 保留无状态入口，兼容旧前端 / 快速调用。
- 会话 API 支持按文章恢复对话、切换模型、清空会话。
- 助手只给建议，不直接修改文章；所有写入仍由编辑器用户操作。
"""

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from openai import OpenAI
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import require_user
from app.db.session import get_db
from app.models.assistant import AssistantMessage, AssistantSession
from app.models.user import AppUser
from app.services.model_profile_service import resolve_llm_profile_config

router = APIRouter(prefix="/assistant", tags=["assistant"])

_SYSTEM = (
    "你是稿流的编辑助手，嵌入在文章编辑器侧边。你只能给建议、回答问题、"
    "帮用户梳理结构与表达；你绝不能声称已经保存、发布或修改了文章，"
    "所有写入都由用户在编辑器里手动完成。回答简洁、具体、可执行。"
)


class AssistantMessageIn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    text: str = Field(max_length=100_000)


class AssistantChatRequest(BaseModel):
    messages: list[AssistantMessageIn] = Field(min_length=1, max_length=40)
    articleContext: str | None = Field(default=None, max_length=200_000)
    profileId: str | None = Field(default=None, max_length=64)
    mode: str = Field(default="chat", pattern="^(chat|rewrite)$")
    attachments: list[str] = Field(default_factory=list, max_length=4)


class AssistantSessionCreateRequest(BaseModel):
    articleId: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=200)


class AssistantSessionChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=100_000)
    articleContext: str | None = Field(default=None, max_length=200_000)
    profileId: str | None = Field(default=None, max_length=64)
    mode: str = Field(default="chat", pattern="^(chat|rewrite)$")
    attachments: list[str] = Field(default_factory=list, max_length=4)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _session_out(db: Session, session: AssistantSession) -> dict:
    messages = db.scalars(
        select(AssistantMessage)
        .where(AssistantMessage.session_id == session.id)
        .order_by(AssistantMessage.created_at.asc())
    ).all()
    return {
        "id": session.id,
        "articleId": session.article_id,
        "title": session.title,
        "activeProfileId": session.active_profile_id,
        "messages": [
            {"id": message.id, "role": message.role, "text": message.content,
             "profileId": message.profile_id, "createdAt": message.created_at.isoformat()}
            for message in messages
        ],
        "createdAt": session.created_at.isoformat(),
        "updatedAt": session.updated_at.isoformat(),
    }


def _owned_session(db: Session, session_id: str, user: AppUser) -> AssistantSession:
    session = db.get(AssistantSession, session_id)
    if session is None or (
        session.owner_user_id is not None and session.owner_user_id != user.id
    ):
        raise HTTPException(status_code=404, detail={"code": "ASSISTANT_SESSION_NOT_FOUND"})
    return session


_REWRITE_INSTRUCTION = (
    "\n\n当前处于片段改写模式：最后一条用户消息包含对选中片段的改写要求。"
    "只输出改写后的片段正文本身：不要解释、不要引号、不要 Markdown 代码块围栏。"
)


def _llm_reply(
    db: Session,
    *,
    user: AppUser,
    history: list[AssistantMessage],
    article_context: str | None,
    profile_id: str | None,
    mode: str = "chat",
    attachments: list[str] | None = None,
) -> tuple[str, dict]:
    config = resolve_llm_profile_config(
        db, profile_id=profile_id, owner_user_id=user.id,
    )
    system = _SYSTEM
    if article_context:
        system += "\n\n当前文章全文（只作上下文）：\n---\n" + article_context[:120_000] + "\n---"
    if mode == "rewrite":
        system += _REWRITE_INSTRUCTION
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for message in history[-20:]:
        messages.append({
            "role": "assistant" if message.role == "assistant" else "user",
            "content": message.content,
        })
    client = OpenAI(
        api_key=config["api_key"] or "sk-not-configured",
        base_url=config["base_url"],
        timeout=config["timeout_seconds"],
    )
    if attachments:
        capabilities = config.get("capabilities") or {}
        if not capabilities.get("vision"):
            raise HTTPException(status_code=400, detail="当前模型档案未开启图片理解能力。")
        parts: list[dict[str, Any]] = [{"type": "text", "text": messages[-1]["content"] if messages else ""}]
        for data_url in attachments:
            if not data_url.startswith("data:image/"):
                raise HTTPException(status_code=400, detail="附件必须是图片 dataURL。")
            parts.append({"type": "image_url", "image_url": {"url": data_url}})
        if messages[-1]["role"] == "user":
            messages[-1]["content"] = parts
        else:
            raise HTTPException(status_code=400, detail="图片附件需要随用户消息发送。")
    try:
        response = client.chat.completions.create(
            model=config["model"], messages=messages, temperature=0.6,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"助手调用失败：{exc}") from None
    reply = response.choices[0].message.content or ""
    return reply, config


def _save_message(
    db: Session, *, session_id: str, role: str, content: str,
    profile_id: str | None = None,
) -> None:
    db.add(AssistantMessage(
        id=uuid.uuid4().hex, session_id=session_id, role=role,
        content=content[:100_000], profile_id=profile_id, created_at=_now(),
    ))


@router.post("/chat")
def assistant_chat(
    body: AssistantChatRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """兼容旧前端的无状态调用；不落库。"""
    history = [
        AssistantMessage(id="local", role=message.role, content=message.text)
        for message in body.messages
    ]
    reply, config = _llm_reply(
        db, user=user, history=history,
        article_context=body.articleContext, profile_id=body.profileId,
        mode=body.mode, attachments=body.attachments,
    )
    return {
        "reply": reply,
        "profileId": config["profileId"],
        "profileName": config["profileName"],
        "persisted": False,
    }


@router.get("/sessions")
def list_assistant_sessions(
    articleId: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    query = select(AssistantSession).where(AssistantSession.owner_user_id == user.id)
    if articleId:
        query = query.where(AssistantSession.article_id == articleId)
    rows = db.scalars(query.order_by(AssistantSession.updated_at.desc())).all()
    return {"sessions": [_session_out(db, row) for row in rows]}


@router.post("/sessions", status_code=201)
def create_assistant_session(
    body: AssistantSessionCreateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    row = AssistantSession(
        id=uuid.uuid4().hex,
        article_id=body.articleId,
        owner_user_id=user.id,
        title=(body.title or "编辑助手").strip()[:200],
        created_at=_now(), updated_at=_now(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _session_out(db, row)


@router.get("/sessions/{session_id}")
def get_assistant_session(
    session_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    return _session_out(db, _owned_session(db, session_id, user))


@router.post("/sessions/{session_id}/chat")
def chat_with_assistant_session(
    session_id: str,
    body: AssistantSessionChatRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    session = _owned_session(db, session_id, user)
    _save_message(db, session_id=session.id, role="user", content=body.message)
    if body.profileId:
        session.active_profile_id = body.profileId
    db.commit()
    db.refresh(session)
    history = db.scalars(
        select(AssistantMessage)
        .where(AssistantMessage.session_id == session.id)
        .order_by(AssistantMessage.created_at.asc())
    ).all()
    reply, config = _llm_reply(
        db, user=user, history=history,
        article_context=body.articleContext or None,
        profile_id=body.profileId or session.active_profile_id,
        mode=body.mode, attachments=body.attachments,
    )
    _save_message(
        db, session_id=session.id, role="assistant", content=reply,
        profile_id=config["profileId"],
    )
    session.updated_at = _now()
    db.commit()
    return {
        **_session_out(db, session),
        "reply": reply,
        "profileId": config["profileId"],
        "profileName": config["profileName"],
        "persisted": True,
    }


@router.delete("/sessions/{session_id}", status_code=204)
def delete_assistant_session(
    session_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    session = _owned_session(db, session_id, user)
    db.delete(session)
    db.commit()
    return None
