"""Function semantics use real raw sample windows, never a discarded suffix."""

import pytest

from migrator.source.datadog.compile_query import CompiledError
from migrator.validation import check_promql_syntax
from tests.datadog.helpers import entry, mapping
from tests.datadog.test_compile_query import SEL, codes, ok, run


def test_weighted_weights_raw_presence_before_grain_and_space() -> None:
    m = mapping(
        postgresql__connections=entry(grain={"aggregation": "max", "labels": ["host_name"]})
    )
    result = ok("sum:postgresql.connections{*} by {db}.weighted()", m)
    weighted = (
        f"sum_over_time({SEL}[$__rate_interval]) / "
        f"scalar(max(count_over_time({SEL}[$__rate_interval])))"
    )
    assert result.promql == (
        "sum by (postgresql_database_name) (max by (postgresql_database_name, host_name) "
        f"({weighted}))"
    )
    assert codes(result) == ["BEST_EFFORT"]
    assert result.diagnostics[0].remark == "WEIGHTED"
    assert "denominator=max sample count" in result.diagnostics[0].message
    assert result == ok("sum:postgresql.connections{*} by {db}.weighted()", m)
    assert check_promql_syntax(result.promql) is None


def test_weighted_offsets_both_sample_windows_and_keeps_fixed_filters() -> None:
    m = mapping(postgresql__connections=entry(matchers={"operation": "active"}, scale=0.5))
    result = ok("sum:postgresql.connections{db:x}.weighted()", m, offset=3600)
    assert result.promql.count("offset 1h") == 2
    assert result.promql.count('postgresql_database_name="x", operation="active"') == 2
    assert result.promql.endswith("* 0.5")
    assert check_promql_syntax(result.promql) is None


@pytest.mark.parametrize(
    ("call", "reducer", "window"),
    [
        ("rollup(avg, 60)", "avg", "60s"),
        ("rollup(sum, 120)", "sum", "120s"),
        ("rollup(count, 1)", "count", "1s"),
        ("rollup(min, 86400)", "min", "86400s"),
        ("rollup(max)", "max", "$__rate_interval"),
        ("rollup(10)", "avg", "10s"),
    ],
)
def test_rollup_is_time_then_space(call, reducer, window) -> None:
    result = ok(f"sum:postgresql.connections{{*}} by {{db}}.{call}")
    assert result.promql == (
        f"sum by (postgresql_database_name) ({reducer}_over_time({SEL}[{window}]))"
    )
    assert result.diagnostics[0].remark == "ROLLUP"
    assert codes(result) == ["BEST_EFFORT"]
    assert check_promql_syntax(result.promql) is None


@pytest.mark.parametrize(
    "call",
    [
        "rollup()",
        "rollup(avg, -1)",
        "rollup(avg, 0.5)",
        "rollup(avg, 86401)",
        "rollup(avg, 60, 1)",
        "rollup(avg, weekly)",
        "as_rate(60)",
        "as_count(60)",
        "as_count()",  # gauge mapping: blocked until a counter mapping exists
    ],
)
def test_unsupported_forms_are_blocked_completely(call) -> None:
    result = run(f"sum:postgresql.connections{{*}}.{call}")
    assert isinstance(result, CompiledError)
    assert codes(result) == ["UNSUPPORTED_QUERY_FUNCTION"]


def test_enormous_rollup_number_does_not_crash() -> None:
    result = run("sum:postgresql.connections{*}.rollup(" + "9" * 5000 + ")")
    assert isinstance(result, CompiledError)


def test_as_rate_requires_rate_mapping_and_retains_counter_reset_handling() -> None:
    m = mapping(
        postgresql__rows_fetched=entry(
            kind="rate", target={"name": "postgresql.tup_fetched", "type": "sum"}, rateWindow="5m"
        )
    )
    result = ok("avg:postgresql.rows_fetched{*}.as_rate()", m)
    assert (
        'rate({otel_metric_name="postgresql.tup_fetched", otel_metric_type="sum"}[5m])'
        in result.promql
    )
    assert codes(result) == ["BEST_EFFORT"]
    assert result.diagnostics[0].remark == "ASRATE"
    assert check_promql_syntax(result.promql) is None
    assert isinstance(run("avg:postgresql.connections{*}.as_rate()"), CompiledError)
    for modifier in ("weighted()", "rollup(avg,60)"):
        blocked = run(f"sum:postgresql.rows_fetched{{*}}.{modifier}", m)
        assert isinstance(blocked, CompiledError)
        assert "requires a 'gauge'" in blocked.diagnostics[-1].message


def test_as_count_counts_per_panel_step_on_counter_mappings() -> None:  # #181
    m = mapping(
        postgresql__rows_fetched=entry(
            kind="rate", target={"name": "postgresql.tup_fetched", "type": "sum"}, rateWindow="5m"
        )
    )
    result = ok("sum:postgresql.rows_fetched{*} by {db}.as_count()", m)
    assert result.promql == (
        "sum by (postgresql_database_name) (increase("
        '{otel_metric_name="postgresql.tup_fetched", otel_metric_type="sum"}[$__interval]))'
    )
    assert codes(result) == ["BEST_EFFORT"]
    assert result.diagnostics[0].remark == "ASCOUNT"
    assert check_promql_syntax(result.promql) is None
    blocked = run("sum:postgresql.connections{*}.as_count()")
    assert isinstance(blocked, CompiledError)
    assert "requires a 'rate'" in blocked.diagnostics[-1].message


def test_expression_mapping_does_not_invent_raw_samples() -> None:
    raw = entry(
        kind="expression",
        expression='sum({otel_metric_name="postgresql.backends"$filters})',
        outputLabels=[],
    )
    del raw["target"]
    m = mapping(postgresql__connections=raw)
    for call in ("weighted()", "rollup(avg,60)", "as_rate()"):
        blocked = run(f"sum:postgresql.connections{{*}}.{call}", m)
        assert isinstance(blocked, CompiledError)
        assert "raw series semantics" in blocked.diagnostics[-1].message
