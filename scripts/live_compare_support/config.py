"""Validated, independently selectable workloads and comparison suites."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

ROOT = Path(__file__).resolve().parents[2]
Name = Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,39}$")]
Positive = Annotated[int, Field(strict=True, gt=0)]
Nonnegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Workload(Model):
    version: Literal[1]
    name: Name
    users: Positive = 5
    spawn_rate: Annotated[float, Field(gt=0, allow_inf_nan=False)] = 1
    collection_seconds: Positive = 10
    receivers: list[
        Literal["postgresql", "redis", "nginx", "kafkametrics", "hostmetrics", "docker_stats"]
    ]
    seed_sql: list[str] = Field(default_factory=list)
    feature_flags: str | None = None

    @model_validator(mode="after")
    def unique_receivers(self) -> Workload:
        if not self.receivers or len(set(self.receivers)) != len(self.receivers):
            raise ValueError("receivers must be nonempty and unique")
        return self


class Case(Model):
    id: Name
    source: str  # manifest sourceId, never a guessed target name
    kind: Literal["dashboard", "monitor"] = "dashboard"
    request: str = ""  # JSON pointer to a source dashboard request
    formula_index: Annotated[int, Field(strict=True, ge=0)] = 0
    panel: str = ""
    query_index: Annotated[int, Field(strict=True, ge=0)] = 0
    variables: dict[str, str] = Field(default_factory=dict)
    series_labels: dict[str, str] = Field(default_factory=dict)  # Datadog tag -> Prom label
    mode: Literal["window_mean", "per_bucket"] = "window_mean"
    relative_tolerance_pct: Nonnegative = 3
    absolute_tolerance: Nonnegative = 0
    require_nonzero: bool = True
    expected_outcome: Literal["translated", "approximated", "assumed", "best_effort"] | None = None
    expected_remarks: list[str] | None = None

    @model_validator(mode="after")
    def valid_reference(self) -> Case:
        request_pattern = r"^/(?:widgets/(?:0|[1-9][0-9]*)/definition/)+requests/(?:0|[1-9][0-9]*)$"
        if self.kind == "dashboard" and (
            re.fullmatch(request_pattern, self.request) is None or not self.panel
        ):
            raise ValueError("dashboard cases require a request JSON pointer and panel")
        if self.kind == "monitor" and (self.request or self.panel):
            raise ValueError("monitor cases do not have a request or panel")
        if len(set(self.series_labels.values())) != len(self.series_labels):
            raise ValueError("series label correspondence must be one-to-one")
        return self


class Suite(Model):
    version: Literal[1]
    inputs: list[str]
    mappings: list[str]
    warmup_seconds: Positive = 300
    window_seconds: Positive = 600
    settle_seconds: Annotated[int, Field(strict=True, ge=0)] = 120
    step_seconds: Positive = 60
    rate_interval: Annotated[str, Field(pattern=r"^[1-9][0-9]*[smh]$")] = "5m"
    cases: list[Case]

    @model_validator(mode="after")
    def valid_suite(self) -> Suite:
        if not self.inputs or not self.mappings or not self.cases:
            raise ValueError("inputs, mappings and cases must be nonempty")
        if len({c.id for c in self.cases}) != len(self.cases):
            raise ValueError("case ids must be unique")
        if self.window_seconds % self.step_seconds:
            raise ValueError("window_seconds must be divisible by step_seconds")
        if self.warmup_seconds < duration(self.rate_interval):
            raise ValueError("warm-up must cover rate_interval")
        return self


def duration(value: str) -> int:
    return int(value[:-1]) * {"s": 1, "m": 60, "h": 3600}[value[-1]]


def load[T: Model](path: Path, model: type[T]) -> T:
    return model.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))


def resolve(base: Path, value: str) -> Path:
    return (base.parent / value).resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value: Any) -> None:
    """Atomic state/evidence writes; an interrupted replacement keeps the previous file."""
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n")
    temp.replace(path)
