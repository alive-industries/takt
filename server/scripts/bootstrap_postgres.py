import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.models import Member  # noqa: E402
from app.services import store  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--admin-login", required=True)
    parser.add_argument("--admin-user-id", type=int)
    args = parser.parse_args()
    member = store.upsert_member(
        Member(
            github_login=args.admin_login,
            github_user_id=args.admin_user_id,
            role="admin",
            status="active",
            source="manual",
            added_by="bootstrap",
            added_at=datetime.now(UTC),
        )
    )
    print(f"Seeded admin {member.github_login}.")


if __name__ == "__main__":
    main()
