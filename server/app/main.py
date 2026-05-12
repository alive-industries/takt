"""Takt API — FastAPI app factory."""

from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
        allow_headers=["Authorization", "Content-Type", "X-Takt-Api-Key"],
    )

    # API-key gate. Sits in front of every /v1/* route. /health, /openapi,
    # /docs are deliberately exempt so deploy probes and schema viewers work.
    @app.middleware("http")
    async def api_key_gate(request: Request, call_next):
        s = get_settings()
        if not s.api_key:
            # No key configured — open mode (local dev). PAT auth still
            # applies on every protected route.
            return await call_next(request)

        path = request.url.path
        # Allow CORS preflight, health checks, and OpenAPI introspection
        # through unauthenticated.
        if request.method == "OPTIONS" or path in (
            "/health", "/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect"
        ):
            return await call_next(request)

        # Strip whitespace on both sides — Secret Manager values that were
        # piped via `echo` end up with a trailing newline that breaks
        # constant-time compare. Belt-and-braces; we also recommend
        # `printf` (no newline) when seeding the secret.
        provided = request.headers.get("x-takt-api-key", "").strip()
        expected = s.api_key.strip()
        if not hmac.compare_digest(provided, expected):
            return JSONResponse(
                status_code=401,
                content={
                    "detail": {
                        "code": "invalid_api_key",
                        "message": "Missing or invalid X-Takt-Api-Key header.",
                    }
                },
            )
        return await call_next(request)

    app.include_router(me.router)
    app.include_router(sessions.router)
    app.include_router(admin.router)

    @app.get("/health", include_in_schema=False)
    def health() -> dict:
        return {"ok": True, "version": app.version}

    return app


app = create_app()
