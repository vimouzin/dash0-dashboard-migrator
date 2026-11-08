"""Shared output types: Perses dashboards, rules, diagnostics and outcomes.

Shared code (CLI, report, validation, destination) depends only on these types and on
the SourceProvider interface; it never imports a provider's internals.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, TypedDict

Severity = Literal["error", "warning", "info"]

DiagnosticCode = Literal[
    "UNSUPPORTED_ASSET_KIND",
    "DUPLICATE_SOURCE_ID",
    "INVALID_JSON",
    "UNSUPPORTED_QUERY_SYNTAX",
    "UNSUPPORTED_QUERY_FUNCTION",
    "MISSING_AGGREGATOR",
    "MISSING_METRIC_MAPPING",
    "MISSING_LABEL_MAPPING",
    "UNSUPPORTED_UNIT_CONVERSION",
    "TEMPLATE_VARIABLE_DROPPED",
    "UNSUPPORTED_TEMPLATE_VARIABLE",
    "UNREVIEWED_MAPPING",
    "UNSUPPORTED_WIDGET",
    "UNSUPPORTED_DATA_SOURCE",
    "UNSUPPORTED_FORMULA",
    "LAYOUT_APPROXIMATED",
    "OPTION_IGNORED",
    "TARGET_VALIDATION_FAILED",
    "DEFAULT_AGGREGATOR_APPLIED",
    "UNSUPPORTED_MONITOR_TYPE",
    "UNSUPPORTED_MONITOR_OPTION",
    "THRESHOLD_MISMATCH",
    "NOTIFICATION_NOT_MIGRATED",
    "TEXT_TRUNCATED",
    "APPROXIMATED",
    "ASSUMED",
    "BEST_EFFORT",
    "IMPORT_FAILED",
    "IMPORT_RESULT_UNKNOWN",
]

Outcome = Literal["translated", "approximated", "assumed", "best_effort", "partial", "blocked"]
ItemKind = Literal["dashboard", "widget", "monitor"]
Level = Literal["passed", "failed", "not_run"]


@dataclass(frozen=True)
class Diagnostic:
    code: DiagnosticCode
    severity: Severity
    source_id: str
    source_path: str
    message: str
    suggested_action: str
    source_text: str | None = None
    remark: str | None = None  # remark tag on APPROXIMATED / ASSUMED diagnostics

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "code": self.code,
            "severity": self.severity,
            "sourceId": self.source_id,
            "sourcePath": self.source_path,
            "message": self.message,
            "suggestedAction": self.suggested_action,
        }
        if self.source_text is not None:
            out["sourceText"] = self.source_text
        if self.remark is not None:
            out["remark"] = self.remark
        return out


@dataclass(frozen=True)
class SourceLocation:
    source_id: str
    source_path: str

    def to_dict(self) -> dict[str, str]:
        return {"sourceId": self.source_id, "sourcePath": self.source_path}


@dataclass(frozen=True)
class MetricCoverage:
    metric: str
    mapped: bool
    locations: tuple[SourceLocation, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "mapped": self.mapped,
            "locations": [location.to_dict() for location in self.locations],
        }


@dataclass(frozen=True)
class MappingCoverage:
    """Metric-name presence only; not proof that a query can be translated."""

    parsed_queries: int
    metrics: tuple[MetricCoverage, ...]
    unparsed_queries: tuple[Diagnostic, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "parsedQueries": self.parsed_queries,
            "metrics": [metric.to_dict() for metric in self.metrics],
            "unparsedQueries": [diagnostic.to_dict() for diagnostic in self.unparsed_queries],
        }


@dataclass(frozen=True)
class ItemResult:
    source_id: str
    source_path: str
    kind: ItemKind
    title: str
    outcome: Outcome
    remarks: tuple[str, ...] = ()  # remark tags of a converted item, first-occurrence order

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "sourceId": self.source_id,
            "sourcePath": self.source_path,
            "kind": self.kind,
            "title": self.title,
            "outcome": self.outcome,
        }
        if self.remarks:
            out["remarks"] = list(self.remarks)
        return out


def remark_outcome(diagnostics: list[Diagnostic]) -> tuple[Outcome, tuple[str, ...]]:
    """Strongest converted category and every tag in first-occurrence order."""
    tags = tuple(dict.fromkeys(d.remark for d in diagnostics if d.remark is not None))
    codes = {d.code for d in diagnostics}
    if "BEST_EFFORT" in codes:
        return "best_effort", tags
    if "ASSUMED" in codes:
        return "assumed", tags
    if "APPROXIMATED" in codes:
        return "approximated", tags
    return "translated", tags


# --- Perses (JSON-shaped; emitted as-is) -------------------------------------------


class PromQuerySpec(TypedDict):
    query: str
    seriesNameFormat: NotRequired[str]


class PromQueryPlugin(TypedDict):
    kind: Literal["PrometheusTimeSeriesQuery"]
    spec: PromQuerySpec


class PersesQuerySpec(TypedDict):
    plugin: PromQueryPlugin


class PersesQuery(TypedDict):
    kind: Literal["TimeSeriesQuery"]
    spec: PersesQuerySpec


class PersesDisplay(TypedDict):
    name: str
    description: str


class PersesPlugin(TypedDict):
    kind: str
    spec: dict[str, Any]


class PersesPanelSpec(TypedDict):
    display: PersesDisplay
    plugin: PersesPlugin
    queries: list[PersesQuery]


class PersesPanel(TypedDict):
    kind: Literal["Panel"]
    spec: PersesPanelSpec


class PersesGridItem(TypedDict):
    x: int
    y: int
    width: int
    height: int
    content: dict[str, str]  # {"$ref": "#/spec/panels/<key>"}


class PersesGridDisplay(TypedDict):
    title: str


class PersesGridSpec(TypedDict):
    display: NotRequired[PersesGridDisplay]
    items: list[PersesGridItem]


class PersesGrid(TypedDict):
    kind: Literal["Grid"]
    spec: PersesGridSpec


class PersesMetadata(TypedDict):
    name: str
    project: str


class PersesDashboardSpec(TypedDict):
    display: PersesDisplay
    duration: str
    variables: list[dict[str, Any]]
    panels: dict[str, PersesPanel]
    layouts: list[PersesGrid]


class PersesDashboard(TypedDict):
    kind: Literal["Dashboard"]
    metadata: PersesMetadata
    spec: PersesDashboardSpec


# --- Rules -------------------------------------------------------------------------


class PrometheusRule(TypedDict):
    alert: str
    expr: str
    labels: dict[str, str]
    annotations: dict[str, str]


class PrometheusRuleGroupEntry(TypedDict):
    name: str
    interval: str
    rules: list[PrometheusRule]


class PrometheusRuleGroup(TypedDict):
    groups: list[PrometheusRuleGroupEntry]


class CheckRuleThresholds(TypedDict):
    degraded: NotRequired[float]
    failed: float


class CheckRuleAnnotations(TypedDict):
    summary: str
    description: str


class Dash0CheckRule(TypedDict):
    name: str
    expression: str
    thresholds: CheckRuleThresholds
    interval: str
    # "for" is a Python keyword; the key is still "for" in the emitted dict.
    enabled: bool
    labels: dict[str, str]
    annotations: CheckRuleAnnotations


@dataclass(frozen=True)
class DashboardArtifact:
    slug: str
    source_id: str
    dashboard: PersesDashboard


@dataclass(frozen=True)
class RuleArtifact:
    slug: str
    source_id: str
    prometheus_rule_group: PrometheusRuleGroup
    check_rule: dict[str, Any]


@dataclass
class CompileResult:
    dashboards: list[DashboardArtifact] = field(default_factory=list)
    rules: list[RuleArtifact] = field(default_factory=list)
    items: list[ItemResult] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)
    mapping_coverage: MappingCoverage | None = None


@dataclass
class ValidationLevels:
    syntax: Level = "not_run"
    schema: Level = "not_run"
    api: Level = "not_run"
    semantics: Level = "not_run"

    def to_dict(self) -> dict[str, str]:
        return {
            "syntax": self.syntax,
            "schema": self.schema,
            "api": self.api,
            "semantics": self.semantics,
        }
