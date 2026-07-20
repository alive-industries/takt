"""enforce transactional invariants

Revision ID: 2a8cd57de876
Revises: 54732d95c12b
Create Date: 2026-07-15 12:05:39.811106
"""

from collections.abc import Sequence

from alembic import op

revision: str = "2a8cd57de876"
down_revision: str | None = "54732d95c12b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_check_constraint("ck_members_role", "members", "role IN ('admin', 'member')")
    op.create_check_constraint(
        "ck_members_status", "members", "status IN ('active', 'revoked', 'pending')"
    )
    op.create_check_constraint("ck_members_source", "members", "source IN ('org', 'manual')")
    op.create_check_constraint(
        "ck_sessions_context_type",
        "sessions",
        "context_type IN ('issue', 'repository', 'category')",
    )
    op.create_check_constraint("ck_sessions_duration", "sessions", "duration_ms >= 0")
    op.create_check_constraint(
        "ck_sessions_context_fields",
        "sessions",
        "(context_type = 'issue' AND repo IS NOT NULL AND issue_number > 0) OR "
        "(context_type = 'repository' AND repo IS NOT NULL AND issue_number = 0) OR "
        "(context_type = 'category' AND repo IS NULL AND issue_number = 0 "
        "AND category IS NOT NULL AND category_title IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_sessions_context_fields", "sessions", type_="check")
    op.drop_constraint("ck_sessions_duration", "sessions", type_="check")
    op.drop_constraint("ck_sessions_context_type", "sessions", type_="check")
    op.drop_constraint("ck_members_source", "members", type_="check")
    op.drop_constraint("ck_members_status", "members", type_="check")
    op.drop_constraint("ck_members_role", "members", type_="check")
