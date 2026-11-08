"""A whole Datadog dashboard -> a Perses dashboard + per-widget outcomes.

Interface under test (PR #85):
    migrator.source.datadog.dashboard.compile_dashboard(asset, slug, mapping, options)
        -> DashboardCompilation(dashboard: PersesDashboard | None,
                                items: [dashboard ItemResult, *one per leaf widget],
                                diagnostics: list[Diagnostic])
"""

from __future__ import annotations

import re

import pytest

from tests.support import (
    Case,
    canonical_json,
    canonical_list,
    case_params,
    compile_case,
    leaf_widget_paths,
    panel_queries,
)


@pytest.mark.parametrize("case", case_params("dashboard"))
def test_dashboard_outcomes(case: Case) -> None:
    comp = compile_case(case)
    expected = case.expected
    widgets = [it for it in comp.items if it.kind == "widget"]
    assert comp.items[0].kind == "dashboard"
    assert comp.items[0].outcome == expected["outcome"]
    assert [w.source_path for w in widgets] == [w["source_path"] for w in expected["widgets"]]
    assert [w.outcome for w in widgets] == [w["outcome"] for w in expected["widgets"]]
    if expected["outcome"] == "blocked":
        assert comp.dashboard is None, "a fully blocked dashboard writes no artifact"


@pytest.mark.parametrize("case", case_params("dashboard"))
def test_dashboard_panel_queries(case: Case) -> None:
    """Exactly the translated widgets become panels, each with its expected PromQL."""
    comp = compile_case(case)
    expected = case.expected
    if expected["outcome"] == "blocked":
        pytest.skip("blocked dashboard has no panels")
    assert comp.dashboard is not None
    got = {
        key: canonical_list(panel_queries(dict(panel)))
        for key, panel in comp.dashboard["spec"]["panels"].items()
    }
    want = {
        w["panel_key"]: canonical_list(w["promql"])
        for w in expected["widgets"]
        if w["outcome"] == "translated"
    }
    assert got == want


@pytest.mark.parametrize("case", case_params("dashboard"))
def test_dashboard_structure_invariants(case: Case) -> None:
    """Shape rules from 00-context.md §7 and plans 04/05, independent of the exact queries."""
    comp = compile_case(case)
    widgets = [it for it in comp.items if it.kind == "widget"]
    assert len(widgets) == len(leaf_widget_paths(case.source_dashboard)), "one item per leaf"
    translated = [w for w in widgets if w.outcome == "translated"]
    if not translated:
        assert comp.items[0].outcome == "blocked" and comp.dashboard is None
        return
    want = "translated" if len(translated) == len(widgets) else "partial"
    assert comp.items[0].outcome == want
    dash = comp.dashboard
    assert dash is not None
    assert dash["kind"] == "Dashboard"
    assert dash["metadata"]["project"] == case.spec["project"]
    assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", dash["metadata"]["name"])
    assert "dash0Extensions" not in dash["metadata"], "never emit an id that overwrites Dash0"
    panels = dash["spec"]["panels"]
    assert all(re.fullmatch(r"widget-\d+(-\d+)?", key) for key in panels)
    items = [item for layout in dash["spec"]["layouts"] for item in layout["spec"]["items"]]
    refs = sorted(item["content"]["$ref"] for item in items)
    assert refs == sorted(f"#/spec/panels/{k}" for k in panels)
    for item in items:
        assert 0 <= item["x"] and item["x"] + item["width"] <= 24, item


@pytest.mark.parametrize("case", case_params("dashboard"))
def test_dashboard_translation_is_deterministic(case: Case) -> None:
    """Same input, mapping and version -> identical output, items and diagnostics."""
    first, second = compile_case(case, cached=False), compile_case(case, cached=False)
    assert canonical_json(first) == canonical_json(second)
