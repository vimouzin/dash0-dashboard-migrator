# translate/query

Task **T4** · scope `src/translate/query/**`, `src/validate/**` · Datadog query AST (from `src/parse`) -> PromQL. Deterministic, no I/O, no LLM.

## API
```ts
translateQuery(expr, ctx?, env?)            // dashboard query or formula (env: query1 -> parsed query)
translateMonitor(monitorQuery, {critical, warning}?, ctx?)  // metric/query alert -> check-rule expression
validatePromQL(text)                        // src/validate/promql.ts, @prometheus-io/lezer-promql
```
Each call returns `{ status, promql, rules, assumptions, findings }`. `status` and `findings` are the CONTRACT-001 types from `src/ir` (`Finding {status, code, message, itemKind, itemId, ruleId?, assumptions?, original?}`). Monitors also return `thresholds {failed, degraded?}` and `negated`.
- `status` is the plan 03 claim: `exact | exact-under | bounded | manual`. It's the worst status among the rules applied.
- `promql` is `null` exactly when `status` is `manual`.
- `rules` lists the `ruleId`s applied. `assumptions` is the ledger for `exact-under`; ids and meanings are in `ASSUMPTIONS`.

`ctx` injects the lookups, so T1's `mappings/*.yaml` plugs in without changes here:
- `metric(ddName)`: `{otel, kind, ddKind?, labels?, status?}`. Use `metricLookup(mappings)`.
- `availability(ddName)`: use `metricAvailability(mappings, dd)`. `no_equivalent`, `derived` and `needs_transform` fail closed, so T4 never queries a metric that doesn't exist.
- `tag(ddTag)`: a label name. Use `tagLookup(mappings)`. Without an entry, dots become `_` and a `tag.unmapped` finding records the assumption.
- `variables`: template var name -> tag key, or `null` for free-form.
- `interval`: `"$__interval"` by default.

## Rules are data
`rules.ts` holds every rule: `ruleId -> {status, assumptions, description}`. `tests/translate/query.test.ts` asserts one exact PromQL string per rule, and fails if any rule in the table has no test.

Choices worth knowing:
- **Datadog order is kept:** time aggregation per series first, then space aggregation. That gives `avg by (h) (avg_over_time(x[$__interval]))`.
- **Regexes are anchored** (`^…$`), because Dash0 matches them unanchored. That includes template variables: `host_name=~"^($host)$"`.
- **`rate()`/`increase()` use `$__rate_interval`** on dashboards, so a short `$__interval` can't leave them with fewer than two samples.
- **Monitors use the subquery form** that the reference evaluator showed is exact (maths.md §5): `fn_over_time((Q on 1m buckets)[W:1m]) > $__threshold`.
- **`per_second`/`per_minute`/`per_hour`** have a rule only for sum/avg over a Datadog gauge that holds an OTel counter's running total: `60 * sum(rate(x[$__rate_interval]))` (bounded). **`diff(q)`** becomes `q - (q offset interval)`, the structural form of "each point minus the previous one" (exact-under alignment and no gaps).
- **`pXX:` on a distribution** (mapping `otelKind: histogram`, or `distribution` in metadata.csv) becomes `histogram_quantile(0.XX, sum by (le, g) (rate({otel_metric_name="<otel>", …}[w])))`, `bounded` with ε = w_b + g + 1%·x (maths.md §12, T11; property test `tests/semantics/histogram-quantile.test.ts`). `w` is `$__rate_interval` on dashboards and `1m` inside a monitor's subquery. No `_bucket` suffix: Dash0's own documented example queries the histogram under its OTel name (`A.histogram-buckets`, not yet probed live). Unknown kind, a gauge/counter mapping, or a postfix modifier stay manual; `avg:`/`max:`… on a distribution stay manual.
- **`<` and `<=` monitors are negated** (maths.md T7). Thresholds are negated too, and `negated: true` is set.

## Metric kinds without a curated mapping
`ctx.ddKind(dd)` gives Datadog's declared kind (from integrations-core `metadata.csv`) for metrics the curated tables don't cover. Gauges keep `avg_over_time`. COUNT/RATE metrics are read as OTel cumulative counters: `.as_count()`, or a plain COUNT, becomes `increase()`; `.as_rate()`, or a plain RATE, becomes `rate()`. These are `bounded`, with the assumptions in the ledger. With no metadata entry, a `.count`/`.total` name queried with `.as_count()`/`.as_rate()` is read as a count, under `A.kind-suffix`.

## Fails closed
Anything without a rule makes the whole query `manual`, with no PromQL and an `unsupported` finding that names the construct. Examples: `top`, `anomalies`, `per_second`, `weighted`, `fill(zero)`, `pXX:` on a metric not known to be a distribution (`fn.histogram.kind`/`fn.histogram.kind-unknown`), OR across tag keys, bare tags, mismatched group-bys in arithmetic, `change()` monitors, and `.as_count()`/`.as_rate()` on a metric whose kind isn't in the mapping table.

An unmapped metric **without** those modifiers keeps its Datadog name and is assumed to be a gauge. That's `exact-under(A.kind-gauge)` plus a `warn` finding.

## Corpus (integrations-core, 7556 queries, no mapping table yet)
- 5556 `exact-under`, 2000 `manual`.
- 0 crashes, and 0 emitted queries fail lezer.
- Most of the `manual` cases are `.as_count()`/`.as_rate()` on metrics whose kind is still unknown. T1's kind table will move them.
