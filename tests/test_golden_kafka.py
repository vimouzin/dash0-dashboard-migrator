"""Golden: Kafka dashboards and monitors (issue #112).

Regenerate by hand with `uv run migrator convert` (arguments as in `convert` below) and review
the diff before committing. Uses the frozen mapping copy fixtures/mappings/kafka.json, so edits
to mappings/datadog/kafka.json (e.g. setting `reviewed`) do not churn this golden.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from migrator.convert import ConvertOptions, run_convert

EXPECTED = Path("fixtures/expected/kafka-p1")
ASSETS = "fixtures/datadog/integrations-core/kafka"


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
            inputs=[f"{ASSETS}/dashboards", f"{ASSETS}/monitors"],
            mapping=["fixtures/mappings/kafka.json"],
            out=str(out),
            format="json",
            project="datadog-migration",
        )
    ).exit_code


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory) -> tuple[int, Path]:
    out = tmp_path_factory.mktemp("kafka") / "out"
    return convert(out), out


def report(out: Path) -> dict[str, Any]:
    data = json.loads((out / "report.json").read_text())
    assert isinstance(data, dict)
    return data


def test_kafka_golden_matches_expected(run: tuple[int, Path]) -> None:
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


def test_outcomes(run: tuple[int, Path]) -> None:
    items = report(run[1])["items"]
    widgets = Counter((i["sourceId"], i["outcome"]) for i in items if i["kind"] == "widget")
    assert widgets == {
        ("dashboards/kafka_dashboard.json", "translated"): 10,
        ("dashboards/kafka_dashboard.json", "best_effort"): 2,
        ("dashboards/kafka_dashboard.json", "blocked"): 34,
        ("dashboards/kafka_kraft_dashboard.json", "translated"): 10,
        ("dashboards/kafka_kraft_dashboard.json", "best_effort"): 2,
        ("dashboards/kafka_kraft_dashboard.json", "blocked"): 40,
    }
    monitors = {i["sourceId"]: i["outcome"] for i in items if i["kind"] == "monitor"}
    assert monitors == {
        "monitors/broker_produce_latency.json": "blocked",  # on_missing_data
        "monitors/kafka_high_producer_request_rate.json": "blocked",  # anomalies()
        "monitors/kafka_offline_partition.json": "approximated",
    }
