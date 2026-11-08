"""Mapping entries agree with Datadog's pinned OTel mapping table (issue #105).

For a reviewed entry whose Datadog metric is in fixtures/datadog/otel-mapping.yaml,
`target.name` must be one of the table's `otel` names, and a `× N` transform means `scale: N`
(checked when the pin stores the transform column). `vendor deviation: <reason>` in `ref` opts
an entry out. Unreviewed entries are not enforced; `scripts/pin_otel_mapping.py --report`
lists their disagreements.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import yaml

from tests.datadog.helpers import entry

ROOT = Path(__file__).resolve().parents[2]
PIN = ROOT / "fixtures" / "datadog" / "otel-mapping.yaml"
MAPPINGS = ROOT / "mappings" / "datadog"
_SCALE = re.compile(r"× (\S+)")


def load_pin() -> tuple[list[str], list[dict[str, Any]]]:
    doc = yaml.safe_load(PIN.read_text(encoding="utf-8"))
    return list(doc["columns"]), list(doc["rows"])


def problems(
    name: str, e: dict[str, Any], columns: list[str], rows: list[dict[str, Any]]
) -> list[str]:
    if not e.get("reviewed") or "vendor deviation:" in e.get("ref", ""):
        return []
    target = (e.get("target") or {}).get("name")
    matching = [r for r in rows if r["datadog"] == name]
    if target is None or not matching:
        return []
    allowed = sorted({r["otel"] for r in matching})
    if target not in allowed:
        return [f"{name}: target {target} is not in the table: {', '.join(allowed)}"]
    if "transform" not in columns:
        return []
    scales = set()
    for r in matching:
        if r["otel"] == target:
            m = _SCALE.fullmatch(r.get("transform", ""))
            scales.add(float(m.group(1)) if m else 1.0)
    if not any(math.isclose(float(e["scale"]), s) for s in scales):
        return [f"{name}: scale {e['scale']}, the table applies {sorted(scales)}"]
    return []


def test_reviewed_mappings_agree_with_vendor_table() -> None:
    columns, rows = load_pin()
    found = []
    for path in sorted(MAPPINGS.glob("*.json")):
        metrics = json.loads(path.read_text(encoding="utf-8"))["metrics"]
        for name, e in sorted(metrics.items()):
            found += [f"{path.name}: {p}" for p in problems(name, e, columns, rows)]
    assert found == []


def test_reviewed_entry_with_table_target_passes() -> None:
    columns, rows = load_pin()
    assert problems("postgresql.connections", entry(), columns, rows) == []


def test_reviewed_entry_with_other_target_fails() -> None:
    columns, rows = load_pin()
    other = entry(target={"name": "postgresql.connection.count", "type": "sum"})
    assert problems("postgresql.connections", other, columns, rows) == [
        "postgresql.connections: target postgresql.connection.count is not in the table: "
        "postgresql.backends"
    ]


def test_vendor_deviation_in_ref_opts_out() -> None:
    columns, rows = load_pin()
    other = entry(
        target={"name": "postgresql.connection.count", "type": "sum"},
        ref="vendor deviation: synthetic test entry",
    )
    assert problems("postgresql.connections", other, columns, rows) == []


def test_unreviewed_entry_is_not_enforced() -> None:
    columns, rows = load_pin()
    other = entry(target={"name": "postgresql.connection.count", "type": "sum"}, reviewed=None)
    assert problems("postgresql.connections", other, columns, rows) == []


def test_times_100_transform_means_scale_100() -> None:
    columns = ["datadog", "otel", "transform"]
    rows = [{"datadog": "system.cpu.user", "otel": "system.cpu.utilization", "transform": "× 100"}]
    target = {"name": "system.cpu.utilization", "type": "gauge"}
    assert problems("system.cpu.user", entry(target=target, scale=100), columns, rows) == []
    assert problems("system.cpu.user", entry(target=target, scale=1), columns, rows) == [
        "system.cpu.user: scale 1, the table applies [100.0]"
    ]
