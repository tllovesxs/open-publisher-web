"""设置 API：模型档案管理 + 密钥加密存储 + 连通性测试与模型列表发现。

蓝本 model-profile / model-test-service / model-discovery 的 Web 版：
- 多 profile 增删改查与激活（is_default）
- 企业级密钥存储（2026-10-27 起）：API Key 密文入库 app_secrets（Fernet 信封加密，
  主密钥走 SECRET_ENCRYPTION_KEY 环境变量），无环境变量密钥回退；
  密钥明文永不入库、永不回显前端，管理端只见掩码尾号 keyHint
- test / discover 使用当前激活 profile（无则回退全局配置）
"""

import time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core import secret_box
from app.core.auth import require_admin, require_user
from app.db.session import get_db
from app.models.user import AppUser
from app.models.settings_profile import ModelProfile
from app.services import secret_store
from app.services.model_profile_service import get_active_profile, resolve_llm_config

router = APIRouter(prefix="/settings", tags=["settings"])


class ModelCapabilities(BaseModel):
    contextWindow: int = Field(default=128000, ge=1024, le=4000000)
    maxTokens: int = Field(default=16384, ge=256, le=200000)
    thinkingLevel: Literal["auto", "off", "low", "medium", "high"] = "auto"
    vision: bool = False
    reasoning: bool = False


class ProfileCreate(BaseModel):
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)
    name: str = Field(min_length=1, max_length=120)
    provider: str = "custom"
    baseUrl: str = Field(min_length=1, max_length=500)
    modelId: str = Field(min_length=1, max_length=200)
    timeoutSeconds: int = Field(default=120, ge=1, le=1800)
    isDefault: bool = False
    apiKey: str | None = Field(default=None, min_length=4, max_length=4096, repr=False)


class ProfileUpdate(BaseModel):
    capabilities: ModelCapabilities | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    provider: str | None = None
    baseUrl: str | None = Field(default=None, min_length=1, max_length=500)
    modelId: str | None = Field(default=None, min_length=1, max_length=200)
    timeoutSeconds: int | None = Field(default=None, ge=1, le=1800)
    isDefault: bool | None = None
    apiKey: str | None = Field(default=None, min_length=4, max_length=4096, repr=False)


class KeyPayload(BaseModel):
    """密钥录入：明文只在请求体里出现一次，入库即加密，永不回显。"""

    apiKey: str = Field(min_length=4, max_length=4096)


def _owned_profile(db: Session, profile_id: str, user: AppUser) -> ModelProfile | None:
    """模型档案为共享资源，这里仅做存在性校验（user 保留以兼容签名/权限依赖）。"""
    del user
    profile = db.get(ModelProfile, profile_id)
    return profile


def _save_profile_credential(db: Session, profile_id: str, value: str | None, actor: str) -> None:
    if value is None:
        return
    if len(value.strip()) < 4:
        raise HTTPException(status_code=400, detail="密钥长度至少 4 位")
    try:
        secret_store.set_secret(db, secret_store.profile_secret_id(profile_id), value.strip(), actor=actor, commit=False)
    except secret_box.SecretBoxError:
        raise HTTPException(status_code=503, detail="密钥加密服务不可用，请检查主密钥配置") from None


def _profile_key_fields(db: Session, profile: ModelProfile) -> dict:
    """profile 密钥状态：只读取数据库密文（只返回掩码）。"""
    meta = secret_store.get_secret_meta(db, secret_store.profile_secret_id(profile.id))
    if meta is not None:
        return {
            "keyConfigured": True,
            "keySource": "db",
            "keyHint": meta.get("keyHint", ""),
        }
    return {"keyConfigured": False, "keySource": "none", "keyHint": ""}


def _profile_out(profile: ModelProfile, db: Session) -> dict:
    key = _profile_key_fields(db, profile)
    return {
        "capabilities": ModelCapabilities(**(profile.capabilities or {})).model_dump(),
        "id": profile.id,
        "name": profile.name,
        "provider": profile.provider,
        "baseUrl": profile.base_url,
        "modelId": profile.model_id,
        "timeoutSeconds": profile.timeout_seconds,
        "isDefault": profile.is_default,
        "createdAt": profile.created_at.isoformat() if profile.created_at else None,
        "ownerId": profile.owner_user_id,
        **key,
    }


@router.get("/model")
def model_status(db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    resolved = resolve_llm_config()
    return {
        "baseUrl": resolved["base_url"],
        "model": resolved["model"],
        "keyConfigured": bool(resolved["api_key"]),
        "keySource": resolved.get("keySource", "none"),
        "keyHint": resolved.get("keyHint", ""),
        "timeoutSeconds": resolved["timeout_seconds"],
        "profileId": resolved["profileId"],
        "profileName": resolved["profileName"],
    }


@router.get("/image", dependencies=[Depends(require_admin)])
def image_status(db: Session = Depends(get_db)):
    """管理端生图配置状态（API Key 只取数据库密文）。"""
    return _image_out(db)


@router.get("/image-models")
def list_image_models(db: Session = Depends(get_db)):
    from app.services.customer_models import available_models
    return available_models(db, "image")


@router.get("/available-models", dependencies=[Depends(require_user)])
def list_available_models(db: Session = Depends(get_db)):
    from app.services.customer_models import KINDS, available_models
    return {kind: available_models(db, kind) for kind in KINDS}


@router.get("/profiles")
def list_profiles(db: Session = Depends(get_db)):
    # 模型档案由管理端统一配置，是平台共享资源：免登录可读（只读，不含密钥明文），增删改仍仅管理员。
    profiles = db.query(ModelProfile).order_by(ModelProfile.created_at.desc()).all()
    return {"profiles": [_profile_out(p, db) for p in profiles]}


@router.post("/profiles", status_code=201, dependencies=[Depends(require_admin)])
def create_profile(
    body: ProfileCreate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    exists = db.query(ModelProfile).filter(
        ModelProfile.name == body.name,
        ModelProfile.owner_user_id.is_(None),
    ).first()
    if exists:
        raise HTTPException(status_code=409, detail="同名模型档案已存在")
    # 第一个档案自动成为默认，避免空默认状态
    is_default = body.isDefault or not db.query(ModelProfile).filter(
        ModelProfile.owner_user_id.is_(None),
    ).first()
    profile = ModelProfile(
        id=f"mp-{uuid.uuid4().hex[:32]}",
        name=body.name,
        provider=body.provider,
        base_url=body.baseUrl,
        model_id=body.modelId,
        timeout_seconds=body.timeoutSeconds,
        capabilities=body.capabilities.model_dump(),
        is_default=is_default,
        owner_user_id=None,  # 管理端配置的平台共享档案，全部用户可见可用
    )
    if is_default:
        db.query(ModelProfile).filter(ModelProfile.owner_user_id.is_(None)).update(
            {ModelProfile.is_default: False},
        )
    db.add(profile)
    _save_profile_credential(db, profile.id, body.apiKey, user.id)
    db.commit()
    db.refresh(profile)
    return _profile_out(profile, db)


@router.patch("/profiles/{profile_id}", dependencies=[Depends(require_admin)])
def update_profile(
    profile_id: str,
    body: ProfileUpdate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    profile = _owned_profile(db, profile_id, user)
    if profile is None:
        raise HTTPException(status_code=404, detail="模型档案不存在")
    data = body.model_dump(exclude_unset=True)
    if data.get("isDefault"):
        db.query(ModelProfile).filter(ModelProfile.owner_user_id.is_(None)).update(
            {ModelProfile.is_default: False},
        )
    mapping = {
        "capabilities": "capabilities",
        "name": "name",
        "provider": "provider",
        "baseUrl": "base_url",
        "modelId": "model_id",
        "timeoutSeconds": "timeout_seconds",
        "isDefault": "is_default",
    }
    for key, column in mapping.items():
        if key in data and data[key] is not None:
            setattr(profile, column, data[key])
    _save_profile_credential(db, profile.id, body.apiKey, user.id)
    db.commit()
    db.refresh(profile)
    return _profile_out(profile, db)


@router.post("/profiles/{profile_id}/activate", dependencies=[Depends(require_admin)])
def activate_profile(
    profile_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    profile = _owned_profile(db, profile_id, user)
    if profile is None:
        raise HTTPException(status_code=404, detail="模型档案不存在")
    db.query(ModelProfile).filter(ModelProfile.owner_user_id.is_(None)).update(
        {ModelProfile.is_default: False},
    )
    profile.is_default = True
    db.commit()
    return _profile_out(profile, db)


@router.delete("/profiles/{profile_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_profile(
    profile_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    profile = _owned_profile(db, profile_id, user)
    if profile is None:
        raise HTTPException(status_code=404, detail="模型档案不存在")
    was_default = profile.is_default
    secret_store.delete_secret(db, secret_store.profile_secret_id(profile.id), actor=user.id, commit=False)
    db.delete(profile)
    db.commit()
    if was_default:
        remaining = db.query(ModelProfile).order_by(ModelProfile.created_at.desc()).first()
        if remaining:
            remaining.is_default = True
            db.commit()
    return None


# ---------- 密钥管理（DB 加密存储；主密钥走 SECRET_ENCRYPTION_KEY 环境变量） ----------


def _key_status_out(db: Session, secret_id: str) -> dict:
    meta = secret_store.get_secret_meta(db, secret_id)
    if meta is not None:
        return {
            "keyConfigured": True,
            "keySource": "db",
            "keyHint": meta.get("keyHint", ""),
            "keyVersion": meta.get("keyVersion"),
        }
    return {"keyConfigured": False, "keySource": "none", "keyHint": "", "keyVersion": None}


@router.put("/llm/key", dependencies=[Depends(require_admin)])
def set_llm_key(
    body: KeyPayload,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """录入/更新全局 LLM 密钥（加密入库，覆盖 llm:global）。"""
    secret_store.set_secret(
        db, secret_store.SECRET_ID_LLM_GLOBAL, body.apiKey.strip(), actor=user.id
    )
    return _key_status_out(db, secret_store.SECRET_ID_LLM_GLOBAL)


@router.delete("/llm/key", dependencies=[Depends(require_admin)])
def delete_llm_key(
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """删除全局 LLM 密钥（后续只能重新录入）。"""
    secret_store.delete_secret(db, secret_store.SECRET_ID_LLM_GLOBAL, actor=user.id)
    return _key_status_out(db, secret_store.SECRET_ID_LLM_GLOBAL)


@router.put("/profiles/{profile_id}/key", dependencies=[Depends(require_admin)])
def set_profile_key(
    profile_id: str,
    body: KeyPayload,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """录入/更新档案级密钥（加密入库，优先级高于全局数据库密钥）。"""
    profile = _owned_profile(db, profile_id, user)
    if profile is None:
        raise HTTPException(status_code=404, detail="模型档案不存在")
    secret_store.set_secret(
        db, secret_store.profile_secret_id(profile.id), body.apiKey.strip(), actor=user.id
    )
    return _key_status_out(db, secret_store.profile_secret_id(profile.id))


@router.delete("/profiles/{profile_id}/key", dependencies=[Depends(require_admin)])
def delete_profile_key(
    profile_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """删除档案级密钥（后续回退全局数据库密钥）。"""
    profile = _owned_profile(db, profile_id, user)
    if profile is None:
        raise HTTPException(status_code=404, detail="模型档案不存在")
    secret_store.delete_secret(db, secret_store.profile_secret_id(profile.id), actor=user.id)
    return _key_status_out(db, secret_store.profile_secret_id(profile.id))


@router.put("/image/key", dependencies=[Depends(require_admin)])
def set_image_key(
    body: KeyPayload,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """录入/更新全局生图密钥（加密入库，覆盖 image:global）。"""
    secret_store.set_secret(
        db, secret_store.SECRET_ID_IMAGE_GLOBAL, body.apiKey.strip(), actor=user.id
    )
    return _key_status_out(db, secret_store.SECRET_ID_IMAGE_GLOBAL)


@router.delete("/image/key", dependencies=[Depends(require_admin)])
def delete_image_key(
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """删除全局生图密钥（后续可回退全局文本模型数据库密钥）。"""
    secret_store.delete_secret(db, secret_store.SECRET_ID_IMAGE_GLOBAL, actor=user.id)
    return _key_status_out(db, secret_store.SECRET_ID_IMAGE_GLOBAL)


def _resolved_llm():
    from app.agents.llm_client import LLMClient

    return LLMClient()


@router.post("/model/test", dependencies=[Depends(require_admin)])
def model_test(db: Session = Depends(get_db), profileId: str | None = None):
    """测试指定档案；未指定时保留测试默认档案的兼容行为。"""
    if profileId:
        from app.agents.llm_client import LLMClient
        from app.services.model_profile_service import resolve_llm_profile_config
        if db.get(ModelProfile, profileId) is None:
            raise HTTPException(status_code=404, detail="模型档案不存在")
        llm = LLMClient(config=resolve_llm_profile_config(db, profile_id=profileId))
    else:
        llm = _resolved_llm()
    if not llm._api_key or llm._api_key == "sk-not-configured":
        raise HTTPException(
            status_code=501,
            detail="未配置密钥：请在管理端录入密钥（数据库加密存储）",
        )
    started = time.monotonic()
    try:
        reply = llm.complete(
            "你是连通性探测器。", "回复两个字：正常", temperature=0,
        ).strip()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="模型调用失败，请检查服务地址、模型和访问密钥") from None
    return {
        "ok": True,
        "latencyMs": int((time.monotonic() - started) * 1000),
        "model": llm.model,
        "profileName": llm.profile_name,
        "reply": reply[:50],
    }


@router.get("/models", dependencies=[Depends(require_admin)])
def discover_models(db: Session = Depends(get_db), profileId: str | None = None):
    """使用指定档案的服务地址和密钥获取模型列表。"""
    from openai import OpenAI

    if profileId:
        from app.services.model_profile_service import resolve_llm_profile_config
        if db.get(ModelProfile, profileId) is None:
            raise HTTPException(status_code=404, detail="模型档案不存在")
        resolved = resolve_llm_profile_config(db, profile_id=profileId)
    else:
        resolved = resolve_llm_config()
    if not resolved["api_key"]:
        raise HTTPException(status_code=501, detail="未配置密钥：请在管理端录入数据库加密密钥")
    client = OpenAI(
        api_key=resolved["api_key"],
        base_url=resolved["base_url"],
        timeout=resolved["timeout_seconds"],
    )
    try:
        models = [m.id for m in client.models.list()]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="模型列表拉取失败，请检查服务地址和访问密钥") from None
    return {"models": sorted(models)}


class ImageConfigUpdate(BaseModel):
    """管理端生图配置；密钥走独立的 /image/key 接口，本体永不回显。"""

    baseUrl: str = Field(min_length=1, max_length=500)
    modelId: str = Field(min_length=1, max_length=200)
    timeoutSeconds: int = Field(default=180, ge=1, le=1800)


def _image_out(db: Session | None = None) -> dict:
    from app.services.model_profile_service import resolve_image_config

    resolved = resolve_image_config(db)
    return {
        "baseUrl": resolved["base_url"],
        "model": resolved["model"],
        "keyConfigured": bool(resolved["api_key"]),
        "keySource": resolved.get("keySource", "none"),
        "keyHint": resolved.get("keyHint", ""),
        "timeoutSeconds": resolved["timeout_seconds"],
        "source": resolved["source"],
    }


@router.put("/image", dependencies=[Depends(require_admin)])
def update_image_config(
    body: ImageConfigUpdate,
    db: Session = Depends(get_db),
):
    """保存全局生图配置（单行 upsert，id 固定 global）。"""
    from app.services.image_config_validation import validate_image_generation_config
    validate_image_generation_config(body.baseUrl, body.modelId)
    from app.models.settings_profile import ImageConfig
    from app.services.model_profile_service import IMAGE_CONFIG_ID

    from app.services.model_profile_service import get_image_config
    row = get_image_config(db)
    if row is None:
        row = ImageConfig(id=IMAGE_CONFIG_ID)
        db.add(row)
    row.base_url = body.baseUrl.strip()
    row.model_id = body.modelId.strip()
    row.timeout_seconds = body.timeoutSeconds
    from app.services.model_config_catalog import catalog_key, read_catalog
    from app.services.workspace_settings import write_preferences
    catalog = read_catalog(db, "image")
    profile = {**next((p for p in catalog["profiles"] if p["id"] == row.id), {"keyMode": "legacy"}), "id": row.id, "name": next((p["name"] for p in catalog["profiles"] if p["id"] == row.id), row.model_id), "baseUrl": row.base_url, "modelId": row.model_id, "timeoutSeconds": row.timeout_seconds}
    profiles = [profile if p["id"] == row.id else p for p in catalog["profiles"]]
    if not any(p["id"] == row.id for p in profiles):
        profiles.append(profile)
    write_preferences(db, catalog_key("image"), {"profiles": profiles, "activeId": row.id})
    db.commit()
    db.refresh(row)
    return _image_out(db)


@router.delete("/image", dependencies=[Depends(require_admin)])
def reset_image_config(db: Session = Depends(get_db)):
    """删除 DB 生图配置覆盖；数据库密钥仍按全局约定解析。"""
    from app.models.settings_profile import ImageConfig
    from app.services.model_profile_service import IMAGE_CONFIG_ID

    from app.services.model_config_catalog import catalog_key, read_catalog
    from app.services.workspace_settings import write_preferences
    catalog = read_catalog(db, "image")
    row = db.get(ImageConfig, IMAGE_CONFIG_ID)
    if row is not None:
        db.delete(row)
    write_preferences(db, catalog_key("image"), {"profiles": [p for p in catalog["profiles"] if p["id"] != IMAGE_CONFIG_ID], "activeId": None})
    return _image_out(db)


@router.post("/image/test", dependencies=[Depends(require_admin)])
def test_image_config(db: Session = Depends(get_db), profileId: str | None = None):
    """生一张最小测试图验证生图链路连通性。"""
    from openai import OpenAI

    from app.services.model_profile_service import resolve_image_config

    if profileId:
        from app.services.model_config_catalog import read_catalog
        if not any(p["id"] == profileId for p in read_catalog(db, "image")["profiles"]):
            raise HTTPException(status_code=404, detail="模型配置不存在")
        resolved = resolve_image_config(db, profile_id=profileId)
    else:
        resolved = resolve_image_config()
    from app.services.image_config_validation import validate_image_generation_config
    validate_image_generation_config(resolved["base_url"], resolved["model"])
    if not resolved["api_key"]:
        raise HTTPException(
            status_code=501,
            detail="未配置密钥：请在管理端录入生图密钥（数据库加密存储）",
        )
    started = time.monotonic()
    client = OpenAI(
        api_key=resolved["api_key"],
        base_url=resolved["base_url"],
        timeout=resolved["timeout_seconds"],
        max_retries=0,
    )
    try:
        result = None
        last_exc: Exception | None = None
        for size in ("512x512", "1024x1024"):
            try:
                result = client.images.generate(
                    model=resolved["model"],
                    prompt="connection test: a tiny minimal blue flower, flat illustration",
                    size=size, n=1,
                )
                break
            except Exception as exc:  # noqa: BLE001
                if getattr(exc, "status_code", None) not in (400, 422):
                    raise
                last_exc = exc
        if result is None:
            raise last_exc if last_exc else RuntimeError("image test failed")
    except Exception as exc:  # noqa: BLE001
        status = getattr(exc, "status_code", None)
        if status in (401, 403):
            detail = "访问验证失败，请检查此配置的密钥及模型使用权限"
        elif status == 404:
            detail = "生图接口或模型不存在，请检查 API 服务地址及模型名称"
        elif status in (400, 422):
            detail = "服务商拒绝生图参数，请检查模型是否支持文生图及测试尺寸"
        elif "timeout" in type(exc).__name__.lower():
            detail = "生图服务响应超时，请检查等待时限，核实服务商请求记录后重试"
        else:
            detail = "生图调用失败，请检查服务地址、模型和访问密钥"
        raise HTTPException(status_code=502, detail=detail) from None
    item = result.data[0] if result.data else None
    if not item or not (item.b64_json or item.url):
        raise HTTPException(status_code=502, detail="生图调用没有返回内容")
    return {
        "ok": True,
        "latencyMs": int((time.monotonic() - started) * 1000),
        "model": resolved["model"],
    }


from typing import Literal
from app.services.workspace_settings import read_preferences, write_preferences

WorkflowNodeId = Literal["research", "outline", "draft", "natural-style", "review", "reference-safety", "risk", "visual"]

class WritingPreferences(BaseModel):
    disabledNodeIds: list[Literal["research", "outline", "draft", "natural-style", "review", "reference-safety", "risk", "visual"]] = Field(default_factory=list, max_length=8)
    webSearchMode: Literal["auto", "off"] = "auto"
    profileId: str | None = None
    nodeProfileIds: dict[WorkflowNodeId, str] = Field(default_factory=dict)
    imageModelId: str | None = Field(default=None, max_length=64)
    embeddingModelId: str | None = Field(default=None, max_length=64)
    rerankModelId: str | None = Field(default=None, max_length=64)

class IntegrationSettings(BaseModel):
    trustedHosts: list[str] = Field(default_factory=list, max_length=30)
    publishBridgeUrl: str = Field(default="", max_length=500)

@router.get("/preferences")
def preferences(db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    from app.services.customer_models import PREFERENCE_FIELDS, available_models
    prefs = WritingPreferences(**read_preferences(db, "user:" + user.id)).model_dump()
    for kind, field in PREFERENCE_FIELDS.items():
        if prefs[field] not in {p["id"] for p in available_models(db, kind)["models"]}:
            prefs[field] = None
    return prefs

@router.put("/preferences")
def save_preferences(body: WritingPreferences, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    profile_ids = [body.profileId, *body.nodeProfileIds.values()]
    if any(profile_id and db.get(ModelProfile, profile_id) is None for profile_id in profile_ids):
        raise HTTPException(status_code=400, detail="模型档案不存在")
    from app.services.customer_models import PREFERENCE_FIELDS, selected_model_id
    for kind, field in PREFERENCE_FIELDS.items():
        if getattr(body, field):
            selected_model_id(db, kind, user.id, getattr(body, field))
    return write_preferences(db, "user:" + user.id, body.model_dump())

@router.get("/integrations", dependencies=[Depends(require_admin)])
def integrations(db: Session = Depends(get_db)):
    return {**IntegrationSettings(**read_preferences(db, "integrations")).model_dump(),
            "tavily": _key_status_out(db, "integration:tavily"),
            "github": _key_status_out(db, "integration:github")}

@router.put("/integrations", dependencies=[Depends(require_admin)])
def save_integrations(body: IntegrationSettings, db: Session = Depends(get_db)):
    from urllib.parse import urlparse
    import re
    hosts = [h.strip().lower() for h in body.trustedHosts if h.strip()]
    if any(not re.fullmatch(r"[a-z0-9.-]+", h) or ".." in h for h in hosts):
        raise HTTPException(status_code=400, detail="可信 Host 只填写主机名")
    if body.publishBridgeUrl:
        url = urlparse(body.publishBridgeUrl)
        if url.scheme not in ("http", "https") or url.hostname not in hosts or url.username or url.password or url.query or url.fragment:
            raise HTTPException(status_code=400, detail="发布桥需为可信 Host 的 HTTP(S) 地址，不允许凭据或查询参数")
    return write_preferences(db, "integrations", {**body.model_dump(), "trustedHosts":hosts})

class WeChatCredentialsPayload(BaseModel):
    """微信公众号发布凭据（appid + appsecret），Fernet 加密入库。"""
    appId: str = Field(min_length=1, max_length=64)
    appSecret: str = Field(min_length=1, max_length=128)


def _wechat_key_status(db: Session) -> dict:
    from app.services.wechat_publisher import load_credentials
    creds = load_credentials(db)
    from app.services import secret_store
    meta = secret_store.get_secret_meta(db, "wechat:global")
    return {
        "configured": creds.configured,
        "appId": creds.app_id if creds.configured else "",
        "keyHint": (meta or {}).get("keyHint", ""),
        "keyVersion": (meta or {}).get("keyVersion", 0),
    }


@router.get("/wechat")
def get_wechat_credentials(db: Session = Depends(get_db)):
    """读取微信公众号发布凭据状态（不回显 appsecret 明文）。"""
    return _wechat_key_status(db)


@router.put("/wechat", dependencies=[Depends(require_admin)])
def save_wechat_credentials(body: WeChatCredentialsPayload, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    from app.services.wechat_publisher import save_credentials
    save_credentials(db, app_id=body.appId, app_secret=body.appSecret, actor=user.id)
    return _wechat_key_status(db)


@router.delete("/wechat", dependencies=[Depends(require_admin)])
def delete_wechat_credentials(db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    from app.services.wechat_publisher import clear_credentials
    clear_credentials(db, actor=user.id)
    return _wechat_key_status(db)


@router.post("/wechat/test", dependencies=[Depends(require_admin)])
def test_wechat_credentials(db: Session = Depends(get_db)):
    """用当前凭据获取 access_token，验证连通性。"""
    from app.services.wechat_publisher import load_credentials, WECHAT_API_BASE
    import httpx as _httpx
    creds = load_credentials(db)
    if not creds.configured:
        raise HTTPException(status_code=501, detail="微信公众号凭据未配置")
    try:
        res = _httpx.get(
            f"{WECHAT_API_BASE}/token",
            params={"grant_type": "client_credential", "appid": creds.app_id, "secret": creds.app_secret},
            timeout=15,
        )
        data = res.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"微信 API 调用失败：{exc}") from None
    if "access_token" not in data:
        return {"ok": False, "errcode": data.get("errcode"), "errmsg": data.get("errmsg")}
    return {"ok": True, "appId": creds.app_id}


@router.put("/integrations/{kind}/key", dependencies=[Depends(require_admin)])
def set_integration_key(kind: Literal["tavily", "github"], body: KeyPayload, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    secret_store.set_secret(db, "integration:" + kind, body.apiKey.strip(), actor=user.id)
    return _key_status_out(db, "integration:" + kind)

# ---------- RAG 检索模型配置 ----------

RAG_PREF_KEY = "admin:rag"


class RagConfigUpdate(BaseModel):
    embeddingBaseUrl: str = Field(default="", max_length=500)
    embeddingModel: str = Field(min_length=1, max_length=200)
    rerankBaseUrl: str = Field(default="", max_length=500)
    rerankModel: str = Field(default="", max_length=200)
    rerankTimeoutSeconds: int = Field(default=3, ge=1, le=120)


def _rag_out(db: Session) -> dict:
    from app.services.model_config_catalog import resolve_rag_config
    from app.core.config import get_settings
    from app.services.workspace_settings import read_preferences

    settings = get_settings()
    saved = read_preferences(db, RAG_PREF_KEY) or {}
    return {
        "embeddingBaseUrl": saved.get("embeddingBaseUrl", ""),
        "embeddingModel": saved.get("embeddingModel", settings.rag_embedding_model),
        "rerankBaseUrl": saved.get("rerankBaseUrl", settings.rerank_base_url),
        "rerankModel": saved.get("rerankModel", ""),
        "rerankTimeoutSeconds": saved.get("rerankTimeoutSeconds", int(settings.rerank_timeout_seconds)),
        "embeddingKeyConfigured": bool(resolve_rag_config(db, "embedding")["api_key"]),
        "source": "db" if saved else "default",
    }


@router.get("/rag", dependencies=[Depends(require_admin)])
def rag_config(db: Session = Depends(get_db)):
    return _rag_out(db)


@router.put("/rag", dependencies=[Depends(require_admin)])
def update_rag_config(body: RagConfigUpdate, db: Session = Depends(get_db)):
    from app.services.workspace_settings import write_preferences

    write_preferences(db, RAG_PREF_KEY, {
        "embeddingBaseUrl": body.embeddingBaseUrl.strip(),
        "embeddingModel": body.embeddingModel.strip(),
        "rerankBaseUrl": body.rerankBaseUrl.strip(),
        "rerankModel": body.rerankModel.strip(),
        "rerankTimeoutSeconds": body.rerankTimeoutSeconds,
    })
    from app.services.model_config_catalog import catalog_key
    for kind in ("embedding", "rerank"):
        catalog = read_preferences(db, catalog_key(kind))
        if catalog and catalog.get("activeId"):
            fields = {"baseUrl": getattr(body, kind + "BaseUrl").strip(), "modelId": getattr(body, kind + "Model").strip()}
            if kind == "rerank":
                fields["timeoutSeconds"] = body.rerankTimeoutSeconds
            write_preferences(db, catalog_key(kind), {**catalog, "profiles": [{**p, **fields} if p["id"] == catalog["activeId"] else p for p in catalog["profiles"]]})
    return _rag_out(db)


@router.delete("/rag", dependencies=[Depends(require_admin)])
def reset_rag_config(db: Session = Depends(get_db)):
    from app.models.settings_profile import WorkspacePreference

    row = db.get(WorkspacePreference, RAG_PREF_KEY)
    if row is not None:
        db.delete(row)
        db.commit()
    from app.services.model_config_catalog import catalog_key
    for kind in ("embedding", "rerank"):
        catalog = read_preferences(db, catalog_key(kind))
        if catalog:
            write_preferences(db, catalog_key(kind), {**catalog, "activeId": None})
    return _rag_out(db)


@router.post("/rag/test", dependencies=[Depends(require_admin)])
def test_rag_config(db: Session = Depends(get_db), target: Literal["all", "embedding", "rerank"] = "all", profileId: str | None = None):
    """分别探测 embedding 与 rerank 链路连通性。"""
    from app.services.model_config_catalog import resolve_rag_config
    from app.services.retrieval_models import embed, rerank, error_detail
    if profileId and target == "all":
        raise HTTPException(status_code=400, detail="请选择要测试的模型类型")
    result = {"embedding": {"ok": False}, "rerank": {"ok": False}}
    for kind in ("embedding", "rerank"):
        if target not in ("all", kind):
            continue
        try:
            config = resolve_rag_config(db, kind, profileId)
        except ValueError:
            raise HTTPException(status_code=404, detail="模型配置不存在") from None
        started = time.monotonic()
        try:
            if kind == "embedding":
                vectors = embed(config, ["苹果是一种水果", "今天的天气晴朗"])
                extra = {"dimensions": len(vectors[0]), "vectors": len(vectors)}
            else:
                if not config["base_url"]:
                    result[kind] = {"ok": False, "detail": "未配置重排服务地址（可留空跳过重排）"}
                    continue
                ranked = rerank(config, "苹果水果", ["苹果是一种水果", "汽车发动机维修"])
                extra = {"results": len(ranked)}
            result[kind] = {"ok": True, "model": config["model"], "latencyMs": int((time.monotonic() - started) * 1000), **extra}
        except Exception as exc:
            result[kind] = {"ok": False, "detail": error_detail(exc)}
    return result


@router.get("/data/export")
def export_my_data(db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    from app.services.article_store import ArticleStore
    from app.services.template_service import TemplateService
    from app.services.media_service import MediaService
    from app.api.assistant import list_assistant_sessions
    return {"schemaVersion":1, "articles":ArticleStore(db).list(user.id),
            "templates":TemplateService(db).list(user.id), "media":MediaService(db).list(user.id),
            "assistant":list_assistant_sessions(db=db, user=user), "preferences":preferences(db=db, user=user)}
