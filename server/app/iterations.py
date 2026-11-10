from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

import httpx
from google.cloud import bigquery

from app.config import get_settings
from app.models import OrgConfig
from app.services import store

_PAGE = "pageInfo { hasNextPage endCursor }"
_PROJECTS = """
query ($org: String!, $after: String) {
  organization(login: $org) {
    projectsV2(first: 100, after: $after) {
      nodes { id number title closed }
      PAGE
    }
  }
}
""".replace("PAGE", _PAGE)
_FIELDS = """
query ($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 {
    fields(first: 100, after: $after) {
      nodes { __typename ... on ProjectV2IterationField {
        id name configuration {
          iterations { id title startDate duration }
          completedIterations { id title startDate duration }
        }
      } }
      PAGE
    }
  } }
}
""".replace("PAGE", _PAGE)
_VALUES = """
fieldValues(first: 100, after: $valuesAfter) {
  nodes {
    __typename
    ... on ProjectV2ItemFieldIterationValue {
      iterationId field { ... on ProjectV2IterationField { id name } }
    }
    ... on ProjectV2ItemFieldNumberValue {
      number field { ... on ProjectV2Field { id name } }
    }
    ... on ProjectV2ItemFieldSingleSelectValue {
      name field { ... on ProjectV2SingleSelectField { id name } }
    }
  }
  PAGE
}
""".replace("PAGE", _PAGE)
_ITEMS = """
query ($id: ID!, $after: String, $valuesAfter: String) {
  node(id: $id) { ... on ProjectV2 {
    items(first: 100, after: $after) {
      nodes {
        id
        content {
          __typename
          ... on Issue { repository { nameWithOwner } number title url state }
          ... on PullRequest { repository { nameWithOwner } number title url state }
          ... on DraftIssue { title }
        }
        VALUES
      }
      PAGE
    }
  } }
}
""".replace("VALUES", _VALUES).replace("PAGE", _PAGE)
_ITEM_VALUES = """
query ($id: ID!, $valuesAfter: String) {
  node(id: $id) { ... on ProjectV2Item { VALUES } }
}
""".replace("VALUES", _VALUES)


def parse_iterations(project: dict, fields: list[dict], synced_at: str) -> list[dict]:
    """Iteration end_date is inclusive: start_date + duration_days - 1."""
    rows = []
    for field in fields:
        if field.get("__typename") != "ProjectV2IterationField":
            continue
        for key, completed in (("iterations", False), ("completedIterations", True)):
            for iteration in field["configuration"][key]:
                start = date.fromisoformat(iteration["startDate"])
                rows.append(
                    {
                        "project_id": project["id"],
                        "project_number": project["number"],
                        "project_title": project["title"],
                        "project_closed": project["closed"],
                        "field_id": field["id"],
                        "field_name": field["name"],
                        "iteration_id": iteration["id"],
                        "title": iteration["title"],
                        "start_date": start.isoformat(),
                        "duration_days": iteration["duration"],
                        "end_date": (start + timedelta(days=iteration["duration"] - 1)).isoformat(),
                        "is_completed": completed,
                        "synced_at": synced_at,
                    }
                )
    return rows


def parse_item(project_id: str, item: dict, config: OrgConfig, synced_at: str) -> list[dict]:
    values = item["fieldValues"]["nodes"]
    numbers = {
        value["field"]["name"]: value["number"]
        for value in values
        if value.get("__typename") == "ProjectV2ItemFieldNumberValue"
    }
    status = next(
        (
            value["name"]
            for value in values
            if value.get("__typename") == "ProjectV2ItemFieldSingleSelectValue"
            and value["field"]["name"] == "Status"
        ),
        None,
    )
    content = item.get("content") or {}
    hours_field = config.project_fields.get(project_id, config.default_field_name)
    return [
        {
            "project_id": project_id,
            "item_id": item["id"],
            "field_id": value["field"]["id"],
            "iteration_id": value["iterationId"],
            "content_type": content.get("__typename"),
            "repo": (content.get("repository") or {}).get("nameWithOwner"),
            "issue_number": content.get("number"),
            "issue_title": content.get("title"),
            "issue_url": content.get("url"),
            "issue_state": content.get("state"),
            "status": status,
            "hours": numbers.get(hours_field),
            "number_fields": json.dumps(numbers),
            "synced_at": synced_at,
        }
        for value in values
        if value.get("__typename") == "ProjectV2ItemFieldIterationValue"
        and value.get("iterationId")
    ]


def _graphql(client: httpx.Client, query: str, variables: dict) -> dict:
    response = client.post(
        "https://api.github.com/graphql",
        json={
            "query": query,
            "variables": variables,
        },
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errors"):
        raise RuntimeError(
            "GitHub GraphQL: " + "; ".join(error["message"] for error in payload["errors"])
        )
    return payload["data"]


def _pages(client: httpx.Client, query: str, variables: dict, parent: str, key: str):
    after = None
    while True:
        data = _graphql(client, query, {**variables, "after": after})
        connection = data[parent][key]
        yield from connection["nodes"]
        if not connection["pageInfo"]["hasNextPage"]:
            break
        cursor = connection["pageInfo"]["endCursor"]
        if not cursor or cursor == after:
            raise RuntimeError("GitHub returned a non-advancing pagination cursor")
        after = cursor


def fetch_snapshot(pat: str, org: str, config: OrgConfig) -> tuple[list[dict], list[dict]]:
    iterations, items = [], []
    synced_at = datetime.now(UTC).isoformat()
    with httpx.Client(headers={"Authorization": f"Bearer {pat}"}, timeout=60) as client:
        for project in _pages(client, _PROJECTS, {"org": org}, "organization", "projectsV2"):
            if project["id"] in config.excluded_projects:
                continue
            fields = list(_pages(client, _FIELDS, {"id": project["id"]}, "node", "fields"))
            iterations.extend(parse_iterations(project, fields, synced_at))
            for item in _pages(
                client,
                _ITEMS,
                {
                    "id": project["id"],
                    "valuesAfter": None,
                },
                "node",
                "items",
            ):
                connection = item["fieldValues"]
                after = None
                while connection["pageInfo"]["hasNextPage"]:
                    cursor = connection["pageInfo"]["endCursor"]
                    if not cursor or cursor == after:
                        raise RuntimeError("GitHub returned a non-advancing field value cursor")
                    after = cursor
                    connection = _graphql(
                        client,
                        _ITEM_VALUES,
                        {
                            "id": item["id"],
                            "valuesAfter": after,
                        },
                    )["node"]["fieldValues"]
                    item["fieldValues"]["nodes"].extend(connection["nodes"])
                items.extend(parse_item(project["id"], item, config, synced_at))
    return iterations, items


def write_snapshot(iterations: list[dict], items: list[dict]) -> None:
    settings = get_settings()
    client = bigquery.Client(project=settings.gcp_project, location=settings.bq_location)
    dataset = f"{settings.gcp_project}.{settings.bq_dataset}"
    staging_tables = []
    statements = ["BEGIN TRANSACTION;"]
    try:
        for name, rows in (("iterations", iterations), ("iteration_items", items)):
            destination = f"{dataset}.{name}"
            staging = f"{dataset}._{name}_{uuid4().hex}"
            schema = client.get_table(destination).schema
            staging_tables.append(staging)
            client.create_table(bigquery.Table(staging, schema=schema))
            if rows:
                client.load_table_from_json(
                    rows,
                    staging,
                    job_config=bigquery.LoadJobConfig(
                        schema=schema,
                        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
                    ),
                ).result()
            statements.extend(
                [
                    f"DELETE FROM `{destination}` WHERE TRUE;",
                    f"INSERT INTO `{destination}` SELECT * FROM `{staging}`;",
                ]
            )
        statements.append("COMMIT TRANSACTION;")
        client.query("\n".join(statements)).result()
    finally:
        for staging in staging_tables:
            client.delete_table(staging, not_found_ok=True)


def sync_iterations(pat: str | None = None, *, dry_run: bool = False) -> tuple[list, list]:
    settings = get_settings()
    pat = pat or settings.github_pat
    if not pat:
        raise ValueError("Set TAKT_GITHUB_PAT or pass --pat")
    snapshot = fetch_snapshot(pat, settings.github_org, store.get_org_config())
    if not dry_run:
        write_snapshot(*snapshot)
    return snapshot
