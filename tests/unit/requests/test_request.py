"""One Datadog request (queries + formulas) -> PromQL queries or a blocking diagnostic.

Cases come from fixtures/expected/<service>/<dashboard>/expected.yaml (`requests:`), with the
input resolved from the pinned source dashboard by `source_path`. Only requests of widget types
the converter compiles (timeseries, query_value) are cases; other widgets are blocked on their
type (see test_widget.py).

The converter (PR #85) has no per-request entry point, so `support.request_unit` compiles the
request as the only request of a widget of the same type, inside its source dashboard.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from tests.support import (
    Case,
    assert_codes,
    canonical_list,
    case_params,
    comparison,
    panel_queries,
    request_unit,
    under,
    widget_path_of,
)


@pytest.mark.parametrize("case", case_params("request"))
def test_request_translation(
    case: Case,
    record_comparison: Callable[[dict[str, Any]], None],
) -> None:
    unit = request_unit(case)
    record_comparison(comparison(case, unit))  # expected vs actual -> out/test-report/index.html
    expected = case.expected
    assert unit.outcome == expected["outcome"]
    if expected["outcome"] == "translated":
        assert unit.panel is not None
        # Compared after PromQL normalization (whitespace, parens, matcher order, + and * order).
        assert canonical_list(panel_queries(unit.panel)) == canonical_list(expected["promql"])
    else:
        assert unit.panel is None, "a blocked request must not emit a panel"
    assert_codes(unit, expected)


@pytest.mark.parametrize("case", case_params("request"))
def test_request_diagnostics_point_into_source(case: Case) -> None:
    """Every diagnostic carries a message and a source path inside the request (or, for the
    widget-level query_value checks, the widget's request list)."""
    unit = request_unit(case)
    requests_path = f"{widget_path_of(case.source_path)}.definition.requests"
    for d in unit.diagnostics:
        assert under(d.source_path, case.source_path) or d.source_path == requests_path, d
        assert d.message, d
