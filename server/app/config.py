"""Runtime configuration loaded from environment variables."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Process-wide settings.

    All values come from env vars; defaults exist only for local dev.
    Cloud Run injects these via the service config.
    """

    model_config = SettingsConfigDict(env_file=".env", env_prefix="TAKT_", extra="ignore")

    # GCP / BigQuery
    gcp_project: str = Field(default="cost-tracker-490815")
    bq_dataset: str = Field(default="takt")
    bq_location: str = Field(
        default="EU", description="BigQuery dataset location (region/multi-region)."
    )

    # GitHub
    github_org: str = Field(default="alive-industries")
    github_api_base: str = Field(default="https://api.github.com")

    # Auth caching (seconds)
    pat_cache_ttl: int = Field(default=300)
    org_membership_cache_ttl: int = Field(default=600)

    # Server
    log_level: str = Field(default="INFO")
    # Shared API key. When set, all /v1/* requests must carry a matching
    # `X-Takt-Api-Key` header. Unset (empty) disables the gate (local dev).
    api_key: str = Field(default="")
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "chrome-extension://*",  # placeholder; CORS for extensions handled differently
        ]
    )

    @property
    def sessions_table(self) -> str:
        return f"{self.gcp_project}.{self.bq_dataset}.sessions"

    @property
    def members_table(self) -> str:
        return f"{self.gcp_project}.{self.bq_dataset}.members"

    @property
    def org_config_table(self) -> str:
        return f"{self.gcp_project}.{self.bq_dataset}.org_config"

    @property
    def audit_log_table(self) -> str:
        return f"{self.gcp_project}.{self.bq_dataset}.audit_log"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
