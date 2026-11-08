"""Golden: nginx dashboards with the frozen nginx mapping (issue #114).

Regenerate by hand with `uv run migrator convert` (arguments as in `convert` below) into an
empty folder, copy everything but `source/` to fixtures/expected/nginx-p1/, and review the diff.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

from migrator.convert import ConvertOptions, run_convert

EXPECTED = Path("fixtures/expected/nginx-p1")
METRICS = "dashboards/NGINX-Metrics_dashboard.json"


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
            inputs=["fixtures/datadog/integrations-core/nginx/dashboards"],
            # Frozen copy, so edits to mappings/datadog/nginx.json do not churn the golden.
            mapping=["fixtures/mappings/nginx.json"],
            out=str(out),
            format="json",
            project="datadog-migration",
        )
    ).exit_code


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory) -> tuple[int, Path]:
    out = tmp_path_factory.mktemp("nginx") / "out"
    return convert(out), out


def report(out: Path) -> dict[str, Any]:
    data = json.loads((out / "report.json").read_text())
    assert isinstance(data, dict)
    return data


def test_nginx_p1_golden_matches_expected(run: tuple[int, Path]) -> None:
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


def test_metrics_dashboard_blocks_only_unmapped_metrics(run: tuple[int, Path]) -> None:
    """widgets[0] (conn_dropped_per_s) and widgets[1] (Plus server_zone) stay unmapped."""
    rep = report(run[1])
    outcomes = {
        i["sourcePath"]: i["outcome"]
        for i in rep["items"]
        if i["sourceId"] == METRICS and i["kind"] == "widget"
    }
    assert outcomes == {
        "widgets[0]": "blocked",
        "widgets[1]": "blocked",
        "widgets[2]": "translated",
        "widgets[3]": "translated",
        "widgets[4]": "translated",
    }
    errors = Counter(
        d["message"]
        for d in rep["diagnostics"]
        if d["sourceId"] == METRICS and d["severity"] == "error"
    )
    assert errors == {
        "No mapping for metric 'nginx.net.conn_dropped_per_s'.": 1,
        "No mapping for metric 'nginx.server_zone.responses.5xx'.": 1,
    }


def test_request_rate_dedups_per_host(run: tuple[int, Path]) -> None:
    d = json.loads((run[1] / "dashboards/nginx-metrics.json").read_text())
    query = d["spec"]["panels"]["widget-2"]["spec"]["queries"][0]["spec"]["plugin"]["spec"]
    assert query["query"] == (
        "sum (max by (host_name) (rate({otel_metric_name=\"nginx.requests\", "
        'otel_metric_type="sum"}[$__rate_interval])))'
    )
