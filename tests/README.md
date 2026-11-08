# Unit tests (pytest)

Oracle-backed suite for the deterministic Datadog → Perses (Dash0 PromQL) converter. The
converter is PR #85's `migrator` package, which is the source of truth for the package layout,
stack and public API; this suite tests it only through that API. The parser cases run by default
and pass; a case from `fixtures/expected/` turns green once a human has reviewed it and the
converter produces exactly the expected outcome.

No LLM takes part in conversion (`AGENTS.md`). Agent0 was used **only at development time** to
*propose* expected outcomes. Its answers are frozen as provenance, never read by a test, and every
expectation must be confirmed by a human before it counts (see "Review").

## Run

```bash
uv sync                                  # once: uv-managed Python 3.13 + locked deps (uv.lock)
uv run migrator check                    # project DoD: ruff + mypy + pytest (unreviewed cases skipped)
uv run pytest --include-unreviewed       # also run oracle-proposed, not yet reviewed cases
uv run pytest -m p0                      # only the MVP cases (also: -m p1, -m p2)
uv run pytest tests/unit/requests        # only request/widget/parser tests
uv run pytest tests/scripts              # fixture tooling (oracle runner, build_expected)
```

Each run that executes `test_request_translation` writes `out/test-report/index.html` (git-ignored;
the `file://` URL is printed in the summary): per request case the expected and actual outcome,
PromQL and diagnostic codes side by side, the canonical PromQL diff and the Datadog request, failures
first. `conftest.py` collects the records (`record_comparison` fixture), `report_html.py` renders them.

Tests are offline: an autouse fixture in `conftest.py` replaces `socket.socket` and
`socket.create_connection`, so any network access raises. A case whose mapping path
(`mapping` in `expected.yaml`) does not exist is skipped.

## Layout

| Path | Level | Cases come from |
|---|---|---|
| `unit/requests/test_parse_query.py` | one Datadog metric query string | `fixtures/synthetic/queries.yaml` (hand-written from plan 02) + every metric query in the pinned dashboards (totality corpus) |
| `unit/requests/test_request.py` | one request (`queries` + `formulas`) → PromQL or a blocking diagnostic | `fixtures/expected/*/*/expected.yaml` → `requests:` |
| `unit/requests/test_widget.py` | one widget → one Perses panel, or blocked | `expected.yaml` → `widgets:` |
| `unit/dashboards/test_dashboards.py` | a whole dashboard → Perses dashboard + per-widget outcomes | `expected.yaml` → `dashboard:` |
| `support.py` | shared helpers: case loading, the converter adapter, PromQL canonicalization, diagnostic codes | |
| `conftest.py` | p0/p1/p2/unreviewed markers, `--include-unreviewed` option, no-network guard | |
| `scripts/` | fixture tooling: `build_expected.py` rules, oracle runner | |

## Interfaces under test (PR #85)

The tests call only the converter's public API. Results are dataclasses and TypedDicts.

```python
from migrator.source.datadog.parse_query import parse_metric_query
parse_metric_query(text) -> ParseOk(ok=True, query: MetricQuery) | ParseError(ok=False, code, offset, message)
#   MetricQuery: aggregator, metric, filters[{kind, key, value} | {kind, name}], group_by, functions[{name, args}]
#   A failed parse has code UNSUPPORTED_QUERY_SYNTAX or UNSUPPORTED_QUERY_FUNCTION and 0 <= offset <= len(text).

from migrator.source.datadog.mapping import parse_mapping   # mappings/datadog/<name>.json -> MappingOk | MappingInvalid
from migrator.source.datadog.dashboard import compile_dashboard
compile_dashboard(SourceAsset, slug, DatadogMapping, CompileOptions(project)) -> DashboardCompilation
#   dashboard: PersesDashboard | None (None when blocked)
#   items: [ItemResult(kind="dashboard"), *ItemResult(kind="widget") per leaf widget, source order]
#   diagnostics: [Diagnostic(code, severity, source_id, source_path, message, suggested_action, source_text)]
#   panels are keyed "widget-<i>" (group child "widget-<i>-<j>")
```

The converter has no per-request or per-widget entry point, so `support.py` derives them:

- **widget** = the widget's `ItemResult`, its panel, and the diagnostics at or under its source path,
  from one compile of the whole source dashboard;
- **request** = the request compiled as the only request of a widget with the same type and title,
  placed as `widgets[0]` in front of the source dashboard's widgets (so template variable promotion
  sees the same queries); diagnostic paths are mapped back to the source request. Only requests of
  `timeseries` and `query_value` widgets are cases: for other types the converter reports
  `UNSUPPORTED_WIDGET` on the type and never reads the requests.

What the tests assert:

- **Request:** outcome; for `translated`, the panel's PromQL list equals the expected list after
  canonicalization (`support.canonical_promql`: ignores whitespace, redundant parentheses, matcher
  order, `by`/`without` label order and `+`/`*` operand order; different metrics, functions,
  matchers, aggregations or range variables never compare equal); a blocked request emits no panel;
  the set of error codes matches, and for translated requests the set of warning codes (sets
  because the converter reports a code once per offending query); every diagnostic lies inside
  the request.
- **Widget:** all-or-nothing (never drop a series); outcome, error/warning code sets, panel key,
  title, Perses panel plugin (`TimeSeriesChart`, `StatChart`, `Markdown`), only `TimeSeriesQuery`
  queries, PromQL as above.
- **Dashboard:** dashboard outcome and the ordered per-widget outcomes; exactly the translated
  widgets become panels with their PromQL; structure invariants (kind, project, slug name, no
  `dash0Extensions` id, panel keys, every layout item references a panel, grid width ≤ 24);
  identical dashboard, items and diagnostics on a second compile (determinism).
- **Parser:** spec cases (subset match); every real corpus query parses or yields exactly one of
  the two parse codes, never a prefix match; deterministic.

## Case format (`fixtures/expected/<service>/<dashboard>/expected.yaml`)

Generated by `scripts/build_expected.py`; do not edit by hand. Inputs are **not** duplicated:
each case names a `source_path` that is resolved inside the pinned source dashboard
(`source_fixture`).

```yaml
source_fixture: fixtures/datadog/integrations-core/nginx/dashboards/NGINX-Metrics_dashboard.json
mapping: mappings/datadog                # reviewed mapping files the expectation assumes (end state)
project: datadog-migration
requests:
- source_path: widgets[0].definition.requests[0]
  milestone: p2                           # p0 MVP (plans 01-04), p1 plan 05, p2 plan 08 services
  reviewed: false                         # false -> skipped unless --include-unreviewed
  provenance: {kind: agent0 | human, ref: <file>}
  live_check: {agent0: <did Agent0's PromQL return data in Dash0>}
  dataset:                                # optional fixture metadata, never compared to converter output
    available: false                      # OTel metric is defined but absent from the Dash0 `default` dataset
    missing_metrics: [zookeeper.connection.active]
    otel_sources: [collector-contrib/receiver/zookeeperreceiver/metadata.yaml]
  expected:
    outcome: translated | blocked
    promql: [...]                         # translated only
    errors: [...]                         # e.g. MISSING_METRIC_MAPPING, UNSUPPORTED_FORMULA,
                                          #      UNSUPPORTED_QUERY_FUNCTION, UNSUPPORTED_QUERY_SYNTAX, UNSUPPORTED_DATA_SOURCE
    warnings: [...]                       # e.g. TEMPLATE_VARIABLE_DROPPED, DEFAULT_AGGREGATOR_APPLIED (compared as a set)
  notes: [...]                            # optional, e.g. rule overlay applied
widgets:   [{source_path, type, milestone, reviewed, expected: {outcome, panel_key, title, panel_plugin, promql, errors, warnings}}]
dashboard: {milestone, reviewed, expected: {outcome, widgets: [{source_path, outcome, panel_key, promql}]}}
```

Entries may carry extra top-level metadata keys (`provenance`, `live_check`, `dataset`, `notes`);
tests read only `source_path`, `milestone`, `reviewed` and `expected`, and ignore everything else.
A request whose OTel metrics exist in the pinned OTel catalog (`fixtures/otel/catalog.yaml`) but are
missing from the Dash0 dataset snapshot (`fixtures/oracle/dash0_default_metrics.yaml`) stays
`translated` and gets the `dataset` block; only metrics found in neither are `blocked` with
`MISSING_METRIC_MAPPING`.

`mapping` names the converter's mapping files: `mappings/datadog`, every `*.json` in it merged into
one table, as `--mapping mappings/datadog` does. The expectations assume those files in their
reviewed end state, so a translated case also expects no `UNREVIEWED_MAPPING` warning.

Widget and dashboard expectations are derived from the request expectations: a widget is
translated only if its type is supported (`timeseries`, `query_value`, `note`), it has no blocking
option (`time`), and all its requests are translated; otherwise it is blocked with
`UNSUPPORTED_WIDGET`, the request read errors (data source, formula), or the requests' error codes.

## Provenance pipeline (development time only)

```text
scripts/extract_cases.py                 pinned dashboards -> fixtures/cases/<svc>/<id>.yaml   (deterministic)
scripts/build_otel_catalog.py            pinned OTel definitions (fixtures/otel/, NOTICE.md) -> fixtures/otel/catalog.yaml (deterministic)
scripts/render_oracle_prompt.py <svc>/<id>   fixtures/oracle/PROMPT.md template + OTel candidates (catalog.yaml, dataset snapshot) -> fixtures/oracle/agent0/<svc>/<id>/prompt.md
  ask Agent0 (dash0 MCP runTask, dataset default) with prompt.md verbatim
  save the YAML answer verbatim         -> fixtures/oracle/agent0/<svc>/<id>/answer.yaml  (header: date, thread link, any quoting fix)
scripts/build_expected.py <svc>/<id>     case + answer + rules overlay + overrides.yaml -> fixtures/expected/<svc>/<id>/expected.yaml
```

`build_expected.py` adds deterministic project rules on top of Agent0's proposal: requests with no
metrics query, and requests that use **any** Datadog function in a query or formula (`.rollup()`,
`.as_count()`, `.weighted()`, `top()`, `per_second()`, `diff()`, ...), are forced to `blocked`, whatever
Agent0 proposed (plans 02/03/05). `ALLOWED_FUNCTIONS` in the script is empty; a function may only be
added through its own plan task with an exact test. The converter's mapping-independent checks
also override Agent0, in PR #85's order: request read errors (non-metric data source, a formula with
a function or a reference to a non-metric query) first; then for every displayed query a wrapping
function, a syntax error (`count:`, `p95:`, `100*(...)`, `-sum:...`), a trailing function, or an
undefined or non-`*` template variable. A query without a space aggregator compiles with Datadog's
default `avg` and expects `DEFAULT_AGGREGATOR_APPLIED`. Error codes come from these rules, not
Agent0's prose; a block that no rule explains gets `MISSING_METRIC_MAPPING` plus a note that the
code is a proposal (the real code depends on the mapping). `TEMPLATE_VARIABLE_DROPPED` is expected for unprefixed `*` variables only; prefixed
ones are promoted to a Perses ListVariable (matcher `<label>=~"^($name)$"`). Every OTel metric in
a translated request is checked against the dataset snapshot and the catalog: present in the dataset →
nothing to note; only in the catalog → stays `translated` with a `dataset` block and a note (no live check
possible); in neither → `blocked` with `MISSING_METRIC_MAPPING`. Other Agent0 choices
(scaling constants, derived metrics, grain) pass through and need a human decision. The oracle prompt (`fixtures/oracle/PROMPT.md`) states the same rules, but the overlay is
what enforces them.

Agent0's live checks ran against the Dash0 `default` dataset, where receiver data only exists
2026-11-07 ~14:05–15:21 UTC.

## Review (`overrides.yaml`)

Unreviewed expectations are proposals. A human records decisions in
`fixtures/expected/<svc>/<id>/overrides.yaml`, keyed by request `source_path`, or by widget
`source_path` for a widget without requests (note, image, event stream, ...):

```yaml
'widgets[0].definition.requests[0]':
  reviewed: true                         # accept as is
'widgets[3].definition.requests[0]':
  reviewed: true
  expected:                              # correct the outcome / PromQL / codes (merged into expected)
    outcome: blocked
    errors: [UNSUPPORTED_FORMULA]
  notes: ['per_minute() needs a reviewed rate rule; blocked for now']
```

Then re-run `uv run scripts/build_expected.py <svc>/<id>`. Overridden entries get
`provenance: {kind: human, ref: .../overrides.yaml}`. A widget counts as reviewed when all its
requests are (a widget without requests through its own override); a dashboard when all its
widgets are.
