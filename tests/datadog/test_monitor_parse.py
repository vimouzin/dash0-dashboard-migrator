from __future__ import annotations

import json
from pathlib import Path

from migrator.source.datadog.model import (
    MetricQuery,
    MonitorExpression,
    MonitorParseOk,
    MonitorQuery,
    MonitorWindow,
    ParseError,
)
from migrator.source.datadog.monitor import parse_monitor_query
from migrator.source.datadog.monitor_expression import monitor_source_queries
from migrator.source.datadog.parse_query import parse_metric_query

PINNED = Path("fixtures/datadog/integrations-core/postgres/monitors")


def pinned_query(name: str) -> str:
    query = json.loads((PINNED / name).read_text())["definition"]["query"]
    assert isinstance(query, str)
    return query


def test_parses_the_golden_monitor() -> None:
    r = parse_monitor_query(pinned_query("percent_usage_connections.json"))
    assert r == MonitorParseOk(
        MonitorQuery(
            time_aggregator="avg",
            window=MonitorWindow(15, "m"),
            query=MetricQuery(aggregator="avg", metric="postgresql.percent_usage_connections"),
            comparator=">",
            threshold=0.9,
        )
    )


def test_blocks_anomalies() -> None:
    r = parse_monitor_query(pinned_query("replication_delay.json"))
    assert isinstance(r, ParseError)
    assert r.code == "UNSUPPORTED_QUERY_FUNCTION"
    assert r.message.startswith("Function 'anomalies' is not supported: ")
    assert "docs.datadoghq.com/monitors/types/anomaly/" in r.message


def test_parses_classic_arithmetic() -> None:
    r = parse_monitor_query(
        "avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90"
    )
    assert isinstance(r, MonitorParseOk)
    assert isinstance(r.monitor.query, MonitorExpression)
    leaves, formula = monitor_source_queries(r.monitor.query)
    assert leaves == ["avg:redis.mem.used{*}", "avg:redis.mem.maxmemory{*}"]
    assert formula == "((100 * q0) / q1)"
    for inner in ["avg:a{*} - avg:b{*}", "(avg:a{*}) + 1", "-avg:a{*}", "avg:a{*} * 2"]:
        r = parse_monitor_query(f"avg(last_5m):{inner} > 1")
        assert isinstance(r, MonitorParseOk), (inner, r)
    # Tag values with '-' or '/' are not arithmetic.
    r = parse_monitor_query("avg(last_5m):avg:a{env:prod-1,path:/x} by {host}junk > 1")
    assert isinstance(r, ParseError)


def test_arithmetic_requires_all_input_and_complete_metric_leaves() -> None:
    for inner in [
        "avg:a{*} /",
        "1 + 2",
        "(avg:a{*} + 1",
        "avg:a{*} + avg:b{*}junk",
        "avg:a{*} + unsupported(avg:b{*})",
        "avg:a{*} + avg:b{*}.rollup(avg,)",
    ]:
        result = parse_monitor_query(f"avg(last_5m):{inner} > 1")
        assert isinstance(result, ParseError), (inner, result)


def test_arithmetic_filters_and_functions_are_preserved() -> None:
    result = parse_monitor_query(
        "sum(last_5m):avg:a{env:prod-1,path:/x} by {host}.as_rate() / "
        "avg:b{env:prod-1,path:/x} by {host} > 1"
    )
    assert isinstance(result, MonitorParseOk)
    assert monitor_source_queries(result.monitor.query) == (
        ["avg:a{env:prod-1,path:/x} by {host}.as_rate()", "avg:b{env:prod-1,path:/x} by {host}"],
        "(q0 / q1)",
    )


def test_nested_arithmetic_is_bounded_and_deterministic() -> None:
    text = "avg(last_5m):" + "(" * 70 + "avg:a{*}" + ")" * 70 + " > 1"
    result = parse_monitor_query(text)
    assert isinstance(result, ParseError)
    assert result == parse_monitor_query(text)


def test_blocks_unknown_window_unit() -> None:
    r = parse_monitor_query("avg(last_1w):avg:x{*} > 1")
    assert isinstance(r, ParseError)
    assert (r.code, r.offset) == ("UNSUPPORTED_QUERY_SYNTAX", 0)


def test_parses_comparators_negative_and_hours() -> None:
    r = parse_monitor_query("max(last_2h):sum:x{a:b} by {host} <= -1.5")
    assert isinstance(r, MonitorParseOk)
    m = r.monitor
    assert (m.time_aggregator, m.window, m.comparator, m.threshold) == (
        "max",
        MonitorWindow(2, "h"),
        "<=",
        -1.5,
    )
    assert isinstance(m.query, MetricQuery)
    assert m.query.group_by == ["host"]


def test_blocks_missing_threshold_at_end() -> None:
    text = "avg(last_5m):avg:x{*}"
    r = parse_monitor_query(text)
    assert isinstance(r, ParseError)
    assert (r.code, r.offset) == ("UNSUPPORTED_QUERY_SYNTAX", len(text))


def test_inner_syntax_offsets_are_shifted_by_the_prefix() -> None:
    prefix = "avg(last_5m):"
    inner = "avg:x{*"
    direct = parse_monitor_query(f"{prefix}{inner} > 1")
    assert isinstance(direct, ParseError)
    alone = parse_metric_query(inner)
    assert isinstance(alone, ParseError)
    assert direct.offset == alone.offset + len(prefix)
