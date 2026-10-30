"""Admin usage ledger, price snapshots, audits, and last login."""

from alembic import op
import sqlalchemy as sa


revision = "0019_admin_usage_and_user_ops"
down_revision = "0018_template_long_reference"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("app_users", sa.Column("last_login_at", sa.DateTime(), nullable=True))
    op.create_index("ix_app_users_last_login_at", "app_users", ["last_login_at"])
    op.create_table(
        "usage_events",
        sa.Column("id", sa.CHAR(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("resource_id", sa.String(length=200), nullable=True),
        sa.Column("operation", sa.String(length=80), nullable=False),
        sa.Column("service_type", sa.String(length=30), nullable=False),
        sa.Column("provider", sa.String(length=160), nullable=False, server_default="unknown"),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column("profile_id", sa.String(length=64), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("image_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("request_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="succeeded"),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("estimated_cost", sa.Numeric(18, 8), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=True),
        sa.Column("pricing_snapshot", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    for column in ("user_id", "run_id", "resource_id", "operation", "service_type", "model_id", "status", "created_at"):
        op.create_index(f"ix_usage_events_{column}", "usage_events", [column])
    op.create_table(
        "model_pricing",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("service_type", sa.String(length=30), nullable=False),
        sa.Column("provider", sa.String(length=160), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column("input_price_per_million", sa.Numeric(18, 8), nullable=True),
        sa.Column("output_price_per_million", sa.Numeric(18, 8), nullable=True),
        sa.Column("image_price", sa.Numeric(18, 8), nullable=True),
        sa.Column("request_price", sa.Numeric(18, 8), nullable=True),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="USD"),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("service_type", "provider", "model_id", name="uq_model_pricing_key"),
    )
    op.create_table(
        "admin_audit_logs",
        sa.Column("id", sa.CHAR(length=36), primary_key=True),
        sa.Column("actor_user_id", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=80), nullable=False),
        sa.Column("subject_type", sa.String(length=40), nullable=False),
        sa.Column("subject_id", sa.String(length=200), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    for column in ("actor_user_id", "action", "subject_id", "created_at"):
        op.create_index(f"ix_admin_audit_logs_{column}", "admin_audit_logs", [column])


def downgrade() -> None:
    op.drop_table("admin_audit_logs")
    op.drop_table("model_pricing")
    op.drop_table("usage_events")
    op.drop_index("ix_app_users_last_login_at", table_name="app_users")
    op.drop_column("app_users", "last_login_at")
