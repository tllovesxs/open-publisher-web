"""模板 API：列表 / 新建 / 删除 / 从文章提取。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import require_user, require_admin
from app.db.session import get_db
from app.models.user import AppUser
from app.services.template_service import TemplateService

router = APIRouter(prefix="/templates", tags=["templates"])


class TemplateCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    category: str = ""
    markdown: str = Field(min_length=1)
    usageInstructions: str = ""
    referenceMarkdown: str | None = None
    styleProfile: dict | None = None
    structureProfile: dict | None = None
    layoutProfile: dict | None = None
    fixedBlocks: list[dict] | None = None
    variables: list[str] | None = None


class TemplateUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    category: str | None = Field(default=None, max_length=100)
    markdown: str | None = None
    usageInstructions: str | None = None
    styleProfile: dict | None = None
    structureProfile: dict | None = None
    layoutProfile: dict | None = None
    fixedBlocks: list[dict] | None = None
    variables: list[str] | None = None


class TemplateExtractRequest(BaseModel):
    rightsConfirmed: bool = False
    markdown: str = Field(min_length=1, max_length=2_000_000)


@router.get("")
def list_templates(db: Session = Depends(get_db), user: AppUser = Depends(require_user)):
    return {"templates": TemplateService(db).list(owner_user_id=user.id)}


@router.post("", status_code=201)
def create_template(
    body: TemplateCreateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    try:
        return TemplateService(db).create_custom(
            name=body.name, description=body.description, category=body.category,
            markdown=body.markdown, usage_instructions=body.usageInstructions,
            reference_markdown=body.referenceMarkdown, owner_user_id=user.id,
            style_profile=body.styleProfile, structure_profile=body.structureProfile,
            layout_profile=body.layoutProfile, fixed_blocks=body.fixedBlocks, variables=body.variables,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.patch("/{template_id}")
def update_template(
    template_id: str,
    body: TemplateUpdateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    try:
        return TemplateService(db).update(
            template_id,
            owner_user_id=user.id,
            name=body.name, description=body.description, category=body.category,
            markdown=body.markdown, usage_instructions=body.usageInstructions,
            style_profile=body.styleProfile,
            structure_profile=body.structureProfile,
            layout_profile=body.layoutProfile,
            fixed_blocks=body.fixedBlocks, variables=body.variables,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="template not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.delete("/{template_id}", status_code=204)
def delete_template(
    template_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    try:
        TemplateService(db).delete(template_id, owner_user_id=user.id)
    except KeyError:
        raise HTTPException(status_code=404, detail="template not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.post("/extract", status_code=201)
def extract_template(
    body: TemplateExtractRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_user),
):
    if not body.rightsConfirmed:
        raise HTTPException(status_code=400, detail="请确认你有权使用参考文章提取模板")
    try:
        return TemplateService(db).extract_from_article(
            body.markdown, owner_user_id=user.id,
        )
    except ValueError as exc:  # 配置类问题（未激活档案 / Key 未注入）
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except Exception as exc:  # noqa: BLE001 - LLM 调用/解析失败统一 502
        raise HTTPException(status_code=502, detail=f"模板提取失败：{exc}") from None


@router.post("/refresh-official", dependencies=[Depends(require_admin)])
def refresh_official_templates(db: Session = Depends(get_db)):
    from app.services.template_service import seed_builtin_templates
    seed_builtin_templates(db, refresh=True)
    return {"refreshed": True}
