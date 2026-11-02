"""Versioned official pricing catalog and configured-model matching.

The catalog is shipped with the application instead of scraping provider pages at
request time. Every entry carries its public source and effective date. Operators
can keep explicit ModelPricing rows as overrides for gateways and negotiated rates.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.settings_profile import ModelProfile
from app.models.usage import ModelPricing

CATALOG_PATH = Path(__file__).resolve().parents[1] / "data" / "official_model_pricing.v1.json"


@lru_cache(maxsize=1)
def read_official_catalog() -> dict:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def normalize_provider(provider: str | None, base_url: str | None = None) -> str:
    value = (provider or "").strip().lower()
    if value and value not in {"custom", "openai-compatible", "unknown"}:
        return value
    host = (urlsplit(base_url or "").hostname or "").lower()
    if host == "api.openai.com" or host.endswith(".openai.com"):
        return "openai"
    if host == "api.deepseek.com" or host.endswith(".deepseek.com"):
        return "deepseek"
    return value or "unknown"


def _match_entry(service_type: str, provider: str, model_id: str) -> dict | None:
    needle_model = model_id.strip().lower()
    needle_provider = provider.strip().lower()
    for entry in read_official_catalog()["entries"]:
        models = [entry["modelId"], *(entry.get("aliases") or [])]
        if (
            entry["serviceType"] == service_type
            and entry["provider"].lower() == needle_provider
            and needle_model in {item.lower() for item in models}
        ):
            return entry
    return None


def official_price_for(service_type: str, provider: str, model_id: str, *, base_url: str | None = None) -> dict | None:
    return _match_entry(service_type, normalize_provider(provider, base_url), model_id)


def configured_model_matches(db: Session) -> list[dict]:
    custom_keys = {
        (row.service_type, row.provider.strip().lower(), row.model_id.strip().lower())
        for row in db.scalars(select(ModelPricing)).all()
    }
    matches: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for profile in db.scalars(select(ModelProfile).order_by(ModelProfile.created_at.desc())).all():
        provider = normalize_provider(profile.provider, profile.base_url)
        key = ("text", provider, profile.model_id.strip().lower())
        if key in seen:
            continue
        seen.add(key)
        official = _match_entry("text", provider, profile.model_id)
        matches.append({
            "serviceType": "text", "provider": provider, "modelId": profile.model_id,
            "profileId": profile.id, "profileName": profile.name,
            "status": "custom" if key in custom_keys else "official" if official else "unavailable",
            "official": official,
        })
    return matches
