"""Validation of emitted artifacts: strict Perses schema and PromQL syntax.

These checks prove syntax and schema only, never API acceptance or semantics.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, Literal

import promql_parser
from pydantic import BaseModel, ConfigDict, Field, ValidationError

# Grafana/Perses-style placeholders, substituted for the syntax check only.
_PLACEHOLDERS = {
    "$__rate_interval": "5m",
    "$__interval": "5m",
    "$__range": "5m",
    "$__threshold": "0",
}
# A Dash0 check rule may use only $__threshold; a Prometheus rule file none at all.
_CHECK_RULE_PLACEHOLDERS = {"$__threshold": "0"}
_NO_PLACEHOLDERS: dict[str, str] = {}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Display(_Strict):
    name: str
    description: str


class _PromSpec(_Strict):
    query: Annotated[str, Field(min_length=1)]
    seriesNameFormat: str | None = None


class _PromPlugin(_Strict):
    kind: Literal["PrometheusTimeSeriesQuery"]
    spec: _PromSpec


class _QuerySpec(_Strict):
    plugin: _PromPlugin


class _Query(_Strict):
    kind: Literal["TimeSeriesQuery"]
    spec: _QuerySpec


class _PanelPlugin(_Strict):
    kind: Literal["TimeSeriesChart", "Markdown", "StatChart", "BarChart"]
    spec: dict[str, Any]


class _PanelSpec(_Strict):
    display: _Display
    plugin: _PanelPlugin
    queries: list[_Query]


class _Panel(_Strict):
    kind: Literal["Panel"]
    spec: _PanelSpec


class _Ref(_Strict):
    ref: str = Field(alias="$ref", pattern=r"^#/spec/panels/[A-Za-z0-9_-]+$")


class _GridItem(_Strict):
    x: Annotated[int, Field(ge=0)]
    y: Annotated[int, Field(ge=0)]
    width: Annotated[int, Field(gt=0, le=24)]
    height: Annotated[int, Field(gt=0)]
    content: _Ref


class _GridDisplay(_Strict):
    title: str


class _GridSpec(_Strict):
    display: _GridDisplay | None = None
    items: list[_GridItem]


class _Grid(_Strict):
    kind: Literal["Grid"]
    spec: _GridSpec


class _VarDisplay(_Strict):
    name: str


class _VarPluginSpec(_Strict):
    labelName: str


class _VarPlugin(_Strict):
    kind: Literal["PrometheusLabelValuesVariable"]
    spec: _VarPluginSpec


class _ListVariableSpec(_Strict):
    name: str
    display: _VarDisplay
    allowAllValue: bool
    allowMultiple: bool
    defaultValue: str
    plugin: _VarPlugin


class _ListVariable(_Strict):
    kind: Literal["ListVariable"]
    spec: _ListVariableSpec


class _Metadata(_Strict):
    name: Annotated[str, Field(pattern=r"^[a-z0-9-]+$")]
    project: Annotated[str, Field(min_length=1)]


class _DashboardSpec(_Strict):
    display: _Display
    duration: str
    variables: list[_ListVariable]
    panels: dict[str, _Panel]
    layouts: list[_Grid]


class _Dashboard(_Strict):
    kind: Literal["Dashboard"]
    metadata: _Metadata
    spec: _DashboardSpec


def validate_dashboard(d: Any) -> list[str]:
    """Return schema problems; an empty list means the dashboard matches the schema."""
    try:
        model = _Dashboard.model_validate(d)
    except ValidationError as err:
        return [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in err.errors()]
    problems: list[str] = []
    refs = [item.content.ref for grid in model.spec.layouts for item in grid.spec.items]
    keys = {f"#/spec/panels/{k}" for k in model.spec.panels}
    for ref in refs:
        if ref not in keys:
            problems.append(f"layouts: dangling reference {ref}")
    if len(refs) != len(set(refs)):
        problems.append("layouts: a panel is referenced more than once")
    for key in sorted(keys - set(refs)):
        problems.append(f"panels: {key} is not placed in any layout")
    return problems


def check_promql_syntax(expr: str, placeholders: Mapping[str, str] = _PLACEHOLDERS) -> str | None:
    """Return None if ``expr`` parses as PromQL, else a short error message.

    ``placeholders`` are substituted before parsing; the default is the dashboard
    set. Rule artifacts pass a narrower set so a dashboard variable fails there.
    """
    text = expr
    for placeholder, value in placeholders.items():
        text = text.replace(placeholder, value)
    try:
        promql_parser.parse(text)
    except Exception as err:  # the parser raises ValueError subclasses
        return f"syntax error: {err}"
    return None


# --- Alert artifacts (plan 06 Task 5) -------------------------------------------

_Duration = Annotated[str, Field(pattern=r"^\d+[smhd]$")]
_Finite = Annotated[float, Field(allow_inf_nan=False)]


class _CheckRuleThresholds(_Strict):
    failed: _Finite
    degraded: _Finite | None = None


class _Annotations(_Strict):
    summary: Annotated[str, Field(max_length=255)]
    description: Annotated[str, Field(max_length=2048)]


class _CheckRule(_Strict):
    # No `id` field: extra="forbid" rejects it, which keeps publishing create-only.
    name: Annotated[str, Field(min_length=1)]
    expression: Annotated[str, Field(min_length=1, pattern=r"\$__threshold$")]
    thresholds: _CheckRuleThresholds
    interval: _Duration
    for_: _Duration = Field(alias="for")
    enabled: Literal[False]
    labels: dict[str, str]
    annotations: _Annotations


class _PromRule(_Strict):
    alert: Annotated[str, Field(min_length=1)]
    expr: Annotated[str, Field(min_length=1)]
    labels: dict[str, str]
    annotations: _Annotations


class _PromGroup(_Strict):
    name: Annotated[str, Field(min_length=1)]
    interval: _Duration
    rules: Annotated[list[_PromRule], Field(min_length=1)]


class _PromRuleFile(_Strict):
    groups: Annotated[list[_PromGroup], Field(min_length=1)]


def _errors(err: ValidationError) -> list[str]:
    return [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in err.errors()]


def validate_check_rule(r: Any) -> list[str]:
    """Strict schema of the Dash0 check-rule body, plus PromQL syntax of its expression."""
    try:
        model = _CheckRule.model_validate(r)
    except ValidationError as err:
        return _errors(err)
    problems: list[str] = []
    if model.thresholds.degraded is None and isinstance(r, dict):
        if "degraded" in r.get("thresholds", {}):
            problems.append("thresholds.degraded: must be omitted, not null")
    syntax = check_promql_syntax(model.expression, _CHECK_RULE_PLACEHOLDERS)
    if syntax is not None:
        problems.append(f"expression: {syntax}")
    return problems


def validate_prometheus_rule_group(g: Any) -> list[str]:
    """Strict schema of the Prometheus rule file, plus PromQL syntax of every expr."""
    try:
        model = _PromRuleFile.model_validate(g)
    except ValidationError as err:
        return _errors(err)
    problems: list[str] = []
    for gi, group in enumerate(model.groups):
        for ri, rule in enumerate(group.rules):
            syntax = check_promql_syntax(rule.expr, _NO_PLACEHOLDERS)
            if syntax is not None:
                problems.append(f"groups[{gi}].rules[{ri}].expr: {syntax}")
    return problems
