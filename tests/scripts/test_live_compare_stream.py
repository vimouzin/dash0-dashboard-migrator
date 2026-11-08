"""Reusable stream readiness, independent suites and explicit remark coverage."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import live_compare_support.config as cfg  # type: ignore[import-not-found]
import live_compare_support.environment as environment  # type: ignore[import-not-found]
import live_compare_support.runner as runner  # type: ignore[import-not-found]
import pytest

from tests.scripts.test_live_compare_run import ENV, ROOT, Clock, DockerStub, Vendors, args


class StreamDocker(DockerStub):
    ready = True

    def healthy(self) -> bool:
        return self.ready


@pytest.fixture(autouse=True)
def reset_stream():
    StreamDocker.calls = []
    StreamDocker.interrupt = False
    StreamDocker.ready = True


def invoke(tmp: Path, clock: Clock, vendors: Vendors, *extra: str) -> int:
    return int(
        runner.main(
            args(tmp / "results", "--stream-dir", str(tmp / "stream"), *extra),
            ENV,
            vendors.send,
            StreamDocker,
            clock.now,
            clock.sleep,
        )
    )


def test_stream_start_returns_without_measurement_sleep_or_publication(tmp_path):
    clock, vendors = Clock(), Vendors()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    assert clock.value == 6000
    assert not vendors.imports()
    assert StreamDocker.calls == ["stop", "prepare", "start"]
    state = json.loads((tmp_path / "stream/stream.json").read_text())
    assert state["status"] == "running" and state["startedAt"] == 6000
    assert not (tmp_path / "results").exists()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    assert StreamDocker.calls.count("start") == 1


def test_ready_stream_evaluates_immediately_and_reuses_receipts(tmp_path):
    clock, vendors = Clock(), Vendors()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    clock.value = 9000
    assert invoke(tmp_path, clock, vendors) == 0
    assert clock.value == 9000
    assert StreamDocker.calls == ["stop", "prepare", "start"]
    report = json.loads((tmp_path / "results/comparison.json").read_text())
    assert report["containers"] == "retained"
    assert report["window"] == {"start": 8280, "endExclusive": 8880, "step": 60}
    assert report["stream"]["startedAt"] == 6000
    assert len(vendors.imports()) == 2
    monitor = report["cases"][-1]
    assert (monitor["conversionOutcome"], monitor["remarks"]) == ("approximated", ["FULLWINDOW"])
    assert invoke(tmp_path, clock, vendors) == 0
    assert len(vendors.imports()) == 2 and clock.value == 9000


def test_insufficient_history_is_immediate_and_does_not_publish(tmp_path, capsys):
    clock, vendors = Clock(), Vendors()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    clock.value += 10
    assert invoke(tmp_path, clock, vendors) == 2
    assert "insufficient history" in capsys.readouterr().out
    assert clock.value == 6010 and not vendors.imports()
    assert StreamDocker.calls[-1] == "start"


def test_unhealthy_or_stopped_stream_is_rejected_without_restarting(tmp_path, capsys):
    clock, vendors = Clock(), Vendors()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    clock.value = 9000
    StreamDocker.ready = False
    assert invoke(tmp_path, clock, vendors) == 2
    assert "unhealthy" in capsys.readouterr().out
    assert not vendors.imports()
    assert invoke(tmp_path, clock, vendors, "--stop-stream") == 0
    StreamDocker.ready = True
    assert invoke(tmp_path, clock, vendors) == 2
    assert StreamDocker.calls == ["stop", "prepare", "start", "stop"]


def test_stream_destination_mismatch_is_rejected(tmp_path, capsys):
    clock, vendors = Clock(), Vendors()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    clock.value = 9000
    assert invoke(tmp_path, clock, vendors, "--dash0-dataset", "another-demo") == 1
    assert "workload/destination changed" in capsys.readouterr().out
    assert not vendors.imports()


def test_one_failed_publication_keeps_other_cases_and_reuses_successful_receipt(tmp_path):
    from migrator.http import HttpResponse

    class OneRejected(Vendors):
        def send(self, req: Any) -> Any:
            if "/api/import/dashboard" in req.url:
                self.calls.append(req)
                return HttpResponse(400, b"unsupported panel plugin")
            return super().send(req)

    clock, vendors = Clock(), OneRejected()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    clock.value = 9000
    assert invoke(tmp_path, clock, vendors) == 1
    report = json.loads((tmp_path / "results/comparison.json").read_text())
    assert len(report["cases"]) == 6
    assert [c["status"] for c in report["cases"]] == ["failed"] * 5 + ["passed"]
    assert report["assets"][1]["readback"] == "not_run"
    count = len(vendors.imports())
    assert invoke(tmp_path, clock, vendors) == 1
    assert len(vendors.imports()) == count + 1
    assert sum("/api/import/check-rule" in req.url for req in vendors.imports()) == 1


def test_stream_can_feed_new_case_selections_without_new_warmup(tmp_path):
    clock, vendors = Clock(), Vendors()
    assert invoke(tmp_path, clock, vendors, "--start-stream") == 0
    clock.value = 9000
    assert invoke(tmp_path, clock, vendors, "--case", "postgres-connections") == 0
    assert (
        invoke(tmp_path, clock, vendors, "--out", str(tmp_path / "other"), "--case", "redis-memory")
        == 0
    )
    first = json.loads((tmp_path / "results/comparison.json").read_text())
    second = json.loads((tmp_path / "other/comparison.json").read_text())
    assert first["stream"] == second["stream"]
    assert first["runId"] == second["runId"]
    assert first["assets"][0]["id"] != second["assets"][0]["id"]
    assert StreamDocker.calls.count("start") == 1 and clock.value == 9000


def test_stream_interrupted_start_is_cleaned_up(tmp_path):
    StreamDocker.interrupt = True
    with pytest.raises(KeyboardInterrupt):
        invoke(tmp_path, Clock(), Vendors(), "--start-stream")
    assert StreamDocker.calls == ["stop", "prepare", "start", "stop"]
    assert json.loads((tmp_path / "stream/stream.json").read_text())["status"] == "stopped"


def test_infrastructure_suite_has_all_six_integrations_and_approved_outcomes(tmp_path):
    path = ROOT / "scripts/live/suites/infrastructure.yaml"
    suite = cfg.load(path, cfg.Suite)
    runner.compile_suite(suite, path, tmp_path / "compiled")
    assert len(suite.cases) == 28
    assert {c.id.split("-", 1)[0] for c in suite.cases} == {
        "postgres",
        "redis",
        "nginx",
        "kafka",
        "host",
        "docker",
    }
    assert {c.expected_outcome for c in suite.cases} == {"translated", "assumed", "approximated"}
    assert {tag for c in suite.cases for tag in c.expected_remarks or []} == {
        "TIMEPIN",
        "FULLWINDOW",
        "NEWHOST",
        "SEMANTIC",
        "DERIVED",
        "TOPN",
    }
    for case in suite.cases:
        runner.bind_case(tmp_path / "compiled", case, suite, "demo-live-test")
    bad = suite.cases[2].model_copy(update={"expected_outcome": "translated"})
    with pytest.raises(runner.DataError, match="expected translated, got assumed"):
        runner.bind_case(tmp_path / "compiled", bad, suite, "demo-live-test")
    bad = suite.cases[2].model_copy(update={"expected_remarks": []})
    with pytest.raises(runner.DataError, match="remark tags"):
        runner.bind_case(tmp_path / "compiled", bad, suite, "demo-live-test")


@pytest.mark.parametrize("state", ["exited", "restarting", "paused"])
def test_stream_health_rejects_nonrunning_service(tmp_path, state):
    (tmp_path / "compose.json").write_text(json.dumps({"services": {"otel-collector": {}}}))

    def execute(*args: Any) -> str:
        return json.dumps({"Service": "otel-collector", "State": state, "Health": ""})

    workload = cfg.load(ROOT / "scripts/live/datasets/infrastructure.yaml", cfg.Workload)
    instance = environment.Environment(
        tmp_path, workload, tmp_path / "profile", "demo", {}, execute=execute
    )
    assert not instance.healthy()


def test_opt_in_metrics_are_enabled_from_documented_receiver_names():
    workload = cfg.load(ROOT / "scripts/live/datasets/infrastructure.yaml", cfg.Workload)
    receivers = environment.collector_config(workload, "demo")["receivers"]
    assert receivers["postgresql"]["metrics"]["postgresql.database.locks"]["enabled"]
    assert receivers["redis"]["metrics"]["redis.maxmemory"]["enabled"]
    assert receivers["docker_stats"]["metrics"]["container.state.status"]["enabled"]
    assert receivers["hostmetrics"]["scrapers"]["memory"]["metrics"][
        "system.linux.memory.available"
    ]["enabled"]
