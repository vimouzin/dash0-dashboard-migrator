"""Deterministic case inventory for the pinned Datadog dashboards.

Walks every pinned integrations-core dashboard and lists each widget and each
request (including widgets nested in groups) with its JSON source path. The
output is the skeleton that oracle answers and reviewed expectations attach to.

This script never calls a model or the network. Same input -> same output.

Usage: uv run scripts/extract_cases.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "fixtures" / "datadog" / "integrations-core"
CASES_DIR = ROOT / "fixtures" / "cases"
PINNED_COMMIT = "a9b9e42b7e484861ecbd1f5919da7c52a694b74d"


def _queries_of(request: dict) -> list[dict]:
    """Return the request's queries in a uniform shape, keeping source keys."""
    if "queries" in request:
        return [
            {
                "name": q.get("name"),
                "data_source": q.get("data_source"),
                "query": q.get("query"),
            }
            for q in request["queries"]
        ]
    if "q" in request:
        return [{"name": None, "data_source": "metrics", "query": request["q"]}]
    return []


def _walk_widgets(widgets: list[dict], prefix: str, out_widgets: list, out_requests: list) -> None:
    for i, widget in enumerate(widgets):
        path = f"{prefix}[{i}]"
        definition = widget.get("definition", {})
        wtype = definition.get("type")
        requests = definition.get("requests")
        # Some widget types (query_value, toplist, ...) use a list; a few use a dict.
        if isinstance(requests, dict):
            request_items = sorted(requests.items())
        elif isinstance(requests, list):
            request_items = [(str(j), r) for j, r in enumerate(requests)]
        else:
            request_items = []

        out_widgets.append(
            {
                "source_path": path,
                "type": wtype,
                "title": definition.get("title"),
                "request_count": len(request_items),
                "has_layout": "layout" in widget,
            }
        )
        for key, request in request_items:
            rpath = f"{path}.definition.requests[{key}]" if key.isdigit() else f"{path}.definition.requests.{key}"
            if not isinstance(request, dict):
                continue
            out_requests.append(
                {
                    "source_path": rpath,
                    "widget_type": wtype,
                    "widget_title": definition.get("title"),
                    "queries": _queries_of(request),
                    "formulas": [f.get("formula") for f in request.get("formulas", [])],
                }
            )
        if wtype == "group":
            _walk_widgets(definition.get("widgets", []), f"{path}.definition.widgets", out_widgets, out_requests)


def extract(path: Path) -> dict:
    dashboard = json.loads(path.read_text())
    widgets: list = []
    requests: list = []
    _walk_widgets(dashboard.get("widgets", []), "widgets", widgets, requests)
    service = path.parent.parent.name
    return {
        "source": {
            "repository": "DataDog/integrations-core",
            "commit": PINNED_COMMIT,
            "file": f"{service}/assets/dashboards/{path.name}",
            "fixture": str(path.relative_to(ROOT)),
        },
        "service": service,
        "dashboard_id": path.stem,
        "title": dashboard.get("title"),
        "layout_type": dashboard.get("layout_type"),
        "template_variables": [
            {"name": tv.get("name"), "prefix": tv.get("prefix"), "default": tv.get("default")}
            for tv in dashboard.get("template_variables", [])
        ],
        "widgets": widgets,
        "requests": requests,
    }


def main() -> int:
    files = sorted(SOURCE_DIR.glob("*/dashboards/*.json"))
    if not files:
        print(f"no dashboards under {SOURCE_DIR}", file=sys.stderr)
        return 1
    for path in files:
        case = extract(path)
        target = CASES_DIR / case["service"] / f"{case['dashboard_id']}.yaml"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(yaml.safe_dump(case, sort_keys=False, allow_unicode=True, width=1000))
        print(f"{target.relative_to(ROOT)}: {len(case['widgets'])} widgets, {len(case['requests'])} requests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
