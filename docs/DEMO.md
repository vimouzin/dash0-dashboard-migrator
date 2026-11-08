# Demo runbook: Postgres, Datadog → Dash0

**First acceptance gate: conversion is fully deterministic, with no LLM involved in source-to-Perses or query/alert translation.** Optional model-based conversion, repair, and fallback paths also fail this gate. Demo speed or appearance cannot override it.

The demo migrates the pinned DataDog/integrations-core Postgres assets (commit `a9b9e42`) into the Dash0 dataset `default`. It shows one dashboard, one monitor turned into a check rule, and an honest list of everything that was blocked.

**What has actually been run (2026-11-07), and what hasn't:**

| Step | State |
|---|---|
| `convert` on the Postgres fixtures | Run. Output below is real. Its dashboard, check-rule and Prometheus rule files match the goldens `fixtures/expected/postgres-p1/` and `fixtures/expected/postgres-monitors/`; `report.json` and `manifest.json` differ, because each golden converts only its own folder |
| `publish --dry-run` | Run, with placeholder credentials (a dry run sends nothing) |
| Dash0 import API (live) | Run 2026-11-07 (plan 07 Task 1): `demo-Postgres - Metrics` and the disabled `demo-[Postgres] …` check rule were imported and read back; see `docs/STATUS.md` |
| `publish` (live) | Run 2026-11-07 ~20:10 UTC (plan 07 Task 5): the check rule and both dashboards imported with `demo-` names, read back equal, rerun `UNCHANGED`; ids and output in `docs/STATUS.md`. UI checked: the Metrics dashboard shows live data except Network traffic (rate window too short for sparse data); the Overview panels render too short (layout height not scaled) |
| Converted queries in Dash0 | Checked read-only through the Dash0 MCP server (dataset `default`); results in `docs/STATUS.md` |
| `fetch` (live) | **Not run.** Needs blocker B3, a Datadog account. Only tested against a fake API |
| Threshold crossing with `scripts/hold-pg-connections.sh` | **Not run.** Tested against a stub `docker` only. Needs blocker B2, the demo telemetry owner |

Update this table as the live steps happen. Never present generated JSON as a migrated dashboard: the evidence for a live import is returned IDs, read-back output and UI screenshots.

## Prepare (at least 30 minutes before)

1. **Telemetry is flowing.** `default` has Postgres data only while the OTel Demo stack runs on its host (`docker-desktop`); see [DASH0_INVENTORY.md caveat 1](DASH0_INVENTORY.md#caveats). In Dash0, check that `postgresql.backends` has fresh points.
2. **Credentials in the shell, never in arguments or files you share:**

   ```bash
   export DASH0_API_URL='<your API URL>'   # e.g. https://api.eu-west-1.aws.dash0.com
   export DASH0_DATASET=default
   read -rs DASH0_AUTH_TOKEN; export DASH0_AUTH_TOKEN   # paste the token (scoped to dataset default); it isn't echoed
   ```

   Or keep all three in a local `.env` (copied from `.env.example`, never committed) and load it with `set -a; . ./.env; set +a`.

3. **Start the threshold crossing early.** The check's window is 15 minutes, so a crossing shows up only after at least 15 minutes of held connections. Current usage is about 0.08 against thresholds of 0.8 (degraded) and 0.9 (failed). The holder script adds idle sessions and refuses to exceed `max_connections`:

   ```bash
   export PG_CONTAINER=<postgres container> PGUSER=… PGDATABASE=… PGPASSWORD=…
   scripts/hold-pg-connections.sh <count> 1800 --dry-run   # check the plan first
   scripts/hold-pg-connections.sh <count> 1800             # Ctrl-C releases every session
   ```

   Pick `<count>` so that (current + count) / max_connections lands between 0.8 and 0.9 for "degraded", or above 0.9 for "failed". The script refuses to go past `max_connections` − `superuser_reserved_connections`. Capture screenshots of both states as they happen. They are the evidence for step 6 if the live crossing isn't finished in time.

   **Planned numbers (not yet run live; blocker B2).** A read-only Dash0 check on 2026-11-07 showed about 8 backends (ratio ≈ 0.08), so `max_connections` ≈ 100:

   | `<count>` | Usage | State |
   |---|---|---|
   | 75 | (8 + 75) / 100 ≈ 0.83 | degraded |
   | 85 | (8 + 85) / 100 ≈ 0.93 | failed |

   The `--dry-run` line prints the measured `max_connections` and current count. That count includes background workers (autovacuum, walwriter, …), so it reads a little higher than the client connections Dash0 shows. Record the live values here after the run.

4. **Have the fallback ready** (see "Fallback" below).

## Show the migration (about five minutes)

### 1. The source

Open `fixtures/datadog/integrations-core/postgres/`:

- `dashboards/postgresql_dashboard.json` ("Postgres - Metrics", 9 timeseries widgets);
- `monitors/percent_usage_connections.json`: `avg(last_15m):avg:postgresql.percent_usage_connections{*} > 0.9`, warning 0.8.

Point at one query, its 15-minute lookback and both thresholds.

### 2. Convert (offline, deterministic)

```bash
uv run migrator convert --source datadog \
  --input fixtures/datadog/integrations-core/postgres \
  --mapping mappings/datadog --out /tmp/pg-demo
```

Real output:

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

Exit code `2`, because something is partial or blocked. Show:

- `mappings/datadog/postgres.json` and `host.json`: the explicit Datadog → OTel pairs, each with its evidence `ref` and `reviewed`;
- `dashboards/postgres-metrics.json`: the Connections panel, `avg by (postgresql_database_name) (max by (postgresql_database_name, service_instance_id) ({otel_metric_name="postgresql.backends", otel_metric_type="sum"}))` (the inner `max` deduplicates series after a collector restart);
- `check-rules/<slug>.json`: `avg_over_time((<connection ratio>)[15m:1m]) > $__threshold`, thresholds `{degraded: 0.8, failed: 0.9}`, `enabled: false`, no `id`;
- `rules/<slug>.prometheus.json`: the same condition as warning and critical Prometheus rules.

Running it twice produces identical bytes; `tests/test_golden_dashboards.py` checks this.

### 3. What didn't translate, and why

Open `report.json`. Every widget and monitor has an outcome and, if blocked, a diagnostic with a source path and a suggested action:

- `replication_delay` is blocked with `UNSUPPORTED_QUERY_FUNCTION`: `Function 'anomalies' is not supported.`
- In "Postgres - Metrics" (zero-based paths, as in `report.json`), `widgets[3]`, `widgets[5]` and `widgets[7]` are blocked with `MISSING_METRIC_MAPPING` (`system.io.util`, `system.cpu.guest`, `system.mem.*`). `widgets[2]` and `widgets[4]` translate with the default `avg` and warn `DEFAULT_AGGREGATOR_APPLIED`.
- "Postgres - Overview" blocks 22 of 30 widgets: `toplist`, `query_table` and `log_stream` widgets (`UNSUPPORTED_WIDGET`); unmapped metrics such as `postgresql.dead_rows` (`MISSING_METRIC_MAPPING`); formulas such as `week_before(...)` (`UNSUPPORTED_FORMULA`); and the query functions `.as_count()` and `.rollup()` (`UNSUPPORTED_QUERY_FUNCTION`).

Nothing is silently dropped. A widget is all or nothing.

### 4. Publish

Demo resources carry a `demo-` prefix (AGENTS.md), so every publish in this runbook passes `--name-prefix demo-`. The prefix is added to each dashboard's `metadata.name` and display name and to the check rule's name at send time; the files in `/tmp/pg-demo`, their sha256 and the manifest stay as `convert` wrote them.

```bash
uv run migrator publish --from /tmp/pg-demo --dry-run --allow-partial --name-prefix demo-
```

Real output (with a placeholder URL):

```text
SKIP monitor postgres/monitors/replication_delay.json  (blocked in convert)
DRY-RUN POST https://api.eu-west-1.aws.dash0.com/api/import/check-rule?dataset=default  demo-[Postgres] Number of connections is approaching connection limit on {{host.name}}  (publish)
DRY-RUN POST https://api.eu-west-1.aws.dash0.com/api/import/dashboard?dataset=default  demo-Postgres - Metrics  (publish)
DRY-RUN POST https://api.eu-west-1.aws.dash0.com/api/import/dashboard?dataset=default  demo-Postgres - Overview  (publish)
```

Without `--allow-partial`, the two partial dashboards are skipped too. `publish` reads JSON, so convert without `--format yaml` for a run you'll publish. Then, with the user's explicit go-ahead, run it without `--dry-run` (keep `--name-prefix demo-`). Show the `IMPORTED … id=…` lines and `/tmp/pg-demo/import-results.json`, whose receipts record `"namePrefix": "demo-"`. A second run with the same prefix reports `UNCHANGED`; a run with another prefix, or none, is refused. Publishing is create-only and never overwrites.

### 5. The dashboard in Dash0

Open "demo-Postgres - Metrics" in Dash0. The Connections chart shows two series, `astronomy_db` and `postgres`. A read-only check on 2026-11-07 returned 5 and 3. Point out the blocked widgets are absent, as the report said.

### 6. The check rule

Open the imported check rule, "demo-[Postgres] Number of connections …". It shows the expression, the 15-minute window inside the expression, and thresholds 0.8 / 0.9, and it's disabled. Enable **only this demo check**, as part of the requested demo. Show it go degraded and then failed while the holder script runs, live or from the screenshots captured in "Prepare". Afterwards, stop the script (Ctrl-C releases every session) and disable the check again.

### 7. The limits

Close with the supported subset and the known limits from the [README](../README.md#known-limits). They include:

- only metric queries and metric monitors;
- no query functions;
- mappings that a human must review;
- notifications that are not migrated.

## Fallback

- **Telemetry stopped, or the network fails:** rerun `convert` live (it's offline), then show earlier evidence. Label it on screen as **earlier evidence, captured on <date>**: returned IDs, read-back JSON and screenshots of the dashboard and the check states. Never claim the current attempt succeeded.
- **No live import has ever succeeded:** show `convert`, the dry run and the read-only query checks recorded in `docs/STATUS.md`, and say plainly that live acceptance is incomplete.
- **An import timed out:** its receipt says `unknown`, and `publish` refuses to send it again. Look in Dash0 for the asset, reconcile `import-results.json` by hand, then retry.

## Evidence to keep

| Claim | Evidence |
|---|---|
| Deterministic conversion | Goldens and the determinism test; `uv run migrator check` output |
| Correct queries | The mapping `ref`s, the generated PromQL, read-only Dash0 query results |
| Dashboard imported | The returned ID, read-back JSON, a screenshot with live data |
| Check rule imported and working | The returned ID, read-back JSON, screenshots of degraded and failed |
| Honest incompatibilities | `report.json` diagnostics; skipped entries in the publish output |
| Partial failure handling | Per-asset receipts in `import-results.json` |

Keep source exports, API responses, receipts and screenshots in ignored local directories. Sanitize anything that goes into the PR.

## Cleanup

Disable the demo check after the demo. Deleting imported resources is a separate, explicit action; keep the IDs from `import-results.json` for it.
