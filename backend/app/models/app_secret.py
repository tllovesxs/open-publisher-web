"""企业级密钥存储模型：密文入库（app_secrets）+ 变更审计（app_secret_audit）。

秘密 id 约定：
- ``llm:global``        全局文本 LLM 密钥全局文本模型密钥
- ``image:global``      全局生图密钥全局生图密钥
- ``profile:<id>``      模型档案级密钥（ModelProfile.id）
- ``model-config:<kind>:<id>`` 生图、嵌入和排序的独立配置密钥
- ``integration:<kind>`` 集成密钥（tavily / github 等）

表里只有 Fernet 密文与掩码尾号，明文永不落库、不下发前端。
"""

from sqlalchemy import DateTime, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AppSecret(Base):
    __tablename__ = "app_secrets"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    key_hint: Mapped[str] = mapped_column(String(16), nullable=False, default="")
    key_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[object] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP"), nullable=False
    )


class SecretAudit(Base):
    """密钥变更审计：谁在何时设置/删除了哪个秘密（不记录明文与密文）。"""

    __tablename__ = "app_secret_audit"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    secret_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(20), nullable=False)  # set / delete
    actor: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[object] = mapped_column(
        DateTime, server_default=text("CURRENT_TIMESTAMP"), nullable=False
    )
