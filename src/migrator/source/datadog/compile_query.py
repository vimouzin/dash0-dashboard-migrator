"""Compile a parsed Datadog MetricQuery to Dash0 PromQL (handoff plans 03, 05, 06).

Check order (the first blocking failure returns ``CompiledError`` with the warnings
collected so far plus that error):

1. unsupported function/args     -> UNSUPPORTED_QUERY_FUNCTION
   supported approximation      -> BEST_EFFORT with its approved reason tag
2. no space aggregator           -> DEFAULT_AGGREGATOR_APPLIED (warning, continue with avg)
3. metric not in the mapping     -> MISSING_METRIC_MAPPING
4. entry not reviewed            -> UNREVIEWED_MAPPING (warning, continue)
5. filters, in source order      -> UNSUPPORTED_TEMPLATE_VARIABLE / TEMPLATE_VARIABLE_DROPPED
                                    (warning) / MISSING_LABEL_MAPPING
6. group-by tags                 -> MISSING_LABEL_MAPPING

A query without a space aggregator (`system.load.1{*}`) uses Datadog's default, `avg`
(plan 05 Task 1): the Metrics Explorer and the dashboard editor both default to `avg`
(https://docs.datadoghq.com/metrics/explorer/#space-aggregation,
https://docs.datadoghq.com/dashboards/querying/#aggregation-method).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from migrator.promql import (
    Matcher,
    MetricRef,
    format_number,
    format_offset,
    render_aggregation,
    render_matchers,
    render_selector,
)
from migrator.source.datadog.mapping import (
    DatadogMapping,
    ExpressionMapping,
    GaugeMapping,
    RateMapping,
)
from migrator.source.datadog.model import MetricQuery, QueryFunction, SpaceAggregator, TagFilter
from migrator.source.datadog.remarks import approved
from migrator.target import Diagnostic, DiagnosticCode, Severity

RATE_INTERVAL = "$__rate_interval"
# Perses panel step; `.as_count()` counts per step (ASCOUNT, #181).
INTERVAL = "$__interval"
DEFAULT_AGGREGATOR: SpaceAggregator = "avg"  # Datadog's space aggregation without `agg:`
DEFAULT_AGGREGATOR_DOC = "https://docs.datadoghq.com/dashboards/querying/#aggregation-method"
ROLLUP_DOC = "https://docs.datadoghq.com/dashboards/functions/rollup/"
FILL_DOC = "https://docs.datadoghq.com/dashboards/functions/interpolation/#fill"

# Unsupported variants keep function-specific documentation rather than silently falling back.
_FUNCTION_BLOCKS: dict[str, tuple[str, str]] = {
    "rollup": (
        "Unsupported '.rollup()' arguments: use avg, sum, min, max or count with an optional "
        f"integer interval from 1 to 86400 seconds ({ROLLUP_DOC}).",
        "Use a supported fixed-duration rollup form or migrate this query manually.",
    ),
    "fill": (
        "Query function '.fill()' is blocked: PromQL has no equivalent of Datadog's gap "
        f"interpolation (methods linear, last, zero, null; gap limit in seconds; {FILL_DOC}).",
        "Migrate this widget manually, or remove '.fill()' from the source query if unfilled "
        "gaps are acceptable.",
    ),
}


@dataclass(frozen=True)
class TemplateVariable:
    name: str
    prefix: str | None
    default: str | None


@dataclass(frozen=True)
class QueryContext:
    source_id: str
    source_path: str
    source_text: str
    variables: list[TemplateVariable]
    # Template variables promoted to a Perses ListVariable: name -> target label.
    promoted: dict[str, str] = field(default_factory=dict)
    # Timeshift in seconds (formula.py); every selector gets ` offset <duration>`.
    offset_seconds: int = 0


@dataclass(frozen=True)
class CompiledOk:
    promql: str
    group_labels: list[str]
    diagnostics: list[Diagnostic]
    ok: Literal[True] = True


@dataclass(frozen=True)
class CompiledError:
    diagnostics: list[Diagnostic]
    ok: Literal[False] = False


CompiledQuery = CompiledOk | CompiledError


class _Diags:
    def __init__(self, ctx: QueryContext) -> None:
        self.ctx = ctx
        self.items: list[Diagnostic] = []

    def add(
        self,
        code: DiagnosticCode,
        severity: Severity,
        message: str,
        action: str,
        remark: str | None = None,
    ) -> None:
        self.items.append(
            Diagnostic(
                code=code,
                severity=severity,
                source_id=self.ctx.source_id,
                source_path=self.ctx.source_path,
                message=message,
                suggested_action=action,
                source_text=self.ctx.source_text,
                remark=remark,
            )
        )

    def block(self, code: DiagnosticCode, message: str, action: str) -> CompiledError:
        self.add(code, "error", message, action)
        return CompiledError(diagnostics=list(self.items))


# Datadog weights gauge series by their configured submission interval. That metadata is not
# in exported queries, so this bounded approximation uses the fullest selected series' sample
# count as its denominator. It is deliberately BEST_EFFORT, including for stable telemetry.
WEIGHTED_DOC = "https://docs.datadoghq.com/dashboards/guide/how-weighted-works/"
TYPE_MODIFIERS_DOC = "https://docs.datadoghq.com/metrics/custom_metrics/type_modifiers/"
_ROLLUP_AGGREGATORS = {"avg", "sum", "min", "max", "count"}


@dataclass(frozen=True)
class _FunctionPlan:
    kind: Literal["weighted", "rollup", "as_rate", "as_count"]
    aggregation: str = "avg"
    window: str = RATE_INTERVAL


def _positive_seconds(value: str) -> str | None:
    # Finite bounded grammar; calendar rollups and enormous/zero/negative ranges are rejected.
    if len(value) <= 5 and value.isascii() and value.isdigit() and 0 < int(value) <= 86400:
        return f"{int(value)}s"
    return None


def _function_plan(q: MetricQuery, d: _Diags) -> _FunctionPlan | CompiledError | None:
    if not q.functions:
        return None
    # Changing modifier order can change time-vs-space evaluation. Never silently reorder.
    if len(q.functions) != 1:
        return d.block(
            "UNSUPPORTED_QUERY_FUNCTION",
            "Chained query modifiers are not supported; their evaluation order is not "
            "established by the bounded best-effort function implementation.",
            "Split or migrate this query manually; no modifier has been discarded.",
        )
    fn: QueryFunction = q.functions[0]
    if fn.name == "weighted" and not fn.args and q.aggregator == "sum":
        return _FunctionPlan("weighted")
    if fn.name == "as_rate" and not fn.args:
        return _FunctionPlan("as_rate")
    if fn.name == "as_count" and not fn.args:
        return _FunctionPlan("as_count", window=INTERVAL)
    if fn.name == "rollup":
        if len(fn.args) == 1:
            if fn.args[0] in _ROLLUP_AGGREGATORS:
                return _FunctionPlan("rollup", aggregation=fn.args[0])
            window = _positive_seconds(fn.args[0])
            if window is not None:
                return _FunctionPlan("rollup", window=window)
        if len(fn.args) == 2 and fn.args[0] in _ROLLUP_AGGREGATORS:
            window = _positive_seconds(fn.args[1])
            if window is not None:
                return _FunctionPlan("rollup", aggregation=fn.args[0], window=window)
    message, action = _FUNCTION_BLOCKS.get(
        fn.name,
        (
            f"Query function '.{fn.name}()' or its arguments are not supported. "
            "weighted() requires explicit sum and no arguments; as_rate() and as_count() "
            "take no arguments.",
            "Use a documented supported form or migrate this query manually.",
        ),
    )
    return d.block("UNSUPPORTED_QUERY_FUNCTION", message, action)


def _approve_function(
    plan: _FunctionPlan, entry: GaugeMapping | RateMapping | ExpressionMapping, d: _Diags
) -> CompiledError | None:
    counter = plan.kind in ("as_rate", "as_count")
    valid = isinstance(entry, RateMapping) if counter else isinstance(entry, GaugeMapping)
    if not valid:
        expected = "rate" if counter else "gauge"
        return d.block(
            "UNSUPPORTED_QUERY_FUNCTION",
            f"'.{plan.kind}()' requires a '{expected}' metric mapping; expressions and "
            "other metric kinds lack the raw series semantics required by this implementation.",
            "Use a reviewed mapping of the documented metric kind or migrate manually.",
        )
    tag = {"weighted": "WEIGHTED", "rollup": "ROLLUP", "as_rate": "ASRATE", "as_count": "ASCOUNT"}[
        plan.kind
    ]
    remark = approved(tag)
    if remark is None:
        return d.block(
            "UNSUPPORTED_QUERY_FUNCTION",
            f"Best-effort {plan.kind} conversion awaits approval of {tag}.",
            "Review the documented approximation before converting this query.",
        )
    detail = (
        f" Window={plan.window}; denominator=max sample count across all selected raw series."
        if plan.kind == "weighted"
        else f" Window={plan.window}; reducer={plan.aggregation}."
        if plan.kind == "rollup"
        else f" Window={plan.window}."
        if plan.kind == "as_count"
        else ""
    )
    d.add(
        "BEST_EFFORT",
        "warning",
        f"{tag}: {remark.summary}{detail}",
        "Verify the source and target numerically on representative telemetry; "
        "no global error bound is guaranteed.",
        remark=tag,
    )
    return None


_REGEX_META = re.compile(r"[.^$|?*+()\[\]{}\\]")


def tag_matcher(label: str, flt: TagFilter) -> Matcher:
    """Exact matcher for a tag filter (#178). One literal value is `=`/`!=`. Globs and OR'd
    values become one anchored alternation, `=~`/`!~`: Datadog's `*` matches any characters
    in a tag value (https://docs.datadoghq.com/metrics/advanced-filtering/#wildcard-filtered-queries),
    regex metacharacters are escaped, and the anchors make Dash0's unanchored `=~` match whole
    values (see the template-variable comment below). Like Datadog, a negated matcher keeps
    series that lack the label."""
    values = flt.values
    if len(values) == 1 and "*" not in values[0]:
        return Matcher(label, values[0], "!=" if flt.negated else "=")
    alternation = "|".join(
        ".*".join(_REGEX_META.sub(r"\\\g<0>", part) for part in v.split("*")) for v in values
    )
    return Matcher(label, f"^({alternation})$", "!~" if flt.negated else "=~")


def compile_metric_query(
    q: MetricQuery, mapping: DatadogMapping, ctx: QueryContext
) -> CompiledQuery:
    d = _Diags(ctx)

    plan = _function_plan(q, d)
    if isinstance(plan, CompiledError):
        return plan
    aggregator = q.aggregator
    if aggregator is None:
        aggregator = DEFAULT_AGGREGATOR
        d.add(
            "DEFAULT_AGGREGATOR_APPLIED",
            "warning",
            f"Query has no space aggregator; applied Datadog's default '{aggregator}' "
            f"({DEFAULT_AGGREGATOR_DOC}).",
            f"Add an explicit space aggregator to the source query if '{aggregator}' is not "
            "intended.",
        )
    entry = mapping.metrics.get(q.metric)
    if entry is None:
        gap = mapping.gaps.get(q.metric)
        if gap is not None:
            return d.block(
                "MISSING_METRIC_MAPPING",
                f"No mapping for metric '{q.metric}' (gap {gap.tag}: {gap.reason})",
                "Migrate this widget manually; the gap is recorded in the mapping file.",
            )
        return d.block(
            "MISSING_METRIC_MAPPING",
            f"No mapping for metric '{q.metric}'.",
            f"Add a reviewed entry for '{q.metric}' to the mapping file.",
        )
    if plan is not None:
        failure = _approve_function(plan, entry, d)
        if failure is not None:
            return failure
    if entry.assumption is not None:
        tag = entry.assumption
        remark = approved(tag)
        if remark is None:
            return d.block(
                "MISSING_METRIC_MAPPING",
                f"The mapping for '{q.metric}' relies on assumption {tag}, which awaits manual "
                "approval.",
                f"Approve {tag} in src/migrator/source/datadog/remarks.py, or migrate manually.",
            )
        d.add(
            "ASSUMED",
            "warning",
            f"{tag}: {remark.summary}",
            f"Check the '{q.metric}' mapping entry's ref for the assumption.",
            remark=tag,
        )
    if entry.reviewed is None:
        d.add(
            "UNREVIEWED_MAPPING",
            "warning",
            f"Mapping for '{q.metric}' has not been reviewed by a human.",
            f"Review the '{q.metric}' entry against its ref and set 'reviewed'.",
        )

    matchers: list[Matcher] = []
    for flt in q.filters:
        if isinstance(flt, TagFilter):
            label = entry.labels.get(flt.key)
            if label is None:
                return d.block(
                    "MISSING_LABEL_MAPPING",
                    f"No label mapping for tag '{flt.key}' on metric '{q.metric}'.",
                    f"Add a reviewed label mapping for '{flt.key}' to the '{q.metric}' entry.",
                )
            matchers.append(tag_matcher(label, flt))
            continue
        var = next((v for v in ctx.variables if v.name == flt.name), None)
        if var is None:
            return d.block(
                "UNSUPPORTED_TEMPLATE_VARIABLE",
                f"Template variable '${flt.name}' is not defined on the dashboard.",
                "Define the variable on the source dashboard or remove it from the query.",
            )
        promoted = ctx.promoted.get(var.name)
        if (
            promoted is not None
            and var.prefix is not None
            and entry.labels.get(var.prefix) == promoted
        ):
            # Datadog `$var` filters are exact tag matches. The dashboard substitutes the
            # value at view time, so the closest documented form is the anchored
            # alternation `=~"^($name)$"`: Dash0 does not anchor `=~` and documents exactly
            # this form for whole-value matching
            # (dash0.com/docs/dash0/dashboards/bind-variables-to-queries). Under Prometheus
            # semantics (`=~` is fully anchored) the anchors change nothing.
            # Assumptions and residual gaps (PR #85):
            # - Values are not regex-escaped: a selected `a.b` also matches `aXb`. Perses
            #   documents `${name:regex}`, but its single-backslash output (`(a\.b)`) is an
            #   invalid escape in a double-quoted PromQL string; the double-backslash
            #   `regexliteral` format exists only in Perses' source, is undocumented, and
            #   Dash0 documents no format modifiers. If Dash0 lacked it, `${name:...}` would
            #   stay literal and match nothing, which is worse than a wider match.
            # - What Dash0 substitutes for the "All" default (`$__all`) is undocumented;
            #   Perses expands it to the alternation of all values, which the anchors keep.
            #   Confirm in the Dash0 ListVariable render check (plan 07 Task 1).
            matchers.append(Matcher(promoted, f"^(${var.name})$", "=~"))
        elif var.default is None or var.default == "*":
            default_note = "default '*'" if var.default == "*" else "no default"
            d.add(
                "TEMPLATE_VARIABLE_DROPPED",
                "warning",
                f"Template variable '${var.name}' ({default_note}) dropped; "
                "the converted panel shows all series.",
                "Add a label mapping for the variable's prefix tag to filter by it.",
            )
        else:
            return d.block(
                "UNSUPPORTED_TEMPLATE_VARIABLE",
                f"Template variable '${var.name}' has default '{var.default}'; "
                "dropping it would change the data shown.",
                "Migrate this widget manually or change the variable default to '*'.",
            )

    group_labels: list[str] = []
    for tag in q.group_by:
        label = entry.labels.get(tag)
        if label is None:
            return d.block(
                "MISSING_LABEL_MAPPING",
                f"No label mapping for group-by tag '{tag}' on metric '{q.metric}'.",
                f"Add a reviewed label mapping for '{tag}' to the '{q.metric}' entry.",
            )
        if isinstance(entry, ExpressionMapping) and label not in entry.outputLabels:
            return d.block(
                "MISSING_LABEL_MAPPING",
                f"Label '{label}' is not an output label of the expression for '{q.metric}'.",
                f"Add '{label}' to outputLabels only if the reviewed expression keeps it.",
            )
        group_labels.append(label)

    if isinstance(entry, ExpressionMapping):
        if ctx.offset_seconds:
            return d.block(
                "UNSUPPORTED_FORMULA",
                f"Timeshift of '{q.metric}' is not supported: its mapping is a PromQL "
                "expression, and the compiler only shifts the selectors it renders itself.",
                "Migrate this widget manually or remove the timeshift function.",
            )
        filters = ", " + render_matchers(matchers) if matchers else ""
        body = entry.expression.replace("$filters", filters)
        expr = render_aggregation(aggregator, group_labels, body)
    else:
        expr = _render_metric(entry, aggregator, group_labels, matchers, ctx.offset_seconds, plan)

    if entry.scale != 1:
        expr = f"({expr}) * {format_number(entry.scale)}"
    return CompiledOk(promql=expr, group_labels=group_labels, diagnostics=list(d.items))


def _render_metric(
    entry: GaugeMapping | RateMapping,
    aggregator: str,
    group_labels: list[str],
    matchers: list[Matcher],
    offset_seconds: int = 0,
    plan: _FunctionPlan | None = None,
) -> str:
    fixed = [Matcher(label, value) for label, value in sorted(entry.matchers.items())]
    inner = render_selector(MetricRef(entry.target.name, entry.target.type), matchers + fixed)
    offset = f" offset {format_offset(offset_seconds)}" if offset_seconds else ""
    if isinstance(entry, RateMapping) and plan is not None and plan.kind == "as_count":
        inner = f"increase({inner}[{plan.window}]{offset})"
    elif isinstance(entry, RateMapping):
        inner = f"rate({inner}[{entry.rateWindow or RATE_INTERVAL}]{offset})"
    elif plan is not None and plan.kind == "weighted":
        samples = f"{inner}[{plan.window}]{offset}"
        # sum_over_time/count_max = average * series_count/count_max. Weight raw sample
        # presence before grain deduplication, otherwise PromQL lookback invents persistence.
        inner = f"sum_over_time({samples}) / scalar(max(count_over_time({samples})))"
    elif plan is not None and plan.kind == "rollup":
        inner = f"{plan.aggregation}_over_time({inner}[{plan.window}]{offset})"
    else:
        inner += offset
    if entry.grain is not None:
        grain_by = group_labels + [lbl for lbl in entry.grain.labels if lbl not in group_labels]
        inner = render_aggregation(entry.grain.aggregation, grain_by, inner)
    return render_aggregation(aggregator, group_labels, inner)
