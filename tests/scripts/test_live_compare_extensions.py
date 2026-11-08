"""Extension evidence uses parsed leaves, explicit tolerances and strict decisions."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import live_compare_support.config as config  # type: ignore[import-not-found]
import live_compare_support.queries as queries  # type: ignore[import-not-found]
import pytest
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]
SUITE = ROOT / "scripts/live/suites/extensions.yaml"


def _monitor_case() -> Any:
    return config.Case.model_validate(
        {"id": "ratio", "source": "extensions-monitor.json", "kind": "monitor"}
    )


def _pair_monitor(query: str | None = None, evaluation_delay: int = 0) -> Any:
    source = json.loads((ROOT / "scripts/live/assets/extensions-monitor.json").read_text())
    if query is not None:
        source["query"] = query
    if evaluation_delay:
        source["options"]["evaluation_delay"] = evaluation_delay
    # A synthetic known-body check isolates pairing from compiler generation.
    # Compiler integration and schema/readback are exercised by the live suite.
    target = {
        "expression": "avg_over_time((sum({otel_metric_name=\"redis.memory.used\"}) / "
        "sum({otel_metric_name=\"redis.memory.rss\"}))[5m:1m]) > $__threshold",
        "thresholds": {"failed": 0.9, "degraded": 0.8},
    }
    return queries.pair(_monitor_case(), source, target, "5m", "demo-live-test")


def test_best_effort_is_explicit_and_unknown_categories_are_rejected():
    suite = config.load(SUITE, config.Suite)
    assert len(suite.cases) == 8
    assert [c.relative_tolerance_pct for c in suite.cases[:4]] == [4.9] * 4
    assert [c.relative_tolerance_pct for c in suite.cases[4:]] == [3] * 4
    assert {c.expected_outcome for c in suite.cases[:4]} == {"best_effort"}
    bad = suite.cases[0].model_dump()
    bad["expected_outcome"] = "looks_good"
    with pytest.raises(ValidationError):
        config.Case.model_validate(bad)


def test_arithmetic_monitor_binds_every_leaf_and_preserves_source_formula():
    bound = _pair_monitor()
    assert [q["name"] for q in bound.queries] == ["q0", "q1"]
    assert [q["query"] for q in bound.queries] == [
        "avg:redis.mem.used{host:demo-live-test}",
        "avg:redis.mem.rss{host:demo-live-test}",
    ]
    assert bound.formula == "(q0 / q1)"
    assert bound.monitor_window == 300
    assert bound.monitor_aggregator == "avg"
    assert bound.thresholds == {"failed": 0.9, "degraded": 0.8}
    assert bound.target.count('host_name="demo-live-test"') == 2


def test_arithmetic_monitor_semantic_mode_applies_to_every_leaf():
    bound = queries.with_semantic_mode(_pair_monitor(), "combined")
    assert [q["semantic_mode"] for q in bound.queries] == ["combined", "combined"]


def test_arithmetic_monitor_rejects_trailing_input_before_binding():
    with pytest.raises(queries.DataError, match="unsupported monitor"):
        _pair_monitor("avg(last_5m):avg:redis.mem.used{*} / avg:redis.mem.rss{*} > 0.9 trailing")


def test_arithmetic_monitor_still_checks_thresholds_from_original_source():
    source = json.loads((ROOT / "scripts/live/assets/extensions-monitor.json").read_text())
    target = {
        "expression": "avg({otel_metric_name=\"redis.memory.used\"}) > $__threshold",
        "thresholds": {"failed": 0.91, "degraded": 0.8},
    }
    with pytest.raises(queries.DataError, match="thresholds differ"):
        queries.pair(_monitor_case(), source, target, "5m", "demo-live-test")


def test_arithmetic_monitor_binding_refuses_conflicting_host_in_any_leaf():
    with pytest.raises(queries.DataError, match="conflicts"):
        _pair_monitor(
            "avg(last_5m):avg:redis.mem.used{*} / avg:redis.mem.rss{host:production} > 0.9"
        )


def test_delayed_monitor_is_rejected_instead_of_using_unshifted_source_history():
    with pytest.raises(queries.DataError, match="evaluation_delay"):
        _pair_monitor(evaluation_delay=60)
