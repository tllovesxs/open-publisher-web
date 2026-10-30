"""Per-user writing defaults and shared administrator integrations."""
from app.models.settings_profile import WorkspacePreference
from app.services.secret_store import get_secret

def read_preferences(db, key):
    row = db.get(WorkspacePreference, key)
    return row.value if row else {}

def write_preferences(db, key, value):
    row = db.get(WorkspacePreference, key)
    if row is None:
        db.add(WorkspacePreference(id=key, value=value))
    else:
        row.value = value
    db.commit()
    return value

def integration_key(db, kind):
    return get_secret(db, "integration:" + kind) or ""


def normalize_disabled_nodes(nodes):
    """正文是新文章的必需步骤；兼容历史偏好和旧客户端。"""
    optional = {"research", "outline", "natural-style", "review", "reference-safety", "risk", "visual"}
    return list(dict.fromkeys(node for node in (nodes or []) if node in optional))
