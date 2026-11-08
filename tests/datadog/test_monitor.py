from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import promql_parser
import pytest

from migrator.source.asset import SourceAsset
from migrator.source.datadog.mapping import DatadogMapping, MappingOk, parse_mapping
from migrator.source.datadog.monitor import (
    MonitorCompilation,
    compile_monitor,
    escape_template_braces,
)
from migrator.write import slugify

MONITORS = Path("fixtures/datadog/integrations-core/postgres/monitors")
SLUG = "postgres-number-of-connections-is-approaching-connection-limit-o"
# Plan 06 Task 3's expected PromQL for avg:postgresql.percent_usage_connections{*}.
C = (
    "avg (sum by (service_instance_id) (max by (service_instance_id, postgresql_database_name) "
    '({otel_metric_name="postgresql.backends", otel_metric_type="sum"})) '
    "/ on (service_instance_id) "
    'max by (service_instance_id) ({otel_metric_name="postgresql.connection.max", '
    'otel_metric_type="gauge"}))'
)
CONDITION = f"avg_over_time(({C})[15m:1m])"


def mapping() -> DatadogMapping:
    r = parse_mapping(json.loads(Path("mappings/datadog/postgres.json").read_text()))
    assert isinstance(r, MappingOk)
    return r.mapping


def pinned(name: str) -> dict[str, Any]:
    body = json.loads((MONITORS / name).read_text())["definition"]
    assert isinstance(body, dict)
    return body


def asset(body: dict[str, Any], source_id: str = "monitors/m.json") -> SourceAsset:
    return SourceAsset(source_id, "monitor", str(body.get("name", "")), body, body)


def golden_body() -> dict[str, Any]:
    return copy.deepcopy(pinned("percent_usage_connections.json"))


def run(body: dict[str, Any]) -> MonitorCompilation:
    return compile_monitor(asset(body), SLUG, mapping())


def codes(r: MonitorCompilation, severity: str = "error") -> list[str]:
    return [d.code for d in r.diagnostics if d.severity == severity]


def test_golden_monitor_renders_both_artifacts() -> None:
    body = golden_body()
    assert slugify(body["name"]) == SLUG
    r = run(body)
    # require_full_window and new_host_delay are A3 approximations with remark tags.
    assert (r.item.outcome, r.item.remarks) == ("approximated", ("NEWHOST", "FULLWINDOW"))
    assert r.rule is not None
    check = r.rule.check_rule
    assert check["expression"] == f"{CONDITION} > $__threshold"
    assert check["thresholds"] == {"degraded": 0.8, "failed": 0.9}
    assert check["enabled"] is False
    assert (check["interval"], check["for"]) == ("1m", "0s")
    assert check["labels"] == {"migration_remarks": "NEWHOST,FULLWINDOW"}
    assert "id" not in check

    (group,) = r.rule.prometheus_rule_group["groups"]
    assert (group["name"], group["interval"]) == (SLUG, "1m")
    assert [rule["expr"] for rule in group["rules"]] == [f"{CONDITION} > 0.8", f"{CONDITION} > 0.9"]
    assert [rule["labels"]["severity"] for rule in group["rules"]] == ["warning", "critical"]
    assert {rule["labels"]["migration_remarks"] for rule in group["rules"]} == {
        "NEWHOST,FULLWINDOW"
    }
    assert all(rule["alert"] == SLUG for rule in group["rules"])
    assert all(rule["annotations"] == check["annotations"] for rule in group["rules"])
    assert codes(r) == []


def test_annotations_escape_datadog_templates() -> None:
    r = run(golden_body())
    assert r.rule is not None
    ann = r.rule.check_rule["annotations"]
    assert ann["summary"].endswith('on {{ "{{" }}host.name{{ "}}" }}')
    assert ann["description"].startswith('{{ "{{" }}#is_alert{{ "}}" }}')


def test_escapes_template_braces_in_one_pass() -> None:
    assert escape_template_braces("a {{host.name}} b") == 'a {{ "{{" }}host.name{{ "}}" }} b'
    # One pass: the escape output itself is not escaped again.
    assert escape_template_braces("{{{") == '{{ "{{" }}{'


def test_blocks_threshold_mismatch() -> None:
    body = golden_body()
    body["query"] = body["query"].replace("> 0.9", "> 0.95")
    r = run(body)
    assert (r.rule, r.item.outcome) == (None, "blocked")
    assert codes(r) == ["THRESHOLD_MISMATCH"]


def test_blocks_inverted_warning() -> None:
    body = golden_body()
    body["options"]["thresholds"]["warning"] = 0.95
    r = run(body)
    assert r.rule is None
    assert codes(r) == ["THRESHOLD_MISMATCH"]
    assert [d.source_path for d in r.diagnostics if d.severity == "error"] == [
        "options.thresholds.warning"
    ]


@pytest.mark.parametrize(("cmp", "warning", "ok"), [("<", 0.95, True), ("<", 0.8, False)])
def test_warning_side_follows_comparator(cmp: str, warning: float, ok: bool) -> None:
    body = golden_body()
    body["query"] = body["query"].replace("> 0.9", f"{cmp} 0.9")
    body["options"]["thresholds"]["warning"] = warning
    assert (run(body).rule is not None) is ok


def test_blocks_windows_over_7d() -> None:
    body = golden_body()
    body["query"] = body["query"].replace("last_15m", "last_8d")
    r = run(body)
    assert r.rule is None
    assert codes(r) == ["UNSUPPORTED_MONITOR_OPTION"]


def test_accepts_window_of_exactly_7d() -> None:
    body = golden_body()
    body["query"] = body["query"].replace("last_15m", "last_7d")
    r = run(body)
    assert r.rule is not None
    assert "[7d:1m]" in r.rule.check_rule["expression"]


def test_truncates_long_descriptions() -> None:
    body = golden_body()
    body["message"] = "x" * 3000
    r = run(body)
    assert r.rule is not None
    description = r.rule.check_rule["annotations"]["description"]
    assert len(description) <= 2048
    assert description.endswith("…")
    assert ("TEXT_TRUNCATED", "message") in [
        (d.code, d.source_path) for d in r.diagnostics if d.severity == "warning"
    ]


def test_truncation_never_splits_an_escape_token() -> None:
    body = golden_body()
    body["message"] = "{{x}}" * 1000
    r = run(body)
    assert r.rule is not None
    description = r.rule.check_rule["annotations"]["description"]
    assert len(description) <= 2048
    body_part = description[:-1]
    assert body_part.endswith(('{{ "}}" }}', '{{ "{{" }}', "x"))


def test_replication_delay_is_blocked() -> None:
    r = compile_monitor(asset(pinned("replication_delay.json")), "replication", mapping())
    assert r.rule is None
    assert r.item.outcome == "blocked"
    assert [d.code for d in r.diagnostics] == ["UNSUPPORTED_QUERY_FUNCTION"]


def test_blocks_unsupported_monitor_type() -> None:
    body = golden_body()
    body["type"] = "service check"
    r = run(body)
    assert codes(r) == ["UNSUPPORTED_MONITOR_TYPE"]


def test_blocks_unmapped_metric() -> None:
    body = golden_body()
    body["query"] = body["query"].replace("postgresql.percent_usage_connections", "nope.metric")
    r = run(body)
    assert r.rule is None
    assert codes(r) == ["MISSING_METRIC_MAPPING"]


def test_notification_handles_and_ignored_fields() -> None:
    body = golden_body()
    body["message"] = "Disk full @pagerduty-db @slack-ops mail me at a@b.c"
    body["priority"] = 2
    r = run(body)
    assert r.rule is not None
    notes = [d for d in r.diagnostics if d.code == "NOTIFICATION_NOT_MIGRATED"]
    assert len(notes) == 1
    assert "@pagerduty-db, @slack-ops" in notes[0].message
    assert "a@b.c" not in notes[0].message
    ignored = [d.source_path for d in r.diagnostics if d.code == "OPTION_IGNORED"]
    assert {"priority", "tags"} <= set(ignored)


@pytest.mark.parametrize(
    ("message", "handle"),
    [
        ("{{#is_alert}}@pagerduty-db{{/is_alert}}", "@pagerduty-db"),
        ("notify (@slack-ops) now", "@slack-ops"),
        ("@oncall first", "@oncall"),
        ("line one\n@webhook-x", "@webhook-x"),
    ],
)
def test_handles_after_template_or_punctuation_are_reported(message: str, handle: str) -> None:
    body = golden_body()
    body["message"] = message
    notes = [d for d in run(body).diagnostics if d.code == "NOTIFICATION_NOT_MIGRATED"]
    assert len(notes) == 1
    assert handle in notes[0].message


def test_email_addresses_are_not_handles() -> None:
    body = golden_body()
    body["message"] = "mail ops+db@example.com or a.b@c.d"
    assert "NOTIFICATION_NOT_MIGRATED" not in codes(run(body))


def test_diagnostics_are_sorted_by_path() -> None:
    paths = [d.source_path for d in run(golden_body()).diagnostics]
    assert paths == sorted(paths)


def test_integer_thresholds_render_without_decimals() -> None:
    body = golden_body()
    body["query"] = body["query"].replace("> 0.9", "> 90")
    body["options"]["thresholds"] = {"critical": 90, "warning": 80}
    r = run(body)
    assert r.rule is not None
    exprs = [rule["expr"] for rule in r.rule.prometheus_rule_group["groups"][0]["rules"]]
    assert [e.rsplit(" ", 1)[1] for e in exprs] == ["80", "90"]


def test_rate_monitor_uses_a_fixed_range_not_the_dashboard_variable() -> None:
    body = golden_body()
    body["query"] = "avg(last_5m):avg:postgresql.rows_fetched{*} > 1000"
    body["options"]["thresholds"] = {"critical": 1000}
    r = run(body)
    assert r.rule is not None, r.diagnostics
    exprs = [rule["expr"] for rule in r.rule.prometheus_rule_group["groups"][0]["rules"]]
    exprs.append(r.rule.check_rule["expression"].replace("$__threshold", "1000"))
    for expr in exprs:
        assert "$" not in expr, expr
        assert "[5m])" in expr, expr
        promql_parser.parse(expr)  # raises on a syntax error


def test_empty_window_is_an_unsupported_option() -> None:
    body = golden_body()
    body["query"] = body["query"].replace("last_15m", "last_0m")
    r = run(body)
    assert r.rule is None
    assert codes(r) == ["UNSUPPORTED_MONITOR_OPTION"]


@pytest.mark.parametrize(
    ("reducer", "target_function"),
    [
        ("avg", "avg_over_time"),
        ("sum", "sum_over_time"),
        ("min", "min_over_time"),
        ("max", "max_over_time"),
    ],
)
def test_classic_arithmetic_is_reduced_after_division(reducer: str, target_function: str) -> None:
    body = golden_body()
    body["query"] = (
        f"{reducer}(last_5m):100 * avg:postgresql.connections{{*}} by {{db}} / "
        "avg:postgresql.connections{*} by {db} > 90"
    )
    body["options"] = {"thresholds": {"critical": 90, "warning": 80}}
    result = run(body)
    assert result.rule is not None, result.diagnostics
    assert result.item.outcome == "translated"
    expression = result.rule.check_rule["expression"]
    assert expression.startswith(f"{target_function}((100 * (")
    assert expression.endswith("[5m:1m]) > $__threshold")
    # Exactly one time reducer surrounds the entire ratio. Reducing each metric
    # first instead would compute the different Datadog as_count evaluation path.
    assert expression.count("_over_time(") == 1
    assert expression.count(" / ") == 1
    assert result.rule.check_rule["enabled"] is False
    for rule in result.rule.prometheus_rule_group["groups"][0]["rules"]:
        condition, _, threshold = rule["expr"].rpartition(" > ")
        assert condition == expression.removesuffix(" > $__threshold")
        assert threshold in ("80", "90")
        promql_parser.parse(rule["expr"])


def test_arithmetic_requires_compatible_grouping() -> None:
    body = golden_body()
    body["query"] = (
        "avg(last_5m):avg:postgresql.connections{*} by {db} / avg:postgresql.connections{*} > 0.9"
    )
    result = run(body)
    assert result.rule is None
    assert codes(result) == ["UNSUPPORTED_FORMULA"]
    assert "grouping mismatch" in next(
        d.message for d in result.diagnostics if d.severity == "error"
    )


def test_arithmetic_blocks_whole_monitor_when_one_leaf_has_no_mapping() -> None:
    body = golden_body()
    body["query"] = "avg(last_5m):avg:postgresql.connections{*} / avg:unknown.metric{*} > 0.9"
    result = run(body)
    assert (result.rule, result.item.outcome) == (None, "blocked")
    assert codes(result) == ["MISSING_METRIC_MAPPING"]


@pytest.mark.parametrize(
    "inner",
    [
        "sum:postgresql.rows_fetched{*}.as_count()",
        "sum:postgresql.rows_fetched{*}.as_count() / sum:postgresql.rows_returned{*}.as_count()",
    ],
)
def test_as_count_never_uses_the_classic_monitor_path(inner: str) -> None:
    body = golden_body()
    body["query"] = f"sum(last_5m):{inner} > 0.9"
    result = run(body)
    assert result.rule is None
    assert codes(result) == ["UNSUPPORTED_QUERY_FUNCTION"]
    error = next(d.message for d in result.diagnostics if d.severity == "error")
    assert "time aggregation before arithmetic" in error
    assert "as-count-in-monitor-evaluations" in error


def test_delay_offsets_the_complete_monitor_lookback() -> None:
    body = golden_body()
    body["options"]["evaluation_delay"] = 300
    result = run(body)
    assert result.rule is not None
    assert (
        result.rule.check_rule["expression"]
        == f"avg_over_time(({C})[15m:1m] offset 300s) > $__threshold"
    )
    expression = result.rule.check_rule["expression"].replace("$__threshold", "0.9")
    promql_parser.parse(expression)
    assert result.item.outcome == "approximated"  # Existing FULLWINDOW/NEWHOST only.


def test_arithmetic_conversion_is_repeatable() -> None:
    body = golden_body()
    body["query"] = "avg(last_5m):(avg:postgresql.connections{*} + 1) / 2 > 0.9"
    assert run(body) == run(copy.deepcopy(body))
