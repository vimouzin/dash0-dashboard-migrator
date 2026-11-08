"""Round trip (plan 10 Task 2): fetch by ID, then convert the fetched folder.

Compared against the P1 golden (#82), which stands in for the plan's P0 golden. The
fake API responses carry the server-side fields real GET responses add, so convert
is shown to tolerate them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from migrator.cli import main
from migrator.convert import ConvertOptions, run_convert
from migrator.fetch import run_fetch
from migrator.http import HttpRequest, HttpResponse
from migrator.input import InputError
from migrator.source.asset import FetchSelection

PG = Path("fixtures/datadog/integrations-core/postgres")
DASHBOARD_ID = "abc-def-123"
MONITOR_ID = "4242"
ENV = {"DD_API_KEY": "ddapi_SECRET", "DD_APP_KEY": "ddapp_SECRET"}


# Server-side fields the real GET endpoints add around the definition (Datadog API
# reference: Dashboards "Get a dashboard", Monitors "Get a monitor's details").
DASHBOARD_API_FIELDS = {
    "id": DASHBOARD_ID,
    "author_handle": "someone@example.com",
    "author_name": "Someone",
    "created_at": "2026-01-02T03:04:05.000000+00:00",
    "modified_at": "2026-01-03T03:04:05.000000+00:00",
    "url": f"/dashboard/{DASHBOARD_ID}/postgres-metrics",
    "is_read_only": False,
    "notify_list": [],
    "restricted_roles": [],
}
MONITOR_API_FIELDS = {
    "id": int(MONITOR_ID),
    "created": "2026-01-02T03:04:05.000000+00:00",
    "modified": "2026-01-03T03:04:05.000000+00:00",
    "creator": {"email": "someone@example.com", "handle": "someone@example.com", "name": "S"},
    "overall_state": "OK",
    "org_id": 1,
    "deleted": None,
    "multi": False,
    "restricted_roles": None,
}


def fake_datadog(req: HttpRequest) -> HttpResponse:
    if req.url.endswith(f"/api/v1/dashboard/{DASHBOARD_ID}"):
        body = json.loads((PG / "dashboards/postgresql_dashboard.json").read_text())
        return HttpResponse(200, json.dumps({**DASHBOARD_API_FIELDS, **body}).encode())
    if req.url.endswith(f"/api/v1/monitor/{MONITOR_ID}"):
        wrapped = json.loads((PG / "monitors/percent_usage_connections.json").read_text())
        # The API returns the inner definition, not integrations-core's wrapper.
        body = {**MONITOR_API_FIELDS, **wrapped["definition"]}
        return HttpResponse(200, json.dumps(body).encode())
    return HttpResponse(404, b'{"errors": ["Not found"]}')


def test_fetched_folder_converts(tmp_path: Path) -> None:
    fetched = tmp_path / "fetched"
    written = run_fetch(
        "datadog", FetchSelection((DASHBOARD_ID,), (MONITOR_ID,)), str(fetched), ENV, fake_datadog
    )
    assert written == [f"dashboards/{DASHBOARD_ID}.json", f"monitors/{MONITOR_ID}.json"]

    out = tmp_path / "out"
    result = run_convert(
        ConvertOptions(
            source="datadog",
            inputs=[str(fetched)],
            mapping=["fixtures/mappings/postgres.json"],  # the frozen copy, as the issue asks
            out=str(out),
        )
    )
    expected = Path("fixtures/expected/postgres-p1/dashboards/postgres-metrics.json")
    assert (out / "dashboards/postgres-metrics.json").read_bytes() == expected.read_bytes()
    kinds = sorted(
        (i["kind"], i["sourceId"]) for i in result.report["items"] if i["sourcePath"] == ""
    )
    assert kinds == [
        ("dashboard", f"fetched/dashboards/{DASHBOARD_ID}.json"),
        ("monitor", f"fetched/monitors/{MONITOR_ID}.json"),
    ]


def test_cli_fetch_requires_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("DD_API_KEY", raising=False)
    monkeypatch.delenv("DD_APP_KEY", raising=False)
    code = main(
        ["fetch", "--source", "datadog", "--dashboard-id", "a", "--out", str(tmp_path / "o")]
    )
    assert code == 1
    assert "missing env: DD_API_KEY, DD_APP_KEY" in capsys.readouterr().err


def test_cli_fetch_rejects_empty_selection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    code = main(["fetch", "--source", "datadog", "--out", str(tmp_path / "o")])
    assert code == 1
    assert "select at least one" in capsys.readouterr().err


def test_unknown_source_is_input_error(tmp_path: Path) -> None:
    with pytest.raises(InputError, match="unknown --source"):
        run_fetch("nope", FetchSelection(("a",)), str(tmp_path / "o"), ENV, fake_datadog)


def test_shared_cli_imports_no_source_specific_code() -> None:
    # AGENTS: the shared CLI stays free of source-specific logic.
    assert "migrator.source.datadog" not in Path("src/migrator/cli.py").read_text()
