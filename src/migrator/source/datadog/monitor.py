"""Datadog metric monitors (plan 06): query parser and options allowlist.

Deterministic and rule-based only. The inner metric query goes through the shared
dashboard parser; anything outside the bounded grammar blocks the monitor.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from migrator.source.asset import SourceAsset
from migrator.source.datadog.compile_query import (
    RATE_INTERVAL,
    CompiledOk,
    QueryContext,
    compile_metric_query,
)
from migrator.source.datadog.formula import RenderedQuery, RenderOk, render_formula
from migrator.source.datadog.mapping import DatadogMapping
from migrator.source.datadog.model import (
    Comparator,
    MetricQuery,
    MonitorExpression,
    MonitorParseOk,
    MonitorParseResult,
    MonitorQuery,
    MonitorWindow,
    ParseError,
    ParseOk,
    TimeAggregator,
    WindowUnit,
)
from migrator.source.datadog.monitor_expression import (
    ExpressionOk,
    parse_monitor_expression,
)
from migrator.source.datadog.parse_query import function_block, parse_metric_query
from migrator.source.datadog.remarks import approved
from migrator.target import (
    Diagnostic,
    DiagnosticCode,
    ItemResult,
    PrometheusRule,
    PrometheusRuleGroup,
    RuleArtifact,
    Severity,
    remark_outcome,
)
from migrator.validation import validate_check_rule, validate_prometheus_rule_group

_PREFIX = re.compile(r"^(avg|max|min|sum)\(last_(\d+)(m|h|d)\):")
_SUFFIX = re.compile(r" (>=|<=|>|<) (-?\d+(?:\.\d+)?)$")


# Arithmetic between queries or numbers, outside `{...}` filters (tag values may hold `-`, `/`).
_BRACES = re.compile(r"\{[^}]*(?:\}|$)")
_ARITHMETIC = re.compile(r"^\s*[\d(-]|[*/+]| - ")
METRIC_MONITOR_DOC = "https://docs.datadoghq.com/monitors/types/metric/"
COUNT_EVALUATION_DOC = "https://docs.datadoghq.com/monitors/guide/as-count-in-monitor-evaluations/"


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def parse_monitor_query(text: str) -> MonitorParseResult:
    prefix = _PREFIX.match(text)
    if prefix is None:
        return ParseError(
            code="UNSUPPORTED_QUERY_SYNTAX",
            offset=0,
            message="Expected '<avg|max|min|sum>(last_<n><m|h|d>):' at offset 0.",
        )
    suffix = _SUFFIX.search(text, prefix.end())
    if suffix is None:
        offset = _utf16_len(text)
        return ParseError(
            code="UNSUPPORTED_QUERY_SYNTAX",
            offset=offset,
            message=f"Expected ' <comparator> <number>' at the end of the query (offset {offset}).",
        )

    inner_text = text[prefix.end() : suffix.start()]
    inner = parse_metric_query(inner_text)
    query: MetricQuery | MonitorExpression
    if not isinstance(inner, ParseOk):
        shift = _utf16_len(text[: prefix.end()])
        arithmetic = parse_monitor_expression(inner_text)
        if isinstance(arithmetic, ExpressionOk):
            query = arithmetic.expression
        else:
            if _ARITHMETIC.search(_BRACES.sub("{}", inner_text)):
                return ParseError(arithmetic.code, arithmetic.offset + shift, arithmetic.message)
            documented = function_block(inner_text)
            if documented is not None:
                return ParseError(code=inner.code, offset=shift, message=documented[0])
            # Function errors point at the whole query; syntax offsets identify a character.
            return ParseError(code=inner.code, offset=inner.offset + shift, message=inner.message)
    else:
        query = inner.query

    return MonitorParseOk(
        monitor=MonitorQuery(
            time_aggregator=cast(TimeAggregator, prefix.group(1)),
            window=MonitorWindow(
                amount=int(prefix.group(2)), unit=cast(WindowUnit, prefix.group(3))
            ),
            query=query,
            comparator=cast(Comparator, suffix.group(1)),
            threshold=float(suffix.group(2)),
        )
    )


# --- Options allowlist (plan 06 Task 2, decision A3) ---------------------------


@dataclass(frozen=True)
class MonitorThresholds:
    critical: float
    warning: float | None = None


@dataclass(frozen=True)
class OptionsOk:
    thresholds: MonitorThresholds
    diagnostics: list[Diagnostic] = field(default_factory=list)
    evaluation_delay: int = 0
    ok: Literal[True] = True


@dataclass(frozen=True)
class OptionsBlocked:
    diagnostics: list[Diagnostic] = field(default_factory=list)
    ok: Literal[False] = False


OptionsResult = OptionsOk | OptionsBlocked


def _is_number(v: Any) -> bool:
    # bool is an int subclass in Python; Datadog JSON true/false must never pass as 1/0.
    return isinstance(v, int | float) and not isinstance(v, bool)


def _is_finite(v: Any) -> bool:
    return _is_number(v) and math.isfinite(v)


def _is_zero(v: Any) -> bool:
    return _is_number(v) and v == 0


# key -> accepted-silently predicate. Anything else for these keys blocks the monitor.
_STRICT_DEFAULTS: dict[str, tuple[Callable[[Any], bool], str]] = {
    "notify_no_data": (lambda v: v is False, "false"),
    "no_data_timeframe": (lambda v: v is None, "null"),
    "timeout_h": (lambda v: v is None or _is_zero(v), "0 or null"),
    "renotify_interval": (lambda v: v is None or _is_zero(v) or v == "0", "0 or null"),
    "escalation_message": (lambda v: v == "", "an empty string"),
    "notify_audit": (lambda v: v is False, "false"),
    "locked": (lambda v: v is False, "false"),
}

_STRICT_REASONS: dict[str, str] = {
    "notify_no_data": "Dash0 handles missing data differently from Datadog no-data alerts.",
    "no_data_timeframe": "Dash0 has no no-data timeframe.",
    "timeout_h": "Dash0 has no auto-resolve timeout.",
    "renotify_interval": "Re-notification is configured in Dash0 notification channels.",
    "escalation_message": "Escalation messages are not migrated.",
    "notify_audit": "Audit notifications are not migrated.",
    "locked": "Monitor locking has no Dash0 equivalent.",
}


def evaluate_monitor_options(options: Mapping[str, Any], *, source_id: str) -> OptionsResult:
    """Check `options` against the reviewed allowlist. Unknown or semantically
    different options block the monitor; diagnostics are sorted by source path."""
    diags: list[Diagnostic] = []

    def add(
        code: DiagnosticCode,
        severity: Severity,
        path: str,
        message: str,
        action: str,
        remark: str | None = None,
    ) -> None:
        diags.append(Diagnostic(code, severity, source_id, path, message, action, None, remark))

    def approximate(path: str, tag: str, detail: str) -> None:
        """An option the target lacks: APPROXIMATED with its remark tag once approved."""
        remark = approved(tag)
        if remark is None:
            block(path, f"{detail} Remark {tag} awaits manual approval in remarks.py.")
            return
        add(
            "APPROXIMATED",
            "warning",
            path,
            f"{tag}: {detail} {remark.summary}",
            "Check that this difference is acceptable for the alert.",
            remark=tag,
        )

    def block(path: str, message: str) -> None:
        add(
            "UNSUPPORTED_MONITOR_OPTION",
            "error",
            path,
            message,
            "Migrate this monitor manually or change the option to its default.",
        )

    critical: float | None = None
    warning: float | None = None
    evaluation_delay = 0

    for key in sorted(options):
        value = options[key]
        path = f"options.{key}"
        if key == "thresholds":
            if not isinstance(value, Mapping):
                block(path, "Monitor thresholds must be an object.")
                continue
            for tkey in sorted(value):
                tval = value[tkey]
                tpath = f"{path}.{tkey}"
                if tkey not in ("critical", "warning"):
                    block(tpath, f"Threshold '{tkey}' is not supported.")
                elif not _is_finite(tval):
                    block(tpath, f"Threshold '{tkey}' must be a finite number.")
                elif tkey == "critical":
                    critical = float(tval)
                else:
                    warning = float(tval)
            if "critical" not in value:
                block(path, "Monitor has no critical threshold.")
        elif key == "require_full_window":
            if value is True:
                approximate(path, "FULLWINDOW", "require_full_window is true.")
            elif value is not False:
                block(path, "require_full_window must be true or false.")
        elif key == "new_host_delay":
            if _is_number(value) and value > 0:
                approximate(path, "NEWHOST", f"new_host_delay is {value} s.")
            elif not (value is None or _is_zero(value)):
                block(path, "new_host_delay must be null or a non-negative number.")
        elif key == "include_tags":
            if isinstance(value, bool):
                add(
                    "OPTION_IGNORED",
                    "info",
                    path,
                    "Monitor option 'include_tags' is ignored.",
                    "No action needed; notification titles are not migrated.",
                )
            else:
                block(path, "include_tags must be true or false.")
        elif key == "evaluation_delay":
            # Datadog moves the complete lookback into the past, e.g. at 07:00 a
            # five-minute window with 300 s delay evaluates 06:50-06:55:
            # https://docs.datadoghq.com/monitors/configuration/#evaluation-delay
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 86400:
                evaluation_delay = value
            elif value is not None:
                block(path, "evaluation_delay must be null or an integer from 0 to 86400 seconds.")
        elif key in _STRICT_DEFAULTS:
            accepts, expected = _STRICT_DEFAULTS[key]
            if not accepts(value):
                block(path, f"Only {expected} is supported for '{key}'. {_STRICT_REASONS[key]}")
        else:
            block(path, f"Monitor option '{key}' is not supported.")

    if "thresholds" not in options:
        block("options.thresholds", "Monitor has no thresholds.")

    diags.sort(key=lambda d: d.source_path)
    if critical is None or any(d.severity == "error" for d in diags):
        return OptionsBlocked(diagnostics=diags)
    return OptionsOk(
        thresholds=MonitorThresholds(critical, warning),
        diagnostics=diags,
        evaluation_delay=evaluation_delay,
    )


# --- compile_monitor and both renderers (plan 06 Task 4) ------------------------

SUPPORTED_MONITOR_TYPES = ("query alert", "metric alert")
CHECK_INTERVAL = "1m"
SUMMARY_MAX = 255
DESCRIPTION_MAX = 2048
MAX_WINDOW_MINUTES = 7 * 24 * 60
# Rule expressions can't use the dashboard variable $__rate_interval: Prometheus
# never interpolates it, and whether Dash0 check rules do is unverified (07.T1).
# A monitor's rate() uses this fixed range instead: four times the 1m evaluation
# step, so each step sees several samples at scrape intervals up to about 1m.
MONITOR_RATE_RANGE = "5m"
REMARKS_LABEL = "migration_remarks"  # comma-separated remark tags of a converted monitor
# Any other $variable left in a compiled query (none is expected for monitors).
_DASHBOARD_VARIABLE = re.compile(r"\$(?:__)?[A-Za-z_]\w*")
_UNIT_MINUTES: dict[str, int] = {"m": 1, "h": 60, "d": 24 * 60}
_TIME_FUNCTIONS: dict[str, str] = {
    "avg": "avg_over_time",
    "max": "max_over_time",
    "min": "min_over_time",
    "sum": "sum_over_time",
}
_OPEN_ESC = '{{ "{{" }}'
_CLOSE_ESC = '{{ "}}" }}'
# A handle is any "@name" not preceded by an email-local-part character, so
# "}}@pagerduty", "(@slack-ops)" and line starts count while "a@b.c" does not.
_HANDLE = re.compile(r"(?<![A-Za-z0-9._%+\-])@[A-Za-z0-9_][A-Za-z0-9_.\-]*")


@dataclass(frozen=True)
class MonitorCompilation:
    rule: RuleArtifact | None
    item: ItemResult
    diagnostics: list[Diagnostic]


def _escape_tokens(text: str) -> list[str]:
    """Split into atomic output tokens: each template brace pair becomes one escape token."""
    tokens: list[str] = []
    i = 0
    while i < len(text):
        pair = text[i : i + 2]
        if pair == "{{":
            tokens.append(_OPEN_ESC)
            i += 2
        elif pair == "}}":
            tokens.append(_CLOSE_ESC)
            i += 2
        else:
            tokens.append(text[i])
            i += 1
    return tokens


def escape_template_braces(text: str) -> str:
    """One pass: '{{' -> '{{ "{{" }}' and '}}' -> '{{ "}}" }}', so Go templates print them."""
    return "".join(_escape_tokens(text))


def _escaped_within(text: str, limit: int) -> tuple[str, bool]:
    """Escape, then cut to `limit` characters only between tokens, appending '…'."""
    tokens = _escape_tokens(text)
    full = "".join(tokens)
    if len(full) <= limit:
        return full, False
    out: list[str] = []
    used = 0
    for tok in tokens:
        if used + len(tok) > limit - 1:
            break
        out.append(tok)
        used += len(tok)
    return "".join(out) + "…", True


def _by_path(diags: list[Diagnostic]) -> list[Diagnostic]:
    # 00-context §8: by source path, then emission order (sorted() is stable).
    return sorted(diags, key=lambda d: d.source_path)


def _format_threshold(value: float) -> str:
    return str(int(value)) if value.is_integer() else repr(value)


def _warning_on_correct_side(comparator: str, warning: float, critical: float) -> bool:
    if comparator in (">", ">="):
        return warning < critical
    return warning > critical


def compile_monitor(asset: SourceAsset, slug: str, mapping: DatadogMapping) -> MonitorCompilation:
    body = asset.body
    sid = asset.source_id
    diags: list[Diagnostic] = []

    def add(
        code: DiagnosticCode,
        severity: Severity,
        path: str,
        message: str,
        action: str,
        text: str | None = None,
    ) -> None:
        diags.append(Diagnostic(code, severity, sid, path, message, action, text))

    def blocked() -> MonitorCompilation:
        item = ItemResult(sid, "", "monitor", asset.title, "blocked")
        return MonitorCompilation(rule=None, item=item, diagnostics=_by_path(diags))

    # 1. Monitor type.
    mtype = body.get("type")
    if mtype not in SUPPORTED_MONITOR_TYPES:
        add(
            "UNSUPPORTED_MONITOR_TYPE",
            "error",
            "type",
            f"Monitor type {mtype!r} is not supported; only metric monitors are.",
            "Migrate this monitor manually.",
        )
        return blocked()

    # 2. Query.
    query_text = body.get("query")
    if not isinstance(query_text, str):
        add("UNSUPPORTED_QUERY_SYNTAX", "error", "query", "Monitor has no query.", "Add a query.")
        return blocked()
    parsed = parse_monitor_query(query_text)
    if not isinstance(parsed, MonitorParseOk):
        add(
            parsed.code,
            "error",
            "query",
            parsed.message,
            "Rewrite the query within the supported subset or migrate it manually.",
            query_text,
        )
        return blocked()
    monitor = parsed.monitor

    # 3. Options.
    raw_options = body.get("options")
    options_result = evaluate_monitor_options(
        raw_options if isinstance(raw_options, Mapping) else {}, source_id=sid
    )
    diags.extend(options_result.diagnostics)
    if not isinstance(options_result, OptionsOk):
        return blocked()
    thresholds = options_result.thresholds

    # 4. Inline threshold must equal the critical threshold.
    if monitor.threshold != thresholds.critical:
        add(
            "THRESHOLD_MISMATCH",
            "error",
            "query",
            f"Query threshold {_format_threshold(monitor.threshold)} differs from "
            f"options.thresholds.critical {_format_threshold(thresholds.critical)}.",
            "Make the query threshold and the critical threshold equal in Datadog.",
            query_text,
        )
        return blocked()

    # 5. Warning on the correct side of critical.
    if thresholds.warning is not None and not _warning_on_correct_side(
        monitor.comparator, thresholds.warning, thresholds.critical
    ):
        add(
            "THRESHOLD_MISMATCH",
            "error",
            "options.thresholds.warning",
            f"Warning threshold {_format_threshold(thresholds.warning)} is on the wrong side of "
            f"critical {_format_threshold(thresholds.critical)} for '{monitor.comparator}'.",
            "Fix the warning threshold in Datadog.",
        )
        return blocked()

    # 6. Window within Dash0's limit.
    minutes = monitor.window.amount * _UNIT_MINUTES[monitor.window.unit]
    if minutes == 0:
        add(
            "UNSUPPORTED_MONITOR_OPTION",
            "error",
            "query",
            f"Window last_0{monitor.window.unit} is empty.",
            "Use a window of at least one minute.",
            query_text,
        )
        return blocked()
    if minutes > MAX_WINDOW_MINUTES:
        add(
            "UNSUPPORTED_MONITOR_OPTION",
            "error",
            "query",
            f"Window last_{monitor.window.amount}{monitor.window.unit} is longer than 7 days.",
            "Shorten the window to 7 days or less, or migrate manually.",
            query_text,
        )
        return blocked()

    # 7. Classic metric arithmetic happens at each timestamp, before the lookback
    # reducer. Datadog's as_count path has the opposite order: never let a future
    # dashboard function implementation accidentally enter that path here.
    queries = (
        monitor.query.queries if isinstance(monitor.query, MonitorExpression) else (monitor.query,)
    )
    if any(fn.name == "as_count" for query in queries for fn in query.functions):
        add(
            "UNSUPPORTED_QUERY_FUNCTION",
            "error",
            "query",
            "Monitor '.as_count()' requires time aggregation before arithmetic and a "
            f"count bucket model that is not supported ({COUNT_EVALUATION_DOC}).",
            "Use a reviewed rate-based monitor or migrate this count monitor manually.",
            query_text,
        )
        return blocked()
    compiled_queries: dict[str, RenderedQuery] = {}
    for index, query in enumerate(queries):
        compiled = compile_metric_query(query, mapping, QueryContext(sid, "query", query_text, []))
        diags.extend(compiled.diagnostics)
        if isinstance(compiled, CompiledOk):
            compiled_queries[f"q{index}"] = RenderedQuery(compiled.promql, compiled.group_labels)
    if any(d.severity == "error" for d in diags):
        return blocked()
    if isinstance(monitor.query, MonitorExpression):
        rendered = render_formula(monitor.query.formula, compiled_queries)
        if not isinstance(rendered, RenderOk):
            add(
                "UNSUPPORTED_FORMULA",
                "error",
                "query",
                f"Monitor arithmetic cannot be rendered: {rendered.reason}.",
                "Use the same explicitly mapped group-by labels on every metric query.",
                query_text,
            )
            return blocked()
        promql = rendered.promql
    else:
        promql = compiled_queries["q0"].promql
    promql = promql.replace(f"[{RATE_INTERVAL}]", f"[{MONITOR_RATE_RANGE}]")
    leftover = sorted(set(_DASHBOARD_VARIABLE.findall(promql)))
    if leftover:
        add(
            "UNSUPPORTED_QUERY_SYNTAX",
            "error",
            "query",
            f"The compiled query uses dashboard variables {', '.join(leftover)}, which a "
            "rule expression can't use.",
            "Rewrite the monitor query without template variables, or migrate it manually.",
            query_text,
        )
        return blocked()

    # 8. Notification handles are not migrated.
    message = body.get("message")
    message_text = message if isinstance(message, str) else ""
    handles = sorted(set(_HANDLE.findall(message_text)))
    if handles:
        add(
            "NOTIFICATION_NOT_MIGRATED",
            "warning",
            "message",
            f"Notification targets are not migrated: {', '.join(handles)}.",
            "Configure Dash0 notification channels for this check rule.",
        )

    # 9. Ignored metadata.
    for key in ("priority", "tags"):
        value = body.get(key)
        if value is not None and value != []:
            add(
                "OPTION_IGNORED",
                "info",
                key,
                f"Monitor field '{key}' is ignored.",
                "No action needed unless routing depends on it.",
            )

    name = body.get("name")
    name_text = name if isinstance(name, str) else asset.title
    summary, cut_summary = _escaped_within(name_text, SUMMARY_MAX)
    description, cut_description = _escaped_within(message_text, DESCRIPTION_MAX)
    for cut, path, limit in (
        (cut_summary, "name", SUMMARY_MAX),
        (cut_description, "message", DESCRIPTION_MAX),
    ):
        if cut:
            add(
                "TEXT_TRUNCATED",
                "warning",
                path,
                f"Text was cut to {limit} characters after escaping.",
                "Shorten the text in Datadog if the cut part matters.",
            )

    # Remark tags go on both artifacts as a label (Dash0 merges check-rule labels into each
    # failed check: https://www.dash0.com/docs/dash0/monitoring/alerting/route-alert-check-notifications).
    outcome, tags = remark_outcome(diags)
    remark_labels = {REMARKS_LABEL: ",".join(tags)} if tags else {}

    window = f"{monitor.window.amount}{monitor.window.unit}"
    over_time = _TIME_FUNCTIONS[monitor.time_aggregator]
    delay = f" offset {options_result.evaluation_delay}s" if options_result.evaluation_delay else ""
    condition = f"{over_time}(({promql})[{window}:{CHECK_INTERVAL}]{delay})"
    annotations = {"summary": summary, "description": description}

    levels: list[tuple[str, float]] = []
    if thresholds.warning is not None:
        levels.append(("warning", thresholds.warning))
    levels.append(("critical", thresholds.critical))
    rules: list[PrometheusRule] = [
        {
            "alert": slug,
            "expr": f"{condition} {monitor.comparator} {_format_threshold(value)}",
            "labels": {"severity": severity, **remark_labels},
            "annotations": dict(annotations),
        }
        for severity, value in levels
    ]
    group: PrometheusRuleGroup = {
        "groups": [{"name": slug, "interval": CHECK_INTERVAL, "rules": rules}]
    }

    check_thresholds: dict[str, float] = {"failed": thresholds.critical}
    if thresholds.warning is not None:
        check_thresholds["degraded"] = thresholds.warning
    check_rule: dict[str, Any] = {
        "name": name_text,
        "expression": f"{condition} {monitor.comparator} $__threshold",
        "thresholds": check_thresholds,
        "interval": CHECK_INTERVAL,
        "for": "0s",
        "enabled": False,
        "labels": dict(remark_labels),
        "annotations": dict(annotations),
    }

    problems = [f"check rule {p}" for p in validate_check_rule(check_rule)] + [
        f"prometheus rule {p}" for p in validate_prometheus_rule_group(group)
    ]
    if problems:
        add(
            "TARGET_VALIDATION_FAILED",
            "error",
            "",
            "Emitted monitor artifacts failed validation: " + "; ".join(problems),
            "This is a converter bug; report it with the source asset.",
        )
        return blocked()

    item = ItemResult(sid, "", "monitor", asset.title, outcome, tags)
    return MonitorCompilation(
        rule=RuleArtifact(slug, sid, group, check_rule), item=item, diagnostics=_by_path(diags)
    )
