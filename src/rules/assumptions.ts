// Assumptions behind exact-under claims (plan 03 §2). Each is phrased so it can be checked on live data.
// T4's assumptions come first (src/translate/query/rules.ts, PR #3), copied verbatim; tests/rules keeps them in sync.

export const ASSUMPTIONS = {
  // T4
  "A.align": "PromQL evaluation step equals the Datadog rollup width and timestamps are Unix-aligned (maths.md T8, A1-A2)",
  "A.boundary": "no sample lies exactly on a bucket boundary (maths.md T8, A3)",
  "A.kind-gauge": "the metric is a gauge; there is no mapping-table entry to confirm its kind",
  "A.monitor-rollup-60s": "Datadog evaluates the monitor's inner query on 60 s buckets",
  "A.nonzero-denominator": "the denominator is never 0 (Datadog drops the point, PromQL yields ±Inf/NaN)",
  "A.var-default": "a free-form template variable (no tag key) is left at its default '*', so dropping it filters nothing",
  "A.var-regex": "the dashboard substitutes the variable as a regex of escaped literal values (a single value, or (a|b) for several)",
  "A.tag-default": "the Datadog tag maps to the OTel label of the same name with dots replaced by underscores (no tag-table entry)",
  "A.query-threshold": "Datadog evaluates the threshold written in the monitor query, which differs from options.thresholds.critical",
  "A.dd-per-unit": "Datadog's per_second/per_minute/per_hour on a gauge that holds a running total is its change per second/minute/hour between consecutive points, and the counter does not reset (Datadog docs; not yet checked against Datadog)",
  "A.no-reset":
    "no counter reset inside the window (anchored increase adds the post-reset value; Datadog's treatment of a reset is unverified, maths.md T4)",
  "A.regular-sampling":
    "the sampling period is constant and divides the rollup width, so Datadog averaging its per-check points equals the time-weighted PromQL rate (maths.md T10a)",
  "A.no-gaps": "every rollup bucket has a sample, so Datadog's previous point is exactly one interval earlier",
  "A.kind-metadata": "the metric's kind is the one declared in its integration's metadata.csv (no curated mapping entry)",
  "A.otel-counter": "the OTel metric with this name is a cumulative counter (Datadog count/rate without a curated mapping entry)",
  "A.top-stable": "the ranking of the series is the same at every step, so Datadog's whole-window ranking picks the same series as PromQL's per-step topk",
  "A.static-tags": "each series keeps its tags for the whole window, so .weighted() has nothing to re-weight",
  "A.dd-count-default": "Datadog shows a COUNT metric queried without a modifier as counts per interval, i.e. like .as_count() (Datadog docs; not yet checked against Datadog)",
  "A.kind-suffix": "a metric with no metadata.csv entry whose name ends in .count or .total, queried with .as_count()/.as_rate(), is a monotonic count (Datadog OpenMetrics naming)",
  "A.mono-diff": "Datadog's monotonic_diff drops negative steps (counter resets) rather than reporting them as 0",
  "A.same-key-and": "Datadog applies a literal tag filter and a template variable on the same key together (AND)",
  "A.at-range": "the dashboard substitutes $__range with its visible time range, so the zero-filled series are those present in the window (Dash0 accepts @ end(), verified live)",
  "A.monotonic": "the gauge only increases between resets (a running total), so its change per second is rate()",
  "A.sumby-together": "the series a mapping's sumBy adds up are scraped together, so they have samples at the same timestamps (the average, rate or increase of their sum is the sum of theirs)",
  "A.histogram-buckets":
    "Dash0 exposes the OTel histogram under {otel_metric_name=\"<otel>\"} so that histogram_quantile over sum by (le, ...) (rate(...)) reads its buckets: Dash0's own dashboard-source example queries histogram_quantile(q, sum by (service_name) (rate({otel_metric_name=\"dash0.spans.duration\"}[w]))) with no _bucket suffix (native histogram); not yet checked live on a collector-emitted explicit-bucket histogram",
  "A.histogram-samples":
    "the Datadog distribution and the OTel histogram record the same samples in each window (maths.md §12, A.same-samples for distributions)",
  "A.finite-quantile":
    "the quantile falls below the histogram's highest finite bucket bound (otherwise histogram_quantile returns that bound whatever the data, maths.md T11d)",
  "A.both-present": "both arguments have a value at the step (Datadog's max/min of a missing point is the other argument)",
  // T12 (src/translate/logs, PR #13), text verbatim
  "A.log-count": "Dash0's dash0.logs counter counts the same log records Datadog indexed (no sampling or exclusion filters on either side)",
  "A.log-source": "logs carry Datadog's `source` as a `source` attribute (set by the shipper); OTel has no built-in equivalent",
  "A.log-attr-default": "a log attribute without a table entry keeps its name in OTel (dots become underscores in the label)",
  "A.log-fulltext": "Datadog's free-text match of a word equals a case-insensitive substring match on the log body",
  "A.group-limit": "the number of groups stays within the widget's group limit, so Datadog shows every group too",
  "A.severity-map": "the Datadog status maps to the OTel severity range listed in mappings/log-attributes.yaml (no 1:1 level)",
  "A.all-indexes": "every Datadog log index is queried (Dash0 has no indexes)",
  "A.log-range": "the panel's $__range is the dashboard's visible time range and the panel shows the value at the end of that range (a stat uses calculation last-number; a TimeSeriesTable shows the last point), so a scalar covers the same timeframe Datadog aggregates over",
  // T17 additions
  "A.same-samples": "Datadog and Dash0 see the same samples of the counter (maths.md T4 model: a RATE point is (vᵢ − vᵢ₋₁)/s)",
  "A.full-window": "every evaluated series has samples across the whole monitor window (Datadog require_full_window)",
  "A.no-new-groups": "no new group (host, tag value) appears during the monitor's new_group_delay / new_host_delay",
  "A.eval-1m": "Datadog evaluates the monitor once per minute (true for metric monitors with windows up to 24 h)",
  "A.notify-manual": "notification routing (channels, renotify, escalation) is recreated by hand in Dash0; it does not change when the rule fires",
  "A.label-rename": "nothing downstream matches on the original Datadog tag key spelling, only on the sanitised label",
  "A.msg-conditional": "the reader of a notification can tell failed from degraded by the rule's threshold, so text from {{#is_alert}} / {{#is_warning}} blocks may appear unconditionally",
  "A.msg-recovery": "text Datadog only sends on recovery, no-data or renotify notifications is not needed in a firing notification",
  "A.no-data-manual": "the monitor's no-data alert is recreated by hand in Dash0 (the companion absent_over_time rule is not generated yet)",
  "A.notify-wider": "the channel may also receive notifications Datadog did not send to it (Dash0 has no degraded-only or recovery-only channel binding)",
  "A.msg-length": "text beyond Dash0's annotation limits (description 2048, summary 255 characters) is not needed in the notification; the full original stays in the report",
  "A.msg-verbatim": "showing an unknown Datadog template token as literal text is acceptable in the notification",
  "A.style": "fonts, colours, alignment, legend placement and free-layout positions are not part of the panel's meaning",
  "A.row-height": "one Dash0 grid row has the same height as one Datadog grid row (to confirm from the T0 golden export)",
  "A.var-values": "a label's values in Dash0 are the same set as the matching tag's values in Datadog",
  "A.table-single-query": "the table has one query, default sorting and no conditional formats",
  "A.alt-view": "what the widget conveys is its value per group; the map or chart drawing is not part of that meaning",
  "A.table-columns": "every column groups by the same labels, so Dash0 shows one row per group with one value column per query (read on a rendered table); default sorting, no conditional formats",
  "A.top-uniform": "every ranked series has samples on the same uniform grid over the dashboard range, and no two window means tie",
  "A.top-unlimited": "showing every series, unranked and without the top-N limit, is acceptable until fn.top.window ships",
  "A.agg-default": "a query_value request without an aggregator uses Datadog's default, avg",
  "A.stat-first": "only the first query of a multi-query stat panel matters",
} as const;

export type AssumptionId = keyof typeof ASSUMPTIONS;

/**
 * T12's assumption ids, in T12's order (LOG_ASSUMPTIONS in src/translate/logs). A.var-regex, A.var-default and
 * A.top-stable are shared with T4: the catalog keeps one text per id (T4's), and T12's wording of the last two differs
 * only in naming (facet vs tag key, groups vs series).
 */
export const T12_ASSUMPTION_IDS = [
  "A.log-count",
  "A.log-source",
  "A.log-attr-default",
  "A.log-fulltext",
  "A.align",
  "A.boundary",
  "A.var-regex",
  "A.var-default",
  "A.top-stable",
  "A.group-limit",
  "A.severity-map",
  "A.all-indexes",
  "A.log-range",
] as const satisfies readonly AssumptionId[];

/** T4's assumption ids, in T4's order. */
export const T4_ASSUMPTION_IDS = [
  "A.align",
  "A.boundary",
  "A.kind-gauge",
  "A.monitor-rollup-60s",
  "A.nonzero-denominator",
  "A.var-default",
  "A.var-regex",
  "A.tag-default",
  "A.dd-per-unit",
  "A.same-samples",
  "A.no-reset",
  "A.regular-sampling",
  "A.no-gaps",
  "A.kind-metadata",
  "A.otel-counter",
  "A.top-stable",
  "A.static-tags",
  "A.dd-count-default",
  "A.kind-suffix",
  "A.mono-diff",
  "A.both-present",
  "A.same-key-and",
  "A.at-range",
  "A.monotonic",
  "A.query-threshold",
  "A.sumby-together",
  "A.histogram-buckets",
  "A.histogram-samples",
  "A.finite-quantile",
] as const satisfies readonly AssumptionId[];
