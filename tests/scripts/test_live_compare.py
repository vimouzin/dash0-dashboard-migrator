"""Behavioral tests: independent configs, strict comparison and query contracts."""

from __future__ import annotations

import copy
import json
import re
import signal
from pathlib import Path
from typing import Any

import live_compare_support.comparison as cp  # type: ignore[import-not-found]
import live_compare_support.config as cfg  # type: ignore[import-not-found]
import live_compare_support.environment as docker  # type: ignore[import-not-found]
import live_compare_support.queries as queries  # type: ignore[import-not-found]
import live_compare_support.runner as runner  # type: ignore[import-not-found]
import promql_parser as prom
import pytest
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]
PROFILE = ROOT / "scripts/live/datasets/otel-demo.yaml"
SUITE = ROOT / "scripts/live/suites/default.yaml"


def case(**changes: Any) -> Any:
    return cfg.Case.model_validate(
        {
            "id": "example",
            "source": "d.json",
            "panel": "widget-0",
            "request": "/widgets/0/definition/requests/0",
            **changes,
        }
    )


def series(values: list[float], labels: dict[str, str] | None = None) -> Any:
    return [cp.Series(labels or {}, dict(zip([0, 60], values, strict=True)))]


@pytest.mark.parametrize(
    "value,passed", [(103, True), (103.00001, False), (97, True), (96.99, False)]
)
def test_tolerance_boundary(value, passed):
    result = cp.compare(case(), series([100, 100]), series([value, value]), [0, 60])
    assert (result["status"] == "passed") == passed


def test_window_mean_and_pointwise_are_distinct():
    a, b = series([90, 110]), series([110, 90])
    assert cp.compare(case(), a, b, [0, 60])["status"] == "passed"
    assert cp.compare(case(mode="per_bucket"), a, b, [0, 60])["status"] == "failed"


def test_zero_denominator_and_explicit_absolute_tolerance():
    c = case(require_nonzero=False)
    assert cp.compare(c, series([0, 0]), series([0, 0]), [0, 60])["status"] == "passed"
    assert cp.compare(c, series([0, 0]), series([0.01, 0.01]), [0, 60])["status"] == "failed"
    c = case(require_nonzero=False, absolute_tolerance=0.01)
    assert cp.compare(c, series([0, 0]), series([0.01, 0.01]), [0, 60])["status"] == "passed"
    with pytest.raises(cp.DataError, match="nonzero"):
        cp.compare(case(), series([0, 0]), series([0, 0]), [0, 60])


@pytest.mark.parametrize(
    "a,b",
    [
        ([], []),
        (series([1, 1]), []),
        ([cp.Series({}, {0: 1})], series([1, 1])),
        (series([1, 1]) * 2, series([1, 1])),
    ],
)
def test_missing_or_ambiguous_series_never_pass(a, b):
    with pytest.raises(cp.DataError):
        cp.compare(case(), a, b, [0, 60])


def test_explicit_group_pairs_ignore_order_but_reject_missing_groups():
    c = case(series_labels={"db": "postgresql_database_name"})
    a = [*series([1, 1], {"db": "one"}), *series([2, 2], {"db": "two"})]
    b = [
        *series([2, 2], {"postgresql_database_name": "two"}),
        *series([1, 1], {"postgresql_database_name": "one"}),
    ]
    assert cp.compare(c, a, b, [0, 60])["status"] == "passed"
    with pytest.raises(cp.DataError):
        cp.compare(c, a, b[:1], [0, 60])


@pytest.mark.parametrize("value", [None, True, "NaN", "Inf", "-Inf", "bad"])
def test_bad_samples_are_rejected(value):
    with pytest.raises(cp.DataError):
        cp.samples([0], [value], 1)


def test_duplicate_or_unaligned_timestamps_are_rejected():
    with pytest.raises(cp.DataError):
        cp.samples([0, 0], [1, 1], 1)
    with pytest.raises(cp.DataError):
        cp.samples([0.1], [1], 1)
    with pytest.raises(cp.DataError, match="coverage"):
        cp.compare(case(), [cp.Series({}, {1: 10, 61: 10})], series([10, 10]), [0, 60])


def test_documented_datadog_response_shape():
    body: Any = {
        "data": {
            "type": "timeseries_response",
            "attributes": {
                "series": [{"query_index": 0, "group_tags": ["db:test"]}],
                "times": [0, 60000],
                "values": [[1, 2]],
            },
        }
    }
    assert cp.datadog_series(body) == [cp.Series({"db": "test"}, {0: 1, 60: 2})]
    body["data"]["attributes"]["values"] = []
    with pytest.raises(cp.DataError):
        cp.datadog_series(body)


def test_dash0_warnings_and_malformed_results_fail():
    body = {
        "status": "success",
        "warnings": ["gaps"],
        "data": {"resultType": "matrix", "result": []},
    }
    with pytest.raises(cp.DataError):
        cp.dash0_series(body)
    with pytest.raises(cp.DataError):
        cp.dash0_series({"status": "success", "data": {"resultType": "vector"}})


@pytest.mark.parametrize(
    "change",
    [
        {"relative_tolerance_pct": -1},
        {"relative_tolerance_pct": float("nan")},
        {"mode": "guess"},
        {"unexpected": True},
        {"series_labels": {"a": "x", "b": "x"}},
    ],
)
def test_invalid_cases_rejected(change):
    with pytest.raises(ValidationError):
        case(**change)


def test_suite_rejects_duplicates_and_misaligned_windows():
    data = cfg.load(SUITE, cfg.Suite).model_dump()
    data["cases"].append(data["cases"][0])
    with pytest.raises(ValidationError):
        cfg.Suite.model_validate(data)
    data = cfg.load(SUITE, cfg.Suite).model_dump()
    data["window_seconds"] = 601
    with pytest.raises(ValidationError):
        cfg.Suite.model_validate(data)


def test_variable_literals_are_regex_and_json_escaped():
    bound = queries.target_query('{label=~"^($tag)$"}', {"tag": 'a.b"x\\y'}, "5m", "demo")
    ast = prom.parse(bound)
    assert isinstance(ast, prom.VectorSelector)
    assert ast.matchers.matchers[0].value == "^(" + re.escape('a.b"x\\y') + ")$"
    assert any(m.name == "host_name" and m.value == "demo" for m in ast.matchers.matchers)
    with pytest.raises(cp.DataError, match="safely"):
        queries.source_query(
            "avg:postgresql.connections{$tag}", {"tag": "a,b"}, {"tag": "host"}, "demo"
        )


def test_unbound_variables_and_conflicting_scope_fail():
    with pytest.raises(cp.DataError, match="unbound"):
        queries.target_query('{a=~"$missing"}', {}, "5m", "demo")
    with pytest.raises(cp.DataError, match="conflicts"):
        queries.source_query("avg:postgresql.connections{host:production}", {}, {}, "demo")


def test_every_nested_selector_is_scoped_and_strings_roundtrip():
    text = (
        'sum(rate({m="a",tag=~"$tag"}[$__rate_interval])) + '
        'sum(label_replace({m="b"}, "dst", "$1", "src", "(.*)"))'
    )
    bound = queries.target_query(text, {"tag": "a.b"}, "5m", "demo")
    found: list[bool] = []

    def visit(node: Any) -> None:
        if isinstance(node, prom.VectorSelector):
            found.append(
                any(m.name == "host_name" and m.value == "demo" for m in node.matchers.matchers)
            )

    prom.walk(prom.parse(bound), pre_visit=visit)
    assert found == [True, True]
    assert '"$1"' in bound


def test_negative_request_indices_are_not_json_pointer_array_indices():
    with pytest.raises(ValidationError):
        case(request="/widgets/0/definition/requests/-1")


def test_default_pairs_compile_deterministically_and_wrong_pair_fails(tmp_path):
    suite = cfg.load(SUITE, cfg.Suite)
    a, b = tmp_path / "a", tmp_path / "b"
    runner.compile_suite(suite, SUITE, a)
    runner.compile_suite(suite, SUITE, b)
    assert {p.relative_to(a): p.read_bytes() for p in a.rglob("*") if p.is_file()} == {
        p.relative_to(b): p.read_bytes() for p in b.rglob("*") if p.is_file()
    }
    for item in suite.cases:
        _, bound = runner.bind_case(a, item, suite, "demo-live-test")
        assert "host_name" in bound.target
        assert all("host:demo-live-test" in q["query"] for q in bound.queries)
    bad = suite.cases[0].model_copy(update={"panel": "widget-1"})
    with pytest.raises(cp.DataError, match="correspond"):
        runner.bind_case(a, bad, suite, "demo-live-test")


def test_source_semantic_mode_is_preserved_and_override_is_explicit(tmp_path):
    suite = cfg.load(SUITE, cfg.Suite)
    runner.compile_suite(suite, SUITE, tmp_path / "compiled")
    _, source, target = runner.artifact(tmp_path / "compiled", suite.cases[0])
    source["widgets"][0]["definition"]["requests"][0]["queries"][0]["semantic_mode"] = "combined"
    bound = queries.pair(suite.cases[0], source, target, "5m", "demo-live-test")
    assert bound.queries[0]["semantic_mode"] == "combined"
    explicit = queries.with_semantic_mode(bound, "native")
    assert explicit.queries[0]["semantic_mode"] == "native"
    assert bound.queries[0]["semantic_mode"] == "combined"
    assert explicit.target == bound.target
    assert queries.with_semantic_mode(bound, None) is bound
    with pytest.raises(cp.DataError):
        queries.with_semantic_mode(bound, "guess")


def test_dash0_is_evaluated_at_bucket_end_and_keyed_by_bucket_start():
    from migrator.destination.dash0 import Dash0Config
    from migrator.http import HttpResponse

    seen: list[str] = []

    def send(req: Any) -> Any:
        seen.append(req.url)
        values = [[120, "1"], [180, "2"]]
        result = [{"metric": {}, "values": values}]
        body = {"status": "success", "data": {"resultType": "matrix", "result": result}}
        return HttpResponse(200, json.dumps(body).encode())

    bound = queries.BoundQuery([], "a", "up")
    dash0 = Dash0Config(api_url="https://dash0.example", token="t", dataset="d")
    out = queries.query_target(bound, 60, 180, 60, dash0, send)
    assert "start=120&end=180&step=60" in seen[0]
    assert out[0].samples == {60: 1.0, 120: 2.0}


def test_monitor_thresholds_are_checked_against_the_source_monitor(tmp_path):
    suite = cfg.load(SUITE, cfg.Suite)
    runner.compile_suite(suite, SUITE, tmp_path / "compiled")
    monitor = next(c for c in suite.cases if c.kind == "monitor")
    _, source, target = runner.artifact(tmp_path / "compiled", monitor)
    assert queries.pair(monitor, source, target, "5m", "demo-live-test").thresholds
    swapped = {**target, "thresholds": {"failed": 80.0, "degraded": 100.0}}
    with pytest.raises(cp.DataError, match="thresholds differ"):
        queries.pair(monitor, source, swapped, "5m", "demo-live-test")


def test_readback_allows_only_known_normalizations(tmp_path):
    suite = cfg.load(SUITE, cfg.Suite)
    runner.compile_suite(suite, SUITE, tmp_path / "compiled")
    _, _, monitor = runner.artifact(tmp_path / "compiled", suite.cases[-1])
    actual = copy.deepcopy(monitor)
    actual.update(name="demo-" + monitor["name"], interval="1m0s", metadata={"labels": {}})
    assert runner.validate_readback(monitor, actual, "check-rule", "demo-")
    actual["metadata"]["annotations"] = {"dash0.com/deleted-at": "deleted"}
    assert not runner.validate_readback(monitor, actual, "check-rule", "demo-")
    actual["metadata"].pop("annotations")
    actual["enabled"] = True
    assert not runner.validate_readback(monitor, actual, "check-rule", "demo-")
    actual["enabled"] = False
    actual["expression"] += " + 1"
    assert not runner.validate_readback(monitor, actual, "check-rule", "demo-")


def test_monitor_lookback_and_threshold_states():
    bound = queries.BoundQuery([], "a", "unused", 120, "avg", ">", {"failed": 10})
    a = runner.monitor_values([cp.Series({}, {-60: 8, 0: 12, 60: 12})], bound, [0, 60], 60)
    assert a[0].samples == {0: 10, 60: 12}
    assert runner.threshold_decisions(a, bound)[0].samples == {0: 0, 60: 1}
    with pytest.raises(cp.DataError):
        runner.monitor_values(series([10, 10]), bound, [0, 60], 60)


def test_shared_pipeline_only_datadog_gets_rate_preprocessing():
    workload = cfg.load(PROFILE, cfg.Workload)
    config = docker.collector_config(workload, "demo-live-test")
    a = config["service"]["pipelines"]["metrics/dash0"]
    b = config["service"]["pipelines"]["metrics/datadog"]
    assert a["receivers"] == b["receivers"]
    assert a["processors"] == ["resource/run"]
    assert "deltatorate/pg" in b["processors"]
    assert "mappings" not in json.dumps(config)
    assert (
        config["exporters"]["otlphttp/dash0"]["headers"]["Dash0-Dataset"] == "${env:DASH0_DATASET}"
    )


def test_compose_isolation_pinning_local_ports_and_secret_passthrough(tmp_path):
    workload = cfg.load(PROFILE, cfg.Workload)
    services = {
        name: {
            "image": name,
            "container_name": name,
            "build": {},
            "environment": {},
            "ports": [{"target": 8080, "published": "8080"}],
            "volumes": [],
        }
        for name in ["otel-collector", "load-generator"]
    }
    compose = {
        "name": "upstream",
        "services": services,
        "networks": {"default": {"name": "upstream"}},
    }
    result = docker.isolate(compose, workload, tmp_path, {n: n + "@sha256:123" for n in services})
    for service in result["services"].values():
        assert "container_name" not in service and "build" not in service
        assert service["ports"][0]["host_ip"] == "127.0.0.1"
        assert service["ports"][0]["published"] == "0"
        assert "@sha256:" in service["image"]
    assert "name" not in result["networks"]["default"]
    assert result["services"]["otel-collector"]["environment"]["DD_API_KEY"] is None
    assert all(
        v["target"] not in ["/hostfs", "/var/run/docker.sock"]
        for v in result["services"]["otel-collector"]["volumes"]
    )


def test_unpinned_images_and_wrong_archive_are_rejected(tmp_path):
    with pytest.raises(RuntimeError, match="checksum"):
        docker.unpack(b"bad archive", tmp_path / "source")
    with pytest.raises(RuntimeError, match="unpinned"):
        docker.isolate(
            {"services": {"x": {"image": "latest"}}}, cfg.load(PROFILE, cfg.Workload), tmp_path, {}
        )


def test_actual_environment_lifecycle_uses_stubbed_docker_commands(tmp_path):
    commands: list[list[str]] = []

    def stub(args: list[str], cwd: Path, env: Any) -> str:
        commands.append(args)
        return ""

    (tmp_path / "seed.sql").write_text("SELECT 1;")
    (tmp_path / "compose.json").write_text("{}")
    workload = cfg.load(PROFILE, cfg.Workload).model_copy(update={"seed_sql": ["seed.sql"]})
    environment = docker.Environment(
        tmp_path, workload, tmp_path / "profile.yaml", "demo-live-test", {}, execute=stub
    )
    environment.start()
    environment.stop()
    assert commands[0][-6:] == ["up", "--detach", "--no-build", "--wait", "--wait-timeout", "300"]
    assert "cp" in commands[1]
    assert "ON_ERROR_STOP=1" in commands[2]
    assert commands[-1][-3:] == ["down", "--volumes", "--remove-orphans"]


def test_interruption_kills_compose_process_group_before_cleanup(tmp_path, monkeypatch):
    events: list[Any] = []

    class InterruptedProcess:
        pid = 123
        calls = 0

        def communicate(self, timeout: int | None = None) -> tuple[str, str]:
            self.calls += 1
            if self.calls == 1:
                raise KeyboardInterrupt
            events.append("reaped")
            return "", ""

    monkeypatch.setattr(docker.subprocess, "Popen", lambda *a, **kw: InterruptedProcess())
    monkeypatch.setattr(docker.os, "killpg", lambda pid, sig: events.append((pid, sig)))
    with pytest.raises(KeyboardInterrupt):
        docker.command(["docker", "compose", "up"], tmp_path, {})
    assert events == [(123, signal.SIGKILL), "reaped"]
