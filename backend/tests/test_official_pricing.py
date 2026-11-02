from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models.settings_profile import ModelProfile
from app.models.usage import ModelPricing
from app.services.official_pricing import configured_model_matches, normalize_provider, official_price_for
from app.services.usage import record_usage


def factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def test_provider_is_inferred_only_for_known_official_hosts():
    assert normalize_provider("custom", "https://api.openai.com/v1") == "openai"
    assert normalize_provider("custom", "https://api.deepseek.com/v1") == "deepseek"
    assert normalize_provider("custom", "https://gateway.example/v1") == "custom"


def test_official_catalog_prices_usage_without_manual_row():
    with factory()() as db:
        event = record_usage(db, user_id="u-1", service_type="text", operation="write", provider="openai", model_id="gpt-4o-mini", input_tokens=10_000, output_tokens=2_000)
        assert event.estimated_cost == Decimal("0.00270000")
        assert event.pricing_snapshot["source"] == "official"
        assert event.pricing_snapshot["sourceUrl"] == "https://openai.com/api/pricing/"


def test_manual_price_overrides_official_catalog_and_is_snapshotted():
    with factory()() as db:
        db.add(ModelPricing(service_type="text", provider="openai", model_id="gpt-4o-mini", input_price_per_million=1, output_price_per_million=2, currency="USD"))
        db.commit()
        event = record_usage(db, user_id="u-1", service_type="text", operation="write", provider="openai", model_id="gpt-4o-mini", input_tokens=1_000_000, output_tokens=1_000_000)
        assert event.estimated_cost == Decimal("3.00000000")
        assert event.pricing_snapshot["source"] == "custom"


def test_configured_profiles_report_official_and_unavailable_matches():
    with factory()() as db:
        db.add_all([
            ModelProfile(id="official", name="OpenAI", provider="custom", base_url="https://api.openai.com/v1", model_id="gpt-4o-mini"),
            ModelProfile(id="other", name="Gateway", provider="custom", base_url="https://gateway.example/v1", model_id="private-model"),
        ])
        db.commit()
        rows = {row["profileId"]: row for row in configured_model_matches(db)}
        assert rows["official"]["status"] == "official"
        assert rows["other"]["status"] == "unavailable"
        assert official_price_for("text", "openai", "missing") is None
