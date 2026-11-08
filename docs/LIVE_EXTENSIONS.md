# Alert and function extension comparison

Issue [#165](https://github.com/XNotAGuestX/thinchackdash/issues/165) adds a bounded
eight-case suite for the deterministic query/alert extensions. The source assets are
synthetic Datadog inputs. The normal offline compiler produces every destination artifact;
the live harness binds run filters and evaluates the original source functions/formula.
No model participates in conversion or verification.

The suite uses the retained infrastructure stream from
[#157](https://github.com/XNotAGuestX/thinchackdash/issues/157), with ten one-minute
buckets, five minutes of prior monitor/rate history, and two minutes ingestion allowance.
The Redis used/RSS formula is sent to Datadog as separate parsed metric leaves and a
formula. Its five-minute `avg`/`max` reduction is computed on the aligned source buckets,
then compared with the numeric left side of the generated disabled check rule. This
follows Datadog's documented
[classic arithmetic evaluation order](https://docs.datadoghq.com/monitors/guide/as-count-in-monitor-evaluations/).
`as_count()` monitor expressions remain blocked by the compiler because their evaluation
order differs. The harness never approximates an unrecognized monitor expression.

The tolerances are declared in `scripts/live/suites/extensions.yaml` before the live
comparison: **4.9%** for weighted gauges, rollups and explicit rates; **3%** for the
baseline gauge, exact dashboard ratio, and arithmetic monitors. Absolute tolerance is
zero. Every configured series requires full finite bucket coverage and nonzero data.
Threshold decisions must match at every bucket with zero numeric tolerance, independently
of the value comparison. Failures stay in the evidence and do not widen these tolerances.

```sh
uv run scripts/live_compare.py \
  --dataset-config scripts/live/datasets/infrastructure.yaml \
  --tests scripts/live/suites/extensions.yaml \
  --datadog-semantic-mode combined \
  --dash0-dataset default \
  --stream-dir /private/tmp/thinchackdash-157/out/live/infrastructure-stream \
  --env-file /Users/felix/tum/artemis/thinchackdash/.env \
  --out out/live/extensions
```

Use a new output directory after changing compiler artifacts or inputs; reuse the same
directory to preserve fixed windows and import receipts. `--dry-run` performs no vendor
requests. Checks remain disabled. Remote assets and the retained stream stay available;
their cleanup is a separate explicitly requested action.

The harness uses the official
[Datadog timeseries API](https://docs.datadoghq.com/api/latest/metrics/query-timeseries-data-across-multiple-products/)
to evaluate source formulas. It does not create or execute a Datadog monitor. Numeric
agreement does not verify alert scheduling, no-data handling, notifications, interpolation
across arbitrary gaps or weighted ephemeral-series churn. Steady shared telemetry can
support an empirical approximation result without proving those broader semantics.
The two monitor fixtures do not configure `evaluation_delay`; delayed evaluation is not
covered by this suite. The harness explicitly rejects a nonzero `evaluation_delay` so it
cannot compare an unshifted source window with a delayed target expression.

Seven focused tests cover category/tolerance declaration, complete arithmetic leaf binding,
Combined mode on every leaf, trailing-syntax rejection, source threshold checks and
conflicting-host rejection, plus explicit rejection of delayed source windows. The broader
harness retains its strict data/coverage checks.

Live source preflight observed one series with ten finite buckets for each of weighted
Redis memory, average/max rollup Redis memory and PostgreSQL explicit rate. This establishes
source availability only; the integrated destination comparison is recorded separately.

## Observed result, 2026-11-08

One integrated live run used the existing `default` demo dataset and retained stream
`demo-live-4c447ebf85d1`. The historical measurement window was **03:44–03:54 UTC**, end
exclusive, on a 60-second grid. The dry-run reported **8 cases, 0 blocked**. The actual
comparison exited **0: 8/8 passed**, with one nonzero series and **10/10 finite samples**
on each side for every case. No collection wait or second comparison run was needed.

| Case | Outcome | Relative mean difference | Declared tolerance | Result |
| --- | --- | ---: | ---: | --- |
| Redis weighted used memory | `best_effort` / `WEIGHTED` | 0.351950% | 4.9% | passed |
| Redis average rollup, 60s | `best_effort` / `ROLLUP` | 0.000000% | 4.9% | passed |
| Redis maximum rollup, 60s | `best_effort` / `ROLLUP` | 0.068225% | 4.9% | passed |
| PostgreSQL explicit rate | `best_effort` / `ASRATE` | 3.266330% | 4.9% | passed |
| Redis used-memory baseline | `translated` | 0.068225% | 3% | passed |
| Redis used/RSS dashboard ratio | `translated` | 0.068271% | 3% | passed |
| Average ratio monitor | `translated` | 0.072932% | 3% | passed |
| Maximum percentage monitor | `translated` | 0.068223% | 3% | passed |

Both degraded and failed threshold decisions agreed at all ten timestamps for each
monitor, independently of the numeric tolerance. Values stayed below both thresholds;
this run does not establish threshold-crossing or notification behavior.

All three generated demo-prefixed assets were API accepted and read back successfully:

| Asset | Returned ID | Read-back |
| --- | --- | --- |
| Function dashboard | `a8939cb3-aaeb-42cf-b084-6ae835835008` | passed |
| Average ratio check, disabled | `859023b6-6a73-40eb-80fa-8d8c32353600` | passed |
| Maximum percentage check, disabled | `b0dac707-4921-434f-bd4d-1563f7fac3ad` | passed |

The checks remained disabled, and all assets and the telemetry stream were retained.
UI rendering was not inspected. The weighted case used a stable reporting population;
it does not empirically validate sparse or ephemeral-series weighting. The reported
errors apply to the chosen ten-minute means, rather than a universal or per-bucket bound.
Numeric passes do not clear `remarkBehaviorValidation: not_run` for best-effort semantics.

Private, ignored evidence is in
`/private/tmp/thinchackdash-outcomes/out/live/extensions-165-20261108/comparison.json`
and `comparison.md`, with normal compilation artifacts and import receipts alongside.
No credentials, raw live responses or run artifacts are committed.
