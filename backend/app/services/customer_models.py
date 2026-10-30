"""Administrator catalogs exposed as safe, user-selectable model options."""
from fastapi import HTTPException
from app.services.model_config_catalog import read_catalog
from app.services.workspace_settings import read_preferences

KINDS = ("image", "embedding", "rerank")
PREFERENCE_FIELDS = {kind: kind + "ModelId" for kind in KINDS}


def available_models(db, kind: str) -> dict:
    catalog = read_catalog(db, kind)
    models = []
    for profile in catalog["profiles"]:
        if not profile.get("enabled", True):
            continue
        try:
            if kind == "image":
                from app.services.image_config_validation import validate_image_generation_config
                validate_image_generation_config(profile["baseUrl"], profile["modelId"])
            else:
                from app.services.retrieval_models import validate_config
                validate_config({"base_url": profile["baseUrl"], "model": profile["modelId"], "protocol": profile.get("protocol", "auto")}, kind)
        except (ValueError, HTTPException):
            continue
        models.append({"id": profile["id"], "name": profile["name"], "model": profile["modelId"], "isDefault": False})
    default = next((p["id"] for p in models if p["id"] == catalog.get("activeId")), models[0]["id"] if models else None)
    for model in models:
        model["isDefault"] = model["id"] == default
    return {"models": models, "defaultId": default}


def selected_model_id(db, kind: str, owner_user_id: str | None, explicit_id: str | None = None, *, preferences: dict | None = None) -> str | None:
    options = available_models(db, kind)
    ids = {model["id"] for model in options["models"]}
    if explicit_id:
        if explicit_id not in ids:
            raise HTTPException(status_code=400, detail="所选模型不存在或未向客户端开放，请重新选择")
        return explicit_id
    prefs = preferences if preferences is not None else read_preferences(db, "user:" + owner_user_id) if owner_user_id else {}
    saved = prefs.get(PREFERENCE_FIELDS[kind])
    if saved in ids:
        return saved
    if not ids:
        raise HTTPException(status_code=501, detail="管理员尚未开放可用模型，请联系管理员配置")
    return options["defaultId"]
