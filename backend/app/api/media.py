"""素材库 API：列表 / 上传 / 生成 / 删除 / 原始内容。"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import require_user
from app.db.session import get_db
from app.models.user import AppUser
from app.services.media_service import MediaService

router = APIRouter(prefix="/media", tags=["media"])


class MediaUploadRequest(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    mime: str = Field(min_length=1, max_length=100)
    dataUrl: str = Field(min_length=1)
    alt: str = Field(default="", max_length=500)
    usageHint: str = Field(default="", max_length=500)
    visualDescription: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=20)


class MediaUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    alt: str | None = Field(default=None, max_length=500)
    visualDescription: str | None = Field(default=None, max_length=2000)
    usageHint: str | None = Field(default=None, max_length=500)
    generationPrompt: str | None = Field(default=None, max_length=4000)
    tags: list[str] | None = Field(default=None, max_length=20)


class MediaGenerateRequest(BaseModel):
    imageModelId: str | None = Field(default=None, max_length=64)
    prompt: str = Field(min_length=1, max_length=16_000)
    size: str = "1024x1024"


@router.get("")
def list_media(
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
    search: str | None = Query(default=None, max_length=200),
    origin: str | None = Query(default=None, pattern="^(upload|generated)$"),
    tag: str | None = Query(default=None, max_length=50),
    sort: str = Query(default="created_desc", pattern="^(created_desc|created_asc|name_asc|name_desc)$"),
):
    return {
        "assets": MediaService(db).list(
            owner_user_id=user.id,
            search=search, origin=origin, tag=tag, sort=sort,
        )
    }


@router.post("", status_code=201)
def upload_media(
    body: MediaUploadRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    try:
        return MediaService(db).add_upload(
            name=body.name, mime=body.mime, data_url=body.dataUrl,
            alt=body.alt, usage_hint=body.usageHint,
            visual_description=body.visualDescription, tags=body.tags,
            owner_user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.post("/generate", status_code=201)
def generate_media(
    body: MediaGenerateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    return MediaService(db).generate(
        image_profile_id=body.imageModelId,
        prompt=body.prompt, size=body.size, owner_user_id=user.id,
    )


class MediaPreviewRequest(BaseModel):
    """预览生成：只返回 data URL，不落库。"""
    prompt: str = Field(min_length=1, max_length=2000)
    size: str = "1024x1024"
    imageModelId: str | None = Field(default=None, max_length=64)


@router.post("/preview")
def preview_media(
    body: MediaPreviewRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """生成预览图：调用生图 API 返回 data URL，但不创建素材库记录。"""
    import base64 as _base64
    from app.services.model_profile_service import resolve_image_config

    from app.services.customer_models import selected_model_id
    selected = selected_model_id(db, "image", user.id, body.imageModelId)
    resolved = resolve_image_config(db=db, profile_id=selected)
    if not resolved["api_key"]:
        raise HTTPException(status_code=501, detail="生图模型未配置密钥")
    from openai import OpenAI

    client = OpenAI(
        api_key=resolved["api_key"], base_url=resolved["base_url"],
        timeout=resolved["timeout_seconds"],
    )
    try:
        result = client.images.generate(
            model=resolved["model"], prompt=body.prompt, size=body.size, n=1,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"预览生成失败：{exc}") from None
    item = result.data[0]
    if item.b64_json:
        return {"source": f"data:image/png;base64,{item.b64_json}"}
    if item.url:
        import httpx as _httpx
        try:
            resp = _httpx.get(str(item.url), follow_redirects=True, timeout=30)
            resp.raise_for_status()
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"预览图下载失败：{exc}") from None
        mime = resp.headers.get("content-type", "image/png").split(";")[0].strip()
        if not mime.startswith("image/") or not resp.content:
            raise HTTPException(status_code=502, detail="预览返回的不是有效图片")
        return {"source": f"data:{mime};base64,{_base64.b64encode(resp.content).decode('ascii')}"}
    raise HTTPException(status_code=502, detail="生图 API 没有返回内容")


class MediaAnalyzeRequest(BaseModel):
    """上传后 AI 分析：可用模型档案留空 = 全局激活档案。"""
    profileId: str | None = Field(default=None, max_length=64)


@router.post("/{asset_id}/analyze")
def analyze_media(
    asset_id: str,
    body: MediaAnalyzeRequest | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    """视觉模型分析素材图片，回填 alt/视觉描述/使用场景/标签。"""
    row = MediaService(db).get(asset_id, owner_user_id=user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="asset not found")
    _writable_or_403(row, user)
    from app.agents.llm_client import LLMClient, LLMError
    from app.services.model_profile_service import resolve_llm_profile_config

    resolved = resolve_llm_profile_config(
        db, profile_id=body.profileId if body else None, owner_user_id=user.id,
    )
    capabilities = resolved.get("capabilities") or {}
    if not capabilities.get("vision"):
        raise HTTPException(status_code=400, detail="当前模型档案未开启图片理解能力。")
    if not resolved.get("api_key"):
        raise HTTPException(status_code=501, detail="LLM 模型未配置密钥")
    try:
        return MediaService(db).analyze(
            asset_id, owner_user_id=user.id, llm=LLMClient(config=resolved),
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="asset not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


@router.delete("/{asset_id}", status_code=204)
def delete_media(
    asset_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    row = MediaService(db).get(asset_id, owner_user_id=user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="asset not found")
    _writable_or_403(row, user)
    try:
        MediaService(db).delete(asset_id, owner_user_id=user.id)
    except KeyError:
        raise HTTPException(status_code=404, detail="asset not found") from None


def _writable_or_403(row, user: AppUser) -> None:
    """共享（无属主）素材只读；写操作仅属主或管理员。"""
    if row.owner_user_id != user.id and getattr(user, "role", "user") != "admin":
        raise HTTPException(status_code=403, detail={"code": "MEDIA_FORBIDDEN", "message": "asset belongs to another user"})


@router.patch("/{asset_id}")
def update_media(
    asset_id: str,
    body: MediaUpdateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    row = MediaService(db).get(asset_id, owner_user_id=user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="asset not found")
    _writable_or_403(row, user)
    try:
        return MediaService(db).update(
            asset_id,
            owner_user_id=user.id,
            name=body.name, alt=body.alt,
            visual_description=body.visualDescription,
            usage_hint=body.usageHint,
            generation_prompt=body.generationPrompt,
            tags=body.tags,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="asset not found") from None


@router.get("/{asset_id}/raw")
def raw_media(
    asset_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    row = MediaService(db).get(asset_id, owner_user_id=user.id)
    if row is None:
        raise HTTPException(status_code=404, detail="asset not found")
    if row.source.startswith("data:"):
        header, b64 = row.source.split(",", 1)
        import base64

        data = base64.b64decode(b64)
        return Response(content=data, media_type=row.mime)
    # 兼容历史生成任务：模型网关可能只返回临时 URL。仅允许后端生成的素材走代理，
    # 避免把用户上传/外部素材库变成任意 SSRF 入口。
    if row.origin == "generated" and row.source.startswith(("http://", "https://")):
        import base64
        import httpx
        try:
            response = httpx.get(row.source, follow_redirects=True, timeout=30)
            response.raise_for_status()
        except Exception:  # noqa: BLE001 - 上游临时链接可能过期
            raise HTTPException(status_code=404, detail="remote asset is unavailable") from None
        content_type = response.headers.get("content-type", row.mime).split(";", 1)[0].strip()
        if not content_type.startswith("image/") or not response.content or len(response.content) > 20 * 1024 * 1024:
            raise HTTPException(status_code=404, detail="remote asset is not a valid image")
        # 自愈：临时 URL 首次成功取回后立即落成 data URL，之后不再依赖远端。
        row.source = f"data:{content_type};base64," + base64.b64encode(response.content).decode("ascii")
        row.mime = content_type
        db.commit()
        return Response(content=response.content, media_type=content_type)
    raise HTTPException(status_code=404, detail="remote asset has no local raw content")
