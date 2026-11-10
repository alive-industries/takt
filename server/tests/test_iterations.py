import json

import httpx
import pytest

from app import iterations
from app.models import OrgConfig

PROJECT = {"id": "p1", "number": 1, "title": "Work", "closed": True}
STAMP = "2026-01-01T00:00:00+00:00"


def connection(nodes, cursor=None):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor}}


def field():
    return {
        "__typename": "ProjectV2IterationField",
        "id": "f1",
        "name": "WO section",
        "configuration": {
            "iterations": [{"id": "i1", "title": "3B", "startDate": "2026-02-27", "duration": 3}],
            "completedIterations": [
                {"id": "i0", "title": "3A", "startDate": "2026-02-01", "duration": 7},
            ],
        },
    }


def value(kind, **kwargs):
    return {"__typename": f"ProjectV2ItemField{kind}Value", **kwargs}


def item(content_type="Issue"):
    content = {"__typename": content_type, "title": "Task"}
    if content_type != "DraftIssue":
        content.update(
            repository={"nameWithOwner": "org/repo"},
            number=7,
            url="https://github.com/org/repo/issues/7",
            state="OPEN",
        )
    return {
        "id": "item1",
        "content": content,
        "fieldValues": connection(
            [
                value("Iteration", iterationId="i1", field={"id": "f1", "name": "WO section"}),
                value("Number", number=2.5, field={"name": "Hours"}),
                value("Number", number=0, field={"name": "Actual"}),
                value("SingleSelect", name="In Progress", field={"name": "Status"}),
                value("SingleSelect", name="P1", field={"name": "Priority"}),
            ]
        ),
    }


def test_parse_iterations():
    rows = iterations.parse_iterations(PROJECT, [field(), {"__typename": "ProjectV2Field"}], STAMP)
    assert len(rows) == 2
    assert rows[0] == {
        "project_id": "p1",
        "project_number": 1,
        "project_title": "Work",
        "project_closed": True,
        "field_id": "f1",
        "field_name": "WO section",
        "iteration_id": "i1",
        "title": "3B",
        "start_date": "2026-02-27",
        "duration_days": 3,
        "end_date": "2026-03-01",
        "is_completed": False,
        "synced_at": STAMP,
    }
    assert rows[1]["is_completed"] is True
    assert rows[1]["end_date"] == "2026-02-07"
    assert iterations.parse_iterations(PROJECT, [], STAMP) == []


@pytest.mark.parametrize("content_type", ["Issue", "PullRequest", "DraftIssue"])
def test_parse_items(content_type):
    config = OrgConfig(org_login="org", default_field_name="Hours")
    rows = iterations.parse_item("p1", item(content_type), config, STAMP)
    assert len(rows) == 1
    row = rows[0]
    assert row["hours"] == 2.5
    assert row["status"] == "In Progress"
    assert json.loads(row["number_fields"]) == {"Hours": 2.5, "Actual": 0}
    assert row["content_type"] == content_type
    assert row["issue_title"] == "Task"
    assert row["repo"] == (None if content_type == "DraftIssue" else "org/repo")
    assert row["issue_number"] == (None if content_type == "DraftIssue" else 7)
    config.project_fields = {"p1": "Actual"}
    assert iterations.parse_item("p1", item(content_type), config, STAMP)[0]["hours"] == 0
    config.project_fields = {"p1": "Missing"}
    assert iterations.parse_item("p1", item(content_type), config, STAMP)[0]["hours"] is None


def test_empty_and_unavailable_items():
    config = OrgConfig(org_login="org")
    data = item()
    data["content"] = None
    data["fieldValues"]["nodes"] = data["fieldValues"]["nodes"][:1]
    row = iterations.parse_item("p1", data, config, STAMP)[0]
    assert row["content_type"] is None
    assert row["status"] is None
    assert row["hours"] is None
    assert row["number_fields"] == "{}"
    data["fieldValues"] = connection([])
    assert iterations.parse_item("p1", data, config, STAMP) == []


def test_fetch_paginates_all_connections_and_excludes(monkeypatch):
    calls = []

    def graphql(_client, query, variables):
        calls.append((query, variables))
        after = variables.get("after")
        if query == iterations._PROJECTS:
            nodes = [PROJECT] if not after else [{**PROJECT, "id": "excluded"}]
            return {"organization": {"projectsV2": connection(nodes, None if after else "p2")}}
        if query == iterations._FIELDS:
            return {
                "node": {
                    "fields": connection([] if not after else [field()], None if after else "f2")
                }
            }
        if query == iterations._ITEMS:
            data = item("DraftIssue" if after else "PullRequest")
            data["id"] = "item2" if after else "item1"
            data["fieldValues"] = connection(data["fieldValues"]["nodes"][:1], "v2")
            return {"node": {"items": connection([data], None if after else "items2")}}
        assert query == iterations._ITEM_VALUES
        assert variables["valuesAfter"] == "v2"
        return {"node": {"fieldValues": connection(item()["fieldValues"]["nodes"][1:])}}

    monkeypatch.setattr(iterations, "_graphql", graphql)
    config = OrgConfig(org_login="org", default_field_name="Hours", excluded_projects=["excluded"])
    rows, items = iterations.fetch_snapshot("pat", "org", config)
    assert len(rows) == 2
    assert len(items) == 2
    assert [row["hours"] for row in items] == [2.5, 2.5]
    assert len(calls) == 8
    assert all(variables.get("id") != "excluded" for _, variables in calls)


@pytest.mark.parametrize("graphql_error", [True, False])
def test_graphql_errors(graphql_error):
    def handler(request):
        if graphql_error:
            return httpx.Response(200, json={"errors": [{"message": "Access denied"}]})
        return httpx.Response(403)

    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        pytest.raises(RuntimeError if graphql_error else httpx.HTTPStatusError),
    ):
        iterations._graphql(client, "query {}", {})


def test_multiple_iteration_assignments():
    data = item()
    data["fieldValues"]["nodes"].append(
        value("Iteration", iterationId="i2", field={"id": "f2", "name": "Another section"})
    )
    rows = iterations.parse_item("p1", data, OrgConfig(org_login="org"), STAMP)
    assert [(row["field_id"], row["iteration_id"]) for row in rows] == [
        ("f1", "i1"),
        ("f2", "i2"),
    ]


def test_empty_org(monkeypatch):
    monkeypatch.setattr(
        iterations,
        "_graphql",
        lambda *args: {
            "organization": {"projectsV2": connection([])},
        },
    )
    assert iterations.fetch_snapshot("pat", "org", OrgConfig(org_login="org")) == ([], [])


def test_non_advancing_cursor(monkeypatch):
    monkeypatch.setattr(
        iterations,
        "_graphql",
        lambda *args: {
            "organization": {"projectsV2": connection([], "same")},
        },
    )
    with pytest.raises(RuntimeError, match="non-advancing"):
        iterations.fetch_snapshot("pat", "org", OrgConfig(org_login="org"))


class Job:
    def result(self):
        return self


class Client:
    def __init__(self, fail=None):
        self.fail = fail
        self.created = []
        self.loads = []
        self.queries = []
        self.deleted = []

    def get_table(self, destination):
        return iterations.bigquery.Table(
            destination,
            schema=[
                iterations.bigquery.SchemaField("project_id", "STRING"),
            ],
        )

    def create_table(self, table):
        self.created.append(table)

    def load_table_from_json(self, rows, staging, job_config):
        self.loads.append((rows, staging))
        assert job_config.schema == self.created[-1].schema
        assert job_config.write_disposition == "WRITE_TRUNCATE"
        if self.fail == "load" and len(self.loads) == 2:
            raise RuntimeError("load failed")
        return Job()

    def query(self, sql):
        self.queries.append(sql)
        if self.fail == "query":
            raise RuntimeError("query failed")
        return Job()

    def delete_table(self, staging, not_found_ok):
        assert not_found_ok is True
        self.deleted.append(staging)


@pytest.mark.parametrize("empty", [False, True])
def test_snapshot_write(monkeypatch, empty):
    client = Client()
    monkeypatch.setattr(iterations.bigquery, "Client", lambda **kwargs: client)
    rows = [] if empty else [{"project_id": "p1"}]
    iterations.write_snapshot(rows, rows)
    assert len(client.created) == 2
    assert len(client.loads) == (0 if empty else 2)
    assert len(client.queries) == 1
    sql = client.queries[0]
    assert sql.startswith("BEGIN TRANSACTION;")
    assert sql.endswith("COMMIT TRANSACTION;")
    assert sql.count("DELETE FROM") == 2
    assert sql.count("INSERT INTO") == 2
    assert len(client.deleted) == 2


@pytest.mark.parametrize("failure", ["load", "query"])
def test_failed_write_cleans_staging(monkeypatch, failure):
    client = Client(fail=failure)
    monkeypatch.setattr(iterations.bigquery, "Client", lambda **kwargs: client)
    with pytest.raises(RuntimeError, match="failed"):
        iterations.write_snapshot([{"project_id": "p1"}], [{"project_id": "p1"}])
    assert len(client.deleted) == 2
    assert len(client.queries) == (0 if failure == "load" else 1)


def test_fetch_failure_never_writes(monkeypatch):
    monkeypatch.setattr(iterations.store, "get_org_config", lambda: OrgConfig(org_login="org"))

    def fail(*args):
        raise RuntimeError("GitHub failed")

    monkeypatch.setattr(iterations, "fetch_snapshot", fail)
    monkeypatch.setattr(iterations, "write_snapshot", lambda *args: pytest.fail("Unexpected write"))
    with pytest.raises(RuntimeError, match="GitHub failed"):
        iterations.sync_iterations("pat")


def test_dry_run_and_setting_pat(monkeypatch):
    settings = iterations.get_settings().model_copy(update={"github_pat": "setting-pat"})
    monkeypatch.setattr(iterations, "get_settings", lambda: settings)
    monkeypatch.setattr(iterations.store, "get_org_config", lambda: OrgConfig(org_login="org"))
    used = []

    def fetch(pat, org, config):
        used.append(pat)
        return [], []

    monkeypatch.setattr(iterations, "fetch_snapshot", fetch)
    monkeypatch.setattr(iterations, "write_snapshot", lambda *args: pytest.fail("Unexpected write"))
    assert iterations.sync_iterations(dry_run=True) == ([], [])
    assert iterations.sync_iterations("override", dry_run=True) == ([], [])
    assert used == ["setting-pat", "override"]
    settings.github_pat = ""
    with pytest.raises(ValueError, match="TAKT_GITHUB_PAT"):
        iterations.sync_iterations(dry_run=True)
