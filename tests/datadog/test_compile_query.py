import json
from pathlib import Path
from typing import Any

from migrator.source.datadog.compile_query import (
    CompiledError,
    CompiledOk,
    QueryContext,
    TemplateVariable,
    compile_metric_query,
)
from migrator.source.datadog.mapping import (
    DatadogMapping,
    ExpressionMapping,
    MappingOk,
    parse_mapping,
)
from migrator.source.datadog.model import ParseError, ParseOk
from migrator.source.datadog.parse_query import parse_metric_query
from migrator.validation import check_promql_syntax
from tests.datadog.helpers import entry, mapping

STAR = [TemplateVariable("scope", None, "*")]
SEL = '{otel_metric_name="postgresql.backends", otel_metric_type="sum"}'


def run(
    text: str,
    m: DatadogMapping | None = None,
    variables: list[TemplateVariable] | None = None,
    promoted: dict[str, str] | None = None,
    offset: int = 0,
) -> CompiledOk | CompiledError:
    parsed = parse_metric_query(text)
    assert isinstance(parsed, ParseOk)
    ctx = QueryContext(
        "s.json", "q", text, STAR if variables is None else variables, promoted or {}, offset
    )
    return compile_metric_query(parsed.query, m or mapping(), ctx)


def ok(*args: Any, **kwargs: Any) -> CompiledOk:
    r = run(*args, **kwargs)
    assert isinstance(r, CompiledOk), r
    return r


def codes(r: CompiledOk | CompiledError) -> list[str]:
    return [d.code for d in r.diagnostics]


def test_compiles_the_golden_connections_query() -> None:
    r = ok("avg:postgresql.connections{$scope} by {db}")
    assert r.promql == f"avg by (postgresql_database_name) ({SEL})"
    assert r.group_labels == ["postgresql_database_name"]
    assert codes(r) == ["TEMPLATE_VARIABLE_DROPPED"]
    assert r.diagnostics[0].source_text == "avg:postgresql.connections{$scope} by {db}"


def test_compiles_tag_filters_into_matchers() -> None:
    assert ok("max:postgresql.connections{db:astronomy_db}").promql == (
        'max ({otel_metric_name="postgresql.backends", otel_metric_type="sum", '
        'postgresql_database_name="astronomy_db"})'
    )


def test_blocking_checks() -> None:
    cases = {
        "avg:postgresql.connections{*}.rollup(median)": "UNSUPPORTED_QUERY_FUNCTION",
        "avg:system.io.util{$scope}": "MISSING_METRIC_MAPPING",
        "avg:postgresql.connections{*} by {table}": "MISSING_LABEL_MAPPING",
        "avg:postgresql.connections{table:x}": "MISSING_LABEL_MAPPING",
        "avg:postgresql.connections{$nope}": "UNSUPPORTED_TEMPLATE_VARIABLE",
    }
    for text, code in cases.items():
        r = run(text)
        assert isinstance(r, CompiledError), text
        assert codes(r) == [code], text
        assert r.diagnostics[-1].severity == "error"


ROLLUP_BLOCK = (
    "Unsupported '.rollup()' arguments: use avg, sum, min, max or count with an optional "
    "integer interval from 1 to 86400 seconds "
    "(https://docs.datadoghq.com/dashboards/functions/rollup/).",
    "Use a supported fixed-duration rollup form or migrate this query manually.",
)
FILL_BLOCK = (
    "Query function '.fill()' is blocked: PromQL has no equivalent of Datadog's gap "
    "interpolation (methods linear, last, zero, null; gap limit in seconds; "
    "https://docs.datadoghq.com/dashboards/functions/interpolation/#fill).",
    "Migrate this widget manually, or remove '.fill()' from the source query if unfilled gaps "
    "are acceptable.",
)


def test_unsupported_rollup_and_fill_forms_keep_documented_reasons() -> None:
    cases = {
        "rollup(median)": ROLLUP_BLOCK,
        "rollup(avg, 0)": ROLLUP_BLOCK,
        "rollup(avg, 86401)": ROLLUP_BLOCK,
        "rollup(avg, daily)": ROLLUP_BLOCK,
        "fill(zero)": FILL_BLOCK,
        "fill(last, 300)": FILL_BLOCK,
        "fill(null)": FILL_BLOCK,
        "fill(0)": FILL_BLOCK,
        "fill(60)": FILL_BLOCK,
    }
    for call, (message, action) in cases.items():
        r = run(f"avg:postgresql.connections{{*}} by {{db}}.{call}")
        assert isinstance(r, CompiledError), call
        (d,) = r.diagnostics
        assert (d.code, d.severity) == ("UNSUPPORTED_QUERY_FUNCTION", "error"), call
        assert (d.message, d.suggested_action) == (message, action), call


LOAD = entry(target={"name": "system.cpu.load_average.1m", "type": "gauge"}, labels={})
LOAD_SEL = '{otel_metric_name="system.cpu.load_average.1m", otel_metric_type="gauge"}'


def test_weighted_rejects_arguments_non_sum_and_chains() -> None:
    for text in (
        "sum:postgresql.connections{*}.weighted(1)",
        "avg:postgresql.connections{*}.weighted()",
        "postgresql.connections{*}.weighted()",
        "sum:postgresql.connections{*}.rollup(avg, 60).weighted()",
        "sum:postgresql.connections{*}.weighted().rollup(avg, 60)",
        "sum:postgresql.connections{*}.weighted().unknown()",
    ):
        r = run(text)
        assert isinstance(r, CompiledError), text
        assert codes(r) == ["UNSUPPORTED_QUERY_FUNCTION"], text
        assert r.diagnostics[0].severity == "error"
    parsed = parse_metric_query("sum:(kafka.net.bytes_in.rate{*}).weighted()")
    assert isinstance(parsed, ParseError) and parsed.code == "UNSUPPORTED_QUERY_SYNTAX"


def test_missing_aggregator_defaults_to_avg() -> None:
    r = ok("system.load.1{*}", mapping(system__load__1=LOAD))
    assert r.promql == f"avg ({LOAD_SEL})"
    (warning,) = r.diagnostics
    assert (warning.code, warning.severity) == ("DEFAULT_AGGREGATOR_APPLIED", "warning")
    assert "https://docs.datadoghq.com/dashboards/querying/#aggregation-method" in warning.message


def test_missing_aggregator_never_blocks() -> None:
    m = mapping(system__load__1=LOAD)
    for text in ("system.load.1{*}", "system.load.1{$scope}", "system.io.util{*}"):
        assert "MISSING_AGGREGATOR" not in codes(run(text, m)), text
    # A later check may still block; the warning collected so far stays.
    assert codes(run("system.io.util{*}", m)) == [
        "DEFAULT_AGGREGATOR_APPLIED",
        "MISSING_METRIC_MAPPING",
    ]


def test_blocks_non_star_template_default() -> None:
    r = run(
        "avg:postgresql.connections{$scope}",
        variables=[TemplateVariable("scope", None, "env:prod")],
    )
    assert codes(r) == ["UNSUPPORTED_TEMPLATE_VARIABLE"]


def test_warns_on_unreviewed_entries() -> None:
    r = ok("avg:postgresql.connections{*}", mapping(postgresql__connections=entry(reviewed=None)))
    assert codes(r) == ["UNREVIEWED_MAPPING"]


def test_compiles_rate() -> None:
    m = mapping(
        postgresql__rows_fetched=entry(
            kind="rate", target={"name": "postgresql.tup_fetched", "type": "sum"}
        )
    )
    assert ok("avg:postgresql.rows_fetched{$scope}", m).promql == (
        'avg (rate({otel_metric_name="postgresql.tup_fetched", otel_metric_type="sum"}'
        "[$__rate_interval]))"
    )


def test_appends_fixed_matchers_sorted_after_source_filters() -> None:
    m = mapping(
        system__net__bytes_rcvd=entry(
            kind="rate",
            target={"name": "system.network.io", "type": "sum"},
            labels={"host": "host_name"},
            matchers={"z": "1", "system_network_direction": "receive"},
        )
    )
    assert ok("sum:system.net.bytes_rcvd{host:a}", m).promql == (
        'sum (rate({otel_metric_name="system.network.io", otel_metric_type="sum", host_name="a", '
        'system_network_direction="receive", z="1"}[$__rate_interval]))'
    )


def test_rate_window_replaces_rate_interval() -> None:
    m = mapping(
        system__net__bytes_rcvd=entry(
            kind="rate",
            target={"name": "system.network.io", "type": "sum"},
            matchers={"system_network_direction": "receive"},
            rateWindow="5m",
        )
    )
    promql = ok("sum:system.net.bytes_rcvd{$scope}", m).promql
    assert promql == (
        'sum (rate({otel_metric_name="system.network.io", otel_metric_type="sum", '
        'system_network_direction="receive"}[5m]))'
    )
    assert check_promql_syntax(promql) is None


def test_rate_window_is_validated() -> None:
    base = {
        "kind": "rate",
        "target": {"name": "system.network.io", "type": "sum"},
        "sourceUnit": "byte/second",
        "targetUnit": "byte/second",
        "scale": 1.0,
        "labels": {},
        "ref": "r",
        "reviewed": None,
    }
    for good in ("5m", "120s", "1h"):
        raw = {"version": 1, "source": "datadog", "metrics": {"m": {**base, "rateWindow": good}}}
        assert isinstance(parse_mapping(raw), MappingOk), good
    for bad in ("", "0m", "5", "5min", "1m30s", "$__rate_interval", 5):
        raw = {"version": 1, "source": "datadog", "metrics": {"m": {**base, "rateWindow": bad}}}
        assert not parse_mapping(raw).ok, bad
    gauge = {**base, "kind": "gauge", "rateWindow": "5m"}
    raw = {"version": 1, "source": "datadog", "metrics": {"m": gauge}}
    assert not parse_mapping(raw).ok  # only rate entries take a window


IOWAIT = entry(
    target={"name": "system.cpu.utilization", "type": "gauge"},
    labels={"host": "host_name"},
    matchers={"cpu_mode": "wait"},
    scale=100,
)
CPU_SEL = '{otel_metric_name="system.cpu.utilization", otel_metric_type="gauge", cpu_mode="wait"}'


def test_scale_wraps_aggregation() -> None:
    m = mapping(system__cpu__iowait=IOWAIT)
    assert ok("max:system.cpu.iowait{$scope}", m).promql == f"(max ({CPU_SEL})) * 100"
    assert ok("max:system.cpu.iowait{*} by {host}", m).promql == (
        f"(max by (host_name) ({CPU_SEL})) * 100"
    )


def test_grain_collapses_duplicate_resource_series() -> None:
    m = mapping(
        postgresql__connections=entry(
            grain={"labels": ["service_instance_id"], "aggregation": "max"}
        )
    )
    assert ok("avg:postgresql.connections{$scope} by {db}", m).promql == (
        "avg by (postgresql_database_name) "
        f"(max by (postgresql_database_name, service_instance_id) ({SEL}))"
    )


def test_grain_composes_with_rate_and_scale() -> None:
    m = mapping(
        system__cpu__iowait={**IOWAIT, "grain": {"labels": ["host_name"], "aggregation": "avg"}}
    )
    assert (
        ok("avg:system.cpu.iowait{*}", m).promql == f"(avg (avg by (host_name) ({CPU_SEL}))) * 100"
    )
    m = mapping(x=entry(kind="rate", grain={"labels": ["host_name"], "aggregation": "sum"}))
    assert ok("avg:x{*} by {host}", m).promql == (
        f"avg by (host_name) (sum by (host_name) (rate({SEL}[$__rate_interval])))"
    )


RATIO = {
    "kind": "expression",
    "expression": (
        "sum by (service_instance_id) (max by (service_instance_id, postgresql_database_name) "
        '({otel_metric_name="postgresql.backends", otel_metric_type="sum"$filters})) / on '
        "(service_instance_id) max by (service_instance_id) "
        '({otel_metric_name="postgresql.connection.max", otel_metric_type="gauge"$filters})'
    ),
    "outputLabels": ["service_instance_id"],
    "labels": {
        "host": "host_name",
        "instance": "service_instance_id",
        "db": "postgresql_database_name",
    },
    "sourceUnit": "fraction",
    "targetUnit": "1",
    "scale": 1,
    "ref": "test",
    "reviewed": None,
}


def test_compiles_expression_mappings() -> None:
    m = mapping(postgresql__percent_usage_connections=RATIO)
    r = ok("avg:postgresql.percent_usage_connections{*}", m)
    assert r.promql == (
        "avg (sum by (service_instance_id) (max by (service_instance_id, postgresql_database_name) "
        '({otel_metric_name="postgresql.backends", otel_metric_type="sum"})) / on '
        "(service_instance_id) max by (service_instance_id) "
        '({otel_metric_name="postgresql.connection.max", otel_metric_type="gauge"}))'
    )
    assert codes(r) == ["UNREVIEWED_MAPPING"]


def test_expression_filters_replace_every_placeholder() -> None:
    m = mapping(postgresql__percent_usage_connections=RATIO)
    r = ok("max:postgresql.percent_usage_connections{host:a} by {instance}", m)
    assert r.promql.count('host_name="a"') == 2
    assert "$filters" not in r.promql
    assert r.promql.startswith("max by (service_instance_id) (")


def test_expression_group_by_must_be_an_output_label() -> None:
    m = mapping(postgresql__percent_usage_connections=RATIO)
    r = run("avg:postgresql.percent_usage_connections{*} by {db}", m)
    assert codes(r) == ["UNREVIEWED_MAPPING", "MISSING_LABEL_MAPPING"]


def test_promoted_variable_becomes_regex_matcher() -> None:
    variables = [TemplateVariable("db", "db", "*")]
    r = ok(
        "avg:postgresql.connections{$db}",
        variables=variables,
        promoted={"db": "postgresql_database_name"},
    )
    # Anchored for whole-value (Datadog exact) matching in Dash0, which does not anchor
    # `=~`; the template stays valid PromQL.
    assert r.promql == (
        'avg ({otel_metric_name="postgresql.backends", otel_metric_type="sum", '
        'postgresql_database_name=~"^($db)$"})'
    )
    assert check_promql_syntax(r.promql) is None
    assert codes(r) == []


def _mapping_file(name: str) -> DatadogMapping:
    result = parse_mapping(json.loads(Path(f"mappings/datadog/{name}.json").read_text()))
    assert isinstance(result, MappingOk), result
    return result.mapping


def test_postgres_mapping_dedups_per_instance_and_database() -> None:
    """Resource-hash duplicates collapse per (instance, database), so a sum or avg over
    databases is unchanged (docs/DASH0_INVENTORY.md, caveat 2)."""
    pg = _mapping_file("postgres")
    grain = "max by (service_instance_id, postgresql_database_name)"
    tup = 'rate({otel_metric_name="postgresql.tup_fetched", otel_metric_type="sum"}'
    assert ok("sum:postgresql.rows_fetched{*}", pg).promql == (
        f"sum ({grain} ({tup}[$__rate_interval])))"
    )
    by_db = ok("avg:postgresql.rows_fetched{*} by {db}", pg).promql
    assert by_db == (
        "avg by (postgresql_database_name) "
        "(max by (postgresql_database_name, service_instance_id) "
        f"({tup}[$__rate_interval])))"
    )
    assert ok("avg:postgresql.connections{*}", pg).promql == f"avg ({grain} ({SEL}))"
    for metric in ("deleted", "fetched", "inserted", "returned", "updated"):
        e = pg.metrics[f"postgresql.rows_{metric}"]
        assert not isinstance(e, ExpressionMapping) and e.grain is not None
        assert e.grain.labels == ["service_instance_id", "postgresql_database_name"]


def test_host_network_keeps_every_interface_and_has_no_grain() -> None:
    """Datadog's network check excludes no interface by default (excluded_interfaces
    defaults to []), so loopback stays in, and no grain collapses interfaces. The
    fixed 5m range is the entry's rateWindow: system.network.io is reported every
    60 s, too sparse for $__rate_interval (#90). The otel_scope_name matcher keeps
    only hostmetrics series: Python system_metrics also emits system.network.io (#111)."""
    r = ok("sum:system.net.bytes_rcvd{*}", _mapping_file("host"))
    assert r.promql == (
        'sum (rate({otel_metric_name="system.network.io", otel_metric_type="sum", '
        'otel_scope_name="github.com/open-telemetry/opentelemetry-collector-contrib/receiver/'
        'hostmetricsreceiver/internal/scraper/networkscraper", '
        'system_network_direction="receive"}[5m]))'
    )
    assert check_promql_syntax(r.promql) is None


def test_offset_follows_the_selector_of_a_gauge() -> None:
    r = ok("avg:postgresql.connections{db:a} by {db}", offset=604800)
    sel = SEL[:-1] + ', postgresql_database_name="a"}'
    assert r.promql == f"avg by (postgresql_database_name) ({sel} offset 1w)"
    assert check_promql_syntax(r.promql) is None


def test_offset_goes_inside_rate_after_the_range() -> None:
    m = mapping(
        postgresql__rows_fetched=entry(
            kind="rate", target={"name": "postgresql.tup_fetched", "type": "sum"}
        )
    )
    r = ok("avg:postgresql.rows_fetched{$scope}", m, offset=2419200)
    assert r.promql == (
        'avg (rate({otel_metric_name="postgresql.tup_fetched", otel_metric_type="sum"}'
        "[$__rate_interval] offset 4w))"
    )
    assert check_promql_syntax(r.promql) is None


def test_offset_blocks_expression_mappings() -> None:
    m = mapping(postgresql__percent_usage_connections=RATIO)
    r = run("avg:postgresql.percent_usage_connections{*}", m, offset=3600)
    assert isinstance(r, CompiledError)
    assert codes(r)[-1] == "UNSUPPORTED_FORMULA"
    assert "Timeshift" in r.diagnostics[-1].message
