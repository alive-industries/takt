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
        # Caches the caller's org role: "admin" (owner), "member", or None
        # (not an active member / undeterminable). is_org_member derives from it.
        self._org_cache: TTLCache[tuple[int, str], str | None] = TTLCache(
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

    async def get_user_by_login(self, pat: str, login: str) -> GitHubUser | None:
        """Resolve a login to {login, id} via GET /users/{login}.

        Used for admin on-behalf-of session writes when the members table
        doesn't hold the target's github_user_id yet. Returns None on 404
        (unknown login); raises on transport errors.
        """
        try:
            resp = await self._client.get(
                f"{self._base}/users/{login}", headers=self._headers(pat)
            )
        except httpx.HTTPError as e:
            log.warning("github /users/%s request failed: %s", login, e)
            raise UpstreamError("Could not reach GitHub API.") from e
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise UpstreamError(f"GitHub /users/{login} returned {resp.status_code}")
        data = resp.json()
        return GitHubUser(login=data["login"], id=data["id"])

    async def get_org_role(
        self, pat: str, user: GitHubUser, org: str | None = None
    ) -> str | None:
        """Return the caller's role in `org`: "admin" (org owner), "member", or
        None.

        Uses the caller's own PAT against `GET /user/memberships/orgs/{org}`,
        which reports the authenticated user's membership without needing org
        admin privileges. GitHub labels org *owners* as role "admin".

        None means "not an active member or undeterminable": a 404 (not a
        member), a non-active membership state (e.g. a pending invite), a 403
        (PAT lacks `read:org`), or a transport error. Callers must treat None
        as inconclusive and never demote an existing member on its basis.
        """
        org = org or self._org
        cache_key = (user.id, org)
        cached = self._org_cache.get(cache_key)
        if cache_key in self._org_cache:
            return cached

        url = f"{self._base}/user/memberships/orgs/{org}"
        try:
            resp = await self._client.get(url, headers=self._headers(pat))
        except httpx.HTTPError as e:
            log.warning("github org membership check failed: %s", e)
            return None

        role: str | None = None
        if resp.status_code == 200:
            data = resp.json()
            if data.get("state") == "active":
                role = data.get("role")  # "admin" (owner) | "member"
        # 403 (missing scope), 404 (not a member), other → role stays None.
        self._org_cache[cache_key] = role
        return role

    async def is_org_member(self, pat: str, user: GitHubUser, org: str | None = None) -> bool:
        """Whether `user` is an active member of `org` (any role).

        Requires the PAT to have the `read:org` scope; a PAT lacking it yields
        a 403 which we treat as 'unknown' = False — an admin can still add the
        user manually.
        """
        return await self.get_org_role(pat, user, org) is not None


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
