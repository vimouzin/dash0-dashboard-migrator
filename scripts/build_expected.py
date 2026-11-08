"""Build fixtures/expected/<service>/<dashboard_id>/expected.yaml (development-time only).

Inputs, all in the repo:
  fixtures/cases/<key>.yaml                       deterministic case inventory
  fixtures/oracle/agent0/<key>/answer.yaml        Agent0 proposal (outcome + PromQL per request)
  fixtures/expected/<key>/overrides.yaml          human decisions (optional; wins over everything)

Agent0 proposes WHAT a request becomes (metric, matchers, aggregation). This script
adds the project's deterministic rules on top:
  * blocking rules that Agent0 cannot lift: no metrics query, any Datadog function
    (see ALLOWED_FUNCTIONS), and an OTel metric that exists neither in the `default` dataset
    snapshot (fixtures/oracle/dash0_default_metrics.yaml) nor in the pinned OTel catalog
    (fixtures/otel/catalog.yaml),
  * a `dataset` block for translations whose OTel metrics are defined but missing from the dataset
    (they stay translated; only the live check is impossible),
  * the converter's mapping-independent checks (PR #85 is the source of truth): request read
    errors (data source, formula syntax) first, then per displayed query a function or an
    unsupported template variable (a missing space aggregator means Datadog's default, avg),
  * diagnostic codes derived from the source text (not from Agent0's prose); a block that no rule
    explains gets MISSING_METRIC_MAPPING with a note that the code is a proposal,
  * warnings: TEMPLATE_VARIABLE_DROPPED for unprefixed `*` variables (prefixed ones are promoted),
    DEFAULT_AGGREGATOR_APPLIED for a query without a space aggregator,
  * widget and dashboard expectations derived from the request expectations,
  * milestones.
Nothing here is ever called by the converter or by the tests.

Usage: uv run scripts/build_expected.py <service>/<dashboard_id> [...]
"""

from __future__ import annotations

import functools
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

# Widget types the end-state converter renders (plans 04 + 05) and their Perses panel plugin.
PANEL_PLUGIN = {"timeseries": "TimeSeriesChart", "query_value": "StatChart", "note": "Markdown"}
# Every Datadog function blocks its request: wrapping ones (`top(`, `per_second(`) in plan 02,
# trailing ones (`.rollup()`, `.as_count()`) in plan 03 check 1, functions in formulas in plan 05
# Task 5. A function may only move into this allowlist through its own issue with an exact test,
# whatever Agent0 proposes. `abs` (#119) converts in formulas only (formula.py); in a query string
# it still blocks through WRAPPING_FN. The timeshift functions convert in formulas only, too
# (formula.py, PromQL `offset`).
ALLOWED_FUNCTIONS: frozenset[str] = frozenset(
    {"abs", "hour_before", "day_before", "week_before", "month_before", "timeshift"}
)
AGGREGATORS = {"avg", "sum", "min", "max"}
AGGREGATOR = re.compile(r"^(avg|sum|min|max):")
LEADING_WORD = re.compile(r"\s*([A-Za-z_][A-Za-z0-9_]*):")
# Widget definition keys the converter rejects although the widget type is supported (PR #85
# option allowlist, dashboard._DEF_KEYS). Only keys that occur in the pinned dashboards are listed.
BLOCKING_WIDGET_KEYS = {"time"}
WRAPPING_FN = re.compile(r"^\s*([a-z_]+)\(")
TRAILING_FN = re.compile(r"\.([a-z_]+)\(")
FORMULA_FN = re.compile(r"\b([a-z_]+)\(")
VARIABLE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")
IDENTIFIER = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\b")
UNANCHORED_VARIABLE = re.compile(r'=~"\$([A-Za-z_][A-Za-z0-9_]*)"')
METRIC_SELECTOR = re.compile(r'otel_metric_name="([^"]+)"(?:\s*,\s*otel_metric_type="([^"]+)")?')

P0_CASES = {("postgres/postgresql_dashboard", "widgets[1]")}


def milestone(key: str, widget_path: str) -> str:
    if (key, widget_path) in P0_CASES:
        return "p0"
    if key == "postgres/postgresql_dashboard":
        return "p1"
    return "p2"


def widget_path_of(source_path: str) -> str:
    return source_path.split(".definition.requests")[0]


def resolve(doc, path: str):
    node = doc
    for name, index in re.findall(r"\.?([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]", path):
        node = node[name] if name else node[int(index)]
    return node


def read_errors(request: dict) -> list[str]:
    """Request-level errors the converter (PR #85, dashboard._read_request) reports before it
    compiles any query. When one is present, no query of the widget is compiled."""
    queries = request["queries"]
    if not queries:
        return ["UNSUPPORTED_WIDGET"]  # neither `q` nor `queries`
    codes = set()
    other = {q.get("name") for q in queries if q.get("data_source") not in (None, "metrics")}
    if other:
        codes.add("UNSUPPORTED_DATA_SOURCE")
    for f in request["formulas"]:
        # A function, or a reference to a non-metric query (the converter skips those queries).
        if f and (set(FORMULA_FN.findall(f)) - ALLOWED_FUNCTIONS or other & set(IDENTIFIER.findall(f))):
            codes.add("UNSUPPORTED_FORMULA")
    return sorted(codes)


def displayed_queries(request: dict) -> list[dict]:
    """Queries the converter compiles: all of them without formulas, else only those referenced."""
    metric = [q for q in request["queries"] if q.get("data_source") in (None, "metrics")]
    formulas = [f for f in request["formulas"] if f]
    if not formulas:
        return metric
    names = {n for f in formulas for n in IDENTIFIER.findall(f)}
    return [q for q in metric if q.get("name") in names]


def query_error(text: str, variables: dict[str, dict]) -> str | None:
    """First mapping-independent blocking check that fails, in PR #85's order: parse_metric_query
    (wrapping function, then syntax), then compile_metric_query (function, template variables)."""
    if WRAPPING_FN.match(text):
        return "UNSUPPORTED_QUERY_FUNCTION"
    prefix = LEADING_WORD.match(text)
    if not re.match(r"\s*[A-Za-z_]", text) or (prefix and prefix.group(1) not in AGGREGATORS):
        return "UNSUPPORTED_QUERY_SYNTAX"  # e.g. `100*(...)`, `-sum:...`, `count:`, `p95:`
    if TRAILING_FN.search(text):
        return "UNSUPPORTED_QUERY_FUNCTION"
    for name in VARIABLE.findall(text.split("}")[0]):
        var = variables.get(name)
        if var is None or var.get("default") not in (None, "*"):
            return "UNSUPPORTED_TEMPLATE_VARIABLE"
    return None


def rule_errors(request: dict, variables: dict[str, dict]) -> list[str]:
    """Error codes the converter must report for this request, derived from the source text only
    (no mapping, no Agent0). Empty means only a mapping lookup can block the request."""
    codes = read_errors(request)
    if codes:
        return codes
    return sorted({c for q in displayed_queries(request) if (c := query_error(q["query"] or "", variables))})


def blocked_functions(request: dict) -> list[str]:
    """Datadog functions in the request's queries or formulas that are not allowlisted, sorted."""
    texts = [q["query"] or "" for q in request["queries"]] + [f or "" for f in request["formulas"]]
    return sorted({fn for t in texts for fn in FORMULA_FN.findall(t)} - ALLOWED_FUNCTIONS)


@functools.cache
def otel_catalog() -> dict:
    """Every metric OpenTelemetry defines in the pinned sources (scripts/build_otel_catalog.py)."""
    return yaml.safe_load((ROOT / "fixtures" / "otel" / "catalog.yaml").read_text())


@functools.cache
def dataset_metrics() -> dict:
    """Metric names present in the Dash0 `default` dataset snapshot -> types seen."""
    return yaml.safe_load((ROOT / "fixtures" / "oracle" / "dash0_default_metrics.yaml").read_text())["metrics"]


def metric_availability(promql: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Split the OTel metrics used in `promql` into (not defined anywhere, defined but not in the
    dataset, type mismatches against the catalog for metrics outside the dataset)."""
    catalog, present = otel_catalog(), dataset_metrics()
    used = sorted({(m, t) for q in promql for m, t in METRIC_SELECTOR.findall(q)})
    names = sorted({m for m, _ in used})
    undefined = [m for m in names if m not in present and m not in catalog]
    absent = [m for m in names if m not in present and m in catalog]
    mismatched = sorted(
        f"{m} is {catalog[m]['type']} in {catalog[m]['sources'][0]}, PromQL selects {t}"
        for m, t in used
        if m in absent and t and t != catalog[m]["type"]
    )
    return undefined, absent, mismatched


def anchor_variable_matchers(promql: list[str], variables: dict[str, dict]) -> list[str]:
    """Render promoted-variable matchers like the converter (PR #85): `=~"^($name)$"`, because
    Dash0 does not anchor `=~`. PROMPT.md asks Agent0 for the unanchored `=~"$name"`."""

    def anchor(m: re.Match[str]) -> str:
        return f'=~"^(${m.group(1)})$"' if m.group(1) in variables else m.group(0)

    return [UNANCHORED_VARIABLE.sub(anchor, q) for q in promql]


def rule_warnings(request: dict, variables: dict[str, dict]) -> list[str]:
    """Warning codes (as a set) for a translated request. PR #85 drops an unprefixed `*` variable
    with TEMPLATE_VARIABLE_DROPPED and promotes a prefixed one to a Perses ListVariable (matcher
    `<label>=~"^($name)$"`, no warning), assuming the reviewed mapping maps the prefix tag. A
    query without a space aggregator compiles with avg and DEFAULT_AGGREGATOR_APPLIED."""
    warnings = set()
    for q in displayed_queries(request):
        if not AGGREGATOR.match(q["query"] or ""):
            warnings.add("DEFAULT_AGGREGATOR_APPLIED")
        for name in VARIABLE.findall((q["query"] or "").split("}")[0]):
            var = variables.get(name)
            if var is not None and var.get("prefix") is None and var.get("default") in (None, "*"):
                warnings.add("TEMPLATE_VARIABLE_DROPPED")
    return sorted(warnings)


def build(key: str) -> dict:
    case = yaml.safe_load((ROOT / "fixtures" / "cases" / f"{key}.yaml").read_text())
    answer_path = ROOT / "fixtures" / "oracle" / "agent0" / key / "answer.yaml"
    answers = {a["source_path"]: a for a in yaml.safe_load(answer_path.read_text())}
    overrides_path = ROOT / "fixtures" / "expected" / key / "overrides.yaml"
    overrides = yaml.safe_load(overrides_path.read_text()) if overrides_path.exists() else {}
    overrides = overrides or {}
    source = json.loads((ROOT / case["source"]["fixture"]).read_text())
    variables = {v["name"]: v for v in case["template_variables"]}
    case_requests = {r["source_path"]: r for r in case["requests"]}
    service = case["service"]

    requests_out = []
    by_widget: dict[str, list[dict]] = {}
    for req in case["requests"]:
        sp = req["source_path"]
        agent = answers.get(sp)
        entry = {
            "source_path": sp,
            "milestone": milestone(key, widget_path_of(sp)),
            "reviewed": False,
            "provenance": {"kind": "agent0", "ref": str(answer_path.relative_to(ROOT))},
            "live_check": {"agent0": (agent or {}).get("live_check", "not run")},
        }
        notes = []
        if agent is None:
            outcome, promql = "blocked", []
            notes.append("no Agent0 answer for this request")
        else:
            outcome, promql = agent["outcome"], list(agent.get("promql") or [])
        functions = blocked_functions(req)
        rules = rule_errors(req, variables)
        if outcome == "translated" and not req["queries"]:
            notes.append("rule overlay: Agent0 translated a request without a metrics query")
            outcome, promql = "blocked", []
        elif outcome == "translated" and functions:
            notes.append(
                f"rule overlay: Datadog function(s) {', '.join(functions)} block the request (plans 02/03/05);"
                f" Agent0's translation is discarded: {' ; '.join(promql)}"
            )
            outcome, promql = "blocked", []
        elif outcome == "translated" and rules:
            notes.append(
                f"rule overlay: {', '.join(rules)} blocks the request (converter, PR #85);"
                f" Agent0's translation is discarded: {' ; '.join(promql)}"
            )
            outcome, promql = "blocked", []
        elif outcome == "translated":
            undefined, absent, mismatched = metric_availability(promql)
            if undefined:
                notes.append(
                    f"rule overlay: metric(s) {', '.join(undefined)} exist neither in dataset `default` nor in the"
                    f" pinned OTel catalog (fixtures/otel/catalog.yaml); Agent0's translation is discarded: {' ; '.join(promql)}"
                )
                outcome, promql = "blocked", []
            elif absent:
                entry["dataset"] = {
                    "available": False,
                    "missing_metrics": absent,
                    "otel_sources": sorted({s for m in absent for s in otel_catalog()[m]["sources"]}),
                }
                notes.append(
                    f"OTel metric(s) {', '.join(absent)} are defined by OpenTelemetry but not present in dataset"
                    " `default`; the translation stands, but it cannot be live-checked"
                )
                notes.extend(f"type mismatch: {m}" for m in mismatched)
        expected = {"outcome": outcome}
        if outcome == "translated":
            expected["promql"] = anchor_variable_matchers(promql, variables)
            expected["errors"] = []
            expected["warnings"] = rule_warnings(req, variables)
        else:
            expected["errors"] = rules or ["MISSING_METRIC_MAPPING"]
            if not rules:
                notes.append(
                    "error code is a proposal: Agent0 blocked the request and no source-text rule applies;"
                    " the converter's code depends on the reviewed mapping"
                )
        entry["expected"] = expected
        if notes:
            entry["notes"] = notes
        override = overrides.get(sp)
        if override:
            entry.update({k: v for k, v in override.items() if k != "expected"})
            entry["expected"].update(override.get("expected", {}))
            entry["provenance"] = {"kind": "human", "ref": str(overrides_path.relative_to(ROOT))}
        requests_out.append(entry)
        by_widget.setdefault(widget_path_of(sp), []).append(entry)

    widgets_out = []
    for i, widget in enumerate(source.get("widgets", [])):
        definition = widget.get("definition", {})
        children = (
            [(f"widgets[{i}].definition.widgets[{j}]", f"widget-{i}-{j}", c) for j, c in enumerate(definition.get("widgets", []))]
            if definition.get("type") == "group"
            else [(f"widgets[{i}]", f"widget-{i}", widget)]
        )
        for path, panel_key, w in children:
            wdef = w.get("definition", {})
            wtype = wdef.get("type")
            reqs = by_widget.get(path, [])
            supported = wtype in PANEL_PLUGIN
            # An empty `time: {}` carries no override; the converter ignores it.
            keys = {k for k in wdef if not (k == "time" and wdef[k] == {})}
            bad_keys = sorted(BLOCKING_WIDGET_KEYS & keys) if supported else []
            translated = supported and not bad_keys and all(r["expected"]["outcome"] == "translated" for r in reqs)
            if wtype == "note":
                translated = True
            expected = {"outcome": "translated" if translated else "blocked"}
            if translated:
                expected.update(
                    panel_key=panel_key,
                    title=wdef.get("title", ""),
                    panel_plugin=PANEL_PLUGIN[wtype],
                    promql=[q for r in reqs for q in r["expected"]["promql"]],
                    errors=[],
                    warnings=sorted({c for r in reqs for c in r["expected"].get("warnings", [])}),
                )
            elif not supported:
                expected["errors"] = ["UNSUPPORTED_WIDGET"]
            else:
                # A widget option or request read error stops the converter before any query of
                # the widget compiles.
                read = {c for r in reqs for c in read_errors(case_requests[r["source_path"]])}
                if bad_keys:
                    read.add("UNSUPPORTED_WIDGET")
                expected["errors"] = sorted(read or {c for r in reqs for c in r["expected"]["errors"]})
                if bad_keys and not wtype == "note":
                    expected["notes"] = [f"widget option(s) {', '.join(bad_keys)} block the widget (converter, PR #85)"]
            out = {
                "source_path": path,
                "type": wtype,
                "milestone": milestone(key, path),
                # A widget without requests (note, image, ...) is reviewed through its own override.
                "reviewed": all(r["reviewed"] for r in reqs) if reqs else False,
                "expected": expected,
            }
            override = overrides.get(path)
            if override:
                out.update({k: v for k, v in override.items() if k != "expected"})
                out["expected"].update(override.get("expected", {}))
                out["provenance"] = {"kind": "human", "ref": str(overrides_path.relative_to(ROOT))}
            widgets_out.append(out)

    n_translated = sum(w["expected"]["outcome"] == "translated" for w in widgets_out)
    dash_outcome = "blocked" if n_translated == 0 else ("translated" if n_translated == len(widgets_out) else "partial")
    dashboard = {
        "milestone": "p1" if service == "postgres" else "p2",
        "reviewed": all(w["reviewed"] for w in widgets_out),
        "expected": {
            "outcome": dash_outcome,
            "widgets": [
                {
                    "source_path": w["source_path"],
                    "outcome": w["expected"]["outcome"],
                    **({"panel_key": w["expected"]["panel_key"], "promql": w["expected"]["promql"]} if w["expected"]["outcome"] == "translated" else {}),
                }
                for w in widgets_out
            ],
        },
    }

    return {
        "source_fixture": case["source"]["fixture"],
        "mapping": "mappings/datadog",  # every mapping file, merged into one table (#123)
        "project": "datadog-migration",
        "requests": requests_out,
        "widgets": widgets_out,
        "dashboard": dashboard,
    }


HEADER = """\
# GENERATED by scripts/build_expected.py from Agent0's answer + project rules. Do not edit by hand:
# put human decisions (corrections, `reviewed: true`) in overrides.yaml next to this file, keyed
# by request source_path (or widget source_path for widgets without requests), then re-run.
# Expectations describe the END STATE with the complete, human-reviewed mapping files named below.
# `milestone` says when a case must turn green. Unreviewed cases are skipped by default.
"""


def write(key: str) -> tuple[Path, dict]:
    out = ROOT / "fixtures" / "expected" / key / "expected.yaml"
    out.parent.mkdir(parents=True, exist_ok=True)
    data = build(key)
    out.write_text(HEADER + yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=1000))
    return out, data


def main() -> int:
    for key in sys.argv[1:]:
        out, data = write(key)
        reqs = data["requests"]
        print(
            f"{out.relative_to(ROOT)}: {sum(r['expected']['outcome'] == 'translated' for r in reqs)}/{len(reqs)} requests translated, "
            f"dashboard {data['dashboard']['expected']['outcome']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
