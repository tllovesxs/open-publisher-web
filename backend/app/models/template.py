"""文章模板：蓝本 MarkdownTemplate 的数据库版。"""

from sqlalchemy import Boolean, JSON, String, Text
from sqlalchemy.dialects.mysql import MEDIUMTEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ArticleTemplate(Base):
    __tablename__ = "article_templates"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    owner_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    category: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    markdown: Mapped[str] = mapped_column(Text().with_variant(MEDIUMTEXT(), "mysql"), nullable=False)
    style_profile: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    structure_profile: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    layout_profile: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    fixed_blocks: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    variables: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    usage_instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_built_in: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="scaffold")
    reference_markdown: Mapped[str | None] = mapped_column(Text().with_variant(MEDIUMTEXT(), "mysql"), nullable=True)
    source_fingerprint: Mapped[str | None] = mapped_column(String(80), nullable=True)
