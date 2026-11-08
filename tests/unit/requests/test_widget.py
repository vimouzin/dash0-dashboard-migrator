"""One Datadog widget -> one Perses panel (or a blocked outcome), inside its source dashboard.

A widget is all or nothing: never drop a series (00-context.md §8). The converter (PR #85)
reports one `ItemResult` per leaf widget, panels keyed `widget-<i>` (group child
`widget-<i>-<j>`), and diagnostics under the widget's source path.
"""

from __future__ import annotations

import pytest

from tests.support import (
    Case,
    assert_codes,
    canonical_list,
    case_params,
    compile_case,
    panel_key_of,
    panel_queries,
    widget_unit,
)


@pytest.mark.parametrize("case", case_params("widget"))
def test_widget_translation(case: Case) -> None:
    expected = case.expected
    unit = widget_unit(compile_case(case), case.source_path, panel_key_of(case.source_path))
    assert unit.outcome == expected["outcome"]
    assert_codes(unit, expected)
    if expected["outcome"] == "blocked":
        assert unit.panel is None
        return
    assert unit.panel is not None
    assert panel_key_of(case.source_path) == expected["panel_key"]
    assert unit.panel["kind"] == "Panel"
    assert unit.panel["spec"]["display"]["name"] == expected["title"]
    assert unit.panel["spec"]["plugin"]["kind"] == expected["panel_plugin"]
    assert {q["kind"] for q in unit.panel["spec"]["queries"]} <= {"TimeSeriesQuery"}
    assert canonical_list(panel_queries(unit.panel)) == canonical_list(expected["promql"])
