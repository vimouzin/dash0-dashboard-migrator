"""Unit tests: Datadog metric query string -> parsed model (plan 02).

Interface under test (PR #85):
    migrator.source.datadog.parse_query.parse_metric_query(text: str) -> ParseOk | ParseError
    ParseOk: ok=True, query: MetricQuery
    ParseError: ok=False, code, offset, message
    MetricQuery: aggregator, metric, filters[{kind, key, value} | {kind, name}],
                 group_by: list[str], functions[{name, args}]
"""

from __future__ import annotations

from typing import Any

import pytest
import yaml

from tests.support import SYNTHETIC_DIR, as_plain, load_json, source_dashboards

SPEC = yaml.safe_load((SYNTHETIC_DIR / "queries.yaml").read_text())
PARSE_CODES = {"UNSUPPORTED_QUERY_SYNTAX", "UNSUPPORTED_QUERY_FUNCTION"}


def _subset(expected: Any, actual: Any, path: str = "result") -> None:
    """Assert every key in `expected` matches `actual` (toMatchObject semantics)."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected object, got {actual!r}"
        for key, value in expected.items():
            assert key in actual, f"{path}.{key} missing"
            _subset(value, actual[key], f"{path}.{key}")
    else:
        assert actual == expected, f"{path}: expected {expected!r}, got {actual!r}"


def _parse(text: str) -> Any:
    from migrator.source.datadog.parse_query import parse_metric_query

    return as_plain(parse_metric_query(text))


@pytest.mark.p0
@pytest.mark.parametrize("case", SPEC["cases"], ids=[c["id"] for c in SPEC["cases"]])
def test_parser_spec_case(case):
    _subset(case["expected"], _parse(case["query"]))


def _corpus() -> list[str]:
    seen: list[str] = []
    for path in source_dashboards():
        stack = list(load_json(path).get("widgets", []))
        while stack:
            definition = stack.pop(0).get("definition", {})
            stack.extend(definition.get("widgets", []))
            requests = definition.get("requests")
            items = requests.values() if isinstance(requests, dict) else (requests or [])
            for request in items:
                if not isinstance(request, dict):
                    continue
                for q in request.get("queries", []):
                    if q.get("data_source") == "metrics" and q.get("query"):
                        seen.append(q["query"])
                if request.get("q"):
                    seen.append(request["q"])
    return sorted(set(seen))


CORPUS = _corpus()


@pytest.mark.p0
@pytest.mark.parametrize("text", CORPUS)
def test_corpus_query_never_crashes_and_is_total(text):
    """Every real metric query parses or yields exactly one of the two parse codes."""
    result = _parse(text)
    if result["ok"]:
        assert result["query"]["metric"], "a successful parse must name a metric"
        assert result.get("code") is None
    else:
        assert result["code"] in PARSE_CODES
        assert 0 <= result["offset"] <= len(text)


@pytest.mark.p0
@pytest.mark.parametrize("text", CORPUS[:50])
def test_parse_is_deterministic(text):
    assert _parse(text) == _parse(text)
