"""Named image/retrieval configurations; credentials remain in the existing secret store."""
from sqlalchemy.orm import Session
from app.models.settings_profile import ImageConfig
from app.services.workspace_settings import read_preferences


def catalog_key(kind: str) -> str:
    return "admin:model-configs:" + kind


def read_catalog(db: Session, kind: str) -> dict:
    saved = read_preferences(db, catalog_key(kind))
    if saved:
        return saved
    if kind == "image":
        row = db.get(ImageConfig, "global")
        profiles = [{"id": row.id, "name": row.model_id, "baseUrl": row.base_url, "modelId": row.model_id, "timeoutSeconds": row.timeout_seconds}] if row else []
    else:
        rag = read_preferences(db, "admin:rag")
        model = rag.get(kind + "Model", "")
        base = rag.get(kind + "BaseUrl", "")
        profiles = [{"id": "legacy-" + kind, "name": model or "当前配置", "baseUrl": base, "modelId": model, "timeoutSeconds": rag.get("rerankTimeoutSeconds", 3) if kind == "rerank" else 30}] if model or base else []
    return {"profiles": profiles, "activeId": profiles[0]["id"] if profiles else None}


def apply_config(db: Session, kind: str, profile: dict) -> None:
    """Stage current runtime settings without committing; retain the other RAG kind."""
    from app.models.settings_profile import WorkspacePreference
    if kind == "image":
        row = db.get(ImageConfig, profile["id"])
        if row is None:
            row = ImageConfig(id=profile["id"])
            db.add(row)
        row.base_url, row.model_id, row.timeout_seconds = profile["baseUrl"], profile["modelId"], profile["timeoutSeconds"]
    else:
        value = {**read_preferences(db, "admin:rag"), kind + "BaseUrl": profile["baseUrl"], kind + "Model": profile["modelId"]}
        if kind == "rerank":
            value["rerankTimeoutSeconds"] = profile["timeoutSeconds"]
        row = db.get(WorkspacePreference, "admin:rag")
        if row is None:
            db.add(WorkspacePreference(id="admin:rag", value=value))
        else:
            row.value = value
