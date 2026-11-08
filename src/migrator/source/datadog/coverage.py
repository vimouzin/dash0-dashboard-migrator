"""Inspect known query slots with the full parsers before compiling any assets.

Only exact metric-name presence is checked. Unparsed queries remain explicit; no
prefix extraction, filename routing, semantic inference or translation happens here.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from migrator.source.asset import SourceAsset
from migrator.source.datadog.mapping import DatadogMapping
from migrator.source.datadog.model import MetricQuery, ParseError
from migrator.source.datadog.monitor import parse_monitor_query
from migrator.source.datadog.parse_query import parse_metric_query
from migrator.target import Diagnostic, MappingCoverage, MetricCoverage, SourceLocation


def _dashboard_queries(widgets: Any, path: str = "widgets") -> Iterator[tuple[str, Any]]:
    if not isinstance(widgets, list):
        return
    for index, widget in enumerate(widgets):
        if not isinstance(widget, dict) or not isinstance(widget.get("definition"), dict):
            continue
        definition = widget["definition"]
        base = f"{path}[{index}].definition"
        if definition.get("type") == "group":
            yield from _dashboard_queries(definition.get("widgets"), f"{base}.widgets")
        requests = definition.get("requests")
        if not isinstance(requests, list):
            continue
        for request_index, request in enumerate(requests):
            if not isinstance(request, dict):
                continue
            request_path = f"{base}.requests[{request_index}]"
            if "q" in request:
                yield f"{request_path}.q", request["q"]
            queries = request.get("queries")
            if not isinstance(queries, list):
                continue
            for query_index, query in enumerate(queries):
                if isinstance(query, dict) and query.get("data_source") == "metrics":
                    yield f"{request_path}.queries[{query_index}].query", query.get("query")


def inspect_mapping_coverage(
    assets: list[SourceAsset], mapping: DatadogMapping
) -> MappingCoverage:
    uses: dict[str, list[SourceLocation]] = {}
    unparsed: list[Diagnostic] = []
    parsed_queries = 0
    for asset in sorted(assets, key=lambda item: item.source_id):
        monitor_path = (
            "definition.query"
            if isinstance(asset.raw, dict) and asset.raw.get("definition") is asset.body
            else "query"
        )
        queries = (
            _dashboard_queries(asset.body.get("widgets"))
            if asset.kind == "dashboard"
            else iter([(monitor_path, asset.body.get("query"))])
        )
        for path, text in queries:
            location = SourceLocation(asset.source_id, path)
            metrics: tuple[MetricQuery, ...] = ()
            if not isinstance(text, str):
                error = ParseError("UNSUPPORTED_QUERY_SYNTAX", 0, "Query must be a string.")
            elif asset.kind == "dashboard":
                parsed = parse_metric_query(text)
                if parsed.ok:
                    metrics = (parsed.query,)
                else:
                    error = parsed
            else:
                monitor = parse_monitor_query(text)
                if monitor.ok:
                    query = monitor.monitor.query
                    metrics = (query,) if isinstance(query, MetricQuery) else query.queries
                else:
                    error = monitor
            if not metrics:
                unparsed.append(
                    Diagnostic(
                        error.code,
                        "error",
                        location.source_id,
                        location.source_path,
                        error.message,
                        "Mapping coverage is unknown for this query; use the supported grammar.",
                        text if isinstance(text, str) else None,
                    )
                )
                continue
            parsed_queries += 1
            for name in dict.fromkeys(query.metric for query in metrics):
                uses.setdefault(name, []).append(location)
    return MappingCoverage(
        parsed_queries,
        tuple(
            MetricCoverage(name, name in mapping.metrics, tuple(uses[name]))
            for name in sorted(uses)
        ),
        tuple(unparsed),
    )
