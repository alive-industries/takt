from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

_engine = None
_session_factory = None


def get_engine():
    global _engine, _session_factory
    if _engine is None:
        settings = get_settings()
        _engine = create_engine(
            settings.database_url,
            pool_pre_ping=True,
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
        )
        _session_factory = sessionmaker(_engine, expire_on_commit=False)
    return _engine


@contextmanager
def transaction():
    if _session_factory is None:
        get_engine()
    assert _session_factory is not None
    with _session_factory() as session, session.begin():
        yield session


def get_db() -> Session:
    if _session_factory is None:
        get_engine()
    assert _session_factory is not None
    return _session_factory()


def reset_db() -> None:
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None
