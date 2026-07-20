"""unify time entry reporting model

Revision ID: 79612f0cd15e
Revises: 2a8cd57de876
Create Date: 2026-07-16 15:44:13.843922
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "79612f0cd15e"
down_revision: str | None = "2a8cd57de876"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "clients",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_clients_name"), "clients", ["name"], unique=True)
    op.create_table(
        "client_repositories",
        sa.Column("repository_id", sa.BigInteger(), nullable=False),
        sa.Column("client_id", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"]),
        sa.ForeignKeyConstraint(["repository_id"], ["repositories.id"]),
        sa.PrimaryKeyConstraint("repository_id"),
    )
    op.create_index(
        op.f("ix_client_repositories_client_id"),
        "client_repositories",
        ["client_id"],
        unique=False,
    )
    op.add_column("sessions", sa.Column("source", sa.String(length=20), nullable=True))
    op.add_column("sessions", sa.Column("entry_type", sa.String(length=20), nullable=True))
    op.add_column("sessions", sa.Column("reporting_status", sa.String(length=30), nullable=True))
    op.add_column("sessions", sa.Column("client_id", sa.BigInteger(), nullable=True))
    op.add_column("sessions", sa.Column("client_name", sa.String(length=255), nullable=True))
    op.add_column(
        "sessions", sa.Column("reporting_project_id", sa.String(length=255), nullable=True)
    )
    op.add_column("sessions", sa.Column("project_name", sa.Text(), nullable=True))
    op.add_column("sessions", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("sessions", sa.Column("label", sa.String(length=600), nullable=True))
    op.add_column(
        "sessions",
        sa.Column(
            "github_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column("sessions", sa.Column("duration_hours_exact", sa.Float(), nullable=True))
    op.execute(
        """
        UPDATE sessions
        SET source = CASE
                WHEN source_url IS NOT NULL AND issue_number > 0 THEN 'github'
                ELSE 'manual'
            END,
            entry_type = CASE
                WHEN source_url IS NOT NULL AND issue_number > 0 THEN 'delivery'
                WHEN EXISTS (
                    SELECT 1 FROM session_projects sp
                    WHERE sp.session_id = sessions.session_id
                ) THEN 'delivery'
                ELSE 'ops'
            END,
            reporting_status = 'pending_metadata',
            description = COALESCE(category_title, issue_title, category),
            duration_hours_exact = duration_ms / 3600000.0
        """
    )
    op.execute(
        """
        UPDATE sessions s
        SET reporting_project_id = chosen.project_id,
            project_name = chosen.title
        FROM (
            SELECT DISTINCT ON (sp.session_id)
                sp.session_id, sp.project_id, p.title
            FROM session_projects sp
            JOIN projects p ON p.project_id = sp.project_id
            ORDER BY sp.session_id, sp.project_id
        ) chosen
        WHERE chosen.session_id = s.session_id
        """
    )
    op.alter_column("sessions", "source", nullable=False)
    op.alter_column("sessions", "entry_type", nullable=False)
    op.alter_column("sessions", "reporting_status", nullable=False)
    op.alter_column("sessions", "duration_hours_exact", nullable=False)
    op.alter_column("sessions", "context_type", existing_type=sa.VARCHAR(length=20), nullable=True)
    op.drop_constraint("ck_sessions_context_fields", "sessions", type_="check")
    op.drop_constraint("ck_sessions_context_type", "sessions", type_="check")
    op.create_check_constraint("ck_sessions_source", "sessions", "source IN ('github', 'manual')")
    op.create_check_constraint(
        "ck_sessions_entry_type", "sessions", "entry_type IN ('delivery', 'ops')"
    )
    op.create_check_constraint(
        "ck_sessions_github_delivery",
        "sessions",
        "source != 'github' OR entry_type = 'delivery'",
    )
    op.create_index(op.f("ix_sessions_client_id"), "sessions", ["client_id"], unique=False)
    op.create_foreign_key("fk_sessions_client_id", "sessions", "clients", ["client_id"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_sessions_client_id", "sessions", type_="foreignkey")
    op.drop_index(op.f("ix_sessions_client_id"), table_name="sessions")
    op.drop_constraint("ck_sessions_github_delivery", "sessions", type_="check")
    op.drop_constraint("ck_sessions_entry_type", "sessions", type_="check")
    op.drop_constraint("ck_sessions_source", "sessions", type_="check")
    op.create_check_constraint(
        "ck_sessions_context_type",
        "sessions",
        "context_type IN ('issue', 'repository', 'category')",
    )
    op.alter_column("sessions", "context_type", existing_type=sa.VARCHAR(length=20), nullable=False)
    for column in (
        "duration_hours_exact",
        "github_metadata",
        "label",
        "description",
        "project_name",
        "reporting_project_id",
        "client_name",
        "client_id",
        "reporting_status",
        "entry_type",
        "source",
    ):
        op.drop_column("sessions", column)
    op.drop_index(op.f("ix_client_repositories_client_id"), table_name="client_repositories")
    op.drop_table("client_repositories")
    op.drop_index(op.f("ix_clients_name"), table_name="clients")
    op.drop_table("clients")
