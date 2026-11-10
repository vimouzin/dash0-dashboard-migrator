// The translation table as data (plan 02 §2 rule 1). Every ruleId has a status claim (plan 03 §2),
// the assumptions it needs, and at least one test asserting the exact PromQL it produces.
import type { Status } from "./types.js";

export const ASSUMPTIONS = {
  "A.align": "PromQL evaluation step equals the Datadog rollup width and timestamps are Unix-aligned (maths.md T8, A1-A2)",
  "A.boundary": "no sample lies exactly on a bucket boundary (maths.md T8, A3)",
  "A.kind-gauge": "the metric is a gauge; there is no mapping-table entry to confirm its kind",
  "A.monitor-rollup-60s": "Datadog evaluates the monitor's inner query on 60 s buckets",
  "A.nonzero-denominator": "the denominator is never 0 (Datadog drops the point, PromQL yields ±Inf/NaN)",
  "A.var-default": "a free-form template variable (no tag key) is left at its default '*', so dropping it filters nothing",
  "A.var-regex": "the dashboard substitutes the variable as a regex of escaped literal values (a single value, or (a|b) for several)",
  "A.tag-default": "the Datadog tag maps to the OTel label of the same name with dots replaced by underscores (no tag-table entry)",
  "A.dd-per-unit":
    "Datadog's per_second/per_minute/per_hour on a gauge that holds a running total is its change per second/minute/hour between consecutive points, and the counter does not reset (Datadog docs; not yet checked against Datadog)",
  "A.same-samples": "Datadog and Dash0 see the same samples of the counter (maths.md T4 model: a RATE point is (vᵢ − vᵢ₋₁)/s)",
  "A.no-reset":
    "no counter reset inside the window (anchored increase adds the post-reset value; Datadog's treatment of a reset is unverified, maths.md T4)",
  "A.regular-sampling":
    "the sampling period is constant and divides the rollup width, so Datadog averaging its per-check points equals the time-weighted PromQL rate (maths.md T10a)",
  "A.no-gaps": "every rollup bucket has a sample, so Datadog's previous point is exactly one interval earlier",
  "A.kind-metadata": "the metric's kind is the one declared in its integration's metadata.csv (no curated mapping entry)",
  "A.otel-counter": "the OTel metric with this name is a cumulative counter (Datadog count/rate without a curated mapping entry)",
  "A.top-stable": "the ranking of the series is the same at every step, so Datadog's whole-window ranking picks the same series as PromQL's per-step topk",
  "A.static-tags": "each series keeps its tags for the whole window, so .weighted() has nothing to re-weight",
  "A.dd-count-default":
    "Datadog shows a COUNT metric queried without a modifier as counts per interval, i.e. like .as_count() (Datadog docs; not yet checked against Datadog)",
  "A.kind-suffix":
    "a metric with no metadata.csv entry whose name ends in .count or .total, queried with .as_count()/.as_rate(), is a monotonic count (Datadog OpenMetrics naming)",
  "A.mono-diff": "Datadog's monotonic_diff drops negative steps (counter resets) rather than reporting them as 0",
  "A.both-present": "both arguments have a value at the step (Datadog's max/min of a missing point is the other argument)",
  "A.same-key-and": "Datadog applies a literal tag filter and a template variable on the same key together (AND)",
  "A.at-range": "the dashboard substitutes $__range with its visible time range, so the zero-filled series are those present in the window (Dash0 accepts @ end(), verified live)",
  "A.monotonic": "the gauge only increases between resets (a running total), so its change per second is rate()",
  "A.query-threshold": "Datadog evaluates the threshold written in the monitor query, which differs from options.thresholds.critical",
  "A.sumby-together": "the series a mapping's sumBy adds up are scraped together, so they have samples at the same timestamps (the average, rate or increase of their sum is the sum of theirs)",
  "A.histogram-buckets":
    "Dash0 exposes the OTel histogram under {otel_metric_name=\"<otel>\"} so that histogram_quantile over sum by (le, ...) (rate(...)) reads its buckets: Dash0's own dashboard-source example queries histogram_quantile(q, sum by (service_name) (rate({otel_metric_name=\"dash0.spans.duration\"}[w]))) with no _bucket suffix (native histogram); not yet checked live on a collector-emitted explicit-bucket histogram",
  "A.histogram-samples":
    "the Datadog distribution and the OTel histogram record the same samples in each window (maths.md §12, A.same-samples for distributions)",
  "A.finite-quantile":
    "the quantile falls below the histogram's highest finite bucket bound (otherwise histogram_quantile returns that bound whatever the data, maths.md T11d)",
} as const;

export type AssumptionId = keyof typeof ASSUMPTIONS;

export interface Rule {
  status: Status;
  assumptions: AssumptionId[];
  description: string;
}

const exact = (description: string): Rule => ({ status: "exact", assumptions: [], description });
const under = (assumptions: AssumptionId[], description: string): Rule => ({
  status: "exact-under",
  assumptions,
  description,
});
const bounded = (description: string): Rule => ({ status: "bounded", assumptions: [], description });

export const RULES = {
  // selection
  "select.metric.mapped": exact("Datadog metric -> {otel_metric_name=...} through the mapping table"),
  "select.metric.unmapped": under(["A.kind-gauge"], "no mapping entry: keep the Datadog name, assume gauge"),
  "select.metric.kind-metadata": under(
    ["A.kind-metadata"],
    "no mapping entry: keep the Datadog name; take its kind from the integration's metadata.csv",
  ),
  "time.unmapped.counter": {
    status: "bounded",
    assumptions: ["A.kind-metadata", "A.otel-counter"],
    description: "Datadog count/rate (metadata.csv) without a mapping entry: .as_count() -> increase(x[w]), .as_rate() or a plain rate -> rate(x[w])",
  },
  "time.unmapped.suffix-counter": {
    status: "bounded",
    assumptions: ["A.kind-suffix", "A.otel-counter"],
    description: "no metadata.csv entry, name ends in .count/.total, queried with .as_count()/.as_rate(): treated as a Datadog count",
  },
  "time.count.default": {
    status: "bounded",
    assumptions: ["A.kind-metadata", "A.otel-counter", "A.dd-count-default"],
    description: "Datadog COUNT metric (metadata.csv) queried without a modifier -> increase(x[w]), the same as .as_count()",
  },
  "time.count.counter": {
    status: "bounded",
    assumptions: ["A.dd-count-default"],
    description: "curated mapping row: Datadog COUNT on an OTel cumulative counter, queried without a modifier -> increase(x[w]) (maths.md T4c)",
  },
  "time.rollup.counter": {
    status: "bounded",
    assumptions: [],
    description: ".as_count().rollup(sum, s) -> increase(x[s]); .as_rate().rollup(avg, s) -> rate(x[s]) (maths.md T3b)",
  },
  // Dashboard counter rules on Dash0's `anchored` modifier (probe:anchored = yes, maths.md T4, T4c, T10a): the window is the
  // rollup width, the increase has no edge extrapolation, so these are exact under the listed assumptions. Monitors keep the
  // extrapolated forms above (a check rule with `anchored` has not been probed).
  "time.as_count.counter.anchored": under(
    ["A.same-samples", "A.align", "A.boundary", "A.no-reset"],
    ".as_count() on a cumulative counter -> increase(x[w] anchored) (maths.md T4: the per-check deltas telescope)",
  ),
  "time.as_rate.counter.anchored": under(
    ["A.same-samples", "A.align", "A.boundary", "A.no-reset", "A.regular-sampling"],
    ".as_rate() on a cumulative counter -> rate(x[w] anchored) = increase(x[w] anchored) / w (maths.md T4, T10a)",
  ),
  "time.ddrate.plain.anchored": under(
    ["A.same-samples", "A.align", "A.boundary", "A.no-reset", "A.regular-sampling"],
    "Datadog RATE metric read from an OTel counter, plain query -> rate(x[w] anchored) (D-18, maths.md T10a)",
  ),
  "time.unmapped.counter.anchored": under(
    ["A.kind-metadata", "A.otel-counter", "A.same-samples", "A.align", "A.boundary", "A.no-reset", "A.regular-sampling"],
    "Datadog count/rate (metadata.csv) without a mapping entry: .as_count() -> increase(x[w] anchored), .as_rate() or a plain rate -> rate(x[w] anchored)",
  ),
  "time.unmapped.suffix-counter.anchored": under(
    ["A.kind-suffix", "A.otel-counter", "A.same-samples", "A.align", "A.boundary", "A.no-reset", "A.regular-sampling"],
    "no metadata.csv entry, name ends in .count/.total, queried with .as_count()/.as_rate(): a Datadog count, on anchored increase / rate",
  ),
  "time.count.default.anchored": under(
    ["A.kind-metadata", "A.otel-counter", "A.dd-count-default", "A.same-samples", "A.align", "A.boundary", "A.no-reset"],
    "Datadog COUNT metric (metadata.csv) queried without a modifier -> increase(x[w] anchored), the same as .as_count()",
  ),
  "time.count.counter.anchored": under(
    ["A.dd-count-default", "A.same-samples", "A.align", "A.boundary", "A.no-reset"],
    "curated mapping row: Datadog COUNT on an OTel cumulative counter, queried without a modifier -> increase(x[w] anchored) (maths.md T4c)",
  ),
  "time.rollup.counter.anchored": under(
    ["A.same-samples", "A.align", "A.boundary", "A.no-reset", "A.regular-sampling"],
    ".as_count().rollup(sum, s) -> increase(x[s] anchored); .as_rate().rollup(avg, s) -> rate(x[s] anchored) (maths.md T4, T10a)",
  ),
  "time.fill.zero.single": exact(".fill(zero) on a single-series query -> q or vector(0) (the same as default_zero)"),
  "select.metric.approximate": bounded("the mapping table marks the OTel metric as approximate (see the entry's note)"),
  "select.labels": exact("mapping-table labels pick the series: redis.cpu.sys -> {otel_metric_name=\"redis.cpu.time\", state=\"sys\"}"),
  "select.metric.transform": exact(
    "mapping entry with scale k > 0 and/or sumBy labels L -> k * agg by (G) (sum without (L) (T(x))); k drops out under a count",
  ),
  "select.metric.transform.sumby": under(
    ["A.sumby-together"],
    "sumBy under avg_over_time/rate/increase: the sum of the split series' values equals the value of their sum",
  ),
  "time.ddrate.plain": bounded(
    "Datadog RATE metric (stored per second) read from an OTel counter: a plain query -> rate(x[w]) (D-18, maths.md T3b); dashboards use w = $__rate_interval",
  ),
  "scope.all": exact("{*} -> no matchers"),
  "scope.tag.eq": exact("key:value -> key=\"value\""),
  "scope.tag.neq": exact("!key:value / -key:value -> key!=\"value\""),
  "scope.tag.wildcard": exact("key:a* -> key=~\"^a.*$\" (Dash0 regex is unanchored, so anchor it)"),
  "scope.in": exact("key IN (a,b) -> key=~\"^(a|b)$\""),
  "scope.or.same-key": exact("key:a OR key:b -> key=~\"^(a|b)$\""),
  "scope.not": exact("NOT key:a -> key!=\"a\""),
  "scope.not.set": exact("NOT (key:a OR key:b) / NOT key IN (a,b) / NOT key:a* -> key!~\"^(a|b)$\""),
  "scope.var.negated": under(["A.var-regex"], "!$var / -$var -> label!~\"^($var)$\""),
  "scope.var": under(["A.var-regex"], "$var -> label=~\"^($var)$\" on the variable's tag (anchored: Dash0 regex is unanchored)"),
  "label.default": under(["A.tag-default"], "tag without a tag-table entry -> label with dots replaced by underscores"),
  // time aggregation (Datadog does time first, then space)
  "time.rollup.default": under(["A.align", "A.boundary"], "implicit avg rollup -> avg_over_time(x[interval])"),
  "time.rollup.explicit": under(["A.align", "A.boundary"], ".rollup(fn, s) -> fn_over_time(x[s])"),
  "time.rollup.monitor-bucket": under(
    ["A.boundary"],
    "monitor inner query: fn_over_time(x[1m]) inside a 1m-step subquery, aligned to Unix minutes by construction",
  ),
  "time.as_count.gauge": exact(".as_count() has no effect on gauges"),
  "time.as_rate.gauge": exact(".as_rate() has no effect on gauges"),
  "time.as_count.delta": under(["A.align", "A.boundary"], ".as_count() on a delta sum -> sum_over_time(x[w])"),
  "time.as_count.counter": bounded(
    ".as_count() on a cumulative counter -> increase(x[w]) (extrapolated, maths.md T3b); dashboards use w = $__rate_interval",
  ),
  "time.as_rate.counter": bounded(".as_rate() on a cumulative counter -> rate(x[w]) (maths.md T3b); dashboards use w = $__rate_interval"),
  "time.fill.null": exact(".fill(null) and .fill(null, limit) are Datadog's default: no filling"),
  "time.weighted": under(["A.static-tags"], ".weighted() only re-weights series whose tags change within the window"),
  // space aggregation
  "space.agg": exact("avg|sum|min|max|count by {tags} -> PromQL aggregation by (labels)"),
  "space.default-avg": exact("legacy query without aggregator: Datadog averages -> avg"),
  // pointwise
  "map.abs": exact("abs(q) -> abs(x)"),
  "map.log2": exact("log2(q) -> log2(x)"),
  "map.log10": exact("log10(q) -> log10(x)"),
  "map.clamp_min": exact("clamp_min(q, n) -> clamp_min(x, n)"),
  "map.clamp_max": exact("clamp_max(q, n) -> clamp_max(x, n)"),
  "fn.per_unit.counter": {
    status: "bounded",
    assumptions: ["A.dd-per-unit"],
    description:
      "per_second/per_minute/per_hour(q) where q sums or averages a running total or a counter -> k * agg(rate(x[w])) (maths.md T3b)",
  },
  "fn.diff": under(["A.align", "A.no-gaps"], "diff(q) -> q - (q offset interval): each point minus the previous one"),
  "fn.derivative.counter": {
    status: "bounded",
    assumptions: ["A.dd-per-unit"],
    description: "derivative(q) where q sums or averages a Datadog gauge holding an OTel counter's running total -> agg(rate(x[w]))",
  },
  "fn.top": under(["A.top-stable"], "top(q, N, method, order) / topN / bottomN -> topk(N, q) or bottomk(N, q)"),
  "fn.cutoff": exact("cutoff_min(q, n) -> q >= n, cutoff_max(q, n) -> q <= n (values beyond the cutoff are removed)"),
  "fn.count_not_null": exact("count_not_null(q) -> count(q): the number of series with a value at each step"),
  "fn.count_nonzero": exact("count_nonzero(q) -> count(q != 0)"),
  "fn.default_zero.grouped.monitor": under(
    ["A.monitor-rollup-60s"],
    "default_zero(q) on a grouped monitor query -> q or 0 * q over the evaluation window (the series Datadog sees in the window)",
  ),
  "fn.default_zero.grouped": under(["A.at-range"], "default_zero(q) on a grouped dashboard query -> q or 0 * q[$__range] @ end()"),
  "fn.per_unit.gauge": {
    status: "bounded",
    assumptions: ["A.dd-per-unit", "A.monotonic"],
    description: "per_second/per_minute/per_hour/derivative(q) where q sums or averages a plain gauge -> k * agg(rate(x[w]))",
  },
  "scope.same-key.var": under(["A.same-key-and", "A.var-regex"], "a literal filter and a template variable on the same key -> both matchers"),
  "fn.default_zero.single": exact("default_zero(q) on a single-series query -> q or vector(0)"),
  "fn.exclude_null": exact("exclude_null(q) -> label!=\"\" on every selector for each group-by label (drops the N/A group)"),
  "fn.monotonic_diff": under(["A.align", "A.no-gaps", "A.mono-diff"], "monotonic_diff(q) -> (q - (q offset interval)) >= 0"),
  "fn.round": exact("round(q) -> round(x)"),
  "fn.max_min.scalar": exact("max(q, n) -> clamp_min(x, n); min(q, n) -> clamp_max(x, n)"),
  "fn.max_min.series": under(["A.both-present"], "max(a, b) -> a >= b or b; min(a, b) -> a <= b or b (pointwise, same group-by)"),
  "map.timeshift": exact("timeshift(q, -s) / hour_before(q) / ... -> offset s on every selector"),
  "fn.histogram.quantile": {
    status: "bounded",
    assumptions: ["A.histogram-buckets", "A.histogram-samples", "A.finite-quantile"],
    description:
      "pXX:m{f} by {g} on a distribution / OTel histogram -> histogram_quantile(0.XX, sum by (le, g) (rate(m[w]))) (maths.md §12, T11)",
  },
  "arith.number": exact("arithmetic with a constant"),
  "arith.same-groups": exact("arithmetic between queries with identical group-by labels (one-to-one matching)"),
  "arith.div": under(["A.nonzero-denominator"], "division between queries"),
  "arith.neg": exact("unary minus"),
  // monitors
  "monitor.window": under(
    ["A.monitor-rollup-60s", "A.boundary"],
    "fn(last_W):Q -> fn_over_time((Q on 1m buckets)[W:1m]), the subquery form that mirrors Datadog's order (maths.md §5)",
  ),
  "monitor.change": exact("change(fn(last_W), last_C) -> X - X offset C; pct_change -> 100 * (X - X offset C) / X offset C"),
  "monitor.sum.as_count": {
    status: "bounded",
    assumptions: [],
    description: "sum(last_W):q.as_count() on a counter -> agg(increase(x[W])): the window's total count (maths.md T3b/T4)",
  },
  "monitor.cmp.eq": exact("== T -> -abs(expr - T) >= $__threshold with failed 0; != T -> abs(expr - T) > $__threshold with failed 0"),
  "monitor.cmp.gt": exact("> / >= -> expr > $__threshold, critical -> failed, warning -> degraded"),
  "monitor.cmp.lt": exact("< / <= -> -(expr) > $__threshold with negated thresholds (maths.md T7)"),
} as const satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;
