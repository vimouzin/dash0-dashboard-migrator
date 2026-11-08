"""Datadog mapping file contract (handoff plans 03, 05 and 06; several files: issue #123).

Every metric and label pair the compiler uses comes from the mapping files. Only a human may
set ``reviewed``; coding assistants leave it ``null``. A file may set top-level ``labels``:
an entry without its own ``labels`` inherits them; an entry's own ``labels`` replace them whole.

An entry may name an ``assumption`` tag (remarks.py, category ``assumed``): the Datadog metric
has no exact OTel counterpart and the entry rebuilds it under that stated assumption. Items
using it convert as ``assumed`` once the tag is approved, and block until then.

A file may list ``gaps``: Datadog metrics checked and found unmappable, each with a short tag
and the reason, so the knowledge stays in the repo and the block message can cite it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)

from migrator.source.datadog.remarks import REMARKS

Label = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z_][a-zA-Z0-9_]*$")]
NonEmpty = Annotated[str, StringConstraints(min_length=1)]
Scale = Annotated[float, Field(gt=0, allow_inf_nan=False)]
# A fixed PromQL range such as "5m". Used by RateMapping.rateWindow (issue #90).
RangeDuration = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]*[smh]$")]
Tag = Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9]*$")]


def _assumed_tag(value: str | None) -> str | None:
    if value is not None and (value not in REMARKS or REMARKS[value].category != "assumed"):
        known = ", ".join(sorted(t for t, r in REMARKS.items() if r.category == "assumed"))
        raise ValueError(f"assumption must be an 'assumed' tag in remarks.py: {known}")
    return value


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class Reviewed(_Strict):
    by: NonEmpty
    date: Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
    evidence: NonEmpty


class GaugeTarget(_Strict):
    name: NonEmpty
    type: Literal["gauge", "sum"]


class RateTarget(_Strict):
    name: NonEmpty
    type: Literal["sum"]


class Grain(_Strict):
    labels: Annotated[list[Label], Field(min_length=1)]
    aggregation: Literal["avg", "max", "min", "sum"]


class GaugeMapping(_Strict):
    kind: Literal["gauge"]
    target: GaugeTarget
    sourceUnit: str
    targetUnit: str
    scale: Scale
    labels: dict[str, Label]
    matchers: dict[Label, str] = Field(default_factory=dict)
    grain: Grain | None = None
    ref: NonEmpty
    reviewed: Reviewed | None
    assumption: Tag | None = None

    _assumption = field_validator("assumption")(_assumed_tag)


class RateMapping(_Strict):
    kind: Literal["rate"]
    target: RateTarget
    sourceUnit: str
    targetUnit: str
    scale: Scale
    labels: dict[str, Label]
    matchers: dict[Label, str] = Field(default_factory=dict)
    grain: Grain | None = None
    # A fixed rate() range, used instead of $__rate_interval. For metrics reported
    # too rarely for Dash0's $__rate_interval (e.g. every 60 s): rate() needs at least
    # two samples in its range. Set it from the measured collection interval, as part
    # of the reviewed entry (issue #90).
    rateWindow: RangeDuration | None = None
    ref: NonEmpty
    reviewed: Reviewed | None
    assumption: Tag | None = None

    _assumption = field_validator("assumption")(_assumed_tag)


class ExpressionMapping(_Strict):
    kind: Literal["expression"]
    expression: NonEmpty
    outputLabels: list[Label]
    labels: dict[str, Label]
    sourceUnit: str
    targetUnit: str
    scale: Scale
    ref: NonEmpty
    reviewed: Reviewed | None
    assumption: Tag | None = None

    _assumption = field_validator("assumption")(_assumed_tag)

    @field_validator("expression")
    @classmethod
    def _requires_filters_placeholder(cls, value: str) -> str:
        if "$filters" not in value:
            raise ValueError("expression must contain the literal $filters placeholder")
        return value


MetricMapping = GaugeMapping | RateMapping | ExpressionMapping

_KINDS: dict[str, type[GaugeMapping] | type[RateMapping] | type[ExpressionMapping]] = {
    "gauge": GaugeMapping,
    "rate": RateMapping,
    "expression": ExpressionMapping,
}


class Gap(_Strict):
    tag: Tag  # short reason, e.g. NOOTEL (no OTel metric), NODATA (no Dash0 data)
    reason: NonEmpty


class _Envelope(_Strict):
    version: Literal[1]
    source: Literal["datadog"]
    # File-level default for entries without their own `labels`.
    labels: dict[str, Label] | None = None
    metrics: dict[str, dict[str, Any]]
    gaps: dict[str, Gap] = Field(default_factory=dict)


@dataclass(frozen=True)
class DatadogMapping:
    version: int
    source: str
    metrics: dict[str, MetricMapping]
    gaps: dict[str, Gap] = field(default_factory=dict)


@dataclass(frozen=True)
class MappingOk:
    mapping: DatadogMapping
    ok: Literal[True] = True


@dataclass(frozen=True)
class MappingInvalid:
    errors: list[str]
    ok: Literal[False] = False


def _format(prefix: list[str], err: ValidationError) -> list[str]:
    out = []
    for e in err.errors():
        path = ".".join(prefix + [str(p) for p in e["loc"]])
        out.append(f"{path}: {e['msg']}")
    return out


def parse_mapping(raw: Any) -> MappingOk | MappingInvalid:
    try:
        envelope = _Envelope.model_validate(raw)
    except ValidationError as err:
        return MappingInvalid(errors=_format([], err))
    errors: list[str] = []
    metrics: dict[str, MetricMapping] = {}
    for name in sorted(envelope.metrics):
        entry = envelope.metrics[name]
        kind = entry.get("kind")
        model = _KINDS.get(kind) if isinstance(kind, str) else None
        if model is None:
            known = ", ".join(sorted(_KINDS))
            errors.append(f"metrics.{name}.kind: unknown kind {kind!r}; known: {known}")
            continue
        if "labels" not in entry and envelope.labels is not None:
            entry = {**entry, "labels": envelope.labels}
        try:
            metrics[name] = model.model_validate(entry)
        except ValidationError as err:
            errors.extend(_format(["metrics", name], err))
    errors += [f"gaps.{n}: also mapped in metrics" for n in sorted(envelope.gaps) if n in metrics]
    if errors:
        return MappingInvalid(errors=errors)
    return MappingOk(
        mapping=DatadogMapping(
            version=envelope.version,
            source=envelope.source,
            metrics=metrics,
            gaps=dict(envelope.gaps),
        )
    )


def parse_mappings(files: Sequence[tuple[str, Any]]) -> MappingOk | MappingInvalid:
    """Parse several mapping files, given as (file name, raw JSON), into one table.

    A metric defined in two files is an error naming both files. Errors are prefixed
    with the file name."""
    if not files:
        return MappingInvalid(errors=["no mapping files"])
    errors: list[str] = []
    owner: dict[str, str] = {}
    metrics: dict[str, MetricMapping] = {}
    gaps: dict[str, Gap] = {}
    for source_id, raw in files:
        parsed = parse_mapping(raw)
        if not parsed.ok:
            errors.extend(f"{source_id}: {e}" for e in parsed.errors)
            continue
        named: list[tuple[str, str, MetricMapping | Gap]] = [
            ("metrics", n, e) for n, e in parsed.mapping.metrics.items()
        ]
        named += [("gaps", n, g) for n, g in parsed.mapping.gaps.items()]
        for section, name, item in named:
            if name in owner:
                errors.append(f"{section}.{name}: defined in both {owner[name]} and {source_id}")
                continue
            owner[name] = source_id
            if isinstance(item, Gap):
                gaps[name] = item
            else:
                metrics[name] = item
    if errors:
        return MappingInvalid(errors=errors)
    return MappingOk(
        mapping=DatadogMapping(
            version=1,
            source="datadog",
            metrics=dict(sorted(metrics.items())),
            gaps=dict(sorted(gaps.items())),
        )
    )
