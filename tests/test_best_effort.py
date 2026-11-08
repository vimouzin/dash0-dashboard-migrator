"""Best-effort results remain visible and publishable."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from migrator.convert import ConvertOptions, run_convert
from migrator.publish import PublishOptions, run_publish
from migrator.report import exit_code_for, format_summary, manifest_entry, summarize
from migrator.target import Diagnostic, DiagnosticCode, ItemResult, remark_outcome


@pytest.mark.parametrize("codes", [
    ["BEST_EFFORT"], ["ASSUMED", "BEST_EFFORT"],
    ["BEST_EFFORT", "APPROXIMATED", "ASSUMED", "BEST_EFFORT"],
])
def test_best_effort_preserves_precedence_and_all_reasons(codes: list[DiagnosticCode]) -> None:
    tags = {"BEST_EFFORT": "WEIGHTED", "ASSUMED": "DERIVED", "APPROXIMATED": "TIMEPIN"}
    diags = [
        Diagnostic(code, "warning", "d.json", "query", "reason", "check", remark=tags[code])
        for code in codes
    ]
    assert remark_outcome(diags) == (
        "best_effort", tuple(dict.fromkeys(tags[code] for code in codes))
    )


def test_best_effort_counts_as_converted_with_visible_summary() -> None:
    items = [
        ItemResult("d.json", "", "dashboard", "D", "best_effort", ("WEIGHTED",)),
        ItemResult("d.json", "widgets[0]", "widget", "W", "best_effort", ("WEIGHTED",)),
    ]
    report: dict[str, Any] = {"items": [i.to_dict() for i in items], "summary": summarize(items, 0)}
    assert report["summary"]["widgets"]["best_effort"] == 1
    assert "1/1 widgets, 1 best_effort [WEIGHTED]" in format_summary(report, {})
    entry = manifest_entry("p", "dashboard", "d.json", "x", "best_effort", ("WEIGHTED",))
    assert (entry["eligible"], entry["remarks"]) == (True, ["WEIGHTED"])
    assert exit_code_for(items) == 2


def test_best_effort_manifest_is_selected_for_publish(tmp_path: Path) -> None:
    source = tmp_path / "d.json"
    source.write_text(json.dumps({
        "title": "Coverage", "layout_type": "ordered", "widgets": [{
            "definition": {"type": "timeseries", "requests": [
                {"q": "avg:postgresql.connections{*}"}
            ]}
        }]
    }))
    out = tmp_path / "out"
    run_convert(ConvertOptions("datadog", [str(source)], ["mappings/datadog"], str(out)))
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for entry in manifest["entries"]:
        if entry["kind"] == "dashboard":
            entry.update(outcome="best_effort", remarks=["WEIGHTED"])
    manifest_path.write_text(json.dumps(manifest))
    result = run_publish(PublishOptions(str(out), dry_run=True), {
        "DASH0_API_URL": "https://api.example.dash0.com",
        "DASH0_AUTH_TOKEN": "test-token",
        "DASH0_DATASET": "demo",
    })
    assert result.exit_code == 0
    assert len(result.lines) == 1
    assert result.lines[0].endswith("[best_effort: WEIGHTED]")


@pytest.mark.parametrize("blocked_widget", [False, True])
def test_weighted_dashboard_preserves_category_tags_and_blockers(
    tmp_path: Path, blocked_widget: bool
) -> None:
    source = tmp_path / "d.json"
    widgets = [{"definition": {
        "type": "timeseries", "time": {"live_span": "5m"},
        "requests": [{"q": "sum:redis.mem.used{*}.weighted()"}],
    }}]
    if blocked_widget:
        widgets.append({"definition": {"type": "unknown"}})
    source.write_text(json.dumps({
        "title": "Weighted", "layout_type": "ordered", "widgets": widgets
    }))

    def convert(name: str):
        return run_convert(ConvertOptions(
            "datadog", [str(source)], ["mappings/datadog"], str(tmp_path / name)
        ))

    result = convert("first")
    assert result.exit_code == 2
    dashboard, widget, *rest = result.report["items"]
    assert dashboard["outcome"] == ("partial" if blocked_widget else "best_effort")
    assert widget["outcome"] == "best_effort"
    assert set(widget["remarks"]) == {"TIMEPIN", "WEIGHTED"}
    assert bool(rest) == blocked_widget
    if rest:
        assert rest[0]["outcome"] == "blocked"
    [entry] = [e for e in result.manifest["entries"] if e["kind"] == "dashboard"]
    assert entry["eligible"] is not blocked_widget
    emitted = json.loads((tmp_path / "first" / entry["path"]).read_text())
    assert "Migration remarks: TIMEPIN WEIGHTED" in emitted["spec"]["display"]["description"]
    panel = emitted["spec"]["panels"]["widget-0"]["spec"]
    assert "[WEIGHTED]" in panel["display"]["description"]
    assert "sum_over_time" in panel["queries"][0]["spec"]["plugin"]["spec"]["query"]
    assert result.report["validation"]["semantics"] == "not_run"
    convert("second")
    for path in (tmp_path / "first").rglob("*"):
        if path.is_file():
            assert path.read_bytes() == (tmp_path / "second" / path.relative_to(
                tmp_path / "first"
            )).read_bytes()


def test_best_effort_function_monitor_preserves_disabled_state_and_reasons(tmp_path: Path) -> None:
    source = tmp_path / "m.json"
    source.write_text(json.dumps({
        "name": "Weighted monitor", "type": "query alert",
        "query": "avg(last_5m):sum:redis.mem.used{*}.weighted() > 10000000",
        "options": {"thresholds": {"critical": 10000000}},
    }))
    out = tmp_path / "out"
    result = run_convert(ConvertOptions(
        "datadog", [str(source)], ["mappings/datadog"], str(out)
    ))
    assert result.report["items"][0]["outcome"] == "best_effort"
    assert result.report["items"][0]["remarks"] == ["WEIGHTED"]
    [entry] = [e for e in result.manifest["entries"] if e["kind"] == "check-rule"]
    rule = json.loads((out / entry["path"]).read_text())
    assert rule["enabled"] is False
    assert rule["labels"]["migration_remarks"] == "WEIGHTED"
    assert "$__rate_interval" not in rule["expression"]
