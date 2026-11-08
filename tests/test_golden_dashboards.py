"""Golden: Postgres dashboards at the P1 level (plan 05 Task 9, standing in for plan 04 Task 4).

Regenerate by hand with `uv run migrator convert` and review the diff before committing.
Plan 05 Task 1 (documented default aggregator) is implemented: a query without a space
aggregator compiles with Datadog's default `avg` and warns DEFAULT_AGGREGATOR_APPLIED.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from migrator.convert import ConvertOptions, run_convert

EXPECTED = Path("fixtures/expected/postgres-p1")
METRICS = "dashboards/postgresql_dashboard.json"
OVERVIEW = "dashboards/postgresql_screenboard_dashboard.json"


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
            inputs=["fixtures/datadog/integrations-core/postgres/dashboards"],
            # Frozen copy, so edits to mappings/datadog/postgres.json do not churn the golden.
            mapping=["fixtures/mappings/postgres.json"],
            out=str(out),
            format="json",
            project="datadog-migration",
        )
    ).exit_code


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory) -> tuple[int, Path]:
    out = tmp_path_factory.mktemp("pg") / "out"
    return convert(out), out


def report(out: Path) -> dict[str, Any]:
    data = json.loads((out / "report.json").read_text())
    assert isinstance(data, dict)
    return data


def widget_errors(rep: dict[str, Any], source_id: str, path: str) -> list[str]:
    return [
        d["code"]
        for d in rep["diagnostics"]
        if d["sourceId"] == source_id
        and d["severity"] == "error"
        and (d["sourcePath"] == path or d["sourcePath"].startswith(path + "."))
    ]


def test_postgres_p1_golden_matches_expected(run: tuple[int, Path]) -> None:
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


def test_metrics_widget_outcomes(run: tuple[int, Path]) -> None:
    rep = report(run[1])
    outcomes = {
        i["sourcePath"]: i["outcome"]
        for i in rep["items"]
        if i["sourceId"] == METRICS and i["kind"] == "widget"
    }
    translated = sorted(int(p[8:-1]) for p, o in outcomes.items() if o == "translated")
    assert translated == [0, 1, 2, 4, 6, 8]
    expected_errors = {
        3: ["MISSING_METRIC_MAPPING"],  # system.io.util
        5: ["MISSING_METRIC_MAPPING"],  # system.cpu.guest
        7: ["MISSING_METRIC_MAPPING"] * 2,  # system.mem.usable and system.mem.total
    }
    for n, codes in expected_errors.items():
        assert outcomes[f"widgets[{n}]"] == "blocked"
        assert widget_errors(rep, METRICS, f"widgets[{n}]") == codes, n


def test_missing_aggregator_defaults_to_avg(run: tuple[int, Path]) -> None:
    """Widgets 2, 4 and 5 have no space aggregator: each of their 12 queries gets avg and
    one DEFAULT_AGGREGATOR_APPLIED warning; no query is blocked with MISSING_AGGREGATOR."""
    rep = report(run[1])
    assert all(d["code"] != "MISSING_AGGREGATOR" for d in rep["diagnostics"])
    applied = [d for d in rep["diagnostics"] if d["code"] == "DEFAULT_AGGREGATOR_APPLIED"]
    assert {(d["sourceId"], d["severity"]) for d in applied} == {(METRICS, "warning")}
    widgets = Counter(d["sourcePath"].split(".")[0] for d in applied)
    assert widgets == {"widgets[2]": 3, "widgets[4]": 3, "widgets[5]": 6}
    d = json.loads((run[1] / "dashboards/postgres-metrics.json").read_text())
    query = d["spec"]["panels"]["widget-4"]["spec"]["queries"][0]["spec"]["plugin"]["spec"]
    assert query["query"] == (
        'avg ({otel_metric_name="system.cpu.load_average.1m", otel_metric_type="gauge"})'
    )


def test_connections_query_dedups_per_instance(run: tuple[int, Path]) -> None:
    d = json.loads((run[1] / "dashboards/postgres-metrics.json").read_text())
    query = d["spec"]["panels"]["widget-1"]["spec"]["queries"][0]["spec"]["plugin"]["spec"]
    assert query["query"] == (
        "avg by (postgresql_database_name) (max by (postgresql_database_name, "
        'service_instance_id) ({otel_metric_name="postgresql.backends", otel_metric_type="sum"}))'
    )


def test_overview_is_partial_with_reviewed_counts(run: tuple[int, Path]) -> None:
    rep = report(run[1])
    items = [i for i in rep["items"] if i["sourceId"] == OVERVIEW]
    (dashboard,) = [i for i in items if i["kind"] == "dashboard"]
    assert dashboard["outcome"] == "partial"
    counts = Counter(i["outcome"] for i in items if i["kind"] == "widget")
    # Three toplists convert to bar charts under the TOPN remark (docs/REMARKS.md).
    assert counts == {"translated": 10, "assumed": 3, "blocked": 17}
    assert (run[1] / "dashboards/postgres-overview.json").exists()


def test_cpu_widget_stays_blocked_on_guest(run: tuple[int, Path]) -> None:
    """Issue #41's `cpu widget stays blocked on guest`.

    widgets[5] ("CPU usage (%)") has six queries without a space aggregator; with the
    default avg they reach the mapping lookup, and exactly one blocks: system.cpu.guest
    has no mapping, while idle/system/iowait/user/stolen do.
    """
    rep = report(run[1])
    assert widget_errors(rep, METRICS, "widgets[5]") == ["MISSING_METRIC_MAPPING"]
    (guest,) = [
        d
        for d in rep["diagnostics"]
        if d["sourceId"] == METRICS
        and d["severity"] == "error"
        and d["sourcePath"].startswith("widgets[5].")
    ]
    assert "system.cpu.guest" in guest["message"]
    outcome = {i["sourcePath"]: i["outcome"] for i in rep["items"] if i["sourceId"] == METRICS}
    assert outcome["widgets[5]"] == "blocked"
