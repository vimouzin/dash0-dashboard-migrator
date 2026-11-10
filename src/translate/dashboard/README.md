# translate/dashboard

Task **T5** · scope `src/translate/dashboard/**` · IR `Dashboard` → Dash0 `DashboardDefinition` (Perses), plus a `PanelResult` per widget for the report (T8).

`toPerses(dashboard, translate)` → `{dashboard, panels, status, findings}`. `translate` is T4's `translateQuery`, wrapped by the caller:
```ts
const translate: TranslateExpr = (e, o) => translateQuery(e, { metric: metricLookup(m), tag: tagLookup(m), variables: o.variables, where: o.where }, o.env);
```

| Datadog widget (IR kind) | Dash0 panel | Notes |
|---|---|---|
| timeseries | `TimeSeriesChart` | all-bars → `visual.display: bar`; area/mixed styles → `panel.style` (bounded) |
| query_value (stat) | `StatChart` | `calculation` from the aggregator: avg→mean, sum, min, max, last→last-number. Precision → `format.decimalPlaces`. Conditional colours are reported |
| toplist, query_table | `TimeSeriesTable` | bounded: Dash0 has no bar list, and the top-N limit and ranking aren't applied |
| note | `Markdown` | text kept |
| log_stream / list_stream | Markdown placeholder | `logs.not_translated` (log search → `dash0.logs` / LogTable is plan 01 T12) |
| anything else | Markdown placeholder | keeps the original queries and points at the report item |
| query-backed widget with no translatable query | Markdown placeholder | never an empty chart |

- **Queries.** Formulas are parsed and their `queryN` refs resolved through `env`. Legacy `q` may hold several comma-separated expressions. Non-metric data sources and parse errors fail closed with findings. T4's older finding shape is converted to CONTRACT-001.
- **Variables** are pinned to their defaults (D-21): there's no Perses variable, and each gets a `variable.pinned` exact-under finding.
- **Layout.** Datadog 12 columns → 24 (x and width × 2), height × `ROW_SCALE` (3, a heuristic to tune against a Dash0 golden export). Groups become titled Grid sections; runs of top-level widgets become untitled sections; missing layouts auto-flow.

Measured on the Redis overview with T4 (PR #3 at 1b5f23a) and the redisdb mapping:
- 36/36 widgets accounted for;
- preflight clean;
- 24 PromQL queries, all valid lezer-promql;
- panels: 7 exact, 8 exact-under, 15 bounded, 6 manual.
