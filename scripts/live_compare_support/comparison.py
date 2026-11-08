"""Strict series/time alignment and numeric comparison. No gap filling."""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Any

from live_compare_support.config import Case


@dataclass(frozen=True)
class Series:
    labels: dict[str, str]
    samples: dict[int, float]


class DataError(Exception):
    """Missing, ambiguous, or malformed telemetry is never a successful comparison."""


def number(value: Any) -> float:
    if value is None or isinstance(value, bool):
        raise DataError("null or boolean sample")
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise DataError("nonnumeric sample") from None
    if not math.isfinite(n):
        raise DataError("nonfinite sample")
    return n


def samples(times: list[Any], values: list[Any], divisor: int) -> dict[int, float]:
    if len(times) != len(values):
        raise DataError("timestamp/value count mismatch")
    out: dict[int, float] = {}
    for time, value in zip(times, values, strict=True):
        timestamp = number(time) / divisor
        if not timestamp.is_integer() or int(timestamp) in out:
            raise DataError("duplicate or fractional timestamp")
        out[int(timestamp)] = number(value)
    return out


def datadog_series(payload: Any) -> list[Series]:
    try:
        if payload.get("errors") or payload["data"]["type"] != "timeseries_response":
            raise DataError("Datadog query returned errors or wrong response type")
        attrs = payload["data"]["attributes"]
        if len(attrs["series"]) != len(attrs["values"]):
            raise DataError("Datadog series/value count mismatch")
        out = []
        for meta, values in zip(attrs["series"], attrs["values"], strict=True):
            if meta["query_index"] != 0:
                raise DataError("unexpected Datadog formula index")
            labels: dict[str, str] = {}
            for tag in meta["group_tags"]:
                key, sep, value = tag.partition(":")
                if not sep or key in labels:
                    raise DataError("malformed or duplicate Datadog grouping tag")
                labels[key] = value
            out.append(Series(labels, samples(attrs["times"], values, 1000)))
        return out
    except (KeyError, TypeError, AttributeError, ValueError):
        raise DataError("unexpected Datadog timeseries response shape") from None


def dash0_series(payload: Any) -> list[Series]:
    try:
        if payload["status"] != "success" or payload.get("warnings"):
            raise DataError("Dash0 query returned errors or warnings")
        data = payload["data"]
        if data["resultType"] != "matrix":
            raise DataError("Dash0 response must be a matrix")
        out = []
        for item in data["result"]:
            times = [v[0] for v in item["values"]]
            values = [v[1] for v in item["values"]]
            out.append(Series(item["metric"], samples(times, values, 1)))
        return out
    except (KeyError, TypeError, AttributeError, IndexError):
        raise DataError("unexpected Dash0 timeseries response shape") from None


def keyed(series: list[Series], labels: list[str]) -> dict[tuple[str, ...], Series]:
    out = {}
    for s in series:
        if any(label not in s.labels for label in labels):
            raise DataError("required series label missing")
        key = tuple(s.labels[label] for label in labels)
        if key in out:
            raise DataError("ambiguous series: duplicate configured label key")
        out[key] = s
    return out


def stats(values: list[float]) -> dict[str, float]:
    return {"mean": statistics.fmean(values), "min": min(values), "max": max(values)}


def compare(
    case: Case, source: list[Series], target: list[Series], times: list[int]
) -> dict[str, Any]:
    left = keyed(source, list(case.series_labels))
    right = keyed(target, list(case.series_labels.values()))
    if not left or left.keys() != right.keys():
        raise DataError("missing data or unequal source/destination series sets")
    results = []
    for key in sorted(left):
        a, b = left[key].samples, right[key].samples
        expected = set(times)
        if not expected or set(a) != expected or set(b) != expected:
            raise DataError(
                "incomplete coverage or unexpected timestamps (no interpolation): "
                f"expected {len(expected)}, source {len(a)}, destination {len(b)} samples"
            )
        av, bv = [a[t] for t in times], [b[t] for t in times]
        if case.require_nonzero and (not any(av) or not any(bv)):
            raise DataError("test requires nonzero telemetry")
        sa, sb = stats(av), stats(bv)
        pairs = (
            [(sa["mean"], sb["mean"])]
            if case.mode == "window_mean"
            else list(zip(av, bv, strict=True))
        )
        errors = [abs(y - x) for x, y in pairs]
        limits = [
            max(case.absolute_tolerance, abs(x) * case.relative_tolerance_pct / 100)
            for x, _ in pairs
        ]
        results.append(
            {
                "labels": dict(zip(case.series_labels, key, strict=True)),
                "source": sa,
                "destination": sb,
                "samples": len(times),
                "coverage": 1.0,
                "maxAbsoluteDifference": max(errors),
                "relativeMeanDifferencePct": (
                    abs(sb["mean"] - sa["mean"]) / abs(sa["mean"]) * 100 if sa["mean"] else None
                ),
                "passed": all(
                    e <= limit or math.isclose(e, limit, rel_tol=1e-12, abs_tol=0)
                    for e, limit in zip(errors, limits, strict=True)
                ),
            }
        )
    return {
        "status": "passed" if all(r["passed"] for r in results) else "failed",
        "series": results,
    }
