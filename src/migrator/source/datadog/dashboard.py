"""Datadog dashboard -> Perses dashboard (handoff plans 04 and 05).

Each widget is all or nothing. Widget-level checks (type, option keys, data source,
formula syntax) run first; only then are the displayed queries parsed and compiled.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from migrator.source.asset import CompileOptions, SourceAsset
from migrator.source.datadog.compile_query import (
    CompiledOk,
    QueryContext,
    TemplateVariable,
    compile_metric_query,
)
from migrator.source.datadog.formula import (
    Formula,
    RenderedQuery,
    parse_formula,
    references,
    render_formula,
    shifted,
)
from migrator.source.datadog.mapping import DatadogMapping
from migrator.source.datadog.model import ParseOk, VariableFilter
from migrator.source.datadog.parse_query import function_block, parse_metric_query
from migrator.source.datadog.remarks import REMARKS, approved, describe
from migrator.target import (
    Diagnostic,
    DiagnosticCode,
    ItemResult,
    Outcome,
    PersesDashboard,
    PersesGrid,
    PersesGridItem,
    PersesPanel,
    PersesQuery,
    Severity,
    remark_outcome,
)
from migrator.validation import check_promql_syntax, validate_dashboard

AUTO_WIDTH = 12
DASHBOARD_DURATION = "1h"  # spec.duration of every emitted dashboard
AUTO_HEIGHT = 8
_INDEX = re.compile(r"\[(\d+)\]")
# Documented preset windows; `alert` needs monitor context and is not a time span.
# https://docs.datadoghq.com/dashboards/widgets/timeseries/
_LIVE_SPANS = frozenset(
    {
        "1m",
        "5m",
        "10m",
        "15m",
        "30m",
        "1h",
        "4h",
        "1d",
        "2d",
        "1w",
        "1mo",
        "3mo",
        "6mo",
        "week_to_date",
        "month_to_date",
        "1y",
    }
)

# --- Allowed source keys per level: (silently used, ignored with OPTION_IGNORED) ----

_COMMON_DEF_IGNORED = {"title_size", "title_align", "custom_links"}
_DEF_KEYS: dict[str, tuple[set[str], set[str]]] = {
    "timeseries": (
        {"type", "title", "requests"},
        _COMMON_DEF_IGNORED
        | {"show_legend", "legend_size", "legend_layout", "legend_columns", "yaxis", "markers"},
    ),
    "query_value": (
        {"type", "title", "requests"},
        _COMMON_DEF_IGNORED
        | {"autoscale", "precision", "custom_unit", "text_align", "timeseries_background"},
    ),
    "toplist": (
        {"type", "title", "requests"},
        _COMMON_DEF_IGNORED | {"style"},
    ),
    "note": (
        {"type", "content"},
        {
            "background_color",
            "font_size",
            "text_align",
            "vertical_align",
            "show_tick",
            "tick_pos",
            "tick_edge",
            "has_padding",
        },
    ),
}
_GROUP_KEYS = (
    {"type", "title", "widgets", "layout_type"},
    {"background_color", "show_title", "banner_img", "title_align"},
)
_REQ_KEYS: dict[str, tuple[set[str], set[str]]] = {
    "timeseries": (
        {"queries", "formulas", "q", "response_format"},
        {"style", "display_type", "on_right_yaxis", "metadata"},
    ),
    "query_value": (
        {"queries", "formulas", "q", "response_format", "aggregator"},
        {"conditional_formats", "style", "display_type", "metadata"},
    ),
    "toplist": (
        {"queries", "formulas", "q", "response_format", "sort"},
        {"conditional_formats", "style", "metadata"},
    ),
}
_QUERY_KEYS: dict[str, tuple[set[str], set[str]]] = {
    "timeseries": ({"data_source", "name", "query"}, {"semantic_mode"}),
    "query_value": ({"data_source", "name", "query", "aggregator"}, {"semantic_mode"}),
    "toplist": ({"data_source", "name", "query", "aggregator"}, {"semantic_mode"}),
}
# Formula display options are cosmetic. `limit` (top-N) changes the data: it blocks, except on a
# toplist, where it becomes the BarChart sort under the TOPN remark.
_FORMULA_IGNORED = {"alias", "style", "number_format", "cell_display_mode"}
_FORMULA_KEYS = ({"formula"}, _FORMULA_IGNORED)
_TOPLIST_FORMULA_KEYS = ({"formula", "limit"}, _FORMULA_IGNORED)

# Datadog query_value / toplist aggregator -> Perses StatChart / BarChart calculation (both use
# Perses common.#calculation, perses/plugins@57910ac barchart/schemas/bar.cue).
_CALCULATIONS = {"avg": "mean", "last": "last-number", "max": "max", "min": "min", "sum": "sum"}


@dataclass
class DashboardCompilation:
    dashboard: PersesDashboard | None
    items: list[ItemResult] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)


@dataclass
class _Ctx:
    source_id: str
    mapping: DatadogMapping
    variables: list[TemplateVariable]
    promoted: dict[str, str]


class _Collector:
    def __init__(self, source_id: str) -> None:
        self.source_id = source_id
        self.items: list[Diagnostic] = []

    def add(
        self,
        code: DiagnosticCode,
        severity: Severity,
        path: str,
        message: str,
        action: str,
        source_text: str | None = None,
        remark: str | None = None,
    ) -> None:
        self.items.append(
            Diagnostic(code, severity, self.source_id, path, message, action, source_text, remark)
        )

    def error(
        self, code: DiagnosticCode, path: str, message: str, action: str, text: str | None = None
    ) -> None:
        self.add(code, "error", path, message, action, text)

    def has_error(self) -> bool:
        return any(d.severity == "error" for d in self.items)


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


# --- Template variables -------------------------------------------------------------


def read_template_variables(body: dict[str, Any]) -> list[TemplateVariable]:
    out: list[TemplateVariable] = []
    raw = body.get("template_variables")
    for tv in raw if isinstance(raw, list) else []:
        if not isinstance(tv, dict) or not isinstance(tv.get("name"), str):
            continue
        prefix = tv.get("prefix") if isinstance(tv.get("prefix"), str) else None
        default: str | None
        if tv.get("default") is not None:
            default = str(tv["default"])
        elif isinstance(tv.get("defaults"), list) and tv["defaults"]:
            defaults = tv["defaults"]
            if len(defaults) == 1:
                default = str(defaults[0])
            else:
                default = json.dumps(defaults, separators=(",", ":"))
        else:
            # No `default`, and `defaults` missing or empty: the variable has no default.
            default = None
        out.append(TemplateVariable(name=tv["name"], prefix=prefix, default=default))
    return out


# Legacy `q` requests (#178). Datadog's legacy request string lists one or more series
# separated by top-level commas, and a series may combine metric queries with arithmetic
# (`100 * sum:a{*} / sum:b{*}`). Each series becomes a formula over named sub-queries, so
# it compiles through the same formula path as `queries`/`formulas` requests.
_LEGACY_QUERY = re.compile(
    r"(?<![\w.])(?:[A-Za-z0-9_]+:)?[A-Za-z_][\w.]*\{[^{}]*\}"
    r"(?:\s*by\s*\{[^{}]*\})?(?:\.[A-Za-z_]\w*\([^()]*\))*"
)
_LEGACY_NAME = re.compile(r"\bq(\d+)\b")


def _top_level_split(text: str) -> list[str]:
    parts, depth, start = [], 0, 0
    for i, ch in enumerate(text):
        depth += 1 if ch in "({" else -1 if ch in ")}" else 0
        if ch == "," and depth == 0:
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return [p.strip() for p in parts]


def legacy_series(text: str) -> list[tuple[str, list[str]]] | None:
    """(formula text over `q<k>` names, sub-query texts) per series of a legacy request, or
    None when the request is one plain query or does not split into supported series."""
    series = _top_level_split(text)
    if len(series) == 1 and parse_metric_query(text).ok:
        return None
    out: list[tuple[str, list[str]]] = []
    for part in series:
        found = list(_LEGACY_QUERY.finditer(part))
        if not found:
            return None
        texts: list[str] = []
        formula, pos = "", 0
        for m in found:
            formula += part[pos : m.start()] + f"q{len(texts)}"
            texts.append(m.group(0))
            pos = m.end()
        formula += part[pos:]
        if not parse_formula(formula).ok:
            return None
        out.append((formula, texts))
    return out


def _all_query_strings(widgets: Any) -> list[str]:
    found: list[str] = []
    if not isinstance(widgets, list):
        return found
    for w in widgets:
        d = w.get("definition") if isinstance(w, dict) else None
        if not isinstance(d, dict):
            continue
        if d.get("type") == "group":
            found.extend(_all_query_strings(d.get("widgets")))
            continue
        for r in d.get("requests") or [] if isinstance(d.get("requests"), list) else []:
            if not isinstance(r, dict):
                continue
            if isinstance(r.get("q"), str):
                split = legacy_series(r["q"])
                found.extend([q for _, qs in split for q in qs] if split else [r["q"]])
            queries = r.get("queries")
            for q in queries if isinstance(queries, list) else []:
                if isinstance(q, dict) and isinstance(q.get("query"), str):
                    found.append(q["query"])
    return found


def _promote_variables(
    body: dict[str, Any], variables: list[TemplateVariable], mapping: DatadogMapping
) -> dict[str, str]:
    """Pick variables that become Perses ListVariables: prefixed, default '*', and the
    prefix tag maps to the same label in every mapped query that uses the variable.

    Queries whose metric has no mapping entry are skipped: they are blocked with
    MISSING_METRIC_MAPPING and never render a matcher. A mapped entry without the prefix
    label still prevents promotion."""
    parsed = [
        r.query
        for r in map(parse_metric_query, _all_query_strings(body.get("widgets")))
        if isinstance(r, ParseOk)
    ]
    promoted: dict[str, str] = {}
    for var in variables:
        if var.prefix is None or var.default not in (None, "*"):
            continue
        labels: set[str | None] = set()
        for q in parsed:
            if not any(isinstance(f, VariableFilter) and f.name == var.name for f in q.filters):
                continue
            entry = mapping.metrics.get(q.metric)
            if entry is not None:
                labels.add(entry.labels.get(var.prefix))
        if len(labels) == 1:
            label = next(iter(labels))
            if label is not None:
                promoted[var.name] = label
    return promoted


def _list_variable(name: str, label: str) -> dict[str, Any]:
    return {
        "kind": "ListVariable",
        "spec": {
            "name": name,
            "display": {"name": name},
            "allowAllValue": True,
            "allowMultiple": True,
            "defaultValue": "$__all",
            "plugin": {"kind": "PrometheusLabelValuesVariable", "spec": {"labelName": label}},
        },
    }


# --- Widgets ------------------------------------------------------------------------


def _check_keys(
    obj: dict[str, Any], allowed: tuple[set[str], set[str]], path: str, c: _Collector, what: str
) -> None:
    silent, ignored = allowed
    for key in sorted(obj):
        if key in silent:
            continue
        if key == "time" and what == "Widget" and obj[key] == {}:
            # An empty widget time object sets no override, so the widget follows the
            # dashboard time range, as every Perses panel does (Perses has no per-panel time
            # range: https://perses.dev/docs/perses/latest/api/dashboard/).
            c.add(
                "OPTION_IGNORED",
                "info",
                f"{path}.{key}",
                "Widget option 'time' is empty and is ignored.",
                "No action needed.",
            )
            continue
        value = obj[key]
        if (
            key == "time"
            and what == "Widget"
            and isinstance(value, dict)
            and list(value) == ["live_span"]
            and isinstance(value["live_span"], str)
            and value["live_span"] in _LIVE_SPANS
        ):
            # Felix approved losing the pinned window on reducing panels too (#158).
            # Even the default 1h pin differs once the dashboard time picker changes.
            _time_pin(f"{path}.{key}", value["live_span"], c)
            continue
        if key in ignored:
            c.add(
                "OPTION_IGNORED",
                "info",
                f"{path}.{key}",
                f"{what} option '{key}' is ignored.",
                "No action needed unless the option matters for this panel.",
            )
        else:
            c.error(
                "UNSUPPORTED_WIDGET",
                f"{path}.{key}",
                f"{what} option '{key}' is not supported.",
                "Migrate this widget manually or remove the option in the source.",
            )


def _time_pin(path: str, span: str, c: _Collector) -> None:
    """A widget pinned to its own time frame (`live_span`): TIMEPIN once approved."""
    tag = "TIMEPIN"
    entry = approved(tag)
    default = " (the dashboard default)" if span == DASHBOARD_DURATION else ""
    if entry is not None:
        c.add(
            "APPROXIMATED",
            "warning",
            path,
            f"{tag}: Datadog showed the last {span}{default}. {entry.summary}",
            "Check the panel; set the dashboard time range if the pinned frame matters.",
            remark=tag,
        )
        return
    c.error(
        "UNSUPPORTED_WIDGET",
        path,
        "Widget option 'time' is not supported.",
        f"Remark {tag} ({REMARKS[tag].summary}) awaits manual approval in "
        "src/migrator/source/datadog/remarks.py; until then, migrate this widget manually.",
    )


@dataclass
class _Displayed:
    """One displayed series of a request: a formula over named queries, or one query."""

    formula: Formula | None
    formula_path: str
    formula_text: str
    query_names: list[str]


@dataclass
class _Request:
    queries: dict[str, tuple[str, str, dict[str, Any]]]  # name -> (path, text, raw query)
    displayed: list[_Displayed]
    aggregators: dict[str, Any]  # query name -> source aggregator (query_value, toplist)
    limits: list[Any] = field(default_factory=list)  # toplist: formula `limit`s and request `sort`


def _read_request(req: Any, path: str, wtype: str, c: _Collector) -> _Request | None:
    if not isinstance(req, dict):
        c.error("UNSUPPORTED_WIDGET", path, "Request is not an object.", "Fix the source JSON.")
        return None
    _check_keys(req, _REQ_KEYS[wtype], path, c, "Request")
    if ("q" in req) == ("queries" in req):
        c.error(
            "UNSUPPORTED_WIDGET",
            path,
            "Request must have exactly one of 'q' or 'queries'.",
            "Fix the source request.",
        )
        return None
    if "q" in req:
        if not isinstance(req["q"], str) or "formulas" in req:
            c.error("UNSUPPORTED_WIDGET", f"{path}.q", "Legacy request is malformed.", "Fix it.")
            return None
        split = legacy_series(req["q"])
        if split is None:
            name = "q"
            return _Request(
                queries={name: (f"{path}.q", req["q"], req)},
                displayed=[_Displayed(None, "", "", [name])],
                aggregators={name: req.get("aggregator")},
            )
        legacy = _Request(queries={}, displayed=[], aggregators={})
        for i, (formula_text, texts) in enumerate(split):
            for k, sub_text in enumerate(texts):
                legacy.queries[f"s{i}q{k}"] = (f"{path}.q", sub_text, req)
                legacy.aggregators[f"s{i}q{k}"] = req.get("aggregator")
            if formula_text.strip() == "q0":
                legacy.displayed.append(_Displayed(None, "", "", [f"s{i}q0"]))
                continue
            renamed = _LEGACY_NAME.sub(f"s{i}q" + r"\1", formula_text)
            parsed_formula = parse_formula(renamed)
            assert parsed_formula.ok  # legacy_series parsed the same shape
            legacy.displayed.append(
                _Displayed(
                    parsed_formula.formula,
                    f"{path}.q",
                    req["q"],
                    references(parsed_formula.formula),
                )
            )
        return legacy
    queries: dict[str, tuple[str, str, dict[str, Any]]] = {}
    aggregators: dict[str, Any] = {}
    raw_queries = req["queries"]
    if not isinstance(raw_queries, list) or not raw_queries:
        c.error("UNSUPPORTED_WIDGET", f"{path}.queries", "Request has no queries.", "Fix it.")
        return None
    for k, q in enumerate(raw_queries):
        qpath = f"{path}.queries[{k}]"
        if not isinstance(q, dict):
            c.error("UNSUPPORTED_WIDGET", qpath, "Query is not an object.", "Fix the source.")
            continue
        # Non-metric queries have their own key sets; report only the data source.
        if q.get("data_source") != "metrics":
            c.error(
                "UNSUPPORTED_DATA_SOURCE",
                f"{qpath}.data_source",
                f"Data source '{q.get('data_source')}' is not supported.",
                "Only metric queries convert; migrate this widget manually.",
            )
            continue
        _check_keys(q, _QUERY_KEYS[wtype], qpath, c, "Query")
        qname, qtext = q.get("name"), q.get("query")
        if not isinstance(qname, str) or not isinstance(qtext, str) or qname in queries:
            c.error(
                "UNSUPPORTED_WIDGET",
                qpath,
                "Query needs a unique string 'name' and a string 'query'.",
                "Fix the source query.",
            )
            continue
        queries[qname] = (f"{qpath}.query", qtext, q)
        aggregators[qname] = q.get("aggregator")

    displayed: list[_Displayed] = []
    limits: list[Any] = [req["sort"]] if "sort" in req else []
    formulas = req.get("formulas")
    if formulas is None:
        displayed = [_Displayed(None, "", "", [n]) for n in queries]
    elif not isinstance(formulas, list) or not formulas:
        c.error("UNSUPPORTED_WIDGET", f"{path}.formulas", "Formulas are malformed.", "Fix it.")
    else:
        for f, fo in enumerate(formulas):
            fpath = f"{path}.formulas[{f}]"
            if not isinstance(fo, dict) or not isinstance(fo.get("formula"), str):
                c.error("UNSUPPORTED_WIDGET", fpath, "Formula is malformed.", "Fix it.")
                continue
            keys = _TOPLIST_FORMULA_KEYS if wtype == "toplist" else _FORMULA_KEYS
            _check_keys(fo, keys, fpath, c, "Formula")
            if "limit" in fo:
                limits.append(fo["limit"])
            text = fo["formula"]
            parsed = parse_formula(text)
            if not parsed.ok:
                message, action = function_block(text, anywhere=True) or (
                    f"Formula syntax is not supported at offset {parsed.offset}.",
                    "Only +, -, *, / over query names and numbers convert.",
                )
                c.error("UNSUPPORTED_FORMULA", f"{fpath}.formula", message, action, text)
                continue
            refs = references(parsed.formula)
            unknown = [r for r in refs if r not in queries]
            if unknown:
                c.error(
                    "UNSUPPORTED_FORMULA",
                    f"{fpath}.formula",
                    f"Formula references unknown query '{unknown[0]}'.",
                    "Fix the source formula.",
                    text,
                )
                continue
            displayed.append(_Displayed(parsed.formula, f"{fpath}.formula", text, refs))
    return _Request(queries=queries, displayed=displayed, aggregators=aggregators, limits=limits)


def _series_name_format(labels: list[str]) -> str:
    return " / ".join("{{" + label + "}}" for label in labels)


def _query(promql: str, labels: list[str]) -> PersesQuery:
    spec: dict[str, Any] = {"query": promql}
    if labels:
        spec["seriesNameFormat"] = _series_name_format(labels)
    return {
        "kind": "TimeSeriesQuery",
        "spec": {"plugin": {"kind": "PrometheusTimeSeriesQuery", "spec": spec}},  # type: ignore[typeddict-item]
    }


def _compile_requests(
    requests: list[_Request], ctx: _Ctx, c: _Collector
) -> list[PersesQuery] | None:
    out: list[PersesQuery] = []
    for req in requests:
        compiled: dict[str, RenderedQuery] = {}
        parsed_ok: dict[str, ParseOk] = {}
        needed = [n for d in req.displayed for n in d.query_names]
        for name in dict.fromkeys(needed):
            qpath, text, _ = req.queries[name]
            parsed = parse_metric_query(text)
            if not parsed.ok:
                message, action = function_block(text) or (
                    parsed.message,
                    "Rewrite the query within the supported subset or migrate it manually.",
                )
                c.error(parsed.code, qpath, message, action, text)
                continue
            result = compile_metric_query(
                parsed.query,
                ctx.mapping,
                QueryContext(ctx.source_id, qpath, text, ctx.variables, ctx.promoted),
            )
            c.items.extend(result.diagnostics)
            if isinstance(result, CompiledOk):
                compiled[name] = RenderedQuery(result.promql, result.group_labels)
                parsed_ok[name] = parsed
        # Timeshifted references compile again with an offset. Their other diagnostics
        # repeat the unshifted compile's, so only a new blocking error is reported.
        shifts: dict[tuple[str, int], RenderedQuery] = {}
        pairs = [p for d in req.displayed if d.formula is not None for p in shifted(d.formula)]
        for name, offset in dict.fromkeys(pairs):
            if name not in compiled:
                continue
            qpath, text, _ = req.queries[name]
            result = compile_metric_query(
                parsed_ok[name].query,
                ctx.mapping,
                QueryContext(ctx.source_id, qpath, text, ctx.variables, ctx.promoted, offset),
            )
            if isinstance(result, CompiledOk):
                shifts[(name, offset)] = RenderedQuery(result.promql, result.group_labels)
            else:
                c.items.append(result.diagnostics[-1])
        for disp in req.displayed:
            if any(n not in compiled for n in disp.query_names):
                continue
            if disp.formula is not None and any(p not in shifts for p in shifted(disp.formula)):
                continue
            if disp.formula is None:
                q = compiled[disp.query_names[0]]
                out.append(_query(q.promql, q.group_labels))
                continue
            rendered = render_formula(disp.formula, compiled, shifts)
            if not rendered.ok:
                c.error(
                    "UNSUPPORTED_FORMULA",
                    disp.formula_path,
                    f"Formula cannot be converted: {rendered.reason}.",
                    "Align the group-by tags of the referenced queries or migrate manually.",
                    disp.formula_text,
                )
                continue
            out.append(_query(rendered.promql, rendered.group_labels))
    return None if c.has_error() else out


def _compile_widget(
    widget: Any, path: str, ctx: _Ctx
) -> tuple[PersesPanel | None, str, list[Diagnostic]]:
    """The panel (None when blocked), its title, and diagnostics. A converted widget's remark
    tags go into the panel description, including BEST_EFFORT function diagnostics."""
    c = _Collector(ctx.source_id)
    definition = widget.get("definition") if isinstance(widget, dict) else None
    if not isinstance(definition, dict):
        c.error("UNSUPPORTED_WIDGET", path, "Widget has no definition.", "Fix the source JSON.")
        return None, "", c.items
    title = _str(definition.get("title"))
    wtype = definition.get("type")
    dpath = f"{path}.definition"
    if not isinstance(wtype, str) or wtype not in _DEF_KEYS:
        c.error(
            "UNSUPPORTED_WIDGET",
            f"{dpath}.type",
            f"Widget type '{wtype}' is not supported.",
            "Migrate this widget manually.",
        )
        return None, title, c.items
    _check_keys(definition, _DEF_KEYS[wtype], dpath, c, "Widget")

    if wtype == "note":
        content = definition.get("content")
        if not isinstance(content, str):
            c.error("UNSUPPORTED_WIDGET", f"{dpath}.content", "Note has no text.", "Fix it.")
        if c.has_error():
            return None, title, c.items
        panel = _panel(title, {"kind": "Markdown", "spec": {"text": content}}, [], _tags(c.items))
        return panel, title, c.items

    raw_requests = definition.get("requests")
    if not isinstance(raw_requests, list) or not raw_requests:
        c.error("UNSUPPORTED_WIDGET", f"{dpath}.requests", "Widget has no requests.", "Fix it.")
        return None, title, c.items
    requests = [
        r
        for j, raw in enumerate(raw_requests)
        if (r := _read_request(raw, f"{dpath}.requests[{j}]", wtype, c)) is not None
    ]
    plugin: dict[str, Any] = {"kind": "TimeSeriesChart", "spec": {}}
    if wtype == "query_value" and not c.has_error():
        calc = _stat_calculation(requests, dpath, c, "Query value")
        plugin = {"kind": "StatChart", "spec": {"calculation": calc}}
    if c.has_error():
        return None, title, c.items
    queries = _compile_requests(requests, ctx, c)
    if queries is None:
        return None, title, c.items
    if wtype == "toplist":
        # After the queries, so a legacy `top(...)` query reports its documented block.
        calc = _stat_calculation(requests, dpath, c, "Toplist")
        sort = _toplist_sort(requests, dpath, c) if not c.has_error() else ""
        plugin = {"kind": "BarChart", "spec": {"calculation": calc, "sort": sort}}
        if c.has_error():
            return None, title, c.items
    return _panel(title, plugin, queries, _tags(c.items)), title, c.items


def _tags(diagnostics: list[Diagnostic]) -> list[str]:
    return list(dict.fromkeys(d.remark for d in diagnostics if d.remark is not None))


def _stat_calculation(requests: list[_Request], dpath: str, c: _Collector, what: str) -> str:
    displayed = [d for r in requests for d in r.displayed]
    if len(requests) != 1 or len(displayed) != 1:
        c.error(
            "UNSUPPORTED_WIDGET",
            f"{dpath}.requests",
            f"{what} widgets with several displayed values are not supported.",
            "Migrate this widget manually.",
        )
        return ""
    aggs = [requests[0].aggregators.get(n) for n in displayed[0].query_names]
    agg = aggs[0] if all(a == aggs[0] for a in aggs) else None
    calc = _CALCULATIONS.get(agg) if isinstance(agg, str) else None
    if calc is None:
        message = (
            f"{what} widget has no aggregator."
            if all(a is None for a in aggs)
            else f"{what} aggregator '{agg}' is not supported."
        )
        c.error(
            "UNSUPPORTED_WIDGET",
            f"{dpath}.requests[0]",
            message,
            "Use one of avg, last, max, min or sum in the source widget.",
        )
        return ""
    return calc


def _limit(raw: Any) -> tuple[int, str] | None:
    """(count, order) of a formula `limit` {count, order} or a request `sort`
    {count, order_by: [{type: formula, index: 0, order}]}; None if malformed."""
    if not isinstance(raw, dict):
        return None
    order = raw.get("order")
    if "order_by" in raw:
        by = raw["order_by"]
        ok = (
            isinstance(by, list)
            and len(by) == 1
            and isinstance(by[0], dict)
            and set(by[0]) == {"type", "index", "order"}
            and by[0]["type"] == "formula"
            and by[0]["index"] == 0
        )
        if not ok or set(raw) != {"count", "order_by"}:
            return None
        order = by[0]["order"]
    elif set(raw) != {"count", "order"}:
        return None
    count = raw.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        return None
    return (count, order) if order in ("asc", "desc") else None


def _toplist_sort(requests: list[_Request], dpath: str, c: _Collector) -> str:
    """BarChart sort from the toplist's one top-N limit, with the TOPN remark (approved) for
    the dropped cut; blocks when the limit is missing, repeated or malformed."""
    path = f"{dpath}.requests[0]"
    limits = requests[0].limits
    parsed = _limit(limits[0]) if len(limits) == 1 else None
    if parsed is None:
        c.error(
            "UNSUPPORTED_WIDGET",
            path,
            "Toplist needs exactly one limit with a count and an order (asc or desc).",
            "Migrate this widget manually.",
        )
        return ""
    count, order = parsed
    tag = "TOPN"
    entry = approved(tag)
    if entry is None:
        c.error(
            "UNSUPPORTED_WIDGET",
            f"{dpath}.type",
            "Widget type 'toplist' is not supported.",
            f"Remark {tag} ({REMARKS[tag].summary}) awaits manual approval in "
            "src/migrator/source/datadog/remarks.py; until then, migrate this widget manually.",
        )
        return ""
    c.add(
        "ASSUMED",
        "warning",
        path,
        f"{tag}: Datadog showed the {'top' if order == 'desc' else 'bottom'} {count}. "
        f"{entry.summary}",
        "Check that the series beyond the cut do not crowd the panel.",
        remark=tag,
    )
    return order


def _panel(
    title: str, plugin: dict[str, Any], queries: list[PersesQuery], tags: list[str] | None = None
) -> PersesPanel:
    # Dash0 shows the panel description "in the panel header next to the name"
    # (https://www.dash0.com/docs/dash0/dashboards/configure-panels), so remark tags stay visible.
    return {
        "kind": "Panel",
        "spec": {
            "display": {"name": title, "description": describe(tags or [])},
            "plugin": {"kind": plugin["kind"], "spec": plugin["spec"]},
            "queries": queries,
        },
    }


# --- Layout -------------------------------------------------------------------------


def _source_layout(widget: Any) -> dict[str, int] | None:
    layout = widget.get("layout") if isinstance(widget, dict) else None
    if not isinstance(layout, dict):
        return None
    keys = ("x", "y", "width", "height")
    if not all(
        isinstance(layout.get(k), int) and not isinstance(layout.get(k), bool) for k in keys
    ):
        return None
    return {k: layout[k] for k in keys}


def _fits_source_grid(widget: Any) -> bool:
    """Datadog's ordered layout is a 12-column grid; anything outside it is not mappable."""
    layout = _source_layout(widget)
    return (
        layout is not None
        and layout["x"] >= 0
        and layout["width"] > 0
        and layout["x"] + layout["width"] <= 12
    )


class _GridBuilder:
    # Datadog layout units -> Perses grid units. Columns: Datadog has 12, Perses 24, so x2.
    # Rows: Datadog cells are square ("a maximum width of 12 grid squares",
    # https://docs.datadoghq.com/dashboards/), so one Datadog row is as tall as one Datadog
    # column (= two Perses columns) is wide. Perses rows are 30 px plus a 10 px margin
    # (ROW_HEIGHT, DEFAULT_MARGIN in perses/shared@933b45b
    # dashboards/src/constants/grid-layout-config.ts; the Grid Item spec at
    # https://perses.dev/docs/perses/latest/api/dashboard/ gives no unit). On a W px wide grid
    # that is (W + 10) / 480 Perses rows per Datadog row; no doc fixes W. ROW_SCALE = 3 keeps
    # cells square at W = 1430 px. Proposed constant, pending decision on issue #109.
    # Scaling every item by the same factors keeps non-overlapping layouts non-overlapping.
    COL_SCALE = 2
    ROW_SCALE = 3

    def __init__(self, widgets: list[Any], title: str | None, ordered: bool) -> None:
        self.use_source = ordered and bool(widgets) and all(_fits_source_grid(w) for w in widgets)
        self.title = title
        self.items: list[PersesGridItem] = []

    def place(self, key: str, widget: Any) -> None:
        layout = _source_layout(widget) if self.use_source else None
        if layout is not None:
            x, w = self.COL_SCALE * layout["x"], self.COL_SCALE * layout["width"]
            y, h = self.ROW_SCALE * layout["y"], self.ROW_SCALE * layout["height"]
        else:
            k = len(self.items)
            x, y, w, h = (k % 2) * AUTO_WIDTH, (k // 2) * AUTO_HEIGHT, AUTO_WIDTH, AUTO_HEIGHT
        self.items.append(
            {"x": x, "y": y, "width": w, "height": h, "content": {"$ref": f"#/spec/panels/{key}"}}
        )

    def grid(self) -> PersesGrid | None:
        if not self.items:
            return None
        spec: dict[str, Any] = {"items": self.items}
        if self.title is not None:
            spec["display"] = {"title": self.title}
        return {"kind": "Grid", "spec": spec}  # type: ignore[return-value]


# --- Dashboard ----------------------------------------------------------------------


class _Builder:
    def __init__(self, ctx: _Ctx, c: _Collector, widgets: list[Any], ordered: bool) -> None:
        self.ordered = ordered
        self.ctx = ctx
        self.c = c
        self.widgets = widgets
        self.panels: dict[str, PersesPanel] = {}
        self.layouts: list[PersesGrid] = []
        self.items: list[ItemResult] = []
        # Source paths in item order, plus each group's own path at the group's position,
        # so diagnostics on group options sort with the group, not before every item.
        self.anchors: list[str] = []
        self.top = _GridBuilder(widgets, None, ordered)

    def flush_top(self) -> None:
        grid = self.top.grid()
        if grid is not None:
            self.layouts.append(grid)
        # A new untitled chunk keeps the dashboard-wide layout decision.
        use_source = self.top.use_source
        self.top = _GridBuilder(self.widgets, None, self.ordered)
        self.top.use_source = use_source

    def record(self, key: str, path: str, widget: Any, grid: _GridBuilder) -> None:
        panel, title, diags = _compile_widget(widget, path, self.ctx)
        self.c.items.extend(diags)
        outcome: Outcome = "blocked"
        tags: tuple[str, ...] = ()
        if panel is not None:
            outcome, tags = remark_outcome(diags)
        self.items.append(ItemResult(self.ctx.source_id, path, "widget", title, outcome, tags))
        self.anchors.append(path)
        if panel is not None:
            self.panels[key] = panel
            grid.place(key, widget)

    def block(self, path: str, widget: Any, message: str) -> None:
        d = widget.get("definition") if isinstance(widget, dict) else None
        title = _str(d.get("title")) if isinstance(d, dict) else ""
        self.c.error("UNSUPPORTED_WIDGET", path, message, "Migrate this widget manually.")
        self.items.append(ItemResult(self.ctx.source_id, path, "widget", title, "blocked"))
        self.anchors.append(path)

    def group(self, definition: dict[str, Any], i: int, path: str) -> None:
        """Group children become their own titled grid; the group itself is not an item."""
        self.flush_top()
        self.anchors.append(path)
        raw_children = definition.get("widgets")
        children: list[Any] = raw_children if isinstance(raw_children, list) else []
        dpath = f"{path}.definition"
        keys = _Collector(self.ctx.source_id)
        _check_keys(definition, _GROUP_KEYS, dpath, keys, "Group")
        self.c.items.extend(d for d in keys.items if d.severity != "error")
        blocking = [d for d in keys.items if d.severity == "error"]
        title = _str(definition.get("title"))
        grid = _GridBuilder(children, title, self.ordered)
        for j, child in enumerate(children):
            cpath = f"{dpath}.widgets[{j}]"
            cdef = child.get("definition") if isinstance(child, dict) else None
            if blocking:
                self.block(cpath, child, f"Parent group: {blocking[0].message}")
            elif isinstance(cdef, dict) and cdef.get("type") == "group":
                self.block(cpath, child, "Nested group widgets are not supported.")
            else:
                self.record(f"widget-{i}-{j}", cpath, child, grid)
        built = grid.grid()
        if built is not None:
            self.layouts.append(built)


def compile_dashboard(
    asset: SourceAsset, slug: str, mapping: DatadogMapping, options: CompileOptions
) -> DashboardCompilation:
    body = asset.body
    sid = asset.source_id
    c = _Collector(sid)
    variables = read_template_variables(body)
    promoted = _promote_variables(body, variables, mapping)
    ctx = _Ctx(sid, mapping, variables, promoted)

    out_variables: list[dict[str, Any]] = []
    for i, var in enumerate(variables):
        if var.name in promoted:
            out_variables.append(_list_variable(var.name, promoted[var.name]))
            c.add(
                "OPTION_IGNORED",
                "info",
                f"template_variables[{i}]",
                f"Template variable '${var.name}' became a Perses ListVariable on label "
                f"'{promoted[var.name]}'; variable rendering unverified in Dash0. "
                f'Selected values are matched as an anchored regex (=~"^(${var.name})$"); they are '
                "not escaped, so values containing regex characters such as '.' can match "
                "more series.",
                "Check the variable in Dash0 after publishing.",
            )
    c.add(
        "LAYOUT_APPROXIMATED",
        "info",
        "widgets",
        "Datadog layout converted to a 24-column Perses grid; positions are approximate.",
        "Adjust panel positions in Perses if needed.",
    )

    raw_widgets = body.get("widgets")
    widgets: list[Any] = raw_widgets if isinstance(raw_widgets, list) else []
    b = _Builder(ctx, c, widgets, body.get("layout_type") == "ordered")
    for i, widget in enumerate(widgets):
        path = f"widgets[{i}]"
        definition = widget.get("definition") if isinstance(widget, dict) else None
        if isinstance(definition, dict) and definition.get("type") == "group":
            b.group(definition, i, path)
        else:
            b.record(f"widget-{i}", path, widget, b.top)
    b.flush_top()

    if not b.items:
        c.error(
            "UNSUPPORTED_WIDGET",
            "widgets",
            "Dashboard has no convertible widgets.",
            "Add widgets to the source dashboard or migrate it manually.",
        )

    converted = [it for it in b.items if it.outcome != "blocked"]
    translated = len(converted)
    tags = tuple(dict.fromkeys(t for it in converted for t in it.remarks))
    outcome: Outcome
    if translated and translated == len(b.items):
        outcomes = {it.outcome for it in converted}
        outcome = next(
            (o for o in ("best_effort", "assumed", "approximated") if o in outcomes), "translated"
        )
    elif translated:
        outcome = "partial"
    else:
        outcome = "blocked"

    dashboard: PersesDashboard | None = None
    if outcome != "blocked":
        dashboard = {
            "kind": "Dashboard",
            "metadata": {"name": slug, "project": options.project},
            "spec": {
                "display": {
                    "name": str(body.get("title") or ""),
                    "description": _description(str(body.get("description") or ""), tags),
                },
                "duration": DASHBOARD_DURATION,
                "variables": out_variables,
                "panels": b.panels,
                "layouts": b.layouts,
            },
        }
        problems = _validate(dashboard)
        if problems:
            c.error(
                "TARGET_VALIDATION_FAILED",
                "",
                "Emitted dashboard failed validation: " + "; ".join(problems),
                "This is a converter bug; report it with the source asset.",
            )
            dashboard, outcome, tags = None, "blocked", ()

    items = [ItemResult(sid, "", "dashboard", asset.title, outcome, tags), *b.items]
    return DashboardCompilation(
        dashboard=dashboard, items=items, diagnostics=_ordered(c.items, b.anchors)
    )


def _description(source: str, tags: tuple[str, ...]) -> str:
    """The source description plus one line naming the remark tags of converted panels."""
    if not tags:
        return source
    note = f"Migration remarks: {' '.join(tags)} (see panel descriptions)."
    return f"{source}\n\n{note}" if source else note


def _path_key(path: str) -> tuple[str | int, ...]:
    """Source path as a sort key with numeric indices: `requests[2]` < `requests[10]`.

    `re.split` with one capture group alternates text and index parts, so text always
    compares with text and indices with indices.
    """
    return tuple(int(p) if n % 2 else p for n, p in enumerate(_INDEX.split(path)))


def _ordered(diagnostics: list[Diagnostic], anchors: list[str]) -> list[Diagnostic]:
    """Spec §8: item order, then source path, then emission order (stable sort).

    `anchors` are item paths in item order, with each group's path at its position.
    A diagnostic belongs to the most specific anchor that contains its path; one that
    matches none (dashboard-level, e.g. `template_variables[0]`) belongs to the
    dashboard item, which comes first.
    """

    def key(d: Diagnostic) -> tuple[int, tuple[str | int, ...]]:
        best, best_len = 0, -1
        for index, anchor in enumerate(anchors, start=1):
            if len(anchor) > best_len and (
                d.source_path == anchor or d.source_path.startswith(anchor + ".")
            ):
                best, best_len = index, len(anchor)
        return best, _path_key(d.source_path)

    return sorted(diagnostics, key=key)


def _validate(dashboard: PersesDashboard) -> list[str]:
    problems = validate_dashboard(dashboard)
    for key, panel in sorted(dashboard["spec"]["panels"].items()):
        for n, q in enumerate(panel["spec"]["queries"]):
            err = check_promql_syntax(q["spec"]["plugin"]["spec"]["query"])
            if err is not None:
                problems.append(f"panels.{key}.queries[{n}]: {err}")
    return problems
