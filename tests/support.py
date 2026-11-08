"""Shared helpers for the oracle tests: case loading, the converter adapter, PromQL comparison.

Expectations live in fixtures/expected/<service>/<dashboard_id>/expected.yaml. Inputs are
resolved from the pinned dashboard by JSON source path, so the request/widget input is never
duplicated in the expectation file.

The converter under test is PR #85's `migrator` package. Its only public conversion entry
point is `compile_dashboard(asset, slug, mapping, options)`; a widget is all or nothing, and
results come back as per-widget `ItemResult`s, panels keyed `widget-<i>[-<j>]`, and diagnostics
scoped by source path. The helpers below read those, never private functions.
"""

from __future__ import annotations

import dataclasses
import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml

from migrator.source.asset import CompileOptions, SourceAsset
from migrator.source.datadog.dashboard import DashboardCompilation, compile_dashboard
from migrator.source.datadog.mapping import DatadogMapping, parse_mappings
from migrator.target import Diagnostic
from migrator.write import assign_slugs

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
SOURCE_DIR = FIXTURES / "datadog" / "integrations-core"
EXPECTED_DIR = FIXTURES / "expected"
SYNTHETIC_DIR = FIXTURES / "synthetic"

# Widget types whose requests the converter compiles. For any other type it reports
# UNSUPPORTED_WIDGET on the type and never looks at the requests.
REQUEST_WIDGET_TYPES = {"timeseries", "query_value"}

# --------------------------------------------------------------------------- loading

_TOKEN = re.compile(r"\.?([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]")


def resolve(document: Any, source_path: str) -> Any:
    """Resolve 'widgets[1].definition.requests[0]' inside a parsed JSON document."""
    node = document
    pos = 0
    while pos < len(source_path):
        m = _TOKEN.match(source_path, pos)
        if not m:
            raise ValueError(f"bad source path {source_path!r} at {pos}")
        node = node[m.group(1)] if m.group(1) is not None else node[int(m.group(2))]
        pos = m.end()
    return node


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def source_dashboards() -> list[Path]:
    return sorted(SOURCE_DIR.glob("*/dashboards/*.json"))


def expected_files() -> list[Path]:
    return sorted(EXPECTED_DIR.glob("*/*/expected.yaml"))


def widget_path_of(source_path: str) -> str:
    return source_path.split(".definition.requests")[0]


@dataclasses.dataclass(frozen=True)
class Case:
    """One expectation entry plus everything needed to run it."""

    case_id: str
    level: str  # "request" | "widget" | "dashboard"
    source_path: str
    expected: dict[str, Any]
    milestone: str
    reviewed: bool
    spec: dict[str, Any]  # the whole expected.yaml (mapping, project, fixture, ...)
    spec_dir: Path

    @property
    def source_dashboard(self) -> dict[str, Any]:
        doc: dict[str, Any] = load_json(ROOT / self.spec["source_fixture"])
        return doc

    @property
    def source_item(self) -> Any:
        doc = self.source_dashboard
        return doc if self.source_path == "" else resolve(doc, self.source_path)

    @property
    def mapping_path(self) -> Path:
        return ROOT / str(self.spec["mapping"])


def iter_cases(level: str) -> Iterator[Case]:
    # Only source_path / milestone / reviewed / expected are read. Other entry keys
    # (provenance, live_check, dataset, notes, ...) are fixture metadata and ignored on purpose.
    key = {"request": "requests", "widget": "widgets"}.get(level, "")
    for path in expected_files():
        spec = yaml.safe_load(path.read_text())
        dash_id = f"{path.parent.parent.name}/{path.parent.name}"
        if level == "dashboard":
            entry = spec.get("dashboard")
            if entry:
                yield Case(
                    dash_id,
                    level,
                    "",
                    entry["expected"],
                    entry["milestone"],
                    bool(entry["reviewed"]),
                    spec,
                    path.parent,
                )
            continue
        source: dict[str, Any] | None = None
        for entry in spec.get(key) or []:
            if level == "request":
                source = source or load_json(ROOT / spec["source_fixture"])
                widget = resolve(source, widget_path_of(entry["source_path"]))
                if widget.get("definition", {}).get("type") not in REQUEST_WIDGET_TYPES:
                    continue  # covered by the widget case (UNSUPPORTED_WIDGET)
            yield Case(
                f"{dash_id}/{entry['source_path']}",
                level,
                entry["source_path"],
                entry["expected"],
                entry["milestone"],
                bool(entry["reviewed"]),
                spec,
                path.parent,
            )


def case_params(level: str) -> list[Any]:
    params = []
    for case in iter_cases(level):
        marks = [getattr(pytest.mark, case.milestone)]
        if not case.reviewed:
            marks.append(pytest.mark.unreviewed)
        params.append(pytest.param(case, id=case.case_id, marks=marks))
    if not params:
        params.append(
            pytest.param(
                None,
                id=f"no-{level}-cases",
                marks=pytest.mark.skip(reason=f"no {level} expectations recorded yet"),
            )
        )
    return params


# --------------------------------------------------------------------------- converter adapter


def load_mapping(path: Path) -> DatadogMapping:
    """Parse a reviewed mapping file, or a directory of them as one table (`--mapping <dir>`);
    skip the case while the path does not exist yet."""
    if not path.exists():
        pytest.skip(f"mapping file {path.relative_to(ROOT)} does not exist yet")
    files = sorted(path.glob("*.json")) if path.is_dir() else [path]
    parsed = parse_mappings([(f.name, load_json(f)) for f in files])
    assert parsed.ok, getattr(parsed, "errors", None)
    return parsed.mapping


def compile_body(
    body: dict[str, Any], source_id: str, mapping: DatadogMapping, project: str
) -> DashboardCompilation:
    title = str(body.get("title") or "")
    asset = SourceAsset(source_id, "dashboard", title, body, body)
    return compile_dashboard(asset, assign_slugs([title])[0], mapping, CompileOptions(project))


_COMPILED: dict[Path, DashboardCompilation] = {}


def compile_case(case: Case, *, cached: bool = True) -> DashboardCompilation:
    """Compile the case's whole source dashboard (once per expected.yaml unless cached=False)."""
    if cached and case.spec_dir in _COMPILED:
        return _COMPILED[case.spec_dir]
    result = compile_body(
        case.source_dashboard,
        case.spec["source_fixture"],
        load_mapping(case.mapping_path),
        case.spec["project"],
    )
    if cached:
        _COMPILED[case.spec_dir] = result
    return result


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + ".")


def diagnostics_under(diagnostics: list[Diagnostic], prefix: str) -> list[Diagnostic]:
    return [d for d in diagnostics if under(d.source_path, prefix)]


@dataclasses.dataclass(frozen=True)
class Unit:
    """What the converter produced for one widget (or one request compiled as a widget)."""

    outcome: str  # "translated" | "blocked"
    panel: dict[str, Any] | None
    diagnostics: list[Diagnostic]


def widget_unit(comp: DashboardCompilation, path: str, panel_key: str) -> Unit:
    items = [it for it in comp.items if it.kind == "widget" and it.source_path == path]
    assert len(items) == 1, f"expected one widget item at {path}, got {len(items)}"
    panels: dict[str, Any] = dict(comp.dashboard["spec"]["panels"]) if comp.dashboard else {}
    panel = panels.get(panel_key) if items[0].outcome == "translated" else None
    return Unit(items[0].outcome, panel, diagnostics_under(comp.diagnostics, path))


def panel_key_of(path: str) -> str:
    """'widgets[3]' -> 'widget-3', 'widgets[3].definition.widgets[1]' -> 'widget-3-1'."""
    return "widget-" + "-".join(re.findall(r"\[(\d+)\]", path))


def request_unit(case: Case) -> Unit:
    """Compile one request as the only request of a widget of the same type and title.

    The converter has no public per-request entry point, so the request is put into a copy of
    its source dashboard as widgets[0]; the original widgets stay behind it so template variable
    promotion sees the same queries. Diagnostic paths are mapped back to the source request.
    """
    doc = case.source_dashboard
    widget_path = widget_path_of(case.source_path)
    definition = resolve(doc, widget_path)["definition"]
    wrapped = {
        "definition": {
            "type": definition["type"],
            "title": definition.get("title", ""),
            "requests": [case.source_item],
        }
    }
    body = {**doc, "widgets": [wrapped, *doc.get("widgets", [])]}
    comp = compile_body(
        body, case.spec["source_fixture"], load_mapping(case.mapping_path), case.spec["project"]
    )
    unit = widget_unit(comp, "widgets[0]", "widget-0")
    remapped = []
    for d in unit.diagnostics:
        path = d.source_path
        for old, new in (
            ("widgets[0].definition.requests[0]", case.source_path),
            ("widgets[0]", widget_path),
        ):
            if under(path, old):
                path = new + path[len(old) :]
                break
        remapped.append(dataclasses.replace(d, source_path=path))
    return Unit(unit.outcome, unit.panel, remapped)


def panel_queries(panel: dict[str, Any]) -> list[str]:
    return [q["spec"]["plugin"]["spec"]["query"] for q in panel["spec"]["queries"]]


def comparison(case: Case, unit: Unit) -> dict[str, Any]:
    """Expected vs actual of one request case, for the HTML report (tests/report_html.py)."""
    expected = case.expected
    exp_promql = list(expected.get("promql") or [])
    act_promql = panel_queries(unit.panel) if unit.panel else []
    act_errors, act_warnings = codes(unit.diagnostics, "error"), codes(unit.diagnostics, "warning")
    exp_errors, exp_warnings = set(expected.get("errors", [])), set(expected.get("warnings", []))
    mismatch = []
    if unit.outcome != expected["outcome"]:
        mismatch.append("outcome")
    if canonical_list(act_promql) != canonical_list(exp_promql):
        mismatch.append("promql")
    if act_errors != exp_errors or (
        expected["outcome"] == "translated" and act_warnings != exp_warnings
    ):
        mismatch.append("codes")

    def side(outcome: str, promql: list[str], errors: set[str], warnings: set[str]) -> Any:
        return {
            "outcome": outcome,
            "promql": promql,
            "canonical": canonical_list(promql),
            "errors": sorted(errors),
            "warnings": sorted(warnings),
        }

    return {
        "case_id": case.case_id,
        "reviewed": case.reviewed,
        "source": case.source_item,
        "expected": side(expected["outcome"], exp_promql, exp_errors, exp_warnings),
        "actual": side(unit.outcome, act_promql, act_errors, act_warnings),
        "mismatch": mismatch,
    }


# --------------------------------------------------------------------------- result helpers


def as_plain(obj: Any) -> Any:
    """Convert dataclass results to plain dicts/lists so tests don't depend on classes."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: as_plain(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: as_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [as_plain(v) for v in obj]
    return obj


def canonical_json(obj: Any) -> str:
    return json.dumps(as_plain(obj), sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def codes(diagnostics: list[Diagnostic], severity: str) -> set[str]:
    return {d.code for d in diagnostics if d.severity == severity}


def assert_codes(unit: Unit, expected: dict[str, Any]) -> None:
    """Error codes always match as a set; warning codes too for translated units.

    Sets, not lists: the converter reports a code once per offending query, the expectation
    once per request, so only which codes appear is compared, not how often."""
    assert codes(unit.diagnostics, "error") == set(expected.get("errors", []))
    if expected["outcome"] == "translated":
        assert codes(unit.diagnostics, "warning") == set(expected.get("warnings", []))


# --------------------------------------------------------------------------- PromQL comparison

# Grafana/Perses range variables are replaced by distinct durations so the parser accepts them
# and `[$__rate_interval]` never compares equal to `[5m]` or `[$__range]`.
_RANGE_VARS = {"$__rate_interval": "7771s", "$__interval": "7772s", "$__range": "7773s"}
_RANGE_VAR = re.compile(r"\$__(rate_interval|interval|range)\b")


def canonical_promql(query: str) -> str:
    """Normalize PromQL so semantically identical renderings compare equal.

    Ignores whitespace, redundant parentheses, matcher order, label order in
    by/without, and operand order of `+` / `*` without vector-matching modifiers.
    Does NOT treat different metrics, functions, matchers, aggregations or ranges as equal.
    """
    import promql_parser

    expr = promql_parser.parse(_RANGE_VAR.sub(lambda m: _RANGE_VARS[m.group(0)], query))
    return _canon(expr)


def _canon(node: Any) -> str:
    kind = type(node).__name__
    if kind == "ParenExpr":
        return _canon(node.expr)
    if kind == "BinaryExpr":
        lhs, rhs, op = _canon(node.lhs), _canon(node.rhs), str(node.op)
        mod = str(node.modifier) if node.modifier else ""
        if op in ("+", "*") and not mod:
            lhs, rhs = sorted([lhs, rhs])
        return f"({lhs} {op}{' ' + mod if mod else ''} {rhs})"
    if kind == "AggregateExpr":
        mod = ""
        if node.modifier is not None:
            word = "by" if "By" in str(node.modifier.type) else "without"
            mod = f" {word} ({', '.join(sorted(node.modifier.labels))})"
        param = f"{_canon(node.param)}, " if node.param is not None else ""
        return f"{node.op}{mod}({param}{_canon(node.expr)})"
    if kind == "Call":
        return f"{node.func.name}({', '.join(_canon(a) for a in node.args)})"
    if kind == "NumberLiteral":
        return repr(float(node.val))
    if kind == "UnaryExpr":
        return f"(-{_canon(node.expr)})"
    prettified: str = node.prettify()  # selectors (matchers already sorted), strings, subqueries
    return prettified


def canonical_list(queries: list[str]) -> list[str]:
    return [canonical_promql(q) for q in queries]


def leaf_widget_paths(dashboard: dict[str, Any]) -> list[str]:
    """Source paths of every top-level non-group widget and every group child, in order."""
    paths: list[str] = []
    for i, widget in enumerate(dashboard.get("widgets", [])):
        definition = widget.get("definition", {})
        if definition.get("type") == "group":
            paths.extend(
                f"widgets[{i}].definition.widgets[{j}]"
                for j in range(len(definition.get("widgets", [])))
            )
        else:
            paths.append(f"widgets[{i}]")
    return paths
