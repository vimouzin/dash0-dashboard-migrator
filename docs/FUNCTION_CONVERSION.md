# Best-effort Datadog functions

The offline compiler supports a bounded subset of three common modifiers. These queries and
all panels depending on them have outcome `best_effort`, with a visible reason tag. They never
become `translated` merely because a numerical test passes. Compilation remains deterministic;
no live samples, clock, credentials or model participate in producing an artifact.

The pinned dashboard inventory contains 36 `.weighted()` calls, eight `.as_rate()` calls and
six `.rollup()` calls. Some still depend on unavailable metrics or labels. Those mapping gaps
remain blocked rather than being guessed. This inventory determines the initial priority.

| Form | Supported metric mapping | Target behavior | Reason tag |
| --- | --- | --- | --- |
| `sum:metric{filters}[ by {tags}].weighted()` | `gauge` | Sum raw sample values over `$__rate_interval`, divide each series by the greatest raw sample count among all selected series, then apply existing grain deduplication and space aggregation | `WEIGHTED` |
| `agg:metric{filters}.rollup(reducer[,seconds])` | `gauge` | Apply `reducer_over_time` to each raw series before grain deduplication and space aggregation | `ROLLUP` |
| `agg:metric{filters}.rollup(seconds)` | `gauge` | Same, with reducer `avg` | `ROLLUP` |
| `agg:metric{filters}.as_rate()` | `rate` | Use the mapping's counter-reset-aware `rate()` with its configured `rateWindow` or `$__rate_interval` | `ASRATE` |
| `agg:metric{filters}.as_count()` (dashboards) | `rate` | `increase()` of the mapped counter over the panel step `$__interval` | `ASCOUNT` |

`reducer` is exactly `avg`, `sum`, `min`, `max` or `count`. Explicit seconds must be an ASCII
integer from 1 through 86400, with at most five digits. Without an explicit interval, rollup
uses `$__rate_interval`; the diagnostic records the chosen interval and reducer. Datadog's
graph-dependent minimum interval, UNIX bucket alignment and sample selection are not reproduced.
Offsets, source filters, fixed mapping matchers, grouping and unit scale are retained.

Only one modifier is supported per query. Modifier chains are blocked in full: applying
weighting, rollup and type conversion in a different order can change the result. Expression
mappings lack raw sample provenance and cannot use these modifiers. Weighted calls with
arguments, a non-`sum` aggregator, calendar rollups, unknown reducers or invalid intervals block.
The parser still consumes the entire query; trailing syntax is never ignored.

`WEIGHTED` is a sample-count normalization approximation, not an inferred submission interval.
Datadog uses a configured catalog interval that exported queries do not carry. This implementation
needs a representative full-window series with the same sampling cadence for close agreement.
If every series churns, all series have gaps, cadences differ, or resource identities change,
the fullest observed series can have too few samples. The denominator then differs from the
expected slot count; error can exceed 5%. Grain deduplication after weighting can also differ
from Datadog when overlapping or fragmented resource identities carry the same grain. These
limitations remain visible even on a stable-data live pass; no general error bound is claimed.

`ROLLUP` uses a window ending at each target evaluation timestamp. Datadog uses graph-dependent,
UNIX-aligned buckets and may enlarge a requested interval. A fixed rollup can therefore shift
or smooth spikes differently; `sum` and `count` can differ substantially on irregular sampling.

`ASRATE` preserves the physical per-second mapping. Datadog's COUNT/RATE type metadata,
submission interval, bucket normalization, zero alignment and interpolation differ from
PromQL counter extrapolation. The compiler does not claim to reconstruct those in-app settings.

`ASCOUNT` (#181, Felix's explicit best-effort request) counts per panel step: Datadog counts
per UNIX-aligned rollup bucket whose width depends on the graph, so bucket width, alignment,
counter extrapolation and resets can differ. Only counter (`rate`) mappings qualify; gauges and
expressions keep blocking. Monitor `.as_count()` still blocks (docs/ALERT_CONVERSION.md).
`.fill()` remains blocked, including the undocumented numeric
forms `.fill(0)` and `.fill(60)` in pinned inputs. Omitting those modifiers would change gaps
or counts. Unknown functions and semantic combinations remain diagnostics.

Primary semantics:

- [Datadog weighted evaluation](https://docs.datadoghq.com/dashboards/guide/how-weighted-works/)
- [Datadog rollup and enforced intervals](https://docs.datadoghq.com/dashboards/functions/rollup/)
- [Datadog type modifiers](https://docs.datadoghq.com/metrics/custom_metrics/type_modifiers/)
- [Datadog interpolation](https://docs.datadoghq.com/dashboards/functions/interpolation/)
- [Prometheus range functions](https://prometheus.io/docs/prometheus/latest/querying/functions/#aggregation_over_time)

The empirical suite compares the new queries against the retained shared-OTel stream. Numeric
coverage and tolerance, API acceptance and semantic limitations are reported separately. Stable
Redis gauges exercise weighting and rollup values; they do not exercise tag churn or sparse gaps.
The root integration task records actual results in `docs/STATUS.md` and the task issues.
