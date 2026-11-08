# Metric alert conversion

`migrator convert` reads Datadog `query alert` and `metric alert` assets alongside
dashboards. Every supported monitor emits a Prometheus rule group and a **disabled**
Dash0 check rule from the same compiled condition. Warning/critical thresholds,
comparison direction, mapped grouping labels and existing remark labels are shared
between both artifacts. One unsupported metric, option or expression blocks the
entire monitor; no incomplete alert is emitted.

The supported query shape is:

```text
<avg|min|max|sum>(last_<positive integer><m|h|d>):<expression> <comparison> <threshold>
```

Lookbacks are limited to seven days. Comparisons are `>`, `>=`, `<` and `<=`.
The inline threshold must equal `options.thresholds.critical`; a warning threshold
must be on the less severe side of critical.

Expressions can contain fully parsed mapped metric queries, finite decimal scalars,
`+`, `-`, `*`, `/`, unary signs and nested parentheses. Operators use ordinary
arithmetic precedence. Every metric query must produce the same mapped group-by
label set, preventing accidental vector joins. All syntax must be consumed.

Classic arithmetic is evaluated at each timestamp, then reduced over the lookback
on the existing one-minute grid. This follows Datadog's documented
[classic evaluation order](https://docs.datadoghq.com/monitors/guide/as-count-in-monitor-evaluations/).
For example, `avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.rss{*} > 90`
reduces the percentage series after dividing the two mapped metric series.

`.as_count()` monitors remain blocked: Datadog switches to a different evaluation
order when any query uses that modifier, and its count buckets require a separate
model. This explicit guard also prevents a dashboard-only function extension from
silently entering the classic monitor path. Other functions use the same supported
deterministic metric compiler as dashboards; their assumptions and best-effort
diagnostics propagate to the monitor.

`options.evaluation_delay` accepts null or an integer from 0 to 86400 seconds.
The complete lookback is shifted into the past using a PromQL subquery offset,
following Datadog's documented
[evaluation delay](https://docs.datadoghq.com/monitors/configuration/#evaluation-delay).
Other options retain their explicit allowlist: unsupported recovery/no-data/routing
behavior blocks conversion; approved full-window and new-host differences retain
their remark tags. Notification targets are reported for manual destination setup.

Compilation stays offline, deterministic and model-free. Syntax/schema validation
does not establish numerical parity, actual evaluation scheduling, missing-data
behavior or notification delivery. The live comparison harness can independently
bind each parsed arithmetic leaf using `monitor_source_queries()` and evaluate
the source formula before its lookback reducer. Delayed monitor verification must
also shift the source history and retain enough warmup; it must not silently test
the undelayed condition. Live evidence and destination IDs are recorded separately
from compiled artifacts.
