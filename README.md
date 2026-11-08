# Datadog → Dash0 Migrator

**📄 Presentation: [Deterministic Migration (Dash0 case)](00_dash0_case_pr%C3%A4sentation.pdf)**

The local UI also supports explicitly requested Agent0 recommendations for blocked
translations, capped at three calls per backend session. These drafts stay separate
from the deterministic converter; see the exception in [AGENTS.md](AGENTS.md).

**Highest priority, before anything else: deterministic conversion. No LLM shall be involved in translation from a source to Perses, PromQL, or Dash0 check rules—not even as an optional fallback. Reduce MVP scope before compromising this rule.** Codex and Claude may help write the implementation and tests; migration itself uses explicit parsers, mappings, and deterministic rules only.

A deterministic CLI that migrates Datadog dashboards and metric monitors to Dash0. Dashboards become Perses dashboards; metric monitors become Dash0 check rules and Prometheus rule groups. Every metric pair comes from an explicit, human-reviewed mapping file. Anything outside the supported subset is blocked with a diagnostic instead of being guessed.

**State (2026-11-07):**
- `convert` works offline and is covered by golden tests.
- `publish` has run live against Dash0: the Postgres check rule and both dashboards were imported and read back (plan 07 Task 5).
- `fetch` is implemented but its asset-fetch round trip has only been tested against a fake API.

See [STATUS.md](docs/STATUS.md) for details and [DEMO.md](docs/DEMO.md) for the demo runbook.

Metric monitors support classic arithmetic and evaluation delay, producing disabled Dash0
checks and Prometheus rules from one condition. See [alert conversion](docs/ALERT_CONVERSION.md).
Bounded `.weighted()`, `.rollup()` and `.as_rate()` conversions produce the distinct
`best_effort` category with visible limitations; unsupported combinations still block.
See [function grammar](docs/FUNCTION_CONVERSION.md), [remark categories](docs/REMARKS.md)
and [empirical verification](docs/LIVE_EXTENSIONS.md).

## Install and test

Needs Python ≥ 3.13 and [uv](https://docs.astral.sh/uv/). Everything runs through one entry point, `uv run migrator <command>`:

```bash
uv sync                      # install runtime and dev dependencies
uv run migrator check        # ruff + mypy --strict + pytest
uv run migrator test -k parse    # pytest; extra args pass through
uv run migrator typecheck    # mypy --strict over src and tests
uv run migrator lint         # ruff
```

## Compare live Datadog and Dash0 values

The on-demand harness reuses the full OpenTelemetry Demo and its load generator, sends
shared samples to both vendors, publishes converted demo assets, verifies read-back and
compares each matched series within a configurable tolerance (default 3%). Workload profiles,
comparison suites and the Dash0 dataset are independently selectable.

```sh
uv run scripts/live_compare.py \
  --dataset-config scripts/live/datasets/otel-demo.yaml \
  --tests scripts/live/suites/default.yaml \
  --datadog-semantic-mode combined \
  --dash0-dataset migration-demo --out out/live/demo-01 --dry-run
```

The script loads the repository `.env` automatically. Configure `DD_API_KEY` for ingestion,
`DATADOG_PAT` (or `DD_BEARER_TOKEN`) for queries and `DASH0_AUTH_TOKEN`, then remove `--dry-run`.
Dash0 endpoints default to the project's EU West region and can be overridden.
See [LIVE_COMPARE.md](docs/LIVE_COMPARE.md) for configuration, evidence, resumption and cleanup.
The real two-vendor run passed 4/6 cases at 3%; two Postgres connection cases differed by
3.28% and remain failed. See [recorded evidence](docs/STATUS.md#live-shared-sample-comparison-2026-11-08).
Imported checks remain disabled.

For broader coverage, the [28-case infrastructure suite](docs/LIVE_COMPARE.md#reuse-a-running-stream)
includes Kafka, host and Docker plus approved assumed/approximated cases. Start a retained
stream once; subsequent suites reuse its real history without another collection wait.

## Convert (offline)

For the local upload-and-convert UI, run `uv run python -m backend.server` and open
<http://localhost:3001/>. Upload Datadog JSON or use the pinned demo. This runs the same
offline converter; results show exact outcome categories and can be downloaded.
Publishing and numeric comparison are unavailable in this UI.
See [backend/README.md](backend/README.md) for setup and frontend/backend mismatches.

```bash
uv run migrator convert --source datadog \
  --input fixtures/datadog/integrations-core/postgres \
  --mapping mappings/datadog --out /tmp/pg-out
```

Example outcome summary (the mapping coverage section follows the totals):

```text
Dashboards
  PARTIAL     postgres-metrics   6/9 widgets
  PARTIAL     postgres-overview  8/30 widgets

Monitors
  TRANSLATED  postgres/monitors/percent_usage_connections.json
  BLOCKED     postgres/monitors/replication_delay.json

Totals        translated     partial     blocked
  dashboards           0           2           0
  widgets             14           0          25
  monitors             1           0           1
  skipped files: 0
```

`--input` takes files or folders, which are read recursively. `--mapping` takes a mapping file or a folder; a folder means its `*.json` files, sorted, not recursive. Repeat `--mapping` to add more. Without `--mapping`, the repository's `mappings/<source>` folder is used, so `--source datadog` loads every file in `mappings/datadog`. All files merge into one table; a metric defined in two files is an input error naming both. `--out` must be empty. It receives:

- `dashboards/<slug>.json`: Perses dashboards, the Dash0 import body;
- `check-rules/<slug>.json`: Dash0 check-rule bodies, disabled and without an `id`;
- `rules/<slug>.prometheus.json`: Prometheus rule groups, warning then critical;
- `source/`: byte copies of the inputs;
- `report.json`: an outcome per dashboard, widget and monitor, every diagnostic, each mapping file's name and sha256, and metric mapping coverage;
- `manifest.json`: every file with its sha256 and whether it is eligible to publish.

Options: `--format yaml` writes the dashboards and Prometheus rules as YAML. `--project <name>` sets the Perses project; the default is `datadog-migration`.

General-purpose dashboards can mix integrations: filenames and folder names never select a
service. The whole explicit mapping table (`mappings/datadog`) is available by default.
Before compiling assets, the provider inspects known metric-query slots with the full query
parsers. The terminal summary and `report.json.mappingCoverage` list missing metric names and
every source location, plus queries whose syntax could not be parsed. Mapping coverage checks
name presence only; functions, labels, units, options and other semantics can still block an
otherwise mapped query. Unparsed queries never count as covered.

`uv run scripts/generate_vendor_mappings.py` rebuilds the draft `vendor-table.json` mappings
from the pinned vendor table and type metadata; `--check` verifies the committed bytes and
`--skipped` lists rejected names and reasons. Generation requires explicit compatible unit
pairs and rejects conflicting OTel definitions. Unit rules preserve Datadog values (for example,
cores become nanocores with a factor of 10⁹); a conflicting vendor scale is rejected. Unknown
or incompatible units stay unmapped. All generated entries keep `reviewed: null` and require
human review; generation does not establish live telemetry equivalence.

Each JSON file must contain one recognized dashboard or monitor. Arrays and export wrappers
such as `{"dashboards": [...]}` remain unsupported. Empty folders and inputs with no recognized
assets fail with `NO_SUPPORTED_ASSETS` before output is created. A run containing both recognized
and skipped files preserves all inputs, prints each skipped-file warning and returns exit 2.

Exit codes:
- `0`: everything translated (an `approximated` or `assumed` item, converted with an approved remark tag, still gives `2`; see [docs/REMARKS.md](docs/REMARKS.md));
- `2`: something partial, blocked or skipped (also converted items with remark categories);
- `1`: bad input, mapping or arguments, including no recognized assets.

The same inputs, mapping and version always produce the same bytes.

To view the converted dashboards in a local Perses (Docker, bound to `127.0.0.1`; queries go to Dash0 through its proxy, so set `DASH0_AUTH_TOKEN` to see data, or any placeholder to see the layout only):

```bash
DASH0_AUTH_TOKEN=... docker compose -f scripts/review/docker-compose.yaml up -d
uv run scripts/review/load_local.py /tmp/pg-out    # prints each dashboard's URL
```

Or in one step, reading the token from `.env`: `scripts/review/up.sh` (converts every integration, loads it and prints each URL; Ctrl-C stops it). See [scripts/review/README.md](scripts/review/README.md).

## Publish to Dash0

```bash
uv run migrator publish --from /tmp/pg-out --dry-run           # print the plan; send nothing
uv run migrator publish --from /tmp/pg-out --allow-partial     # import, including partial dashboards
uv run migrator publish --from /tmp/pg-out --dry-run --name-prefix demo-   # demo names: demo-Postgres - Metrics, …
```

> **Run live on 2026-11-07** (plan 07 Task 5): the Postgres check rule and both dashboards imported into `default` with `--name-prefix demo-`, read back equal, and a rerun reported `UNCHANGED`. See [STATUS.md](docs/STATUS.md#live-publish-plan-07-task-5-2026-11-07-2010-utc).

`publish` reads JSON output only: a run converted with `--format yaml` fails with "not valid JSON".

**What it sends:** translated dashboards and check rules from `manifest.json`. Partial dashboards go only with `--allow-partial`. Prometheus rule files and sources are never sent.

**`--name-prefix PREFIX`** (1–32 characters of `a-z`, `0-9`, `-`, e.g. `demo-`) prepends PREFIX to each dashboard's `metadata.name` and display name and to each check rule's name, at send time; the files, their sha256 and the manifest are unchanged, and the renamed body is validated again. Receipts record the prefix, and a rerun with a different prefix is refused. Use it for demo resources.

**How it sends them:**
- Before the first request, it checks every path, sha256 and schema.
- For each dashboard it also lists the dataset's dashboards (`GET /api/dashboards`) before and after the import, because the import response has no id.
- It is create-only: it never sends a dashboard's `metadata.dash0Extensions.id` or a check-rule `id`.
- Receipts in `<run dir>/import-results.json` make reruns safe. An imported asset reports `UNCHANGED`. A changed or ambiguous (`unknown`: a timeout or network error, any HTTP 5xx, or a 2xx without an ID) asset is refused until a human reconciles it. Only a 4xx counts as a definite failure that may be retried.
- HTTP 401 or 403 stops the run.

Exit codes:
- `0`: all imported or unchanged;
- `2`: something excluded;
- `1`: any failure, unknown result, refusal or validation error.

## Fetch from Datadog (read-only)

```bash
uv run migrator fetch --source datadog --dashboard-id abc-def-123 --monitor-id 4242 --out /tmp/dd-in
uv run migrator convert --source datadog --input /tmp/dd-in --mapping mappings/datadog --out /tmp/dd-out
```

> **Not yet run live.** Waits on a Datadog account (blocker B3). The argument and site validation paths have been run; the requests have only been tested against a fake API, including a fetch → convert round trip that matches the Postgres golden byte for byte.

**What it does:** downloads the selected dashboards and monitors unchanged, into `dashboards/<id>.json` and `monitors/<id>.json`.

**Safety checks:**
- Every ID, the site and the empty `--out` are validated before any request.
- Nothing is written unless every request succeeded.
- Errors carry the HTTP status, a hint (for example "needs the dashboards_read scope") and a body cut to 500 characters, with no key values.

Exit codes: `0` on success, `1` on any error.

## Environment variables

The CLI reads the process environment and doesn't load `.env` itself. Copy `.env.example` to `.env`, fill it in locally, and load it with `set -a; . ./.env; set +a`. Never pass secrets as arguments, and never commit them.

| Variable | Used by | Notes |
|---|---|---|
| `DASH0_API_URL` | `publish` | Your organization's API base URL (Settings → Endpoints); http(s), trailing `/` ignored |
| `DASH0_AUTH_TOKEN` | `publish` | Sent as `Authorization: Bearer`; redacted from every message |
| `DASH0_DATASET` | `publish` | Target dataset, e.g. `default` |
| `DD_API_KEY`, `DD_APP_KEY` | `fetch` | The application key needs `dashboards_read` / `monitors_read`; both are redacted from errors |
| `DD_SITE` | `fetch` | Bare host, default `datadoghq.eu` |
| `PG_CONTAINER`, `PGUSER`, `PGDATABASE`, `PGPASSWORD` | `scripts/hold-pg-connections.sh` | Demo only; passed into the container by name, never printed |

A missing variable gives `error: missing env: <NAMES>` and exit 1, without printing any values.

## Supported subset

**Assets:** Datadog dashboards in their raw JSON shape, and monitors either as the API's `definition` or wrapped as in integrations-core.

**Widgets:**
- `timeseries` becomes a `TimeSeriesChart`, `query_value` a `StatChart` and `note` a `Markdown` panel.
- `group` widgets are flattened into the grid.
- Other widget types (toplist, table, heatmap, …) are blocked with `UNSUPPORTED_WIDGET`.
- A widget is all or nothing: it never drops one of its series.
- Empty `time: {}` is a no-op. Supported pinned `live_span` windows convert with an `approximated` `TIMEPIN` remark: the panel follows the dashboard time picker, so query values and rankings can change. Independent query or mapping errors still block; see [the time-window limits](docs/REMARKS.md#approximated).

**Queries:**
- Supported form: `<avg|sum|min|max>:<metric>{<tag filters, $template vars>} by {<tags>}`.
- Formulas are limited to `+ - * /` over query names and numbers.
- Any query function (`anomalies`, `week_before`, `top`, …) blocks the query with `UNSUPPORTED_QUERY_FUNCTION`.
- A query without a space aggregator uses Datadog's default, `avg`, and warns `DEFAULT_AGGREGATOR_APPLIED` ([docs](https://docs.datadoghq.com/dashboards/querying/#aggregation-method)).

**Mappings** (`mappings/datadog/*.json`): each entry maps a Datadog metric to a Dash0 OTel metric. There are three kinds:
- `gauge`: a direct value;
- `rate`: `rate(...[$__rate_interval])` for per-second counters;
- `expression`: a reviewed PromQL template, such as the deduplicated connection ratio.

Entries can also carry fixed label matchers, unit scale, label renames and a deduplication grain. A file may set top-level `labels`: entries without their own `labels` inherit them, and an entry's own `labels` replace them whole. An unmapped metric or label blocks the query. Entries with `reviewed: null` still convert but carry an `UNREVIEWED_MAPPING` warning; only a human sets `reviewed`. An entry may carry an `assumption` tag when no exact OTel metric exists, and a file may record unmappable metrics under `gaps`; see [docs/REMARKS.md](docs/REMARKS.md). Files exist for `postgres`, `kafka`, `jvm`, `zookeeper`, `docker`, `redis`, `nginx` and `host` (`system.*` metrics).

**Monitors:**
- Supported: `query alert` / `metric alert` with `<avg|max|min|sum>(last_<n><m|h|d>):<query> <op> <number>`, a window ≤ 7 days, and options within the reviewed allowlist.
- They render as `<agg>_over_time((<query>)[<window>:1m]) <op> <threshold>`. The window stays in the expression, never in `for`.
- The inline threshold must equal `options.thresholds.critical`, and the warning must sit on the correct side of critical.
- Datadog `{{…}}` templates in the annotations are escaped, so Go templates print them rather than execute them.

## Known limits

- **Partial coverage by design.** The Postgres goldens translate 6/9 "Metrics" widgets and 8/30 "Overview" widgets. `report.json` names the reason for every block.
- **Monitor behaviour that isn't migrated:**
  - notifications and `@handles` (`NOTIFICATION_NOT_MIGRATED`);
  - no-data alerts, auto-resolve, renotify, escalation and recovery thresholds (all block the monitor);
  - a new-host grace period and full-window evaluation, which convert as `approximated` with the remark tags `NEWHOST` and `FULLWINDOW` ([docs/REMARKS.md](docs/REMARKS.md)).
- **Mappings need human review.** Every shipped entry is still `reviewed: null`.
- **Series churn.** After a collector restart, Dash0 can briefly hold two series for one instance. Sums must deduplicate first, as the Postgres entries do with `max by (service_instance_id, …)`; see [DASH0_INVENTORY.md caveat 2](docs/DASH0_INVENTORY.md#caveats).
- **Ephemeral demo data.** The `default` dataset has data only while the demo stack runs ([caveat 1](docs/DASH0_INVENTORY.md#caveats)).
- **Dash0 import contract (checked live 2026-11-07, plan 07 Task 1):** a check rule's id comes back at `id`. A dashboard import returns no id, so `publish` lists the dataset's dashboards before and after and takes the one new id with that `metadata.name`; anything else is `unknown`. Still open: whether Dash0 renders `{{…}}` in a check-rule `name`. Details in [STATUS.md](docs/STATUS.md#dash0-import-contract-live-plan-07-task-1-2026-11-07).
- **Validation level.** `report.validation` records syntax and schema checks only. API acceptance and semantics are proven separately (`docs/STATUS.md`).

## For contributors

1. Read [AGENTS.md](AGENTS.md), the shared working rules for humans, Codex and Claude. [CLAUDE.md](CLAUDE.md) points Claude to the same rules.
2. Read [the open work list](docs/handoff/README.md) and [the shared spec](docs/handoff/00-context.md).
3. Work is tracked in [GitHub issues](https://github.com/XNotAGuestX/thinchackdash/issues): one branch per issue, and every PR is reviewed by XNotAGuestX.
4. Background: the challenge requirements in [SOURCES.md](docs/SOURCES.md) and the Dash0 data in [DASH0_INVENTORY.md](docs/DASH0_INVENTORY.md).

**Stack:**
- Python ≥ 3.13 with uv, one package (`src/migrator`) and one console script (`migrator`).
- Libraries: argparse, pydantic (strict), `promql-parser`, PyYAML.
- Tooling: pytest, mypy --strict, ruff.
- One `SourceProvider` interface is selected with `--source`; only `datadog` exists so far.
