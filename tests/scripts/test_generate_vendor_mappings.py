"""Tests for scripts/generate_vendor_mappings.py (#175)."""

from __future__ import annotations

from typing import Any

import generate_vendor_mappings as gen  # type: ignore[import-not-found]
import pytest

from migrator.source.datadog.compile_query import CompiledOk
from migrator.source.datadog.mapping import parse_mapping
from tests.datadog.test_compile_query import run
from tests.datadog.test_metric_types import load_types, verdict

GAUGE = {"type": "gauge", "monotonic": None, "unit": "By", "sources": ["s.yaml"]}
COUNTER = {"type": "sum", "monotonic": True, "unit": "s", "sources": ["s.yaml"]}


def _dd(metric_type: str, per_unit: str = "", unit: str = "byte") -> dict[str, str]:
    return {"metric_type": metric_type, "per_unit_name": per_unit, "unit_name": unit, "source": "x"}


def _build(rows: list[dict[str, Any]], catalog: dict[str, Any], types: dict[str, Any]) -> Any:
    return gen.build(rows, catalog, types, set(), "2026-11-08")


def test_committed_file_is_current() -> None:
    text, _ = gen.generate()
    assert gen.OUT.read_text(encoding="utf-8") == text


def test_generated_kinds_follow_the_datadog_type_rule() -> None:
    types = load_types()
    metrics = gen.json.loads(gen.OUT.read_text(encoding="utf-8"))["metrics"]
    verified = {n: e for n, e in metrics.items() if "assumption" not in e}
    assert verified
    assert {n: verdict(e["kind"], types.get(n)) for n, e in verified.items()} == {
        n: "ok" for n in verified
    }
    assert {e["assumption"] for n, e in metrics.items() if n not in verified} == {"OTELTABLE"}


def test_rate_from_monotonic_sum_with_filter_and_scale() -> None:
    rows = [{"datadog": "a.ops", "otel": "o.ops", "filter": {"op.type": "r"}, "transform": "× 1000"}]
    body, skipped = _build(rows, {"o.ops": COUNTER}, {"a.ops": _dd("rate", unit="millisecond")})
    e = body["metrics"]["a.ops"]
    assert (e["kind"], e["target"], e["matchers"], e["scale"]) == (
        "rate",
        {"name": "o.ops", "type": "sum"},
        {"op_type": "r"},
        1000,
    )
    assert skipped == {}


def test_unverified_rows_convert_under_oteltable() -> None:
    rows = [
        {"datadog": "a.gauge_of_counter", "otel": "o.ops"},
        {"datadog": "a.two", "otel": "o.ops"},
        {"datadog": "a.two", "otel": "o.bytes"},
        {"datadog": "a.unknown", "otel": "o.missing"},
        {"datadog": "a.renamed", "otel": "o.ops", "transform": "Rename attribute key `client-id` to `client`"},
    ]
    types = {n: _dd("gauge") for n in ("a.gauge_of_counter", "a.two", "a.unknown", "a.renamed")}
    body, skipped = _build(rows, {"o.ops": COUNTER, "o.bytes": GAUGE}, types)
    m = body["metrics"]
    assert skipped == {}
    assert {n: e["assumption"] for n, e in m.items()} == {n: "OTELTABLE" for n in m}
    assert (m["a.gauge_of_counter"]["kind"], m["a.gauge_of_counter"]["target"]["type"]) == ("gauge", "sum")
    assert m["a.two"]["target"]["name"] == "o.bytes"
    assert "2 distinct table targets" in m["a.two"]["ref"]
    assert m["a.unknown"]["target"] == {"name": "o.missing", "type": "gauge"}
    assert m["a.renamed"]["labels"] == {"host": "host_name", "client": "client_id"}
    assert parse_mapping(body).ok


@pytest.mark.parametrize(
    ("datadog", "row"),
    [
        ("a.value", {"filter": {"state": "free, cached"}}),
        ("a.value{type: X}", {}),
    ],
)
def test_unencodable_rows_stay_blocked(datadog: str, row: dict[str, Any]) -> None:
    body, skipped = _build(
        [{"datadog": datadog, "otel": "o.value", **row}], {"o.value": GAUGE}, {datadog: _dd("gauge")}
    )
    assert body["metrics"] == {}
    assert datadog in skipped


def test_pinned_cpu_mapping_preserves_datadog_nanocore_values() -> None:
    text, _ = gen.generate()
    parsed = parse_mapping(gen.json.loads(text))
    assert parsed.ok
    result = run("avg:kubernetes.cpu.usage.total{*}", parsed.mapping)
    assert isinstance(result, CompiledOk)
    assert result.promql == (
        '(avg ({otel_metric_name="k8s.pod.cpu.usage", otel_metric_type="gauge"})) * 1000000000'
    )
    assert parsed.mapping.metrics["kubernetes.cpu.usage.total"].reviewed is None


@pytest.mark.parametrize(
    ("unit", "target_unit", "transform", "expected"),
    [
        ("byte", "By", "", 1),
        ("nanocore", "{cpu}", "", 1e9),
        ("nanocore", "{cpu}", "× 1000000000", 1e9),
        ("millisecond", "s", "× 1000", 1000),
        ("second", "{ms}", "× 0.001", 0.001),
        ("mebibyte", "By", "× 9.5367431640625e-7", 1 / 1024**2),
        ("fraction", "%", "× 0.01", 0.01),
    ],
)
def test_explicit_unit_factors(unit: str, target_unit: str, transform: str, expected: float) -> None:
    body, skipped = _build(
        [{"datadog": "a.value", "otel": "o.value", "transform": transform}],
        {"o.value": {**GAUGE, "unit": target_unit}},
        {"a.value": _dd("gauge", unit=unit)},
    )
    assert skipped == {}
    assert body["metrics"]["a.value"]["scale"] == expected


@pytest.mark.parametrize(
    ("unit", "target_unit", "per_unit"),
    [
        ("", "By", ""),
        ("byte", "", ""),
        ("unknown", "By", ""),
        ("byte", "{cpu}", ""),
        ("byte", "1", ""),
        ("transaction", "{transactions}/s", ""),
        ("byte", "By", "hour"),
    ],
)
def test_unverified_units_convert_under_oteltable(
    unit: str, target_unit: str, per_unit: str,
) -> None:
    body, skipped = _build(
        [{"datadog": "a.value", "otel": "o.value"}],
        {"o.value": {**GAUGE, "unit": target_unit}},
        {"a.value": _dd("gauge", per_unit=per_unit, unit=unit)},
    )
    assert skipped == {}
    assert body["metrics"]["a.value"]["assumption"] == "OTELTABLE"
    parsed = parse_mapping(body)
    assert parsed.ok
    assert isinstance(run("avg:a.value{*}", parsed.mapping), CompiledOk)


@pytest.mark.parametrize("transform", ["× 1", "× 0", "× -1", "× nan", "× inf"])
def test_table_transform_must_agree_with_units(transform: str) -> None:
    body, skipped = _build(
        [{"datadog": "a.cpu", "otel": "o.cpu", "transform": transform}],
        {"o.cpu": {**GAUGE, "unit": "{cpu}"}},
        {"a.cpu": _dd("gauge", unit="nanocore")},
    )
    assert body["metrics"] == {}
    assert "a.cpu" in skipped


def test_conflicting_catalog_definition_takes_the_datadog_kind() -> None:
    body, skipped = _build(
        [{"datadog": "a.memory", "otel": "o.memory"}],
        {"o.memory": {**GAUGE, "conflicts": ["other.yaml: type sum"]}},
        {"a.memory": _dd("gauge")},
    )
    assert skipped == {}
    e = body["metrics"]["a.memory"]
    assert (e["kind"], e["target"]["type"], e["assumption"]) == ("gauge", "gauge", "OTELTABLE")
    assert "conflicting OTel definitions" in e["ref"]


def test_pinned_catalog_conflicts_convert_under_oteltable() -> None:
    text, _ = gen.generate()
    parsed = parse_mapping(gen.json.loads(text))
    assert parsed.ok
    for name in (
        "kubernetes.ephemeral_storage.usage",
        "kubernetes.memory.rss",
        "kubernetes.node.filesystem.usage",
    ):
        assert parsed.mapping.metrics[name].assumption == "OTELTABLE"
        assert isinstance(run(f"avg:{name}{{*}}", parsed.mapping), CompiledOk)
