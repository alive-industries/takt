from pathlib import Path


def test_pm_facing_view_exposes_unified_contract() -> None:
    schema = (Path(__file__).parents[2] / "infra/bigquery/schema.sql").read_text()
    assert "CREATE OR REPLACE VIEW `__TAKT_DS__.time_tracking`" in schema
    for field in (
        "route",
        "entry_type AS type",
        "github_user AS user",
        "client",
        "project",
        "duration_hours_exact AS hours",
        "duration_hours AS hours_rounded",
        "label",
        "github_metadata",
    ):
        assert field in schema
    assert "reporting_status = 'complete'" in schema
    assert "deleted_at IS NULL" in schema
