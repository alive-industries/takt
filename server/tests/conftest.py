import os
import subprocess
from pathlib import Path

import psycopg
from psycopg import sql

TEST_DATABASE_URL = "postgresql+psycopg://takt:takt@localhost:55432/takt_test"
os.environ["TAKT_API_KEY"] = ""
os.environ["TAKT_DATABASE_URL"] = TEST_DATABASE_URL


def pytest_sessionstart(session) -> None:
    try:
        with psycopg.connect(
            "postgresql://takt:takt@localhost:55432/postgres", autocommit=True
        ) as connection:
            exists = connection.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", ("takt_test",)
            ).fetchone()
            if not exists:
                connection.execute(
                    sql.SQL("CREATE DATABASE {}").format(sql.Identifier("takt_test"))
                )
    except psycopg.OperationalError as exc:
        message = "Start the local database with `docker compose up -d postgres`."
        raise RuntimeError(message) from exc
    root = Path(__file__).resolve().parent.parent
    subprocess.run(
        [str(root / ".venv/bin/alembic"), "upgrade", "head"],
        cwd=root,
        env=os.environ.copy(),
        check=True,
    )
