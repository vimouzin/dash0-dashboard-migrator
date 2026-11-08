from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from migrator.source.datadog.monitor import (
    MonitorThresholds,
    OptionsBlocked,
    OptionsOk,
    evaluate_monitor_options,
)

PINNED = Path("fixtures/datadog/integrations-core/postgres/monitors/percent_usage_connections.json")


def golden_options() -> dict[str, Any]:
    options = json.loads(PINNED.read_text())["definition"]["options"]
    assert isinstance(options, dict)
    return options


def blocked_paths(options: dict[str, Any]) -> list[str]:
    r = evaluate_monitor_options(options, source_id="m.json")
    assert isinstance(r, OptionsBlocked)
    return [d.source_path for d in r.diagnostics if d.code == "UNSUPPORTED_MONITOR_OPTION"]


def test_golden_options_pass_with_approximations() -> None:
    r = evaluate_monitor_options(golden_options(), source_id="m.json")
    assert isinstance(r, OptionsOk)
    assert r.thresholds == MonitorThresholds(critical=0.9, warning=0.8)
    warnings = [d for d in r.diagnostics if d.severity == "warning"]
    assert [(d.code, d.remark) for d in warnings] == [
        ("APPROXIMATED", "NEWHOST"),
        ("APPROXIMATED", "FULLWINDOW"),
    ]
    assert [d.source_path for d in warnings] == [
        "options.new_host_delay",
        "options.require_full_window",
    ]
    assert [(d.code, d.source_path) for d in r.diagnostics if d.severity == "info"] == [
        ("OPTION_IGNORED", "options.include_tags")
    ]
    assert all(d.source_id == "m.json" for d in r.diagnostics)


def test_diagnostics_are_sorted_by_path() -> None:
    r = evaluate_monitor_options(golden_options(), source_id="m.json")
    paths = [d.source_path for d in r.diagnostics]
    assert paths == sorted(paths)


def test_blocks_non_default_no_data() -> None:
    assert blocked_paths({**golden_options(), "notify_no_data": True}) == ["options.notify_no_data"]


def test_blocks_recovery_thresholds() -> None:
    opts = golden_options()
    opts["thresholds"] = {**opts["thresholds"], "critical_recovery": 0.85}
    assert blocked_paths(opts) == ["options.thresholds.critical_recovery"]


def test_blocks_unknown_keys() -> None:
    assert blocked_paths({**golden_options(), "threshold_windows": {}}) == [
        "options.threshold_windows"
    ]


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("no_data_timeframe", 10),
        ("timeout_h", 24),
        ("renotify_interval", 60),
        ("renotify_interval", "60"),
        ("escalation_message", "page"),
        ("notify_audit", True),
        ("locked", True),
        ("timeout_h", False),  # bool must not pass as 0
        ("require_full_window", "true"),
        ("new_host_delay", -1),
        ("include_tags", "yes"),
    ],
)
def test_blocks_non_default_values(key: str, value: object) -> None:
    assert blocked_paths({**golden_options(), key: value}) == [f"options.{key}"]


@pytest.mark.parametrize(
    "thresholds",
    [{"warning": 0.8}, {"critical": "0.9"}, {"critical": True}, {"critical": float("inf")}],
)
def test_blocks_bad_thresholds(thresholds: dict[str, object]) -> None:
    r = evaluate_monitor_options({"thresholds": thresholds}, source_id="m")
    assert isinstance(r, OptionsBlocked)


def test_blocks_missing_thresholds() -> None:
    assert blocked_paths({"notify_no_data": False}) == ["options.thresholds"]


def test_defaults_pass_silently() -> None:
    opts = {
        "thresholds": {"critical": 5},
        "require_full_window": False,
        "new_host_delay": None,
        "notify_no_data": False,
        "no_data_timeframe": None,
        "timeout_h": None,
        "renotify_interval": 0,
        "escalation_message": "",
        "notify_audit": False,
        "locked": False,
    }
    r = evaluate_monitor_options(opts, source_id="m")
    assert r == OptionsOk(thresholds=MonitorThresholds(critical=5.0), diagnostics=[])


@pytest.mark.parametrize("delay", [None, 0, 60, 86400])
def test_evaluation_delay_is_explicit_and_exact(delay: int | None) -> None:
    result = evaluate_monitor_options(
        {"thresholds": {"critical": 5}, "evaluation_delay": delay}, source_id="m"
    )
    assert isinstance(result, OptionsOk)
    assert result.evaluation_delay == (delay or 0)
    assert result.diagnostics == []


@pytest.mark.parametrize("delay", [-1, 86401, 60.5, True, "60", float("inf")])
def test_invalid_evaluation_delay_blocks(delay: object) -> None:
    assert blocked_paths({"thresholds": {"critical": 5}, "evaluation_delay": delay}) == [
        "options.evaluation_delay"
    ]
