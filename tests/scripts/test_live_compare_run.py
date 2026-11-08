"""Full offline orchestration with vendor API fakes and a stub Docker lifecycle."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import live_compare_support.runner as runner  # type: ignore[import-not-found]
import pytest

from migrator.http import HttpRequest, HttpResponse, HttpTransportError

ROOT = Path(__file__).resolve().parents[2]
ENV = {
    "DD_API_KEY": "test-dd-secret",
    "DD_APP_KEY": "test-app-secret",
    "DD_SITE": "datadoghq.eu",
    "DASH0_AUTH_TOKEN": "test-dash-secret",
    "DASH0_API_URL": "https://dash0.example",
    "DASH0_OTLP_ENDPOINT": "https://ingress.example",
}


class Clock:
    def __init__(self) -> None:
        self.value = 6000.0

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class DockerStub:
    calls: list[str] = []
    interrupt = False

    def __init__(self, *args: Any) -> None:
        pass

    def prepare(self) -> None:
        self.calls.append("prepare")

    def start(self) -> None:
        self.calls.append("start")
        if self.interrupt:
            raise KeyboardInterrupt

    def stop(self) -> None:
        self.calls.append("stop")


class Vendors:
    def __init__(self) -> None:
        self.assets: dict[str, Any] = {}
        self.calls: list[HttpRequest] = []
        self.publication_error: BaseException | None = None
        self.readback_mismatch = False
        self.http_error = False
        self.difference = 0
        self.missing = False
        self.value = 10

    def send(self, req: HttpRequest) -> HttpResponse:
        self.calls.append(req)
        path = urlsplit(req.url).path
        if self.http_error:
            return HttpResponse(403, b"private error content")
        if path == "/api/v1/validate":
            return self.response({"valid": True})
        if path == "/api/v2/query/timeseries":
            assert req.body is not None
            a = json.loads(req.body)["data"]["attributes"]
            times = list(range(a["from"], a["to"], a["interval"]))
            return self.response(
                {
                    "data": {
                        "type": "timeseries_response",
                        "attributes": {
                            "times": times,
                            "series": [{"query_index": 0, "group_tags": []}],
                            "values": [[self.value] * len(times)],
                        },
                    }
                }
            )
        if path == "/api/prometheus/api/v1/query_range":
            q = parse_qs(urlsplit(req.url).query)
            times = list(range(int(q["start"][0]), int(q["end"][0]) + 1, int(q["step"][0])))
            values = [[t, str(self.value + self.difference)] for t in times]
            if self.missing and values:
                values = values[:-1]
            return self.response(
                {
                    "status": "success",
                    "data": {"resultType": "matrix", "result": [{"metric": {}, "values": values}]},
                }
            )
        if path == "/api/dashboards":
            return self.response(
                [
                    {"id": k, "name": v["metadata"]["name"], "dataset": "migration-demo"}
                    for k, v in self.assets.items()
                    if v.get("kind") == "Dashboard"
                ]
            )
        if path.startswith("/api/import/"):
            if self.publication_error:
                raise self.publication_error
            assert req.body is not None
            body = json.loads(req.body)
            if "enabled" in body:
                assert body["enabled"] is False
            asset_id = "asset-" + str(len(self.assets) + 1)
            self.assets[asset_id] = body
            return self.response({**body, "id": asset_id})
        asset_id = path.rsplit("/", 1)[-1]
        actual = copy.deepcopy(self.assets[asset_id])
        if self.readback_mismatch:
            if actual.get("kind") == "Dashboard":
                actual["spec"]["display"]["name"] = "changed"
            else:
                actual["expression"] += " + 1"
        return self.response(actual)

    @staticmethod
    def response(body: Any) -> HttpResponse:
        return HttpResponse(200, json.dumps(body).encode())

    def imports(self) -> list[HttpRequest]:
        return [r for r in self.calls if "/api/import/" in r.url]


@pytest.fixture(autouse=True)
def reset_docker():
    DockerStub.calls = []
    DockerStub.interrupt = False


def args(out: Path, *extra: str) -> list[str]:
    return [
        "--dataset-config",
        str(ROOT / "scripts/live/datasets/otel-demo.yaml"),
        "--tests",
        str(ROOT / "scripts/live/suites/default.yaml"),
        "--dash0-dataset",
        "migration-demo",
        "--out",
        str(out),
        *extra,
    ]


def run(out: Path, vendors: Vendors, *extra: str, env: dict[str, str] | None = None) -> int:
    clock = Clock()
    return int(
        runner.main(
            args(out, *extra),
            ENV if env is None else env,
            vendors.send,
            DockerStub,
            clock.now,
            clock.sleep,
        )
    )


def test_dry_run_needs_no_credentials_docker_or_network(tmp_path):
    vendors = Vendors()
    assert run(tmp_path / "out", vendors, "--dry-run", env={}) == 0
    assert not vendors.calls and not DockerStub.calls
    assert not (tmp_path / "out").exists()


def test_default_end_to_end_fake_run_and_receipt_reuse(tmp_path):
    vendors = Vendors()
    assert run(tmp_path, vendors) == 0
    report = json.loads((tmp_path / "comparison.json").read_text())
    assert report["status"] == "passed" and len(report["cases"]) == 6
    assert all(a["readback"] == "passed" for a in report["assets"])
    assert len(vendors.imports()) == 2
    assert DockerStub.calls == ["stop", "prepare", "start", "stop"]
    assert report["cases"][-1]["thresholdDecisions"]["status"] == "passed"
    artifacts = {p: p.read_bytes() for p in (tmp_path / "compiled").rglob("*") if p.is_file()}
    assert run(tmp_path, vendors) == 0
    assert len(vendors.imports()) == 2
    assert DockerStub.calls.count("start") == 1
    assert all(p.read_bytes() == data for p, data in artifacts.items())
    text = (tmp_path / "comparison.json").read_text() + (tmp_path / "comparison.md").read_text()
    assert all(secret not in text for key, secret in ENV.items() if "KEY" in key or "TOKEN" in key)


@pytest.mark.parametrize("field", ["readback_mismatch", "missing", "difference"])
def test_live_mismatches_fail_with_evidence_and_cleanup(tmp_path, field):
    vendors = Vendors()
    setattr(vendors, field, 1 if field == "difference" else True)
    assert run(tmp_path, vendors) == 2
    assert json.loads((tmp_path / "comparison.json").read_text())["status"] == "failed"
    assert DockerStub.calls[-1] == "stop"


def test_api_failure_stops_before_start_or_publish_and_records_error(tmp_path):
    vendors = Vendors()
    vendors.http_error = True
    assert run(tmp_path, vendors) == 1
    assert "start" not in DockerStub.calls and not vendors.imports()
    assert "HTTP 403" in (tmp_path / "comparison.json").read_text()
    assert "private error content" not in (tmp_path / "comparison.json").read_text()


def test_missing_credentials_are_an_error_before_docker(tmp_path):
    assert run(tmp_path, Vendors(), env={}) == 1
    assert not DockerStub.calls


def test_ambiguous_timeout_is_never_retried(tmp_path):
    vendors = Vendors()
    vendors.publication_error = HttpTransportError("ambiguous timeout")
    assert run(tmp_path, vendors) == 1
    count = len(vendors.imports())
    vendors.publication_error = None
    assert run(tmp_path, vendors) == 1
    assert len(vendors.imports()) == count
    assert all(
        r["status"] == "unknown"
        for r in json.loads((tmp_path / "compiled/import-results.json").read_text())
    )


def test_interrupted_publication_requires_reconciliation(tmp_path):
    vendors = Vendors()
    vendors.publication_error = KeyboardInterrupt()
    assert run(tmp_path, vendors) == 1
    count = len(vendors.imports())
    assert json.loads((tmp_path / "state.json").read_text())["publicationInFlight"]
    vendors.publication_error = None
    assert run(tmp_path, vendors) == 1
    assert len(vendors.imports()) == count
    assert DockerStub.calls[-1] == "stop"


def test_interrupted_start_always_cleans_up(tmp_path):
    DockerStub.interrupt = True
    vendors = Vendors()
    assert run(tmp_path, vendors) == 1
    assert DockerStub.calls[-1] == "stop"
    assert not vendors.imports()


def test_keep_running_is_explicit(tmp_path):
    assert run(tmp_path, Vendors(), "--keep-running") == 0
    assert DockerStub.calls == ["stop", "prepare", "start"]


def test_semantic_mode_recheck_reuses_same_window_and_publication_receipts(tmp_path):
    vendors = Vendors()
    assert run(tmp_path, vendors) == 0
    state = json.loads((tmp_path / "state.json").read_text())
    assert run(tmp_path, vendors, "--datadog-semantic-mode", "combined") == 0
    assert json.loads((tmp_path / "state.json").read_text())["start"] == state["start"]
    assert len(vendors.imports()) == 2 and DockerStub.calls.count("start") == 1
    report = json.loads((tmp_path / "comparison.json").read_text())
    assert report["querySettings"]["datadogSemanticModeOverride"] == "combined"
    assert all(
        q["semantic_mode"] == "combined" for c in report["cases"] for q in c["sourceQueries"]
    )


def test_threshold_mismatch_fails_even_when_numeric_difference_is_within_tolerance(tmp_path):
    vendors = Vendors()
    vendors.value, vendors.difference = 79, 2
    assert run(tmp_path, vendors) == 2
    report = json.loads((tmp_path / "comparison.json").read_text())
    monitor = next(c for c in report["cases"] if c["id"] == "connection-monitor")
    assert monitor["series"][0]["passed"]
    assert monitor["thresholdDecisions"]["status"] == "failed"


def test_cleanup_failure_is_an_operational_error(tmp_path):
    class FailingStop(DockerStub):
        def stop(self) -> None:
            if "start" in self.calls:
                raise RuntimeError("cleanup failed")
            super().stop()

    clock = Clock()
    assert (
        runner.main(args(tmp_path), ENV, Vendors().send, FailingStop, clock.now, clock.sleep) == 1
    )
    assert "cleanupError" in json.loads((tmp_path / "comparison.json").read_text())


def test_changed_configuration_and_tampered_artifacts_refuse_resume(tmp_path):
    vendors = Vendors()
    assert run(tmp_path, vendors) == 0
    assert run(tmp_path, vendors, "--case", "redis-memory") == 1
    p = next((tmp_path / "compiled/dashboards").glob("*.json"))
    p.write_text("{}")
    assert run(tmp_path, vendors) == 1
    assert len(vendors.imports()) == 2


def test_unknown_case_and_wrong_destination_are_configuration_errors(tmp_path):
    assert run(tmp_path, Vendors(), "--case", "unknown", "--dry-run") == 1
    assert run(tmp_path, Vendors(), env={**ENV, "DASH0_OTLP_ENDPOINT": "http://example"}) == 1
