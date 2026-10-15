from __future__ import annotations

from sqlalchemy import func, select

from app.db import transaction
from app.db_models import MemberRow
from app.models import Member

from ._common import _audit, _member_model, _now


def get_member(login: str, github_user_id: int | None = None) -> Member | None:
    with transaction() as db:
        row = None
        if github_user_id is not None:
            row = db.scalar(select(MemberRow).where(MemberRow.github_user_id == github_user_id))
        if row is None:
            row = db.scalar(
                select(MemberRow).where(func.lower(MemberRow.github_login) == login.lower())
            )
        if row and github_user_id is not None:
            row.github_login = login
            row.github_user_id = github_user_id
            row.updated_at = _now()
        return _member_model(row) if row else None


def list_members() -> list[Member]:
    with transaction() as db:
        rows = db.scalars(select(MemberRow).order_by(MemberRow.added_at.desc())).all()
        return [_member_model(row) for row in rows]


def upsert_member(member: Member, *, actor: str | None = None) -> Member:
    now = _now()
    with transaction() as db:
        row = db.scalar(
            select(MemberRow).where(
                func.lower(MemberRow.github_login) == member.github_login.lower()
            )
        )
        before = _member_model(row).model_dump(mode="json") if row else None
        if row is None:
            row = MemberRow(
                github_login=member.github_login,
                github_user_id=member.github_user_id,
                role=member.role,
                status=member.status,
                source=member.source,
                added_by=member.added_by,
                added_at=member.added_at or now,
                updated_at=now,
            )
            db.add(row)
        else:
            row.github_user_id = member.github_user_id or row.github_user_id
            row.github_login = member.github_login
            row.role = member.role
            row.status = member.status
            row.source = member.source
            row.updated_at = now
        db.flush()
        result = _member_model(row)
        if actor:
            _audit(
                db,
                actor=actor,
                action="member.upsert",
                target=row.github_login,
                subject=row.github_login,
                before=before,
                after=result.model_dump(mode="json"),
            )
        return result
