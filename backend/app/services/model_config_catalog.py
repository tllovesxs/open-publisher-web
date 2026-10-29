"""Named image/retrieval configurations; credentials remain in the existing secret store."""
from sqlalchemy.orm import Session
from app.models.settings_profile import ImageConfig
from app.services.workspace_settings import read_preferences


def catalog_key(kind: str) -> str:
    return "admin:model-configs:" + kind


def read_catalog(db: Session, kind: str) -> dict:
    saved = read_preferences(db, catalog_key(kind))
    if saved:
        # Preserve the previously active configuration's shared credential only.
        return {**saved, "profiles": [{**p, "keyMode": p.get("keyMode", "legacy" if p["id"] == saved.get("activeId") else "own")} for p in saved["profiles"]]}
    if kind == "image":
        row = db.get(ImageConfig, "global")
        profiles = [{"id": row.id, "name": row.model_id, "baseUrl": row.base_url, "modelId": row.model_id, "timeoutSeconds": row.timeout_seconds}] if row else []
    else:
        rag = read_preferences(db, "admin:rag")
        model = rag.get(kind + "Model", "")
        base = rag.get(kind + "BaseUrl", "")
        profiles = [{"id": "legacy-" + kind, "name": model or "当前配置", "baseUrl": base, "modelId": model, "timeoutSeconds": rag.get("rerankTimeoutSeconds", 3) if kind == "rerank" else 30}] if model or base else []
    profiles = [{**p, "keyMode": "legacy"} for p in profiles]
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


def config_secret_id(kind: str, profile_id: str) -> str:
    return f"model-config:{kind}:{profile_id}"


def credential_id(db: Session, kind: str, profile: dict) -> str | None:
    from app.services import secret_store
    own = config_secret_id(kind, profile["id"])
    if secret_store.get_secret_meta(db, own):
        return own
    if profile.get("keyMode") != "legacy":
        return None
    candidates = ([secret_store.SECRET_ID_IMAGE_GLOBAL, secret_store.SECRET_ID_LLM_GLOBAL] if kind == "image" else [secret_store.SECRET_ID_LLM_GLOBAL] if kind == "embedding" else [])
    if kind == "embedding":
        from app.services.model_profile_service import get_active_profile
        active = get_active_profile(db)
        if active:
            candidates.insert(0, secret_store.profile_secret_id(active.id))
    return next((sid for sid in candidates if secret_store.get_secret_meta(db, sid)), None)


def public_profile(db: Session, kind: str, profile: dict) -> dict:
    from app.services.secret_store import get_secret_meta
    sid = credential_id(db, kind, profile)
    meta = get_secret_meta(db, sid) if sid else None
    return {**{k: v for k, v in profile.items() if k != "keyMode"}, "keyConfigured": bool(meta), "keyHint": (meta or {}).get("keyHint", "")}


def resolve_rag_config(db: Session, kind: str, profile_id: str | None = None) -> dict:
    """Resolve one saved configuration and its own encrypted credential."""
    from app.core.config import get_settings
    from app.services.secret_store import get_secret
    from app.services.model_profile_service import resolve_llm_profile_config
    settings = get_settings()
    catalog = read_catalog(db, kind)
    selected = profile_id or catalog.get("activeId")
    profile = next((p for p in catalog["profiles"] if p["id"] == selected), None)
    llm = resolve_llm_profile_config(db, profile_id=None) if kind == "embedding" else {}
    if profile:
        sid = credential_id(db, kind, profile)
        return {"model": profile["modelId"], "base_url": profile["baseUrl"] or (llm["base_url"] if kind == "embedding" else ""), "timeout_seconds": profile["timeoutSeconds"], "api_key": (get_secret(db, sid) or "") if sid else ""}
    if profile_id:
        raise ValueError("模型配置不存在")
    # No catalog selection: retain pre-catalog runtime defaults.
    rag = read_preferences(db, "admin:rag")
    return {"model": rag.get(kind + "Model") or (settings.rag_embedding_model if kind == "embedding" else ""), "base_url": rag.get(kind + "BaseUrl") or (llm["base_url"] if kind == "embedding" else settings.rerank_base_url), "timeout_seconds": rag.get("rerankTimeoutSeconds", settings.rerank_timeout_seconds) if kind == "rerank" else 30, "api_key": llm["api_key"] if kind == "embedding" else ""}
