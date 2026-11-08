"""The demo adapter calls the real offline compiler and exposes no vendor writes."""

from __future__ import annotations

import json
from collections.abc import Iterator
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread
from typing import Any

import pytest

from backend.server import MAX_BODY, Server, convert_request
from migrator.input import InputError

SUPPORTED = Path("fixtures/datadog/synthetic/dashboards/supported.json")


def upload(text: str, name: str = "dashboard.json") -> dict[str, Any]:
    return {"files": [{"name": name, "text": text}]}


def test_uploaded_conversion_is_deterministic_and_returns_real_artifacts() -> None:
    payload = upload(SUPPORTED.read_text())
    first = convert_request(payload)
    assert first == convert_request(payload)
    assert first["report"]["summary"]["widgets"]["translated"] == 2
    assert first["report"]["validation"]["api"] == "not_run"
    assert first["report"]["validation"]["semantics"] == "not_run"
    artifacts = first["artifacts"]
    assert artifacts["source/dashboard.json"] == SUPPORTED.read_text()
    dashboard = next(json.loads(v) for k, v in artifacts.items() if k.startswith("dashboards/"))
    assert dashboard["kind"] == "Dashboard"
    assert len(dashboard["spec"]["panels"]) == 2
    assert "/tmp/" not in json.dumps(first)
    assert "migrator-preview-" not in json.dumps(first)


def test_demo_runs_real_converter_and_keeps_disabled_checks() -> None:
    result = convert_request({"files": []})
    assert result["exitCode"] == 2
    assert result["report"]["summary"]["monitors"]["blocked"] == 1
    checks = [json.loads(v) for k, v in result["artifacts"].items() if k.startswith("check-rules/")]
    assert checks and all(check["enabled"] is False for check in checks)
    assert json.loads(result["artifacts"]["report.json"]) == result["report"]
    assert json.loads(result["artifacts"]["manifest.json"]) == result["manifest"]


@pytest.mark.parametrize("payload", [
    [], {"files": "wrong"}, {"files": [None]}, upload("{}", "../escape.json"),
    upload("{}", "..\\escape.json"), upload("{}", "bad.txt"), upload("{}", "bad\x00.json"),
    {"files": [{"name": "bad.json", "text": 3}]},
    {"files": [{"name": "same.json", "text": "{}"}] * 2},
    upload("not json"), upload("{}"),
])
def test_invalid_uploads_fail_without_guessing(payload: Any) -> None:
    with pytest.raises(InputError):
        convert_request(payload)


@pytest.fixture
def connection(monkeypatch: pytest.MonkeyPatch) -> Iterator[HTTPConnection]:
    # Local transport only; conversion tests above retain the suite's no-network guard.
    monkeypatch.undo()
    with Server(("127.0.0.1", 0)) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            yield client
        finally:
            client.close()
            server.shutdown()
            thread.join(timeout=5)


def test_http_serves_frontend_and_real_conversion(connection: HTTPConnection) -> None:
    connection.request("GET", "/")
    response = connection.getresponse()
    assert response.status == 200
    assert b'id="source-files"' in response.read()
    connection.request("POST", "/api/convert", json.dumps(upload(SUPPORTED.read_text())),
                       {"Content-Type": "application/json"})
    response = connection.getresponse()
    assert response.status == 200
    result = json.loads(response.read())
    assert result["report"]["summary"]["widgets"]["translated"] == 2
    assert result["artifacts"]


@pytest.mark.parametrize(("path", "body", "headers", "status"), [
    ("/api/publish", "{}", {"Content-Type": "application/json"}, 404),
    ("/api/convert", "{}", {"Content-Type": "text/plain"}, 415),
    ("/api/convert", "{", {"Content-Type": "application/json"}, 400),
    ("/api/convert", json.dumps(upload("not json")), {"Content-Type": "application/json"}, 400),
    ("/api/convert", "{}", {"Content-Type": "application/json", "Origin": "http://elsewhere"}, 403),
    ("/api/convert", "{}", {"Content-Type": "application/json",
                            "Content-Length": str(MAX_BODY + 1)}, 413),
])
def test_http_errors_are_json(
    connection: HTTPConnection, path: str, body: str, headers: dict[str, str], status: int
) -> None:
    connection.request("POST", path, body, headers)
    response = connection.getresponse()
    assert response.status == status
    assert json.loads(response.read())["error"]
