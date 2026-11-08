"""Inline mappings shared by the Datadog unit tests (not the reviewed mapping files)."""

from __future__ import annotations

import copy
from typing import Any

from migrator.source.datadog.mapping import DatadogMapping, parse_mapping

REVIEWED = {"by": "t", "date": "2026-11-07", "evidence": "test"}

CONNECTIONS: dict[str, Any] = {
    "kind": "gauge",
    "target": {"name": "postgresql.backends", "type": "sum"},
    "sourceUnit": "connection",
    "targetUnit": "1",
    "scale": 1,
    "labels": {"db": "postgresql_database_name", "host": "host_name"},
    "ref": "test",
    "reviewed": REVIEWED,
}


def entry(**overrides: Any) -> dict[str, Any]:
    e = copy.deepcopy(CONNECTIONS)
    e.update(overrides)
    return e


def raw_mapping(**metrics: dict[str, Any]) -> dict[str, Any]:
    return {"version": 1, "source": "datadog", "metrics": metrics}


def mapping(**metrics: dict[str, Any]) -> DatadogMapping:
    if not metrics:
        metrics = {"postgresql.connections": entry()}
    result = parse_mapping(raw_mapping(**{k.replace("__", "."): v for k, v in metrics.items()}))
    assert result.ok, getattr(result, "errors", None)
    return result.mapping
