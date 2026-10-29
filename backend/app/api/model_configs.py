"""Administrator-only named configuration catalogs for non-text model types."""
import uuid
from typing import Literal
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from app.core.auth import require_admin
from app.db.session import get_db
from app.models.settings_profile import ImageConfig
from app.services.model_config_catalog import apply_config, catalog_key, read_catalog, config_secret_id, public_profile
from app.services import secret_store
from app.core import secret_box
from app.models.user import AppUser
from app.core.auth import require_user
from app.services.workspace_settings import write_preferences

router = APIRouter(prefix="/settings/model-configs", tags=["settings"], dependencies=[Depends(require_admin)])
ModelKind = Literal["image", "embedding", "rerank"]


class ConfigurationInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    baseUrl: str = Field(default="", max_length=500)
    modelId: str = Field(min_length=1, max_length=200)
    timeoutSeconds: int = Field(default=30, ge=1, le=1800)
    apiKey: str | None = Field(default=None, min_length=4, max_length=4096, repr=False)

    @field_validator("name", "baseUrl", "modelId", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value


def validate_config(kind: str, body: ConfigurationInput) -> None:
    if not body.baseUrl and kind != "embedding":
        raise HTTPException(status_code=400, detail="服务地址必填")
    if body.baseUrl:
        try:
            url = urlsplit(body.baseUrl)
            _ = url.port
        except ValueError:
            raise HTTPException(status_code=400, detail="服务地址格式无效") from None
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise HTTPException(status_code=400, detail="服务地址需为不含密钥和查询参数的 HTTP(S) 地址")
    if kind == "rerank" and body.timeoutSeconds > 120:
        raise HTTPException(status_code=400, detail="排序等待时限不能超过 120 秒")


def find_profile(catalog: dict, profile_id: str) -> dict:
    profile = next((p for p in catalog["profiles"] if p["id"] == profile_id), None)
    if profile is None:
        raise HTTPException(status_code=404, detail="模型配置不存在")
    return profile


@router.get("/{kind}")
def list_configs(kind: ModelKind, db: Session = Depends(get_db)):
    catalog = read_catalog(db, kind)
    return {**catalog, "profiles": [public_profile(db, kind, p) for p in catalog["profiles"]]}


@router.post("/{kind}", status_code=201)
def create_config(kind: ModelKind, body: ConfigurationInput, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    validate_config(kind, body)
    catalog = read_catalog(db, kind)
    if any(p["name"] == body.name for p in catalog["profiles"]):
        raise HTTPException(status_code=409, detail="同名配置已存在")
    profile = {"id": "mc-" + uuid.uuid4().hex, **body.model_dump(exclude={"apiKey"}), "keyMode": "own"}
    save_config_key(db, kind, profile, body.apiKey, user.id)
    catalog = {**catalog, "profiles": [*catalog["profiles"], profile]}
    if kind == "image" or not catalog["activeId"]:
        apply_config(db, kind, profile)
    if not catalog["activeId"]:
        catalog["activeId"] = profile["id"]
    write_preferences(db, catalog_key(kind), catalog)
    return public_profile(db, kind, profile)


@router.patch("/{kind}/{profile_id}")
def update_config(kind: ModelKind, profile_id: str, body: ConfigurationInput, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    validate_config(kind, body)
    catalog = read_catalog(db, kind)
    previous = find_profile(catalog, profile_id)
    if any(p["id"] != profile_id and p["name"] == body.name for p in catalog["profiles"]):
        raise HTTPException(status_code=409, detail="同名配置已存在")
    profile = {**previous, **body.model_dump(exclude={"apiKey"})}
    save_config_key(db, kind, profile, body.apiKey, user.id)
    catalog = {**catalog, "profiles": [profile if p["id"] == profile_id else p for p in catalog["profiles"]]}
    if kind == "image" or catalog["activeId"] == profile_id:
        apply_config(db, kind, profile)
    write_preferences(db, catalog_key(kind), catalog)
    return public_profile(db, kind, profile)


@router.post("/{kind}/{profile_id}/activate")
def activate_config(kind: ModelKind, profile_id: str, db: Session = Depends(get_db)):
    catalog = read_catalog(db, kind)
    profile = find_profile(catalog, profile_id)
    apply_config(db, kind, profile)
    write_preferences(db, catalog_key(kind), {**catalog, "activeId": profile_id})
    return {"activeId": profile_id}


@router.delete("/{kind}/{profile_id}", status_code=204)
def delete_config(kind: ModelKind, profile_id: str, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    catalog = read_catalog(db, kind)
    find_profile(catalog, profile_id)
    if catalog["activeId"] == profile_id:
        raise HTTPException(status_code=409, detail="请先将其他配置设为默认，再删除此配置")
    secret_store.delete_secret(db, config_secret_id(kind, profile_id), actor=user.id, commit=False)
    if kind == "image":
        row = db.get(ImageConfig, profile_id)
        if row:
            db.delete(row)
    write_preferences(db, catalog_key(kind), {**catalog, "profiles": [p for p in catalog["profiles"] if p["id"] != profile_id]})


class ConfigurationKey(BaseModel):
    apiKey: str = Field(min_length=4, max_length=4096, repr=False)


def save_config_key(db: Session, kind: str, profile: dict, value: str | None, actor: str) -> None:
    if value is None:
        return
    if len(value.strip()) < 4:
        raise HTTPException(status_code=400, detail="密钥长度至少 4 位")
    try:
        secret_store.set_secret(db, config_secret_id(kind, profile["id"]), value.strip(), actor=actor, commit=False)
    except secret_box.SecretBoxError:
        raise HTTPException(status_code=503, detail="密钥加密服务不可用，请检查主密钥配置") from None
    profile["keyMode"] = "own"


@router.put("/{kind}/{profile_id}/key")
def set_config_key(kind: ModelKind, profile_id: str, body: ConfigurationKey, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    catalog = read_catalog(db, kind)
    profile = find_profile(catalog, profile_id)
    save_config_key(db, kind, profile, body.apiKey, user.id)
    write_preferences(db, catalog_key(kind), catalog)
    return public_profile(db, kind, profile)


@router.delete("/{kind}/{profile_id}/key")
def remove_config_key(kind: ModelKind, profile_id: str, db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    catalog = read_catalog(db, kind)
    profile = find_profile(catalog, profile_id)
    secret_store.delete_secret(db, config_secret_id(kind, profile_id), actor=user.id, commit=False)
    profile["keyMode"] = "own"  # Explicit removal must not restore a shared legacy key.
    write_preferences(db, catalog_key(kind), catalog)
    return public_profile(db, kind, profile)
