from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class MemberRow(Base):
    __tablename__ = "members"
    __table_args__ = (
        CheckConstraint("role IN ('admin', 'member')", name="ck_members_role"),
        CheckConstraint("status IN ('active', 'revoked', 'pending')", name="ck_members_status"),
        CheckConstraint("source IN ('org', 'manual')", name="ck_members_source"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    github_login: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    github_user_id: Mapped[int | None] = mapped_column(BigInteger, unique=True, nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="member")
    status: Mapped[str] = mapped_column(String(20), default="active")
    source: Mapped[str] = mapped_column(String(20), default="manual")
    added_by: Mapped[str | None] = mapped_column(String(255))
    added_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ClientRow(Base):
    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RepositoryRow(Base):
    __tablename__ = "repositories"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    github_repository_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    full_name: Mapped[str] = mapped_column(String(512), unique=True, index=True)
    owner: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(255))
    url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ClientRepositoryRow(Base):
    __tablename__ = "client_repositories"

    repository_id: Mapped[int] = mapped_column(ForeignKey("repositories.id"), primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ClientProjectRow(Base):
    __tablename__ = "client_projects"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.project_id"), primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProjectRepositoryRow(Base):
    __tablename__ = "project_repositories"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.project_id"), primary_key=True)
    repository_id: Mapped[int] = mapped_column(ForeignKey("repositories.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class IssueRow(Base):
    __tablename__ = "issues"
    __table_args__ = (UniqueConstraint("repository_id", "issue_number"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    repository_id: Mapped[int] = mapped_column(ForeignKey("repositories.id"), index=True)
    github_issue_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    issue_number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProjectRow(Base):
    __tablename__ = "projects"

    project_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    org: Mapped[str | None] = mapped_column(String(255))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SessionRow(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        Index("ix_sessions_user_completed", "github_user", "completed_at"),
        Index("ix_sessions_repo_issue", "repo", "issue_number"),
        CheckConstraint("duration_ms >= 0", name="ck_sessions_duration"),
        CheckConstraint("source IN ('github', 'manual')", name="ck_sessions_source"),
        CheckConstraint("entry_type IN ('delivery', 'ops')", name="ck_sessions_entry_type"),
        CheckConstraint(
            "source != 'github' OR entry_type = 'delivery'",
            name="ck_sessions_github_delivery",
        ),
        CheckConstraint(
            "entry_type != 'ops' OR "
            "(repo IS NULL AND reporting_project_id IS NULL AND issue_number = 0)",
            name="ck_sessions_ops_fields",
        ),
    )

    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("members.id"), index=True)
    created_by_member_id: Mapped[int] = mapped_column(ForeignKey("members.id"))
    updated_by_member_id: Mapped[int | None] = mapped_column(ForeignKey("members.id"))
    deleted_by_member_id: Mapped[int | None] = mapped_column(ForeignKey("members.id"))
    github_user: Mapped[str] = mapped_column(String(255), index=True)
    github_user_id: Mapped[int | None] = mapped_column(BigInteger)
    created_by_user: Mapped[str] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(String(20), default="manual")
    entry_type: Mapped[str] = mapped_column(String(20), default="ops")
    reporting_status: Mapped[str] = mapped_column(String(30), default="pending_metadata")
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id"), index=True)
    client_name: Mapped[str | None] = mapped_column(String(255))
    reporting_project_id: Mapped[str | None] = mapped_column(String(255))
    project_name: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    label: Mapped[str | None] = mapped_column(String(600))
    github_metadata: Mapped[dict] = mapped_column(JSONB, default=dict)
    duration_hours_exact: Mapped[float] = mapped_column(Float, default=0)
    context_type: Mapped[str | None] = mapped_column(String(20))
    repository_id: Mapped[int | None] = mapped_column(ForeignKey("repositories.id"))
    issue_id: Mapped[int | None] = mapped_column(ForeignKey("issues.id"))
    repo: Mapped[str | None] = mapped_column(String(512))
    issue_number: Mapped[int] = mapped_column(Integer, default=0)
    issue_title: Mapped[str | None] = mapped_column(Text)
    issue_url: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(255))
    category_title: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    duration_ms: Mapped[int] = mapped_column(BigInteger)
    duration_hours: Mapped[float] = mapped_column(Float)
    source_url: Mapped[str | None] = mapped_column(Text)
    synced_to_project: Mapped[bool] = mapped_column(Boolean, default=False)
    takt_version: Mapped[str | None] = mapped_column(String(100))
    client_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    inserted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class SessionProjectRow(Base):
    __tablename__ = "session_projects"

    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.session_id"), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.project_id"), primary_key=True)
    project_title_snapshot: Mapped[str] = mapped_column(Text)


class OrgConfigRow(Base):
    __tablename__ = "org_config"

    org_login: Mapped[str] = mapped_column(String(255), primary_key=True)
    default_field_name: Mapped[str | None] = mapped_column(String(255))
    project_fields: Mapped[dict] = mapped_column(JSONB, default=dict)
    excluded_projects: Mapped[list] = mapped_column(JSONB, default=list)
    updated_by: Mapped[str | None] = mapped_column(String(255))
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditLogRow(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    actor: Mapped[str] = mapped_column(String(255))
    action: Mapped[str] = mapped_column(String(100))
    target: Mapped[str | None] = mapped_column(String(255))
    subject: Mapped[str | None] = mapped_column(String(255))
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)


class OutboxEventRow(Base):
    __tablename__ = "outbox_events"
    __table_args__ = (Index("ix_outbox_pending", "exported_at", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    aggregate_type: Mapped[str] = mapped_column(String(50))
    aggregate_id: Mapped[str] = mapped_column(String(255))
    event_type: Mapped[str] = mapped_column(String(50))
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    payload: Mapped[dict] = mapped_column(JSONB)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
