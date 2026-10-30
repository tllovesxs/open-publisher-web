"""账号认证 API（fastapi-users）：注册/登录；管理站使用管理员登录。

对外契约保持不变（{username, password} JSON 进、{token, user} JSON 出 +
HttpOnly Cookie），底层改用 fastapi-users 的 UserManager / PasswordHelper /
JWTStrategy。
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import OAuth2PasswordRequestForm

from fastapi_users import exceptions, schemas
from pydantic import BaseModel, Field
from app.core.auth import COOKIE_NAME, get_current_user
from app.core.rate_limit import rate_limit_auth
from app.core.config import get_settings
from app.core.users import (SyncUserDatabase, UserManager, create_access_token, get_user_db, get_user_manager)
from app.models.user import AppUser

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=8, max_length=200)
    displayName: str = Field(default="", max_length=120)


class ProfileUpdateIn(BaseModel):
    model_config = {"extra": "forbid"}
    displayName: str = Field(min_length=1, max_length=120)


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class UserCreate(schemas.BaseUserCreate):
    """fastapi-users 注册模型：登录名沿用 username 语义（存入 email 字段）。"""

    email: str = Field(min_length=3, max_length=80)  # type: ignore[assignment]
    display_name: str = ""


def _user_out(user: AppUser) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "displayName": user.display_name,
        "role": user.role,
        "createdAt": user.created_at.isoformat() if user.created_at else None,
    }


def _set_auth_cookie(response: Response, token: str) -> None:
    secure = get_settings().app_env.lower() in {"production", "prod"}
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=get_settings().access_token_expire_minutes * 60,
        path="/",
    )


async def _issue_login(
    response: Response, user: AppUser, user_db: SyncUserDatabase
) -> dict:
    """签发 fastapi-users JWT 并设置 Cookie；登录时顺带升级旧密码散列。"""
    token = await create_access_token(user)
    _set_auth_cookie(response, token)
    return {"token": token, "user": _user_out(user)}


@router.post("/register", status_code=201, dependencies=[Depends(rate_limit_auth)])
async def register(
    body: RegisterIn,
    response: Response,
    user_manager: UserManager = Depends(get_user_manager),
    user_db: SyncUserDatabase = Depends(get_user_db),
):
    user_create = UserCreate(
        email=body.username.strip(),
        password=body.password,
        display_name=body.displayName.strip() or body.username.strip(),
    )
    try:
        user = await user_manager.create(user_create)
    except exceptions.UserAlreadyExists as exc:
        raise HTTPException(status_code=409, detail="用户名已存在") from exc
    except exceptions.InvalidPasswordException as exc:
        raise HTTPException(status_code=400, detail="密码不符合要求") from exc
    return await _issue_login(response, user, user_db)


async def _authenticate(
    body: LoginIn, user_manager: UserManager
) -> AppUser:
    credentials = OAuth2PasswordRequestForm(username=body.username, password=body.password, scope="")
    try:
        return await user_manager.authenticate(credentials)
    except exceptions.UserNotExists:
        return None


@router.post("/login", dependencies=[Depends(rate_limit_auth)])
async def login(
    body: LoginIn,
    response: Response,
    user_manager: UserManager = Depends(get_user_manager),
    user_db: SyncUserDatabase = Depends(get_user_db),
):
    user = await _authenticate(body, user_manager)
    if user is None:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已停用")
    return await _issue_login(response, user, user_db)


@router.post("/admin/login", dependencies=[Depends(rate_limit_auth)])
async def admin_login(
    body: LoginIn,
    response: Response,
    user_manager: UserManager = Depends(get_user_manager),
    user_db: SyncUserDatabase = Depends(get_user_db),
):
    user = await _authenticate(body, user_manager)
    if user is None:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已停用")
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="该账号没有管理员权限")
    return await _issue_login(response, user, user_db)


@router.get("/me")
def me(request: Request, response: Response, user: AppUser = Depends(get_current_user)):
    # Bearer 登录态访问时同步刷新 HttpOnly Cookie：
    # <img src="/api/media/.../raw"> 无法携带 Authorization 头，只能依赖 Cookie。
    authorization = request.headers.get("authorization", "")
    if authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        if token:
            _set_auth_cookie(response, token)
    return _user_out(user)


@router.patch("/me")
async def update_profile(
    body: ProfileUpdateIn,
    user: AppUser = Depends(get_current_user),
    user_db: SyncUserDatabase = Depends(get_user_db),
):
    display_name = body.displayName.strip()
    if not display_name:
        raise HTTPException(status_code=422, detail="昵称不能为空")
    updated = await user_db.update(user, {"display_name": display_name})
    return _user_out(updated)


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


