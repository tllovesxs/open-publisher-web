"""Scale credit balances and ledgers to the larger credit unit."""

from alembic import op


revision = "0021_scale_credit_unit"
down_revision = "0020_points_and_vip"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing rows used the first small credit unit. The product moved to a
    # larger unit, so every recorded balance and grant is scaled exactly once.
    op.execute("UPDATE app_users SET credit_balance = credit_balance * 10")
    op.execute(
        "UPDATE credit_ledgers SET amount = amount * 10, "
        "balance_after = balance_after * 10"
    )
    op.execute(
        "DELETE FROM credit_ledgers WHERE LEFT(source, 5) = 'free_' AND amount = 0"
    )


def downgrade() -> None:
    op.execute("UPDATE app_users SET credit_balance = credit_balance DIV 10")
    op.execute(
        "UPDATE credit_ledgers SET amount = amount DIV 10, "
        "balance_after = balance_after DIV 10"
    )
