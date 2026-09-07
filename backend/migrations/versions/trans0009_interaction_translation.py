"""Transparent-translation columns on interactions (#248).

Four nullable columns — the ORIGINAL `message` is never touched; translation
is separate, labeled, and re-runnable. Chained onto `avail0008` (one head).
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "trans0009"
down_revision: str | None = "avail0008"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("detected_language", sa.String(length=8)),
    ("translated_message", sa.Text()),
    ("translated_to", sa.String(length=8)),
    ("translation_status", sa.String(length=16)),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    # Self-adopt guard (lessons §23), comparing COLUMN SETS per column.
    existing = {c["name"] for c in inspector.get_columns("interactions")}
    for name, type_ in _COLUMNS:
        if name not in existing:
            op.add_column("interactions", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _type in reversed(_COLUMNS):
        op.drop_column("interactions", name)
