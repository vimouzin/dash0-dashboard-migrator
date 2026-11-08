# Remarks: converted, but not an exact translation

Most items either translate exactly or block. Other outcomes cover items that convert while differing from the source in a documented way. Each such reason is a **remark tag**: a short uppercase code with a one-line summary. The tag travels with the item into every artifact, so a reader in Dash0 can see why a panel or check rule isn't an exact copy.

The registry is [`src/migrator/source/datadog/remarks.py`](../src/migrator/source/datadog/remarks.py). It is the single source of truth for tags, summaries, evidence and approvals.

## Outcomes

| Outcome | Meaning | Publish |
|---|---|---|
| `translated` | Exact translation. | Eligible. |
| `approximated` | Exact except for one documented, minor behaviour the target lacks. | Eligible; published as its own group, tagged. |
| `assumed` | The exact Datadog metric has no OTel counterpart. The value is rebuilt deterministically from OTel data under a stated, high-confidence assumption. | Eligible; published as its own group, tagged. |
| `best_effort` | An explicitly supported query function uses a deterministic approximation of source aggregation or sampling semantics. Numeric error depends on the workload; live evidence applies only to the tested case. | Eligible; published as its own group, tagged. |
| `partial` | Dashboard only: some widgets converted, some blocked. | Only with `--allow-partial`. |
| `blocked` | Not converted. `report.json` says why. | Never. |

- **Precedence:** `best_effort` beats `assumed`, which beats `approximated`, which beats `translated`. All reasons remain attached.
- **Dashboard outcome:** a dashboard whose widgets all converted takes the strongest widget outcome. If any widget is blocked, the dashboard is `partial`.
- **Exit code:** `convert` still exits `2` unless every item is `translated`.

**Approximated vs assumed.** The two categories answer different questions:
- `approximated`: a target limitation changes an approved behaviour, such as the time frame or alert timing. Losing a pinned time frame can also change a value calculated over that frame; the remark makes this explicit.
- `assumed`: the data itself is reconstructed, because no OTel metric carries the Datadog value as such.

## Manual approval

Every tag needs manual approval before it converts anything.
- A tag with `approved=None` keeps blocking exactly as if it didn't exist. The block's suggested action names the tag that awaits approval.
- Only a human reviewer authorizes an approval. Explicit session instructions count: Felix requested deterministic best-effort query functions on 2026-11-08, including weighted(), with empirical tests and case-by-case tolerance generally below 5%. The registry records that authorization; it does not claim universal numerical equivalence.
- Adding a new reason means adding a new tag. A new reason is never folded into an existing tag.

## Where tags appear

| Artifact | Field |
|---|---|
| `report.json` | Each converted item's `remarks`; each `APPROXIMATED` / `ASSUMED` / `BEST_EFFORT` diagnostic's `remark` |
| `manifest.json` | `remarks` on dashboard, check-rule and Prometheus-rule entries |
| Perses panel | `spec.display.description`: `[TAG] summary`. Dash0 shows panel descriptions "in the panel header next to the name" ([Dash0 docs](https://www.dash0.com/docs/dash0/dashboards/configure-panels)). |
| Perses dashboard | One line appended to `spec.display.description`: `Migration remarks: TAG … (see panel descriptions).` |
| Check rule and Prometheus rules | Label `migration_remarks: "TAG1,TAG2"`. Dash0 merges check-rule labels into each failed check ([Dash0 docs](https://www.dash0.com/docs/dash0/monitoring/alerting/route-alert-check-notifications)). |
| `publish` output | Groups in order: translated, approximated, assumed, best_effort, partial. Each line ends with `[category: TAGS]`. |

## Tags

### Best effort

Felix authorized this category in the 2026-11-08 function-extension request. Every emitted query keeps its complete parsed input, explicit mapping and deterministic PromQL; unsupported combinations still block. No numerical bound is guaranteed by conversion. Live comparisons use a tolerance chosen for each case before execution, generally below 5%, and leave API/semantic evidence outside deterministic artifacts.

| Tag | Supported case and limitation |
|---|---|
| `WEIGHTED` | Explicit `sum` of a directly mapped gauge. Raw sample sums divided by the fullest selected series' sample count approximate occupancy over the target rate window. Missing submission cadence, unequal sampling and resource churn can change the result. |
| `ROLLUP` | A directly mapped gauge with a supported reducer and bounded interval. Trailing PromQL sample windows approximate Datadog's UNIX-aligned buckets. Missing intervals follow the target rate window. |
| `ASRATE` | A mapped cumulative counter uses PromQL `rate`. Datadog's interpolation, rollup and source metadata can differ. |
| `ASCOUNT` | Dashboard `.as_count()` on a mapped cumulative counter uses PromQL `increase()` over `$__interval`. Datadog's UNIX-aligned rollup buckets, extrapolation and resets can differ. |

Function-specific grammar, equations and empirical limitations are documented in [FUNCTION_CONVERSION.md](FUNCTION_CONVERSION.md).

### Approximated

| Tag | When | Why it's only approximate | Approved |
|---|---|---|---|
| `TIMEPIN` | Any supported widget has `time: {"live_span": X}` with a supported preset | The panel follows the dashboard time picker instead of its original pinned window. This can change query values and rankings calculated over that window. Even a `1h` pin matching the initial dashboard duration needs the remark, because changing the time picker changes the converted panel. Time handling is shared across widget types, including future supported types. The documented regular metric-panel schema has no per-panel time range ([Perses API](https://perses.dev/docs/perses/latest/api/dashboard/)). | Yes, Felix 2026-11-08; general widget rule approved in [#158](https://github.com/XNotAGuestX/thinchackdash/issues/158) |
| `FULLWINDOW` | Monitor `require_full_window: true` | Dash0 evaluates partial windows, so a new series can alert early. | Yes, Felix under A3 |
| `NEWHOST` | Monitor `new_host_delay > 0` | Dash0 has no new-host grace period. | Yes, Felix under A3 |

`FULLWINDOW` and `NEWHOST` were approximated with a warning under decision A3 before tags existed. They moved into this category unchanged, and their approval cites A3.

An empty `time: {}` specifies no override and is accepted with `OPTION_IGNORED`, without a `TIMEPIN` remark. Supported pinned presets are `1m`, `5m`, `10m`, `15m`, `30m`, `1h`, `4h`, `1d`, `2d`, `1w`, `1mo`, `3mo`, `6mo`, `week_to_date`, `month_to_date` and `1y`. Unknown values, the context-dependent `alert` span and other time object shapes remain blocked. A time remark never bypasses an unsupported query, missing mapping or unsupported widget type. A toplist also retains its `TOPN` remark and the stronger `assumed` outcome.

### Assumed

A mapping entry names one of `AGG`, `DERIVED`, `ATTRVAL` or `SEMANTIC` in its `assumption` field; its `ref` must spell out the assumption and its evidence. `TOPN` is set by the dashboard converter; Felix placed it in this category (2026-11-08) because the panel shows more series than the source.

| Tag | When | Approved |
|---|---|---|
| `AGG` | The value is rebuilt by aggregating OTel series over an attribute, for example summing memory states. | No (no entry uses it yet) |
| `DERIVED` | The value is computed from other OTel metrics by an expression. | Yes, Felix 2026-11-08 |
| `ATTRVAL` | The value is one slice of an OTel metric, selected by an attribute value that the OTel definition doesn't enumerate. | No (no entry uses it yet) |
| `SEMANTIC` | The Datadog and OTel metrics measure the same thing (often paired in Datadog's vendor table), but their documented definitions differ in scope. | Yes, Felix 2026-11-08 |
| `PROMLABEL` | An OpenMetrics check's metric, mapped to the Prometheus series it scrapes as the OTel Prometheus receiver stores it in Dash0 (raw sample name; `_total` only where the exporter has it). Tags are the series' labels from the check's pinned test exposition, renamed by its `rename_labels`; `host` maps to the scrape target `instance`, since these series have no `host_name`. Entries come from `scripts/generate_openmetrics_mappings.py` ([#185](https://github.com/XNotAGuestX/thinchackdash/issues/185)). Relabelling in the user's scrape config, or labels missing from the test exposition, break the assumption. | Yes, Felix 2026-11-08 (#185) |
| `OTELTABLE` | The OTel metric named in Datadog's [OpenTelemetry mapping table](https://docs.datadoghq.com/opentelemetry/mapping/metrics_mapping/), where the pinned OTel catalog or Datadog metadata doesn't confirm every fact. The target type comes from the catalog, or from the Datadog kind when the catalog lacks the metric. The scale is the explicit unit rule, else the table's factor, else 1. Attribute renames become labels, and several table targets resolve by a fixed order. Entries come from `scripts/generate_vendor_mappings.py` ([#188](https://github.com/XNotAGuestX/thinchackdash/issues/188)), and each entry's `ref` names the unconfirmed fact. A wrong type means no data; a wrong unit means a wrong value. | Yes, Felix 2026-11-08 (#188) |
| `TOPN` | A toplist widget (no `top()`) with one `limit` `{count, order}` or request `sort`. It becomes a Perses `BarChart`: the query aggregator becomes `calculation`, the order becomes `sort`. The BarChart has no count field ([schema](https://github.com/perses/plugins/blob/57910acf0bf979561e13c6c28ea487ce86b2433f/barchart/schemas/bar.cue)), so every series shows; the first N bars match Datadog. Not yet confirmed that Dash0 renders `BarChart`. | Yes, Felix 2026-11-08 |

## Gaps

When a Datadog metric was checked and found unmappable, even with an assumption, its mapping file records it under `gaps`:

```json
"gaps": { "<datadog metric>": { "tag": "NOOTEL", "reason": "<evidence>" } }
```

A widget using that metric still blocks, but its `MISSING_METRIC_MAPPING` message cites the gap tag and reason.

| Tag | Meaning |
|---|---|
| `NOOTEL` | No OTel metric carries it in the pinned sources. |
| `NOEQUIV` | OTel has related data, but there is no deterministic rebuild. |
| `AMBIG` | The Datadog name covers several sources at once (for example two JMX beans), which no single OTel metric reproduces. |

Other short tags may appear; each gap's `reason` explains its tag.

## Not remarks

These diagnostics stay as they are, because the converted value is exact:
- `DEFAULT_AGGREGATOR_APPLIED`: Datadog's documented default.
- `LAYOUT_APPROXIMATED`: cosmetic.
- `OPTION_IGNORED`.

`TEMPLATE_VARIABLE_DROPPED` (a `*` default) is a candidate for a future tag.
