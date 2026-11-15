"""fastapi-users 集成：用户数据库适配器、用户管理器与 JWT 策略。

本项目使用同步 SQLAlchemy（pymysql），而官方 SQLAlchemyUserDatabase 仅支持
AsyncSession，因此这里实现一个同步 Session 版 UserDatabase 适配器，其余
（UserManager、PasswordHelper、JWTStrategy）直接复用 fastapi-users。

登录标识沿用现有 `username` 列：fastapi-users 内部以 email 字段指代登录名，
适配器负责 email <-> username 的映射，数据库结构不变。
"""

import uuid
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import Depends
from fastapi_users import BaseUserManager, InvalidID, exceptions, models
from fastapi_users.authentication import JWTStrategy
from fastapi_users.db import BaseUserDatabase
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import password_helper
from app.db.session import get_db
from app.models.user import AppUser


class SyncUserDatabase(BaseUserDatabase[AppUser, str]):
    """基于同步 Session 的 UserDatabase 适配器（email 字段映射 username 列）。"""

    def __init__(self, session: Session) -> None:
        self.session = session

    async def get(self, id: str) -> AppUser | None:
        return self.session.get(AppUser, str(id))

    async def get_by_email(self, email: str) -> AppUser | None:
        return (
            self.session.query(AppUser).filter(AppUser.username == str(email)).first()
        )

    async def get_by_oauth_account(self, oauth: str, account_id: str) -> AppUser | None:
        return None  # 本项目暂无 OAuth 账号关联

    async def create(self, create_dict: dict[str, Any]) -> AppUser:
        data = dict(create_dict)
        username = str(data.pop("email"))
        hashed = data.pop("hashed_password")
        data.setdefault("display_name", username)
        data.setdefault("role", "user")
        data.setdefault("is_active", True)
        data.setdefault("credit_balance", 0)
        user = AppUser(
            id=f"u-{uuid.uuid4().hex[:32]}",
            username=username,
            hashed_password=hashed,
            **data,
        )
        self.session.add(user)
        self.session.commit()
        self.session.refresh(user)
        return user

    async def update(self, user: AppUser, update_dict: dict[str, Any]) -> AppUser:
        for key, value in update_dict.items():
            setattr(user, key, value)
        self.session.commit()
        self.session.refresh(user)
        return user

    async def delete(self, user: AppUser) -> None:
        self.session.delete(user)
        self.session.commit()


async def get_user_db(db: Session = Depends(get_db)) -> AsyncGenerator[SyncUserDatabase, None]:
    yield SyncUserDatabase(db)


class UserManager(BaseUserManager[AppUser, str]):
    """用户管理器：字符串主钥 + 统一密码散列与校验。"""

    reset_password_token_secret = get_settings().auth_jwt_secret
    verification_token_secret = get_settings().auth_jwt_secret

    def parse_id(self, value: Any) -> str:
        try:
            return str(value)
        except ValueError as exc:
            raise InvalidID() from exc


async def get_user_manager(
    user_db: SyncUserDatabase = Depends(get_user_db),
) -> AsyncGenerator[UserManager, None]:
    yield UserManager(user_db, password_helper=password_helper)


def get_jwt_strategy() -> JWTStrategy:
    """访问令牌策略：标准 JWT（HS256），有效期沿用配置。"""
    settings = get_settings()
    return JWTStrategy(
        secret=settings.auth_jwt_secret,
        lifetime_seconds=settings.access_token_expire_minutes * 60,
    )


async def create_access_token(user: AppUser) -> str:
    return await get_jwt_strategy().write_token(user)
