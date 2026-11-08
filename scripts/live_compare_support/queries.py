"""Bind and scope source/target queries without translating migration inputs."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import urlencode

import promql_parser as prom

from live_compare_support.comparison import DataError, Series, dash0_series, datadog_series
from live_compare_support.config import Case
from live_compare_support.credentials import QueryConfig
from migrator.destination.dash0 import Dash0Config
from migrator.http import HttpRequest, HttpSend
from migrator.source.datadog.model import MetricQuery, TagFilter, VariableFilter
from migrator.source.datadog.monitor import parse_monitor_query
from migrator.source.datadog.monitor_expression import monitor_source_queries
from migrator.source.datadog.parse_query import parse_metric_query


@dataclass(frozen=True)
class BoundQuery:
    queries: list[dict[str, str]]
    formula: str
    target: str
    monitor_window: int = 0
    monitor_aggregator: str = ""
    comparator: str = ""
    thresholds: dict[str, float] | None = None


def with_semantic_mode(bound: BoundQuery, mode: str | None) -> BoundQuery:
    """Explicit live evaluation setting; never modifies conversion artifacts."""
    if mode is None:
        return bound
    if mode not in ("native", "combined"):
        raise DataError("unsupported Datadog telemetry semantic mode")
    return replace(bound, queries=[{**q, "semantic_mode": mode} for q in bound.queries])


def pointer(value: Any, path: str) -> Any:
    for raw in path.removeprefix("/").split("/"):
        key = raw.replace("~1", "/").replace("~0", "~")
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def source_query(
    text: str, variables: dict[str, str], prefixes: dict[str, str], run_id: str
) -> str:
    parsed = parse_metric_query(text)
    if not parsed.ok:
        raise DataError(f"unsupported source query: {parsed.code}")
    q: MetricQuery = parsed.query
    filters = []
    for filt in q.filters:
        if isinstance(filt, VariableFilter):
            if filt.name not in variables or filt.name not in prefixes:
                raise DataError(f"unbound source variable: {filt.name}")
            key, val = prefixes[filt.name], variables[filt.name]
        else:
            assert isinstance(filt, TagFilter)
            key, val = filt.key, filt.value
        # Datadog's bounded parser has no general literal escaping. Reject unsafe
        # substitutions rather than letting a value inject filters/functions.
        if not re.fullmatch(r"[A-Za-z0-9_.:/-]+", val):
            raise DataError("source filter value cannot be safely bound")
        if key == "host" and val != run_id:
            raise DataError("source host filter conflicts with this run")
        filters.append(f"{key}:{val}")
    if not any(f.startswith("host:") for f in filters):
        filters.append(f"host:{run_id}")
    result = (q.aggregator + ":" if q.aggregator else "") + q.metric
    result += "{" + ",".join(filters) + "}"
    if q.group_by:
        result += " by {" + ",".join(q.group_by) + "}"
    for func in q.functions:
        result += f".{func.name}({','.join(func.args)})"
    return result


def target_query(text: str, variables: dict[str, str], rate_interval: str, run_id: str) -> str:
    # Bind regex values inside PromQL string literals using JSON escaping, then
    # parse the result and add a host constraint at each vector selector.
    def bind_string(match: re.Match[str]) -> str:
        value: str = json.loads(match.group())

        def replace(token: re.Match[str]) -> str:
            name = token.group(1) or token.group(2)
            if name not in variables:
                raise DataError(f"unbound destination variable: {name}")
            return re.escape(variables[name])

        value = re.sub(r"\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))", replace, value)
        return json.dumps(value)

    text = re.sub(r'"(?:[^"\\]|\\.)*"', bind_string, text)
    text = re.sub(r"\$(?:\{__rate_interval\}|__rate_interval\b)", rate_interval, text)
    outside_strings = re.sub(r'"(?:[^"\\]|\\.)*"', "", text)
    if re.search(r"\$[A-Za-z_{]", outside_strings):
        raise DataError("unresolved destination variable")
    ast = prom.parse(text)
    literals: dict[str, str] = {}

    def literal(value: str) -> str:
        marker = f"__live_literal_{len(literals)}__"
        literals[marker] = value
        return marker

    def scope(node: Any) -> Any:
        if isinstance(node, prom.VectorSelector):
            if node.matchers.or_matchers:
                raise DataError("OR selectors are outside the live harness subset")
            matchers = list(node.matchers.matchers)
            if any(
                m.name == "host_name" and (m.op != prom.MatchOp.Equal or m.value != run_id)
                for m in matchers
            ):
                # A bound, anchored host variable is also a valid restriction; the
                # exact matcher below makes the run scope unconditional.
                if not any(
                    m.name == "host_name" and m.value == f"^({re.escape(run_id)})$"
                    for m in matchers
                ):
                    raise DataError("destination host filter conflicts with this run")
            matchers.append(prom.Matcher(prom.MatchOp.Equal, "host_name", run_id))
            # promql-parser's Display does not JSON-escape matcher values. Render
            # safe placeholders, then restore literals with JSON escaping below.
            node.matchers = prom.Matchers(
                [prom.Matcher(m.op, m.name, literal(m.value)) for m in matchers]
            )
            return prom.parse(str(node))
        if isinstance(node, prom.StringLiteral):
            return prom.parse(json.dumps(literal(node.val)))
        return None

    rendered = str(prom.transform(ast, post_visit=scope))
    for marker, value in literals.items():
        rendered = rendered.replace(json.dumps(marker), json.dumps(value))
    prom.parse(rendered)
    return rendered


def pair(case: Case, source: Any, target: Any, rate_interval: str, run_id: str) -> BoundQuery:
    variables = {k: run_id if v == "$run" else v for k, v in case.variables.items()}
    if case.kind == "monitor":
        body = source.get("definition", source)
        if body.get("options", {}).get("evaluation_delay") not in (None, 0):
            raise DataError("monitor evaluation_delay is outside the live comparison subset")
        parsed = parse_monitor_query(body["query"])
        if not parsed.ok:
            raise DataError(f"unsupported monitor: {parsed.code}")
        monitor = parsed.monitor
        # The parser owns complete arithmetic and metric-leaf syntax. Bind every
        # leaf separately and let the source API evaluate its original formula.
        leaves, formula = monitor_source_queries(monitor.query)
        expr = prom.parse(target["expression"].replace("$__threshold", "0"))
        if not isinstance(expr, prom.BinaryExpr) or str(expr.op) != monitor.comparator:
            raise DataError("monitor comparator differs from generated check")
        # Verify the converted thresholds against the source monitor itself; the
        # decisions below then apply these (equal) thresholds to both vendors.
        levels = {"critical": "failed", "warning": "degraded"}
        raw = body.get("options", {}).get("thresholds", {})
        if not set(raw) <= set(levels):
            raise DataError("unsupported source monitor threshold")
        expected = {levels[k]: float(v) for k, v in raw.items() if v is not None}
        if expected != {k: float(v) for k, v in target["thresholds"].items()}:
            raise DataError("generated check thresholds differ from source monitor")
        seconds = monitor.window.amount * {"m": 60, "h": 3600, "d": 86400}[monitor.window.unit]
        return BoundQuery(
            [
                {
                    "data_source": "metrics",
                    "name": f"q{index}",
                    "query": source_query(leaf, variables, {}, run_id),
                }
                for index, leaf in enumerate(leaves)
            ],
            formula,
            target_query(str(expr.lhs), variables, rate_interval, run_id),
            seconds,
            monitor.time_aggregator,
            monitor.comparator,
            target["thresholds"],
        )
    # Panel keys are the compiler's documented widget indices. Validate both the
    # panel and flattened displayed-query index against the source reference.
    indices = re.findall(r"/widgets/(\d+)", case.request)
    expected_panel = "widget-" + "-".join(indices)
    requests_path, _, raw_index = case.request.rpartition("/")
    requests = pointer(source, requests_path)
    request_index = int(raw_index)
    req = requests[request_index]

    def displayed(r: Any) -> int:
        return len(r.get("formulas", r.get("queries", [None])))

    expected_index = sum(displayed(r) for r in requests[:request_index]) + case.formula_index
    if case.panel != expected_panel or case.query_index != expected_index:
        raise DataError("source request/formula does not correspond to configured target query")
    prefixes = {
        v["name"]: v["prefix"] for v in source.get("template_variables", []) if v.get("prefix")
    }
    raw_queries = req.get("queries", [{"name": "q", "query": req.get("q")}])
    formulas = req.get("formulas", [{"formula": q["name"]} for q in raw_queries])
    formula = formulas[case.formula_index]["formula"]
    queries = [
        {
            "data_source": "metrics",
            "name": q["name"],
            "query": source_query(q["query"], variables, prefixes, run_id),
        }
        for q in raw_queries
    ]
    for query, original in zip(queries, raw_queries, strict=True):
        if "semantic_mode" in original:
            mode = original["semantic_mode"]
            if mode not in ("native", "combined"):
                raise DataError("unsupported source Datadog semantic_mode")
            query["semantic_mode"] = mode
    target_text = target["spec"]["panels"][case.panel]["spec"]["queries"][case.query_index]
    plugin = target_text["spec"]["plugin"]
    if plugin["kind"] != "PrometheusTimeSeriesQuery":
        raise DataError("target is not a generated Prometheus query")
    return BoundQuery(
        queries, formula, target_query(plugin["spec"]["query"], variables, rate_interval, run_id)
    )


def request_json(request: HttpRequest, send: HttpSend) -> Any:
    response = send(request)
    if not response.ok:
        # Bodies may contain secrets or private telemetry; never persist them.
        raise RuntimeError(f"query API returned HTTP {response.status}")
    try:
        return json.loads(response.body)
    except (ValueError, UnicodeDecodeError):
        raise DataError("query API returned invalid JSON") from None


def query_source(
    bound: BoundQuery, start: int, end: int, step: int, cfg: QueryConfig, send: HttpSend
) -> list[Series]:
    attributes = {
        "from": start * 1000,
        "to": end * 1000,
        "interval": step * 1000,
        "queries": bound.queries,
        "formulas": [{"formula": bound.formula}],
    }
    body = {"data": {"type": "timeseries_request", "attributes": attributes}}
    req = HttpRequest(
        "POST",
        cfg.base_url + "/api/v2/query/timeseries",
        {
            **cfg.headers,
            "Content-Type": "application/json",
        },
        json.dumps(body).encode(),
    )
    return datadog_series(request_json(req, send))


def validate_ingestion_key(api_key: str, cfg: QueryConfig, send: HttpSend) -> None:
    request = HttpRequest("GET", cfg.base_url + "/api/v1/validate", {"DD-API-KEY": api_key})
    payload = request_json(request, send)
    if not isinstance(payload, dict) or payload.get("valid") is not True:
        raise RuntimeError("Datadog ingestion API key validation did not succeed")


def query_target(
    bound: BoundQuery, start: int, end: int, step: int, cfg: Dash0Config, send: HttpSend
) -> list[Series]:
    # Datadog labels the bucket [t, t+step) with t; PromQL evaluated at t looks back
    # from t. Evaluate Dash0 at t+step and key it by t so both describe [t, t+step).
    params = urlencode({"query": bound.target, "start": start + step, "end": end, "step": step})
    req = HttpRequest(
        "GET",
        cfg.api_url + "/api/prometheus/api/v1/query_range?" + params,
        {"Authorization": f"Bearer {cfg.token}", "Dash0-Dataset": cfg.dataset},
    )
    return [
        Series(s.labels, {t - step: v for t, v in s.samples.items()})
        for s in dash0_series(request_json(req, send))
    ]
