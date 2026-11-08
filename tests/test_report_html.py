"""The expected-vs-actual HTML report (tests/report_html.py)."""

from __future__ import annotations

from typing import Any

from tests.report_html import render


def _side(promql: str) -> dict[str, Any]:
    return {"outcome": "translated", "promql": [promql], "canonical": [promql],
            "errors": [], "warnings": []}


def _record(case_id: str, status: str, actual: str) -> dict[str, Any]:
    return {
        "case_id": case_id, "reviewed": True, "source": {"q": "avg:a{*}"},
        "expected": _side("avg(a)"), "actual": _side(actual),
        "mismatch": [] if actual == "avg(a)" else ["promql"],
        "status": status, "message": "",
    }


def test_render_lists_failures_first_with_diff_and_escapes() -> None:
    html = render([_record("x/ok", "passed", "avg(a)"), _record("x/bad", "failed", "sum(a<b)")])
    assert '<span class="failed">1 failed</span><span class="passed">1 passed</span>' in html
    assert html.index("x/bad") < html.index("x/ok")
    assert '<details data-status="failed" open>' in html
    assert "Canonical PromQL diff" in html and html.count("Canonical PromQL diff") == 1
    assert "sum(a&lt;b)" in html and "sum(a<b)" not in html
