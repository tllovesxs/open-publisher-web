"""Revision-bound checks for the browser extension handoff; never calls a model."""
import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.agent_runtime import AgentRun, AgentRunEvent
from app.services.article_store import content_hash


def sync_safety(db: Session, article: dict, markdown: str) -> dict:
    rows = db.execute(
        select(AgentRunEvent).join(AgentRun, AgentRun.id == AgentRunEvent.run_id)
        .where(AgentRun.article_id == article["articleId"],
               AgentRunEvent.event_type == "node.completed")
        .order_by(AgentRunEvent.created_at.desc(), AgentRunEvent.sequence.desc())
    ).scalars()
    level, issues = "unknown", []
    reason = "尚未完成当前正文的风险检查，请人工核验。"
    for row in rows:
        payload = json.loads(row.payload_json)
        if payload.get("nodeId") != "risk":
            continue
        if (payload.get("checkedRevisionId") != article["currentRevisionId"]
                or content_hash(markdown) != article["contentHash"]):
            reason = "正文或版本已变化，需要重新检查或人工核验。"
        else:
            level = payload.get("level", "unknown")
            level = level if level in {"low", "medium", "high"} else "unknown"
            issues = payload.get("issueDetails", [])
            reason = "当前版本风险检查：" + level
        break
    return {"level": level, "issues": issues, "message": reason,
            "blocked": level == "high", "requiresConfirmation": level != "low",
            "revisionId": article["currentRevisionId"], "contentHash": content_hash(markdown)}
