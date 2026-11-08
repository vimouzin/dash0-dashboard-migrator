import pytest

from migrator.source.datadog.model import (
    MetricQuery,
    ParseError,
    ParseOk,
    QueryFunction,
    TagFilter,
    VariableFilter,
)
from migrator.source.datadog.parse_query import parse_metric_query as p


def ok(text: str) -> MetricQuery:
    r = p(text)
    assert isinstance(r, ParseOk), r
    return r.query


def err(text: str) -> ParseError:
    r = p(text)
    assert isinstance(r, ParseError), r
    return r


def test_parses_aggregator_variable_filter_and_group_by() -> None:
    assert ok("avg:postgresql.connections{$scope} by {db}") == MetricQuery(
        aggregator="avg",
        metric="postgresql.connections",
        filters=[VariableFilter("scope")],
        group_by=["db"],
        functions=[],
    )


def test_parses_missing_aggregator_as_none() -> None:
    assert ok("postgresql.rows_inserted{$scope}").aggregator is None


def test_parses_star_and_tag_filters() -> None:
    assert ok("avg:x.y{*}").filters == []
    assert ok("max:system.cpu.iowait{env:demo, host:db-1}").filters == [
        TagFilter("env", "demo"),
        TagFilter("host", "db-1"),
    ]


def test_parses_numeric_metric_segments() -> None:
    # Grammar widening: the golden "System load" widget uses system.load.1.
    assert ok("system.load.15{$scope}").metric == "system.load.15"
    assert err("avg:1system{*}").offset == 4


def test_parses_trailing_functions_for_later_rejection() -> None:
    assert ok("sum:x{*}.rollup(max, 60).as_count()").functions == [
        QueryFunction("rollup", ["max", "60"]),
        QueryFunction("as_count", []),
    ]


def test_rejects_wrapping_functions() -> None:
    assert p("anomalies(avg:x{*}, 'basic', 2)") == ParseError(
        code="UNSUPPORTED_QUERY_FUNCTION",
        offset=0,
        message="Function 'anomalies' is not supported.",
    )


def test_negation_glob_and_same_key_or_parse() -> None:  # #178
    q = ok("avg:x{!env:prod, host:db-*, (az:a OR az:b)}")
    assert q.filters == [
        TagFilter("env", "prod", negated=True),
        TagFilter("host", "db-*"),
        TagFilter("az", "a", alternatives=("b",)),
    ]


def test_boolean_keywords_and_spaces_parse() -> None:  # #178
    q = ok("avg:x{$env AND NOT host:a , $cluster-name AND $logs.auth.token}")
    assert q.filters == [
        VariableFilter("env"),
        TagFilter("host", "a", negated=True),
        VariableFilter("cluster-name"),
        VariableFilter("logs.auth.token"),
    ]


def test_not_or_group_negates_each_value() -> None:  # #178
    q = ok("avg:x{NOT (env:a OR env:b)}")
    assert q.filters == [TagFilter("env", "a", negated=True), TagFilter("env", "b", negated=True)]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("avg:x{env:a OR host:b}", "OR is only supported between positive filters of one tag key"),
        ("avg:x{NOT (env:a AND host:b)}", "A negated AND group is not supported"),
        ("avg:x{!$env}", "Unexpected '$'"),
    ],
)
def test_inexpressible_boolean_filters_block(text: str, message: str) -> None:  # #178
    assert err(text).message.startswith(message)


def test_rejects_trailing_input() -> None:
    e = err("avg:x{*} / 2")
    assert (e.code, e.offset, e.message) == (
        "UNSUPPORTED_QUERY_SYNTAX",
        8,
        "Unexpected ' ' at offset 8.",
    )


def test_rejects_empty_input() -> None:
    assert err("").offset == 0
    assert err("   ").offset == 0
    assert err("").message == "Unexpected end of query at offset 0."


def test_rejects_unknown_aggregator() -> None:
    assert err("count:x{*}").offset == 0


def test_rejects_non_ascii_at_its_offset() -> None:
    assert err("avg:x{a:\U0001f600}").offset == 8
