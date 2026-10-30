"""Allow complete reference sources up to the blueprint transport limit."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.mysql import MEDIUMTEXT

revision = "0018_template_long_reference"
down_revision = "0017_remove_api_key_env"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "mysql":
        for column, nullable in (("markdown", False), ("reference_markdown", True)):
            op.alter_column("article_templates", column, existing_type=sa.Text(), type_=MEDIUMTEXT(), existing_nullable=nullable)


def downgrade():
    # Preserve long user reference text; shrinking to TEXT could truncate data.
    pass
