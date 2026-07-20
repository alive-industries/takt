from app import exporter


class _Job:
    def result(self):
        return self


class _Table:
    schema = []


class _Client:
    def __init__(self):
        self.loaded_rows = None
        self.deleted = None

    def get_table(self, _destination):
        return _Table()

    def load_table_from_json(self, rows, _staging, job_config):
        self.loaded_rows = rows
        assert job_config.ignore_unknown_values is True
        return _Job()

    def query(self, sql):
        assert "MERGE" in sql
        return _Job()

    def delete_table(self, staging, not_found_ok):
        self.deleted = staging
        assert not_found_ok is True


def test_exporter_coalesces_multiple_events_for_one_session(monkeypatch) -> None:
    client = _Client()
    completed = []
    monkeypatch.setattr(
        exporter,
        "_claim",
        lambda _size: [
            (
                1,
                {
                    "session_id": "same",
                    "duration_ms": 100,
                    "reporting_status": "complete",
                    "source": "manual",
                    "entry_type": "ops",
                },
            ),
            (
                2,
                {
                    "session_id": "same",
                    "duration_ms": 200,
                    "reporting_status": "complete",
                    "source": "manual",
                    "entry_type": "ops",
                },
            ),
        ],
    )
    monkeypatch.setattr(exporter, "_complete", lambda ids: completed.extend(ids))
    monkeypatch.setattr(exporter.bigquery, "Client", lambda **_kwargs: client)

    assert exporter.export_pending() == 2
    assert client.loaded_rows is not None
    assert len(client.loaded_rows) == 1
    assert client.loaded_rows[0]["duration_ms"] == 200
    assert client.loaded_rows[0]["replicated_at"]
    assert completed == [1, 2]
    assert client.deleted is not None
