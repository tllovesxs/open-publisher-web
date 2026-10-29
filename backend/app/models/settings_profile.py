"""模型档案：蓝本 TextModelProfile / model-profile.ts 的 Web 版。

API Key 不存模型档案表，统一加密存入 app_secrets；
档案只承载 API 地址、模型、超时等非敏感配置。
"""

from sqlalchemy import Boolean, DateTime, Integer, String, JSON, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ModelProfile(Base):
    __tablename__ = "model_profiles"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    provider: Mapped[str] = mapped_column(String(80), nullable=False, default="custom")
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    model_id: Mapped[str] = mapped_column(String(200), nullable=False)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=120)
    capabilities: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[object] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP"), nullable=False
    )


class ImageConfig(Base):
    """生图模型配置：兼容旧 global 行，并保存各命名配置；默认选择存于 WorkspacePreference。

    API Key 同样只存 app_secrets；本行只保存 API 地址、模型、超时。
    """

    __tablename__ = "image_configs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    model_id: Mapped[str] = mapped_column(String(200), nullable=False)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=180)
    updated_at: Mapped[object] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP"), nullable=False
    )


class WorkspacePreference(Base):
    __tablename__ = "workspace_preferences"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
