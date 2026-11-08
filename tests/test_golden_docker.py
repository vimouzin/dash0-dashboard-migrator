"""Golden: the Docker dashboard at the P1 level (issue #115).

Regenerate by hand with `uv run migrator convert` (arguments as in `convert` below) and review
the diff before committing. The frozen copy fixtures/mappings/docker.json keeps edits to
mappings/datadog/docker.json from churning the golden.

Heatmap, event and image widgets block on their type; the toplists on their top() query.
Widgets pinned to their own `time` (live_span) convert as approximated with the TIMEPIN remark
(docs/REMARKS.md) when their query converts; the rest block on `.fill()`, arithmetic or a
metric missing from the frozen mapping. Request-level PromQL is checked by the oracle suite
(tests/unit/requests, docker cases with --include-unreviewed).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from migrator.convert import ConvertOptions, run_convert
from tests.test_golden_dashboards import tree

EXPECTED = Path("fixtures/expected/docker-p1")
DASHBOARD = "dashboards/docker_dashboard.json"
NOTES = [13, 16, 17, 19, 22]
TYPE_BLOCKED = [3, 6, 9, 10, 15, 26]  # heatmap, event_*, image (toplists block on top())
TIME_PINNED = [14, 20, 21, 23, 24]


def convert(out: Path) -> int:
    return run_convert(
        ConvertOptions(
            source="datadog",
            inputs=["fixtures/datadog/integrations-core/docker_daemon/dashboards"],
            mapping=["fixtures/mappings/docker.json"],
            out=str(out),
            format="json",
            project="datadog-migration",
        )
    ).exit_code


@pytest.fixture(scope="module")
def run(tmp_path_factory: pytest.TempPathFactory) -> tuple[int, Path]:
    out = tmp_path_factory.mktemp("docker") / "out"
    return convert(out), out


def report(out: Path) -> dict[str, Any]:
    data = json.loads((out / "report.json").read_text())
    assert isinstance(data, dict)
    return data


def test_docker_p1_golden_matches_expected(run: tuple[int, Path]) -> None:
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


def test_time_pinned_widgets_are_approximated(run: tuple[int, Path]) -> None:
    rep = report(run[1])
    widgets = [i for i in rep["items"] if i["sourceId"] == DASHBOARD and i["kind"] == "widget"]
    by_outcome: dict[str, list[int]] = {}
    for i in widgets:
        by_outcome.setdefault(i["outcome"], []).append(int(i["sourcePath"][8:-1]))
    assert by_outcome["translated"] == NOTES
    assert by_outcome["approximated"] == TIME_PINNED
    assert all(i.get("remarks") == ["TIMEPIN"] for i in widgets if i["outcome"] == "approximated")
    type_errors = sorted(
        int(d["sourcePath"][8:].split("]")[0])
        for d in rep["diagnostics"]
        if d["sourceId"] == DASHBOARD
        and d["severity"] == "error"
        and d["sourcePath"].endswith(".definition.type")
    )
    assert type_errors == TYPE_BLOCKED
