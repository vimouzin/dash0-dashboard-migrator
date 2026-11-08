"""Tests for scripts/generate_openmetrics_mappings.py and pin_openmetrics_series.py (#185)."""

from __future__ import annotations

import json
from typing import Any

import generate_openmetrics_mappings as gen  # type: ignore[import-not-found]
import pin_openmetrics_series as pin  # type: ignore[import-not-found]

from migrator.source.datadog.compile_query import CompiledError, CompiledOk
from migrator.source.datadog.mapping import parse_mapping
from tests.datadog.test_compile_query import run
from tests.datadog.test_metric_types import load_types, verdict

CHECK = """
__NAMESPACE__ = 'demo'
METRIC_MAP = {
    'demo_requests': 'requests',
    'demo_errors': {'name': 'errors'},
    'demo_queue_depth': 'queue.depth',
    'demo_latency_seconds': 'latency',
    'demo_custom': {'name': 'custom', 'type': 'temporal_percent'},
    'demo_missing': 'missing',
}
DEFAULT = {'rename_labels': {'version': 'demo_version'}}
"""
SERIES = {
    "demo_requests_total": {"types": ["counter"], "labels": ["code", "version"]},
    "demo_errors": {"types": ["counter"], "labels": []},
    "demo_queue_depth": {"types": ["gauge"], "labels": ["queue"]},
    "demo_latency_seconds_count": {"types": ["histogram"], "labels": []},
    "demo_custom": {"types": ["gauge"], "labels": []},
}


def _row(name: str, mtype: str, per: str = "") -> dict[str, str]:
    return {"metric_name": name, "metric_type": mtype, "unit_name": "", "per_unit_name": per}


def _build(rows: list[dict[str, str]], taken: set[str] | None = None) -> Any:
    return gen.build({"demo": ([CHECK], rows)}, {"demo": SERIES}, taken or set())


def test_committed_files_are_current() -> None:
    text, _ = gen.generate()
    assert gen.OUT.read_text(encoding="utf-8") == text


def test_generated_entries_parse_and_follow_the_datadog_type_rule() -> None:
    raw = json.loads(gen.OUT.read_text(encoding="utf-8"))
    assert parse_mapping(raw).ok
    types = load_types()
    metrics = raw["metrics"]
    assert {n: e["assumption"] for n, e in metrics.items()} == {n: "PROMLABEL" for n in metrics}
    assert {n: verdict(e["kind"], types.get(n)) for n, e in metrics.items()} == {
        n: "ok" for n in metrics
    }


def test_live_checked_argocd_counter_targets_the_exposed_total_series() -> None:
    entry = json.loads(gen.OUT.read_text(encoding="utf-8"))["metrics"][
        "argocd.app_controller.app.sync.count"
    ]
    assert entry["target"] == {"name": "argocd_app_sync_total", "type": "sum"}
    assert entry["labels"]["phase"] == "phase"
    assert entry["labels"]["host"] == "instance"


def test_counters_gauges_and_skips() -> None:
    body, skipped = _build(
        [
            _row("demo.requests.count", "count"),
            _row("demo.errors.count", "count"),
            _row("demo.queue.depth", "gauge"),
            _row("demo.latency.count", "count"),
            _row("demo.latency.sum", "gauge"),
            _row("demo.custom", "gauge"),
            _row("demo.missing", "gauge"),
            _row("other.requests.count", "count"),
        ]
    )
    m = body["metrics"]
    assert m["demo.requests.count"]["target"] == {"name": "demo_requests_total", "type": "sum"}
    assert m["demo.requests.count"]["labels"] == {
        "code": "code", "demo_version": "version", "host": "instance"
    }
    # No `_total` in the exposition: the counter keeps its raw name.
    assert m["demo.errors.count"]["target"] == {"name": "demo_errors", "type": "sum"}
    assert m["demo.queue.depth"]["kind"] == "gauge"
    assert skipped == {
        "demo.custom": "demo: no metric map pair",
        "demo.latency.count": "demo: histogram or summary count",
        "demo.latency.sum": "demo: no metric map pair",
        "demo.missing": "demo: not in the test exposition",
        "other.requests.count": "demo: no metric map pair",
    }


def test_type_mismatch_and_taken_names_are_skipped() -> None:
    body, skipped = _build(
        [_row("demo.requests", "gauge"), _row("demo.queue.depth", "gauge")],
        taken={"demo.queue.depth"},
    )
    assert body["metrics"] == {}
    assert skipped == {
        "demo.queue.depth": "already in a mapping file",
        "demo.requests": "demo: not in the test exposition",
    }


def test_generated_entry_compiles_with_the_assumption_and_blocks_unknown_tags() -> None:
    body, _ = _build([_row("demo.requests.count", "count")])
    mapping = parse_mapping(body)
    assert mapping.ok
    result = run("sum:demo.requests.count{demo_version:1} by {host}", mapping.mapping)
    assert isinstance(result, CompiledOk)
    assert result.promql == (
        'sum by (instance) (rate({otel_metric_name="demo_requests_total", '
        'otel_metric_type="sum", version="1"}[$__rate_interval]))'
    )
    assert "ASSUMED" in [d.code for d in result.diagnostics]
    assert isinstance(run("sum:demo.requests.count{env:prod}", mapping.mapping), CompiledError)


def test_exposition_parser_reads_types_labels_and_counter_samples() -> None:
    text = "\n".join(
        [
            "# TYPE a counter",
            'a_total{x="1",y="a,b=\\"c\\""} 3',
            "# TYPE b gauge",
            "b 1",
            "c{z=\"\"} 2",
            "# TYPE h histogram",
            'h_bucket{le="1"} 1',
        ]
    )
    assert pin.parse_exposition(text) == {
        "a_total": ("counter", {"x", "y"}),
        "b": ("gauge", set()),
        "c": ("", {"z"}),
        "h_bucket": ("histogram", {"le"}),
    }
