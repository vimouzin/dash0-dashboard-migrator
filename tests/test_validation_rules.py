from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from migrator.validation import validate_check_rule, validate_prometheus_rule_group

GOLD = Path("fixtures/expected/postgres-monitors")
SLUG = "postgres-number-of-connections-is-approaching-connection-limit-o"


def check_rule() -> dict[str, Any]:
    data = json.loads((GOLD / f"check-rules/{SLUG}.json").read_text())
    assert isinstance(data, dict)
    return data


def rule_group() -> dict[str, Any]:
    data = json.loads((GOLD / f"rules/{SLUG}.prometheus.json").read_text())
    assert isinstance(data, dict)
    return data


def test_golden_artifacts_validate() -> None:
    assert validate_check_rule(check_rule()) == []
    assert validate_prometheus_rule_group(rule_group()) == []


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        (lambda r: r.update(id="abc"), "id"),
        (lambda r: r.update(enabled=True), "enabled"),
        (lambda r: r.pop("for"), "for"),
        (lambda r: r.update(expression="up > 1"), "expression"),
        (lambda r: r.update(expression=r["expression"] + "\n"), "expression"),
        (lambda r: r.update(expression="avg_over_time(( > $__threshold"), "syntax error"),
        (lambda r: r["thresholds"].pop("failed"), "failed"),
        (lambda r: r["annotations"].update(summary="x" * 256), "summary"),
        (lambda r: r["thresholds"].update(degraded=None), "degraded"),
    ],
)
def test_check_rule_rejects(change: Any, fragment: str) -> None:
    r = copy.deepcopy(check_rule())
    change(r)
    problems = validate_check_rule(r)
    assert problems
    assert any(fragment in p for p in problems), problems


def test_rule_group_rejects_bad_expr_and_extra_keys() -> None:
    g = copy.deepcopy(rule_group())
    g["groups"][0]["rules"][0]["expr"] = "sum(("
    assert any("syntax error" in p for p in validate_prometheus_rule_group(g))
    g = copy.deepcopy(rule_group())
    g["groups"][0]["rules"][0]["for"] = "15m"
    assert validate_prometheus_rule_group(g)


@pytest.mark.parametrize("variable", ["$__rate_interval", "$__interval", "$__range"])
def test_rule_group_rejects_dashboard_variables(variable: str) -> None:
    g = copy.deepcopy(rule_group())
    g["groups"][0]["rules"][0]["expr"] = (
        f'avg_over_time((avg (rate({{a="b"}}[{variable}])))[5m:1m]) > 1000'
    )
    assert any("syntax error" in p for p in validate_prometheus_rule_group(g))


@pytest.mark.parametrize("variable", ["$__rate_interval", "$__interval", "$__range"])
def test_check_rule_rejects_dashboard_variables(variable: str) -> None:
    r = copy.deepcopy(check_rule())
    r["expression"] = f'avg_over_time((avg (rate({{a="b"}}[{variable}])))[5m:1m]) > $__threshold'
    assert any("syntax error" in p for p in validate_check_rule(r))


def test_check_rule_with_fixed_rate_range_is_valid() -> None:
    r = copy.deepcopy(check_rule())
    r["expression"] = 'avg_over_time((avg (rate({a="b"}[5m])))[5m:1m]) > $__threshold'
    assert validate_check_rule(r) == []
