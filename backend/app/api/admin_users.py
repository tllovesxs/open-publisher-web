"""Administrator user directory and audited account controls."""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.security import password_helper
from app.db.session import get_db
from app.core.auth import require_admin
from app.models.agent_runtime import AgentRun
from app.models.article import Article
from app.models.media import MediaAsset
from app.models.usage import UsageEvent
from app.models.user import AppUser
from app.services.usage import audit

router = APIRouter(prefix="/admin/users", tags=["admin-users"])


class UserCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=3, max_length=80)
    displayName: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=200, repr=False)
    role: str = Field(default="user", pattern="^(user|admin)$")


class UserUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    displayName: str | None = Field(default=None, min_length=1, max_length=120)
    role: str | None = Field(default=None, pattern="^(user|admin)$")
    isActive: bool | None = None


class PasswordResetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=8, max_length=200, repr=False)


def _user_summary(row, metrics: dict | None = None) -> dict:
    metrics = metrics or {}
    return {
        "id": row.id,
        "username": row.username,
        "displayName": row.display_name,
        "role": row.role,
        "isActive": row.is_active,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "lastLoginAt": row.last_login_at.isoformat() if row.last_login_at else None,
        "usageCalls": int(metrics.get("calls") or 0),
        "inputTokens": int(metrics.get("input") or 0),
        "outputTokens": int(metrics.get("output") or 0),
    }


@router.get("")
def list_users(
    q: str | None = Query(default=None, max_length=160),
    role: str | None = Query(default=None, pattern="^(user|admin)$"),
    status: str | None = Query(default=None, pattern="^(active|disabled)$"),
    page: int = Query(default=1, ge=1),
    perPage: int = Query(default=20, ge=1, le=100),
    sort: str = Query(default="created_desc", pattern="^(created_desc|created_asc|last_login_desc|username_asc)$"),
    db: Session = Depends(get_db),
):
    query = select(AppUser)
    if q and q.strip():
        needle = f"%{q.strip()}%"
        query = query.where(or_(AppUser.username.ilike(needle), AppUser.display_name.ilike(needle)))
    if role:
        query = query.where(AppUser.role == role)
    if status == "active":
        query = query.where(AppUser.is_active.is_(True))
    elif status == "disabled":
        query = query.where(AppUser.is_active.is_(False))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    ordering = {
        "created_desc": AppUser.created_at.desc(),
        "created_asc": AppUser.created_at.asc(),
        "last_login_desc": AppUser.last_login_at.desc(),
        "username_asc": AppUser.username.asc(),
    }[sort]
    rows = db.scalars(query.order_by(ordering, AppUser.id.asc()).offset((page - 1) * perPage).limit(perPage)).all()
    ids = [row.id for row in rows]
    metrics = {}
    if ids:
        for user_id, calls, input_tokens, output_tokens in db.execute(
            select(UsageEvent.user_id, func.count(UsageEvent.id), func.sum(UsageEvent.input_tokens), func.sum(UsageEvent.output_tokens))
            .where(UsageEvent.user_id.in_(ids)).group_by(UsageEvent.user_id)
        ):
            metrics[user_id] = {"calls": calls, "input": input_tokens, "output": output_tokens}
    return {"users": [_user_summary(row, metrics.get(row.id)) for row in rows], "page": page, "perPage": perPage, "total": total, "pages": max(1, (total + perPage - 1) // perPage)}


@router.post("", status_code=201)
def create_user(body: UserCreateIn, db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    username = body.username.strip()
    if db.scalar(select(AppUser.id).where(AppUser.username == username)):
        raise HTTPException(status_code=409, detail="用户名已存在")
    row = AppUser(
        id=f"u-{uuid4().hex[:32]}", username=username,
        display_name=body.displayName.strip(), hashed_password=password_helper.hash(body.password),
        role=body.role, is_active=True,
    )
    db.add(row)
    audit(db, actor_user_id=admin.id, action="user.create", subject_type="user", subject_id=row.id, changes={"role": row.role, "isActive": True})
    db.commit()
    db.refresh(row)
    return _user_summary(row)


@router.get("/{user_id}")
def get_user(user_id: str, db: Session = Depends(get_db)):
    row = db.get(AppUser, user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    totals = db.execute(
        select(func.count(UsageEvent.id), func.sum(UsageEvent.input_tokens), func.sum(UsageEvent.output_tokens), func.sum(UsageEvent.image_count))
        .where(UsageEvent.user_id == user_id)
    ).one()
    articles = db.scalar(select(func.count()).select_from(Article).where(Article.owner_user_id == user_id)) or 0
    media = db.scalar(select(func.count()).select_from(MediaAsset).where(MediaAsset.owner_user_id == user_id)) or 0
    runs = db.scalar(select(func.count()).select_from(AgentRun).where(AgentRun.owner_user_id == user_id)) or 0
    recent = db.execute(
        select(UsageEvent, AppUser.username, AppUser.display_name)
        .join(AppUser, AppUser.id == UsageEvent.user_id)
        .where(UsageEvent.user_id == user_id)
        .order_by(UsageEvent.created_at.desc()).limit(12)
    ).all()
    from app.api.admin_usage import _usage_out
    return {
        "user": _user_summary(row, {"calls": totals[0], "input": totals[1], "output": totals[2]}),
        "stats": {"calls": int(totals[0] or 0), "inputTokens": int(totals[1] or 0), "outputTokens": int(totals[2] or 0), "images": int(totals[3] or 0), "articles": articles, "runs": runs, "media": media},
        "recentUsage": [_usage_out(event, row.username, row.display_name) for event, _, _ in recent],
    }


@router.patch("/{user_id}")
def update_user(user_id: str, body: UserUpdateIn, db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    row = db.get(AppUser, user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    changes = body.model_dump(exclude_unset=True)
    if user_id == admin.id and changes.get("isActive") is False:
        raise HTTPException(status_code=409, detail="不能停用当前管理员账号")
    if user_id == admin.id and changes.get("role") == "user":
        raise HTTPException(status_code=409, detail="不能移除当前管理员权限")
    if changes.get("isActive") is False and row.role == "admin" and db.scalar(select(func.count()).select_from(AppUser).where(AppUser.role == "admin", AppUser.is_active.is_(True))) <= 1:
        raise HTTPException(status_code=409, detail="至少保留一个可用管理员账号")
    if "displayName" in changes and changes["displayName"] is not None:
        row.display_name = changes["displayName"].strip()
        if not row.display_name:
            raise HTTPException(status_code=422, detail="显示名称不能为空")
    if "role" in changes and changes["role"] is not None:
        row.role = changes["role"]
    if "isActive" in changes and changes["isActive"] is not None:
        row.is_active = changes["isActive"]
    audit(db, actor_user_id=admin.id, action="user.update", subject_type="user", subject_id=row.id, changes={"fields": {key: value for key, value in changes.items() if key != "password"}})
    db.commit()
    db.refresh(row)
    return _user_summary(row)


@router.post("/{user_id}/password", status_code=204)
def reset_password(user_id: str, body: PasswordResetIn, db: Session = Depends(get_db), admin: AppUser = Depends(require_admin)):
    row = db.get(AppUser, user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    row.hashed_password = password_helper.hash(body.password)
    audit(db, actor_user_id=admin.id, action="user.password_reset", subject_type="user", subject_id=row.id, changes={})
    db.commit()
    return None
