# On-demand live comparison

The [alert/function extension suite](LIVE_EXTENSIONS.md) exercises `weighted()`, gauge
rollups, explicit rates and classic arithmetic metric monitors against a retained stream.
It declares case-specific tolerances before comparison and preserves strict data coverage
and per-bucket threshold decisions. `best_effort` outcomes participate in numeric checks;
their approximation semantics remain distinct from API acceptance and numeric agreement.

`scripts/live_compare.py` starts the full OpenTelemetry Demo, collects its metrics once,
exports them to Datadog and Dash0, converts configured Datadog assets with the existing
offline compiler, publishes demo-prefixed assets, verifies read-back and compares results.
It stops its containers after completion or a handled interruption. No model participates.

Implementation task: [#146](https://github.com/XNotAGuestX/thinchackdash/issues/146), expanding
[horizon #122](https://github.com/XNotAGuestX/thinchackdash/issues/122) at Felix's request.
This tests selected conversions using shared OTel samples. It does not establish equivalence
between independent native vendor collectors or verify actual alert delivery.

## Reuse a running stream

The infrastructure suite adds host metrics, Docker and Kafka to PostgreSQL, Redis and NGINX:
28 cases, including exact conversions and the approved `SEMANTIC`, `DERIVED`, `TOPN`,
`TIMEPIN`, `FULLWINDOW` and `NEWHOST` remarks. It uses the pending converter changes from
[PR #156](https://github.com/XNotAGuestX/thinchackdash/pull/156); implementation and evidence
are tracked in [#157](https://github.com/XNotAGuestX/thinchackdash/issues/157).

Start telemetry once, independently of any measurement. This command returns after Docker
startup and authentication; it does not wait through a warm-up or ten-minute measurement:

```sh
uv run scripts/live_compare.py \
  --dataset-config scripts/live/datasets/infrastructure.yaml \
  --tests scripts/live/suites/infrastructure.yaml \
  --datadog-semantic-mode combined --dash0-dataset default \
  --stream-dir out/live/infrastructure-stream --start-stream \
  --out out/live/start-only
```

Leave it running while working. Once it has enough real history, run any suite against its
latest completed window, with no collection sleep:

```sh
uv run scripts/live_compare.py \
  --dataset-config scripts/live/datasets/infrastructure.yaml \
  --tests scripts/live/suites/infrastructure.yaml \
  --datadog-semantic-mode combined --dash0-dataset default \
  --stream-dir out/live/infrastructure-stream --out out/live/infrastructure-01
```

The infrastructure suite is a short smoke: two minutes of measurement, with the same 3%
tolerance and complete coverage required. The original default suite retains its ten-minute
measurement. On first startup, real history must accumulate once: five minutes lookback,
the measurement window and two minutes ingestion allowance, rounded to the minute. Insufficient
history returns exit 2 immediately; leave the stream running and retry. Timestamps alone
do not establish data availability: the actual comparisons still require complete finite
samples and every expected series. A stopped, unhealthy or mismatched stream is rejected.
No historical values are fabricated. Host metrics describe the Collector's Linux environment
(the Docker VM on macOS); they are not measurements of the macOS host.

Repeat `--start-stream` to check the existing stream without restarting it. Repeat the same
comparison `--out` to reuse its original window and successful publication receipts. Use a
new `--out` for a new window, changed suite or case selection. Several output directories
share the stream's telemetry identity but have separate demo asset name prefixes. Neither
comparison failures nor interruptions stop a retained stream. A failed individual import
stays visible; unrelated successfully imported/read-back assets are still tested. Ambiguous
creation results remain unretried and require reconciliation.

Stop the selected stream with the same command as startup, replacing `--start-stream` with
`--stop-stream`. That removes only its Compose project and volumes; destination assets stay.
After a workload/receiver change, stop it and start it again before testing the new stream.

Each case records its expected and actual conversion category and remark tags. Numeric
parity and API/read-back evidence are separate from behavior equivalence: a passing tagged
case does not prove the `SEMANTIC` scope assumption, the ignored panel time pin, top-N display,
or monitor grace/full-window behavior. Those remain `remarkBehaviorValidation: not_run`.
Checks stay disabled. Missing data and differences above 3% remain failures for every category.

The infrastructure profile explicitly enables optional receiver metrics for PostgreSQL locks,
Redis maxmemory, host CPU utilization/available memory/total memory, and Docker container count.
Names and defaults are taken from the pinned Collector 0.160.0 metadata:
[PostgreSQL](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/receiver/postgresqlreceiver/metadata.yaml),
[Redis](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/receiver/redisreceiver/metadata.yaml),
[host CPU](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/receiver/hostmetricsreceiver/internal/scraper/cpuscraper/metadata.yaml),
[Docker](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/receiver/dockerstatsreceiver/metadata.yaml).

## Run

Prerequisites: uv, Docker Engine/Desktop with Compose, approximately 6 GB available RAM
and 14 GB disk for the full demo, outbound access to GitHub/GHCR and both vendors, an
existing **demo** Dash0 dataset, and vendor credentials. Containers expose ports only on
localhost with automatically allocated host ports. Existing stacks are left alone.

First validate configuration and source/target pairing offline:

```sh
uv run scripts/live_compare.py \
  --dataset-config scripts/live/datasets/otel-demo.yaml \
  --tests scripts/live/suites/default.yaml \
  --datadog-semantic-mode combined \
  --dash0-dataset migration-demo \
  --out out/live/demo-01 --dry-run
```

The script automatically reads the repository's private, gitignored `.env`. Use
`--env-file <path>` for another file, or `--no-env-file` for shell variables only.
Shell values override file values. Only the documented vendor variables are loaded;
other application credentials are ignored. Values are parsed literally: shell commands,
backticks and variable references are never executed or expanded. Credentials stay in
memory and inherited process environment; they are never embedded in the script.

Configure these variables:

| Variable | Purpose |
|---|---|
| `DD_SITE` | Datadog site, defaults to `datadoghq.eu` |
| `DD_API_KEY` | Required metrics **ingestion** API key; validated before starting containers |
| `DATADOG_PAT` / `DD_BEARER_TOKEN` | PAT for queries with `timeseries_query` permission; a nonempty `DD_BEARER_TOKEN` takes precedence |
| `DD_APP_KEY` | Query application key, needed only if no PAT is configured |
| `DASH0_API_URL` | HTTPS API URL; defaults to the project's `https://api.eu-west-1.aws.dash0.com` |
| `DASH0_OTLP_ENDPOINT` | HTTPS OTLP/HTTP **base** endpoint without `/v1/metrics`; defaults to `https://ingress.eu-west-1.aws.dash0.com` |
| `DASH0_AUTH_TOKEN` | Token with ingestion, query and import access to the demo dataset |

Run the same command without `--dry-run`. `--dash0-dataset` selects the dataset for
ingestion, queries and publication, overriding `DASH0_DATASET`. The script never creates
datasets or modifies source assets. It publishes all source assets configured in the suite;
repeatable `--case redis-memory --case connection-monitor` selects comparisons.

The default measurement takes about 17 minutes after startup: five minutes warm-up, ten
minutes measurement and two minutes ingestion allowance. Progress is printed every 30 seconds.
Image downloads and initial health checks add startup time.

A query PAT is not an ingestion API key. Create the latter in Datadog's
**Organization Settings → API Keys → New Key**, then save it as `DD_API_KEY` in `.env`.
The preflight verifies query access to both vendors and separately validates the ingestion
key before starting containers or publishing. A missing ingestion key is recorded explicitly;
successful query authentication alone is not reported as successful parity.

For this shared-OTel-sample environment, use `--datadog-semantic-mode combined`.
Datadog ingests OTel metric names, while the source fixtures query classic Datadog names.
Its documented [Combined telemetry mode](https://docs.datadoghq.com/metrics/open_telemetry/query_metrics/)
resolves those equivalent metrics in Datadog. Native mode queries only the literal metric
name and can correctly return no data even when the OTel samples have arrived. Availability
of this capability depends on the Datadog organization; an unavailable mode fails explicitly.

Without the override, the script honors a source query's declared `semantic_mode` and otherwise
uses Datadog's Native default. The explicit override affects live query evaluation only; it
does not change compiler inputs, target artifacts, collected samples or tolerance settings.
It is recorded in `querySettings` and every executed source query. Re-running the same output
directory with another explicit mode reuses the fixed measurement window and existing publish
receipts. Preserve prior `comparison.json`/`.md` first if both evaluations should be retained.

Exit codes: **0** all selected comparisons and read-backs passed; **2** comparison failures
or blocked conversions; **1** configuration, credentials, HTTP, Docker or cleanup failure.
An API-accepted dashboard with no data cannot pass. Missing Datadog integration aliases or
tags fail explicitly; no mapping is inferred and tolerances never widen automatically.

## Define datasets and tests independently

All paths inside configuration files are relative to the configuration file itself.
Unknown configuration keys and invalid values are rejected.

Workload profiles, such as `scripts/live/datasets/otel-demo.yaml`, define:

- `users`, `spawn_rate`, `collection_seconds`;
- enabled `receivers`: `postgresql`, `redis`, `nginx`, `kafkametrics`, optionally
  `hostmetrics` and `docker_stats` (the latter two mount host resources read-only);
- `seed_sql`: local SQL files applied to the isolated `astronomy_db` database with
  `ON_ERROR_STOP=1`, after startup and before warm-up;
- `feature_flags`: optional complete [flagd configuration](https://flagd.dev/reference/flag-definitions/)
  JSON file replacing the extracted demo's flag definitions. The original file is untouched.

The pinned full application stack and load generator stay the same across profiles.
The upstream feature-flag UI's mount is read-only so tests use the configured flags.
Additional observability backends and AI demo extras are not started. Only metrics are
exported to the vendors; application traces and logs are consumed locally by a nop exporter.

Test suites, such as `scripts/live/suites/default.yaml`, define `inputs`, `mappings`, timing
and an independent list of `cases`. Inputs are normal Datadog source JSON files/folders;
the existing compiler decides which constructs translate. `source` is the exact manifest
`sourceId`: an individually supplied file uses its filename; a folder uses `folder/path.json`.
Dashboards must fully translate to be published by this harness.

```yaml
version: 1
inputs: [../assets/dashboard.json]
mappings: [../../../mappings/datadog]
warmup_seconds: 300
window_seconds: 600
settle_seconds: 120
step_seconds: 60
rate_interval: 5m
cases:
  - id: connections
    source: dashboard.json
    request: /widgets/0/definition/requests/0
    formula_index: 0
    panel: widget-0
    query_index: 0
    variables: {host: $run}
    series_labels: {}
    mode: window_mean
    relative_tolerance_pct: 3
    absolute_tolerance: 0
    require_nonzero: true
```

`request` is a JSON pointer to the source request. `formula_index` selects a displayed
formula (or query when formulas are absent). `panel` and `query_index` reference the
**generated** Perses output. The harness checks the source widget indices and flattened
displayed-query ordering; a missing or inconsistent pair is rejected.

`variables` supplies literal values for declared source variables; `$run` means the generated
run ID. Source values must fit the supported literal tag grammar; unsafe substitutions are
rejected. Target regex values are escaped and JSON-encoded. Both executed expressions are
scoped to the run's `host`/`host_name` through their parsed syntax trees. Scoping happens at
execution time, before target series deduplication; artifacts and their hashes stay unchanged.

`series_labels` explicitly pairs grouping tags and labels, for example `{db: postgresql_database_name}`.
The source query must actually group by that tag, and the account must expose it. No label
correspondence is inferred. Extra series, missing groups and ambiguous keys fail.

`mode` is `window_mean` or `per_bucket`. Every matched series must have a finite sample at
every requested timestamp; no interpolation, nearest-point matching or dropped nulls.
Comparisons use the half-open historical interval `[start, end)`, on an aligned UTC grid.
Datadog is asked for the same interval as Dash0; a backend changing that grid fails coverage.
Datadog labels each bucket `[t, t+step)` with its start `t`, while PromQL evaluated at `t`
looks back from `t`; Dash0 is therefore evaluated at `t+step` and keyed by `t`, so both sides
describe the same bucket.
Default comparison uses each series' arithmetic mean on this common grid:

```text
abs(Dash0 - Datadog) <= max(absolute_tolerance, abs(Datadog) * relative_tolerance_pct / 100)
```

Set both tolerances to zero for exact numeric equality. With zero Datadog values, only
the absolute tolerance applies. `require_nonzero` defaults to true to prevent idle zero
signals from appearing convincing; set it to false for explicitly expected zero results.
Ranges are recorded for inspection; they do not substitute for the chosen comparison.

For a metric monitor, set `kind: monitor` and omit `request`/`panel`. The harness uses the
existing monitor parser, computes its source lookback reducer on the same step grid, and
queries the numeric left-hand side of the read-back check. Lookbacks must fit warm-up and
align to the query step. The generated check's thresholds must equal the source monitor's
(`critical` → `failed`, `warning` → `degraded`), otherwise the case is blocked. Threshold
decisions must agree at **every** timestamp independently of numeric tolerances. Checks remain disabled; actual evaluation scheduling, no-data policy,
and notifications are not verified by these numeric tests.

## Evidence, resumption and cleanup

The ignored output directory contains:

- `compiled/`: ordinary deterministic source copies, manifest, report, generated artifacts
  and the publisher's `import-results.json`;
- `state.json`: run ID, configuration/input fingerprint, fixed measurement window and
  collection/publication progress;
- `runtime/`: verified upstream source and isolated Compose/collector files;
- `comparison.json` and `comparison.md`: selected expressions, dataset, returned asset IDs,
  read-back outcomes, coverage, means/ranges, differences and threshold decisions.

Evidence is separate from compiler snapshots. Vendor response bodies are not saved in it;
credentials are inherited by the collector without being written into Compose. Run artifacts,
raw telemetry and credentials must not be committed. Current mappings keep their existing
review status; numerical evidence does not automatically set `reviewed`.

Rerun the identical command and output directory to resume. Completed collection reuses the
same historical window, and unchanged publication receipts prevent duplicate imports. Changed
inputs, mappings, compiler output, suite, selected cases, destination or profile require a new
output directory. A process lock prevents concurrent ownership of one output directory.

An ambiguous import receipt blocks retry. If the process died while publication was in
flight, `publicationInFlight` also blocks resumption even if no receipt was written. Inspect
Dash0 and reconcile every possibly created asset/receipt first; only then clear that marker
in `state.json`. Do not clear receipts to force a retry.

Normal completion and SIGINT/SIGTERM stop the owned project, including local volumes.
`--keep-running` explicitly retains it. For retained containers or an uncatchable process
kill, take `runId` from `state.json` and stop only that project:

```sh
docker compose -p <runId> -f <out>/runtime/compose.json down --volumes --remove-orphans
```

Dash0 assets are retained with their recorded IDs. Remote deletion is a separate explicit
operation. A cleanup failure yields exit 1 and is recorded in the evidence.

## Upstream pins and validation

The source is [OpenTelemetry Demo 3.1.0](https://github.com/open-telemetry/opentelemetry-demo/releases/tag/3.1.0),
commit `dedc0178918e260823323b8d95005a8cb924b007`, archive SHA-256
`60bc2420ede659375b54302799fc312443345457a6894b26ba5c2d7acc6895f7`.
`scripts/live/images.lock.json` pins all application/dependency image indexes; the official
Collector is overridden to `0.160.0`, matching the repository's metric definitions. Upstream
copyright and Apache-2.0 notices remain in the extracted source. No images are built.

The Datadog branch uses its supported exporter and its documented
[PostgreSQL cumulative-to-delta/rate processing](https://docs.datadoghq.com/opentelemetry/integrations/postgres_metrics/).
These rules are independent of migrator mappings. Dash0 receives the original cumulative
samples through its OTLP/HTTP endpoint and `Dash0-Dataset` header. Queries follow the official
[Datadog timeseries API](https://docs.datadoghq.com/api/latest/metrics/query-timeseries-data-across-multiple-products/)
and the repository's verified Dash0 Prometheus API contract.

Offline checks:

```sh
uv run migrator check
uv run ruff check scripts/live_compare.py scripts/live_compare_support
uv run mypy --strict scripts/live_compare.py scripts/live_compare_support
```

Focused tests use fake vendor APIs and stubbed Docker operations. They never establish live
parity. A real two-vendor run requires configured credentials and recorded IDs/read-back/
numeric evidence. On 2026-11-08 the authorized `.env` PAT and Dash0 token passed actual query
API checks; the subsequently supplied ingestion key also passed Datadog's validation API.
Read-only diagnostics confirmed that Combined mode returns the original source queries'
OTel-backed series. See `docs/STATUS.md` for the full recorded comparison outcome.
