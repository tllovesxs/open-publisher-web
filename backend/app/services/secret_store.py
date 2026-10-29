"""密钥存储服务：app_secrets 表读写 + 审计。

本模块只负责加密存取与审计。解密失败（主密钥不匹配）返回 None
并记日志，让业务按"未配置"处理，而不是让整条链路 500。
"""

import logging
from datetime import datetime

from sqlalchemy.orm import Session

from app.core import secret_box
from app.models.app_secret import AppSecret, SecretAudit

logger = logging.getLogger(__name__)

# 秘密 id 常量（秘密 id 约定见 app.models.app_secret 模块注释）
SECRET_ID_LLM_GLOBAL = "llm:global"
SECRET_ID_IMAGE_GLOBAL = "image:global"


def profile_secret_id(profile_id: str) -> str:
    return f"profile:{profile_id}"


def set_secret(
    db: Session,
    secret_id: str,
    plaintext: str,
    *,
    actor: str | None = None,
    commit: bool = True,
) -> AppSecret:
    """加密入库/更新，并写审计。key_version 自增便于轮换排查。"""
    row = db.get(AppSecret, secret_id)
    if row is None:
        row = AppSecret(id=secret_id)
        db.add(row)
    row.ciphertext = secret_box.encrypt(plaintext)
    row.key_hint = secret_box.mask(plaintext)
    row.key_version = (row.key_version or 0) + 1
    row.updated_by = actor
    row.updated_at = datetime.now()
    db.add(SecretAudit(secret_id=secret_id, action="set", actor=actor))
    if commit:
        db.commit()
        db.refresh(row)
    else:
        db.flush()
    return row


def get_secret(db: Session, secret_id: str) -> str | None:
    """解密取值；未配置或解密失败返回 None（调用方按未配置处理）。"""
    row = db.get(AppSecret, secret_id)
    if row is None:
        return None
    try:
        return secret_box.decrypt(row.ciphertext)
    except secret_box.SecretBoxError:
        logger.exception("app_secrets[%s] 解密失败，按未配置处理", secret_id)
        return None


def get_secret_meta(db: Session, secret_id: str) -> dict | None:
    """取掩码提示与版本（不下发明文）。"""
    row = db.get(AppSecret, secret_id)
    if row is None:
        return None
    return {"keyHint": row.key_hint, "keyVersion": row.key_version}


def delete_secret(db: Session, secret_id: str, *, actor: str | None = None, commit: bool = True) -> bool:
    """删除秘密并写审计。返回是否真的删了。"""
    row = db.get(AppSecret, secret_id)
    if row is None:
        return False
    db.delete(row)
    db.add(SecretAudit(secret_id=secret_id, action="delete", actor=actor))
    if commit:
        db.commit()
    else:
        db.flush()
    return True
