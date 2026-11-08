from migrator.promql import (
    Matcher,
    MetricRef,
    escape_label_value,
    format_offset,
    render_selector,
)
from migrator.validation import check_promql_syntax


def test_escapes_label_values() -> None:
    assert escape_label_value('a"b\\c\nd') == 'a\\"b\\\\c\\nd'


def test_renders_the_dash0_selector() -> None:
    assert (
        render_selector(
            MetricRef("postgresql.backends", "sum"),
            [Matcher("postgresql_database_name", "astronomy_db")],
        )
        == '{otel_metric_name="postgresql.backends", otel_metric_type="sum", '
        'postgresql_database_name="astronomy_db"}'
    )


def test_escaped_value_never_breaks_out_of_the_selector() -> None:
    sel = render_selector(MetricRef("m", "gauge"), [Matcher("l", 'x"} or vector(1) #')])
    assert check_promql_syntax(f"avg ({sel})") is None
    assert sel.endswith('l="x\\"} or vector(1) #"}')


def test_promql_syntax_check() -> None:
    assert (
        check_promql_syntax('avg by (a) ({otel_metric_name="x", otel_metric_type="sum"})') is None
    )
    assert (check_promql_syntax("avg by (a) (") or "").startswith("syntax error")
    assert check_promql_syntax('rate({otel_metric_name="x"}[$__rate_interval])') is None
    assert check_promql_syntax('avg_over_time((avg ({a="b"}))[15m:1m]) > $__threshold') is None


def test_format_offset_uses_the_largest_exact_unit() -> None:
    cases = {604800: "1w", 2419200: "4w", 86400: "1d", 3600: "1h", 5400: "90m", 61: "61s"}
    for seconds, text in cases.items():
        assert format_offset(seconds) == text
