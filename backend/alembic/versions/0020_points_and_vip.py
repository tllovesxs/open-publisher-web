"""Credit balances, VIP status, and immutable credit ledger."""

from alembic import op
import sqlalchemy as sa


revision = "0020_points_and_vip"
down_revision = "0019_admin_usage_and_user_ops"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "app_users",
        sa.Column("credit_balance", sa.Integer(), nullable=False, server_default="10"),
    )
    op.add_column(
        "app_users",
        sa.Column("is_vip", sa.Boolean(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column("app_users", sa.Column("vip_expires_at", sa.DateTime(), nullable=True))
    op.add_column(
        "app_users",
        sa.Column(
            "unlimited_credits", sa.Boolean(), nullable=False, server_default=sa.text("0")
        ),
    )
    op.execute("UPDATE app_users SET unlimited_credits = 1 WHERE username = 'video_user'")
    op.create_table(
        "credit_ledgers",
        sa.Column("id", sa.CHAR(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=40), nullable=False),
        sa.Column("reason", sa.String(length=200), nullable=True),
        sa.Column("checkin_date", sa.Date(), nullable=True),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "user_id", "source", "checkin_date",
            name="uq_credit_ledgers_user_source_date",
        ),
    )
    for column in ("user_id", "source", "checkin_date", "created_at"):
        op.create_index(f"ix_credit_ledgers_{column}", "credit_ledgers", [column])


def downgrade() -> None:
    op.drop_table("credit_ledgers")
    op.drop_column("app_users", "unlimited_credits")
    op.drop_column("app_users", "vip_expires_at")
    op.drop_column("app_users", "is_vip")
    op.drop_column("app_users", "credit_balance")
