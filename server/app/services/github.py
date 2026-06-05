"""GitHub API client — minimal surface needed by Takt."""

from __future__ import annotations

import hashlib
import logging

import httpx
from cachetools import TTLCache

from app.config import get_settings
from app.errors import InvalidPAT, UpstreamError
from app.models import GitHubUser

log = logging.getLogger(__name__)


def _hash_pat(pat: str) -> str:
    """Stable cache key for a PAT without keeping the token in memory by value."""
    return hashlib.sha256(pat.encode()).hexdigest()


class GitHubClient:
    """Thin async wrapper around api.github.com.

    Caches PAT->user lookups and org-membership results in-process. Cloud Run
    instances are short-lived so the cache stays small; for high-traffic later
    we'd swap this for Memorystore.
    """

    def __init__(self) -> None:
        settings = get_settings()
        self._base = settings.github_api_base
        self._org = settings.github_org
        self._user_cache: TTLCache[str, GitHubUser] = TTLCache(
            maxsize=2048, ttl=settings.pat_cache_ttl
        )
        self._org_cache: TTLCache[tuple[int, str], bool] = TTLCache(
            maxsize=2048, ttl=settings.org_membership_cache_ttl
        )
        self._client = httpx.AsyncClient(timeout=10.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _headers(pat: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def resolve_user(self, pat: str) -> GitHubUser:
        """Resolve a PAT to {login, id}. Raises InvalidPAT on 401."""
        key = _hash_pat(pat)
        cached = self._user_cache.get(key)
        if cached:
            return cached

        try:
            resp = await self._client.get(f"{self._base}/user", headers=self._headers(pat))
        except httpx.HTTPError as e:
            log.warning("github /user request failed: %s", e)
            raise UpstreamError("Could not reach GitHub API.") from e

        if resp.status_code == 401:
            raise InvalidPAT()
        if resp.status_code != 200:
            raise UpstreamError(f"GitHub /user returned {resp.status_code}")

        data = resp.json()
        user = GitHubUser(login=data["login"], id=data["id"])
        self._user_cache[key] = user
        return user

    async def is_org_member(self, pat: str, user: GitHubUser, org: str | None = None) -> bool:
        """Check whether `user` is a member of `org` using their own PAT.

        Requires the PAT to have the `read:org` scope. If the PAT lacks the
        scope GitHub returns 404, which we treat as 'unknown' = False — the
        admin can still add the user manually.
        """
        org = org or self._org
        cache_key = (user.id, org)
        cached = self._org_cache.get(cache_key)
        if cached is not None:
            return cached

        url = f"{self._base}/orgs/{org}/members/{user.login}"
        try:
            resp = await self._client.get(url, headers=self._headers(pat))
        except httpx.HTTPError as e:
            log.warning("github org membership check failed: %s", e)
            return False

        # 204 = member, 302 = requester not a member, 404 = user not a member
        is_member = resp.status_code == 204
        self._org_cache[cache_key] = is_member
        return is_member


_singleton: GitHubClient | None = None


def get_github_client() -> GitHubClient:
    """Return a process-wide GitHubClient, lazily (re)creating it if needed.

    Reset semantics: lifespan shutdown calls `reset_github_client()` so a
    subsequent app start (e.g. between tests with FastAPI TestClient) gets
    a fresh client rather than the closed one.
    """
    global _singleton
    if _singleton is None:
        _singleton = GitHubClient()
    return _singleton


def reset_github_client() -> None:
    global _singleton
    _singleton = None
