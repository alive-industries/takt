"""Takt API — FastAPI app factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routes import admin, me, sessions
from app.services.github import get_github_client, reset_github_client


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=level,
        format='{"ts":"%(asctime)s","lvl":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}',
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await get_github_client().aclose()
    reset_github_client()


def create_app() -> FastAPI:
    settings = get_settings()
    _setup_logging(settings.log_level)

    app = FastAPI(
        title="Takt API",
        version="0.1.0",
        description=(
            "Backend for the Takt time tracker. "
            "Verifies GitHub PATs and writes to BigQuery."
        ),
        lifespan=lifespan,
    )

    # Chrome extensions present `Origin: chrome-extension://<id>`. We allow any
    # extension origin since the extension ID changes per developer; auth is
    # enforced by the bearer PAT, not by origin.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://.*",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.include_router(me.router)
    app.include_router(sessions.router)
    app.include_router(admin.router)

    @app.get("/health", include_in_schema=False)
    def health() -> dict:
        return {"ok": True, "version": app.version}

    return app


app = create_app()
