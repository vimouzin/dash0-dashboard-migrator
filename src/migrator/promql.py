"""Shared PromQL rendering: label-value escaping and Dash0 selectors."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

_ESCAPES = {"\\": "\\\\", '"': '\\"', "\n": "\\n"}

MatchOp = Literal["=", "!=", "=~", "!~"]


@dataclass(frozen=True)
class Matcher:
    label: str
    value: str
    op: MatchOp = "="


@dataclass(frozen=True)
class MetricRef:
    name: str
    type: str


def escape_label_value(value: str) -> str:
    """Escape backslash, double quote and newline in a single pass."""
    return "".join(_ESCAPES.get(ch, ch) for ch in value)


def render_matchers(matchers: list[Matcher]) -> str:
    return ", ".join(f'{m.label}{m.op}"{escape_label_value(m.value)}"' for m in matchers)


def render_selector(metric: MetricRef, matchers: list[Matcher]) -> str:
    base = [Matcher("otel_metric_name", metric.name), Matcher("otel_metric_type", metric.type)]
    return "{" + render_matchers(base + matchers) + "}"


def render_aggregation(agg: str, by: list[str], inner: str) -> str:
    if by:
        return f"{agg} by ({', '.join(by)}) ({inner})"
    return f"{agg} ({inner})"


def format_number(value: float) -> str:
    """Render a finite number the way it reads in the mapping file (100, 0.5, 1e-09)."""
    if not math.isfinite(value):
        raise ValueError(f"non-finite number: {value}")
    if float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(float(value))


_OFFSET_UNITS = (("w", 7 * 86400), ("d", 86400), ("h", 3600), ("m", 60), ("s", 1))


def format_offset(seconds: int) -> str:
    """A positive number of seconds as a PromQL duration in the largest exact unit (4w, 90m)."""
    if seconds <= 0:
        raise ValueError(f"offset must be positive: {seconds}")
    unit, size = next((u, n) for u, n in _OFFSET_UNITS if seconds % n == 0)
    return f"{seconds // size}{unit}"
