"""Golden: the Redis overview dashboard with the frozen Redis mapping (issue #113).

Regenerate by hand with `uv run migrator convert` (arguments as in `convert` below) and
review the diff before committing.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from migrator.convert import ConvertOptions, run_convert

EXPECTED = Path("fixtures/expected/redis-p1")
OVERVIEW = "dashboards/overview.json"


def tree(root: Path) -> dict[str, bytes]:
    return {
        p.relative_to(root).as_posix(): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.relative_to(root).as_posix().startswith("source/")
    }


def convert(out: Path) -> int:
    return run_convert(
        ConvertOptions(
            source="datadog",
            inputs=["fixtures/datadog/integrations-core/redisdb/dashboards"],
            # Frozen copy, so edits to mappings/datadog/redis.json do not churn the golden.
            mapping=["fixtures/mappings/redis.json"],
            out=str(out),
            format="json",
            project="datadog-migration",
        )
    ).exit_code


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory) -> tuple[int, Path]:
    out = tmp_path_factory.mktemp("redis") / "out"
    return convert(out), out


def report(out: Path) -> dict[str, Any]:
    data = json.loads((out / "report.json").read_text())
    assert isinstance(data, dict)
    return data


def queries(out: Path, panel: str) -> list[str]:
    d = json.loads((out / "dashboards/redis-overview.json").read_text())
    return [
        q["spec"]["plugin"]["spec"]["query"] for q in d["spec"]["panels"][panel]["spec"]["queries"]
    ]


def test_redis_p1_golden_matches_expected(run: tuple[int, Path]) -> None:
    code, out = run
    assert code == 2
    expected, actual = tree(EXPECTED), tree(out)
    assert sorted(actual) == sorted(expected)
    for rel, data in expected.items():
        assert actual[rel] == data, rel


def test_conversion_is_deterministic(run: tuple[int, Path], tmp_path: Path) -> None:
    _, first = run
    convert(tmp_path / "again")
    assert tree(tmp_path / "again") == tree(first)


def test_blocked_widgets_and_their_errors(run: tuple[int, Path]) -> None:
    rep = report(run[1])
    widgets = [i for i in rep["items"] if i["sourceId"] == OVERVIEW and i["kind"] == "widget"]
    assert Counter(i["outcome"] for i in widgets) == {"translated": 25, "blocked": 11}
    errors = [d for d in rep["diagnostics"] if d["severity"] == "error"]
    # No Dash0 data or no OTel receiver metric (issue #113 PR); redis.net.commands is mapped.
    assert sorted(d["message"] for d in errors if d["code"] == "MISSING_METRIC_MAPPING") == [
        "No mapping for metric 'redis.info.latency_ms'.",
        "No mapping for metric 'redis.mem.maxmemory'.",
        "No mapping for metric 'redis.replication.delay'.",
        "No mapping for metric 'redis.replication.master_link_down_since_seconds'.",
        "No mapping for metric 'redis.slowlog.micros.count'.",
    ]
    # Two widgets with an empty `time: {}` now reach their (unmapped) queries.
    assert Counter(d["code"] for d in errors) == {
        "UNSUPPORTED_WIDGET": 3,
        "UNSUPPORTED_FORMULA": 3,
        "MISSING_METRIC_MAPPING": 5,
    }


def test_cpu_and_commands_are_rates(run: tuple[int, Path]) -> None:
    """redis.cpu.{sys,user} and redis.net.commands: Datadog self.rate() of an INFO counter."""
    sel = 'otel_metric_type="sum", host_name=~"^($host)$"'
    assert queries(run[1], "widget-2-5") == [
        f'avg (rate({{otel_metric_name="redis.cpu.time", {sel}, state="{s}"}}[$__rate_interval]))'
        for s in ("sys", "user")
    ]
    assert queries(run[1], "widget-4-5") == [
        f'sum (rate({{otel_metric_name="redis.commands.processed", {sel}}}[$__rate_interval]))'
    ]
