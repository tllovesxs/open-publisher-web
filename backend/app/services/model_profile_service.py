"""模型档案服务：多 profile 解析（蓝本 model-profile + secret-provider 的 Web 等价）。

企业级密钥约定（2026-10-27 起生效）：
- API Key 只存 app_secrets 表，Fernet 信封加密；
- 不再使用 LLM_API_KEY / IMAGE_API_KEY 等环境变量回退；
- 明文永不入库、永不回显前端（管理端只见掩码尾号 keyHint）。
"""

import uuid

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.settings_profile import ImageConfig, ModelProfile
from app.services.secret_store import (
    SECRET_ID_IMAGE_GLOBAL,
    SECRET_ID_LLM_GLOBAL,
    get_secret,
    get_secret_meta,
    profile_secret_id,
)


def get_active_profile(db: Session, owner_user_id: str | None = None) -> ModelProfile | None:
    """当前激活档案；模型档案为管理端统一配置的共享资源，不按创建者隔离。"""
    del owner_user_id  # 兼容旧签名：历史上按创建者过滤，现改为全局共享
    return (
        db.query(ModelProfile)
        .filter(ModelProfile.is_default.is_(True))
        .order_by(ModelProfile.created_at.desc())
        .first()
    )


def _none_key() -> tuple[str, str]:
    return "none", ""


def _base_llm_config() -> dict:
    settings = get_settings()
    return {
        "profileId": None,
        "profileName": None,
        "api_key": "",
        "keySource": "none",
        "keyHint": "",
        "base_url": settings.llm_base_url,
        "model": settings.llm_model,
        "timeout_seconds": settings.llm_timeout_seconds,
    }


def _with_db_key(config: dict, db: Session) -> dict:
    meta = get_secret_meta(db, SECRET_ID_LLM_GLOBAL) or {}
    key = get_secret(db, SECRET_ID_LLM_GLOBAL)
    if key:
        config.update(
            {
                "api_key": key,
                "keySource": "db",
                "keyHint": meta.get("keyHint", ""),
            }
        )
    return config


def resolve_llm_config() -> dict:
    """解析当前生效的 LLM 配置；档案级密钥 > 全局数据库密钥。"""
    config = _base_llm_config()
    try:
        with SessionLocal() as db:
            profile = get_active_profile(db)
            if profile is None:
                return _with_db_key(config, db)
            return _with_db_key(
                _with_profile(config, db, profile),
                db,
            )
    except Exception:  # noqa: BLE001 - 表不存在等场景按未配置处理
        return config


def _with_profile(config: dict, db: Session, profile: ModelProfile) -> dict:
    pid = profile_secret_id(profile.id)
    profile_meta = get_secret_meta(db, pid) or {}
    profile_key = get_secret(db, pid)
    if profile_key:
        key_source, key_hint = "db", profile_meta.get("keyHint", "")
    else:
        key_source, key_hint = _none_key()
    config.update(
        {
            "profileId": profile.id,
            "profileName": profile.name,
            "api_key": profile_key or "",
            "keySource": key_source,
            "keyHint": key_hint,
            "base_url": profile.base_url,
            "model": profile.model_id,
            "timeout_seconds": profile.timeout_seconds,
            "capabilities": profile.capabilities or {},
        }
    )
    return config


def resolve_llm_profile_config(
    db: Session,
    *,
    profile_id: str | None,
    owner_user_id: str | None = None,
) -> dict:
    """按用户可用档案解析模型；profile_id 为空则回退全局激活档案。"""
    del owner_user_id
    config = _base_llm_config()
    if not profile_id:
        active = get_active_profile(db)
        profile_id = active.id if active else None
    if not profile_id:
        return _with_db_key(config, db)
    profile = db.get(ModelProfile, profile_id)
    if profile is None:
        return config
    config = _with_profile(config, db, profile)
    if not config["api_key"]:
        return _with_db_key(config, db)
    return config


def preferred_profile_id(db: Session, preferences: dict, node_id: str | None = None) -> str | None:
    """环节优先于个人默认；管理员删除档案后继续回退可用默认。"""
    candidates = [(preferences.get("nodeProfileIds") or {}).get(node_id), preferences.get("profileId")]
    return next((value for value in candidates if value and db.get(ModelProfile, value) is not None), None)


def create_profile(
    db: Session,
    *,
    name: str,
    base_url: str,
    model_id: str,
    provider: str = "custom",
    timeout_seconds: int = 120,
    is_default: bool = False,
    owner_user_id: str | None = None,
) -> ModelProfile:
    if is_default:
        db.query(ModelProfile).update({ModelProfile.is_default: False})
    profile = ModelProfile(
        id=f"mp-{uuid.uuid4().hex[:32]}",
        name=name,
        provider=provider,
        base_url=base_url,
        model_id=model_id,
        timeout_seconds=timeout_seconds,
        is_default=is_default,
        owner_user_id=owner_user_id,
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


IMAGE_CONFIG_ID = "global"


def get_image_config(db: Session) -> ImageConfig | None:
    return db.get(ImageConfig, IMAGE_CONFIG_ID)


def resolve_image_config(
    db: Session | None = None,
    *,
    profile_id: str | None = None,
) -> dict:
    """解析生图配置；密钥只取数据库（生图密钥 > 文本模型密钥）。

    profile_id 非空时优先取对应配置行；行不存在时回退全局默认行。
    """
    settings = get_settings()
    config = {
        "api_key": "",
        "keySource": "none",
        "keyHint": "",
        "base_url": settings.image_base_url or settings.llm_base_url,
        "model": settings.image_model,
        "timeout_seconds": settings.image_timeout_seconds or settings.llm_timeout_seconds,
        "source": "fallback",
        "profileId": None,
    }
    try:
        if db is None:
            with SessionLocal() as session:
                row = session.get(ImageConfig, profile_id or IMAGE_CONFIG_ID)
                if row is None and profile_id:
                    row = session.get(ImageConfig, IMAGE_CONFIG_ID)
                _apply_image_row(config, session, row)
        else:
            row = db.get(ImageConfig, profile_id or IMAGE_CONFIG_ID)
            if row is None and profile_id:
                row = db.get(ImageConfig, IMAGE_CONFIG_ID)
            _apply_image_row(config, db, row)
    except Exception:  # noqa: BLE001 - 表不存在等场景按未配置处理
        return config
    return config


def _apply_image_row(config: dict, db: Session, row: ImageConfig | None) -> None:
    """把数据库生图配置行叠加进 config（密钥只取 app_secrets）。"""
    if row is not None:
        config.update(
            {
                "base_url": row.base_url,
                "model": row.model_id,
                "timeout_seconds": row.timeout_seconds,
                "source": "db",
                "profileId": row.id,
            }
        )

    image_meta = get_secret_meta(db, SECRET_ID_IMAGE_GLOBAL) or {}
    image_key = get_secret(db, SECRET_ID_IMAGE_GLOBAL)
    if image_key:
        config.update(
            {
                "api_key": image_key,
                "keySource": "db",
                "keyHint": image_meta.get("keyHint", ""),
            }
        )
        return

    llm_meta = get_secret_meta(db, SECRET_ID_LLM_GLOBAL) or {}
    llm_key = get_secret(db, SECRET_ID_LLM_GLOBAL)
    if llm_key:
        config.update(
            {
                "api_key": llm_key,
                "keySource": "db",
                "keyHint": llm_meta.get("keyHint", ""),
            }
        )
