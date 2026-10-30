"""Public, immutable examples. Never query or expose users' private libraries."""
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/examples", tags=["examples"])
DATA_PATH = Path(__file__).parents[1] / "data" / "examples.v1.json"


@router.get("/{kind}")
def list_examples(kind: str):
    if kind not in {"articles", "templates", "media"}:
        raise HTTPException(status_code=404, detail="Example collection not found")
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    if kind == "articles":
        data[kind][0]["markdown"] = DATA_PATH.with_name("example-article.v1.md").read_text(encoding="utf-8")
    return {"items": data[kind]}
