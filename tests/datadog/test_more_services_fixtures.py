"""Pinned fixtures for plan 08 Tasks 2-3. The goldens come later."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from migrator.cli import main
from migrator.input import collect_input_files
from migrator.source.datadog.assets import recognize_assets

ROOT = "fixtures/datadog/integrations-core"


def test_recognizes_redis_dashboard_and_monitor() -> None:
    assets, diagnostics = recognize_assets(collect_input_files([f"{ROOT}/redisdb"]))
    assert diagnostics == []
    assert [a.kind for a in assets] == ["dashboard", "monitor"]
    assert assets[0].title == "Redis - Overview"
    assert assets[1].body["query"] == (
        "avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90"
    )


def test_recognizes_nginx_dashboards_and_seven_monitors() -> None:
    # NGINX - Metrics is this plan's fixture; the Overview and Plus dashboards came
    # with the oracle suite (#86) into the same pinned folder.
    assets, diagnostics = recognize_assets(collect_input_files([f"{ROOT}/nginx"]))
    assert diagnostics == []
    assert [a.kind for a in assets] == ["dashboard"] * 3 + ["monitor"] * 7
    assert [a.title for a in assets if a.kind == "dashboard"] == [
        "NGINX - Metrics",
        "NGINX - Overview",
        "NGINX Plus - Overview",
    ]


def _convert(tmp_path: Path, fixture: str, mapping: str) -> Path:
    out = tmp_path / "out"
    code = main(
        [
            "convert",
            "--source",
            "datadog",
            "--input",
            f"{ROOT}/{fixture}",
            "--mapping",
            f"mappings/datadog/{mapping}.json",
            "--out",
            str(out),
        ]
    )
    assert code in (0, 2)
    return out


@pytest.mark.parametrize(("fixture", "mapping"), [("redisdb", "redis"), ("nginx", "nginx")])
def test_mapping_file_compiles_against_its_fixture(
    tmp_path: Path, fixture: str, mapping: str
) -> None:
    out = _convert(tmp_path, fixture, mapping)
    assert list((out / "dashboards").glob("*.json"))
    report = json.loads((out / "report.json").read_text())
    assert "TARGET_VALIDATION_FAILED" not in json.dumps(report)


def test_redis_cpu_is_a_rate_over_the_cumulative_counter(tmp_path: Path) -> None:
    out = _convert(tmp_path, "redisdb", "redis")
    text = "".join(p.read_text() for p in (out / "dashboards").glob("*.json"))
    queries = [q for q in re.findall(r'"query": "([^"\\]*(?:\\.[^"\\]*)*)"', text)]
    cpu = [q for q in queries if "redis.cpu.time" in q]
    assert cpu, "the Average CPU usage widget should translate"
    assert all("rate(" in q for q in cpu), cpu
