"""Source-text rules in scripts/build_expected.py that mirror the converter (PR #85)."""

from __future__ import annotations

from typing import Any

import build_expected as be
import pytest

VARS = {
    "scope": {"name": "scope", "prefix": None, "default": "*"},
    "host": {"name": "host", "prefix": "host", "default": "*"},
    "env": {"name": "env", "prefix": "env", "default": "prod"},
}


def request(*queries: str, formulas: list[str] | None = None, logs: bool = False) -> dict[str, Any]:
    qs: list[dict[str, Any]] = [
        {"name": f"query{i + 1}", "data_source": "metrics", "query": q}
        for i, q in enumerate(queries)
    ]
    if logs:
        qs.append({"name": "logs1", "data_source": "logs", "query": None})
    return {"queries": qs, "formulas": formulas or []}


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("top(avg:x{*}, 10, 'mean', 'desc')", "UNSUPPORTED_QUERY_FUNCTION"),
        ("-sum:x{*}.as_count()", "UNSUPPORTED_QUERY_SYNTAX"),  # parse fails before the function
        ("100*(sum:x{*})", "UNSUPPORTED_QUERY_SYNTAX"),
        ("count:x{*}", "UNSUPPORTED_QUERY_SYNTAX"),
        ("p95:x{*} by {topic}", "UNSUPPORTED_QUERY_SYNTAX"),
        ("sum:x{*}.rollup(max)", "UNSUPPORTED_QUERY_FUNCTION"),
        ("x.y{$scope}", None),  # no space aggregator: Datadog's default avg
        ("avg:x{$nope}", "UNSUPPORTED_TEMPLATE_VARIABLE"),
        ("avg:x{$env}", "UNSUPPORTED_TEMPLATE_VARIABLE"),  # default other than '*'
        ("avg:x{$scope,$host} by {host}", None),  # only a mapping lookup can block it
    ],
)
def test_query_error_follows_the_converter_check_order(text: str, code: str | None) -> None:
    assert be.query_error(text, VARS) == code


def test_read_errors_stop_before_query_checks() -> None:
    req = request("x.y{*}", formulas=["query1 + logs1"], logs=True)
    assert be.rule_errors(req, VARS) == ["UNSUPPORTED_DATA_SOURCE", "UNSUPPORTED_FORMULA"]


def test_abs_formula_is_allowed_but_other_formula_functions_block() -> None:
    assert be.rule_errors(request("avg:x{*}", formulas=["abs(query1)"]), VARS) == []
    assert be.blocked_functions(request("avg:x{*}", formulas=["abs(query1)"])) == []
    req = request("avg:x{*}", formulas=["top(abs(query1), 5, 'mean', 'desc')"])
    assert be.rule_errors(req, VARS) == ["UNSUPPORTED_FORMULA"]
    assert be.query_error("abs(avg:x{*})", VARS) == "UNSUPPORTED_QUERY_FUNCTION"


def test_only_queries_referenced_by_a_formula_are_checked() -> None:
    req = request("avg:x{*}", "count:y{*}", formulas=["query1 * 2"])
    assert be.rule_errors(req, VARS) == []


def test_rule_errors_collect_one_code_per_offending_query() -> None:
    req = request("avg:x.y{$nope}", "sum:z{*}.as_count()")
    assert be.rule_errors(req, VARS) == ["UNSUPPORTED_QUERY_FUNCTION", "UNSUPPORTED_TEMPLATE_VARIABLE"]


def test_only_unprefixed_variables_are_dropped() -> None:
    assert be.rule_warnings(request("avg:x{$scope,$host}"), VARS) == ["TEMPLATE_VARIABLE_DROPPED"]
    assert be.rule_warnings(request("avg:x{$host}"), VARS) == []


def test_expectations_use_the_whole_mapping_directory() -> None:
    assert be.build("redisdb/overview")["mapping"] == "mappings/datadog"


def test_missing_aggregator_warns_like_the_converter() -> None:
    assert be.rule_warnings(request("x.y{$scope}"), VARS) == [
        "DEFAULT_AGGREGATOR_APPLIED",
        "TEMPLATE_VARIABLE_DROPPED",
    ]
    assert be.rule_warnings(request("avg:x.y{*}"), VARS) == []


def test_request_less_widgets_can_be_reviewed_by_override(monkeypatch: pytest.MonkeyPatch) -> None:
    key = "nginx/NGINX-Overview_dashboard"
    built = be.build(key)
    note = next(w for w in built["widgets"] if w["type"] == "note")
    assert note["reviewed"] is False
    real_exists = be.Path.exists

    def exists(path: be.Path) -> bool:
        return bool(path.name == "overrides.yaml" or real_exists(path))

    def read_text(path: be.Path, *args: Any, **kwargs: Any) -> str:
        if path.name == "overrides.yaml":
            return f"'{note['source_path']}':\n  reviewed: true\n"
        return str(real_read(path, *args, **kwargs))

    real_read = be.Path.read_text
    monkeypatch.setattr(be.Path, "exists", exists)
    monkeypatch.setattr(be.Path, "read_text", read_text)
    reviewed = next(w for w in be.build(key)["widgets"] if w["source_path"] == note["source_path"])
    assert reviewed["reviewed"] is True
    assert reviewed["provenance"]["kind"] == "human"


def test_widget_time_option_blocks_the_widget() -> None:
    built = be.build("docker_daemon/docker_dashboard")
    timed = [w for w in built["widgets"] if w["type"] == "timeseries"]
    assert timed and all(w["expected"]["outcome"] == "blocked" for w in timed)
    assert all("UNSUPPORTED_WIDGET" in w["expected"]["errors"] for w in timed)


def test_promoted_variable_matchers_are_anchored_like_the_converter() -> None:
    promql = ['avg({otel_metric_name="m", host_name=~"$host", x=~"$unknown"})']
    assert be.anchor_variable_matchers(promql, VARS) == [
        'avg({otel_metric_name="m", host_name=~"^($host)$", x=~"$unknown"})'
    ]
