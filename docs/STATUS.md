# Shared project status

2026-11-08 follow-up to #177: Felix explicitly authorized Agent0 recommendations
only on user request for blocked items, with a three-call backend-session limit and
then a plain sales prompt (sandy@dash0.com). `/api/suggest` keeps draft recommendations
separate from compiler artifacts/outcomes. No automatic AI or publication. Existing
MCP dependencies are reused. Tests for this follow-up were skipped at Felix's request;
the passing counts below refer to the preceding backend commit, not this AI addition.

2026-11-08 local UI update ([#177](https://github.com/XNotAGuestX/thinchackdash/issues/177),
stacked on frontend PR #174): `backend/` serves the frontend and runs the unchanged
offline converter on uploaded JSON or the pinned Postgres demo. Real rows show exact
outcome categories; translated warnings are hidden and other warnings show short names
only. Full diagnostics and target artifacts remain in the downloadable results.
Dashboard failures remain hidden at Felix's request. Conversion makes no vendor calls; no publishing,
numeric comparison or streamed progress; [mismatch list](../backend/README.md#frontendbackend-mismatches).
Checks: `uv run migrator check` passed (ruff, strict mypy: 89 files;
**1013 passed / 621 skipped**). Explicit backend strict typing/lint and 5 frontend
adapter tests also passed. Converter, mappings, dependencies and goldens are unchanged.

Last updated: 2026-11-08: full-table draft mappings (#171 / #175, PRs #172 / #176) now
validate explicit unit factors and reject catalog conflicts. Generation produces 194
unreviewed entries and skips 1,871 names with reasons. Kubernetes CPU usage preserves
Datadog nanocore values with a factor of 10⁹. Unknown/incompatible unit pairs and three
conflicting Kubernetes memory/filesystem definitions remain unmapped. Existing hand-written
mappings and review flags are unchanged; no live parity or destination import is claimed.

Verification: `uv run migrator check` passed (ruff, strict mypy, **1,022 passed / 621 skipped**).
The generator check reproduces the committed output. Two offline runs over all 845 pinned
assets from 253 integrations exited 2 and produced **1,334 byte-identical files**. Blocked
widgets changed from 12,451 before the vendor mappings to **12,411** (12,406 before the review
fixes); converted monitors remain **5**, up from 3. Syntax/schema passed; API and semantics
remain `not_run`. Private ignored evidence: `out/review-fixes/` in the isolated PR worktree.

Earlier update: general-input safeguards and mapping coverage implemented on
`167-general-inputs` ([#167](https://github.com/XNotAGuestX/thinchackdash/issues/167)); the required
check passes (993 passed, 621 skipped). Review found no blocking issues; Felix explicitly
authorized merging [PR #168](https://github.com/XNotAGuestX/thinchackdash/pull/168).
The prior alert/function extension PR #166 is merged. Earlier comparison failures remain
tracked in #148 and #161. Open work: the orchestrator handoff [`handoff/README.md`](handoff/README.md).
Work is tracked in [issues](https://github.com/XNotAGuestX/thinchackdash/issues) and on the
[project board](https://github.com/users/XNotAGuestX/projects/3).

General-input behavior (#167): no recognized assets produces `NO_SUPPORTED_ASSETS`, exit 1,
before output creation. Mixed recognized/skipped files preserve source copies and supported
artifacts, show skipped-file warnings, and exit 2. The Datadog provider inspects known metric
query slots with the existing full parsers before compilation; the deterministic report and
terminal summary show exact metric mapping presence, missing names and source locations,
and explicitly unparsed queries. File/folder names never choose an integration. Mapping
coverage does not bypass compiler semantics or prove runtime equivalence. Target selection
and bundle extraction remain outside this change.

Verification: `uv run migrator check` passed (ruff, strict mypy: 88 files; **993 passed /
621 skipped**, 25.53s); focused general-input/conversion tests: **41 passed**. The final check
used localhost access for existing HTTP transport tests. Six frozen reports were regenerated
and checked to differ only by the new `mappingCoverage` field: target dashboards, rules,
manifests and all existing report fields are unchanged. No vendor calls or live semantic
verification were performed for this offline change.

2026-11-08 update ([#146](https://github.com/XNotAGuestX/thinchackdash/issues/146), branch
`146-live-comparison`): on-demand comparison harness implemented with independent workload
profiles/test suites, shared-sample exports, publication/read-back, strict numeric comparison,
resumable receipts and cleanup. Default six-case dry-run passes. A local-only full-demo smoke
started all 23 containers healthy and observed five expected nonzero metric families
(Postgres backends/fetched tuples, Redis used/RSS memory, nginx connections); its containers,
network and local volumes were removed. Collector 0.160.0 configuration validated with
networking disabled. The script now loads the private `.env` literally and supports
`DATADOG_PAT`/`DD_BEARER_TOKEN` query authentication. Actual Datadog/Dash0 query calls returned
HTTP 200, and the supplied Datadog ingestion key validated successfully. The authorized full
shared-sample run against the existing demo dataset `default` completed; detailed results below.
See [LIVE_COMPARE.md](LIVE_COMPARE.md).

Verification on an isolated uv-managed CPython 3.13.18 environment, synced from `uv.lock`:
`uv run migrator check` → **781 passed, 621 skipped**, ruff and mypy strict passed.
The new harness also passes explicit script lint/type checks and 69 focused offline tests.

Highest-priority requirement: deterministic conversion before all other objectives. No LLM involvement in source-to-Perses or query/alert conversion, including optional inference, repair, and fallback paths. Codex and Claude remain implementation assistants only.

## Actual state

The current branch adds classic metric-alert arithmetic and exact evaluation-delay rendering,
plus bounded `weighted()`, `rollup()` and `as_rate()` functions under a distinct `best_effort`
category. Reports, manifests, descriptions and publish groups preserve every reason tag.
The single consolidated review integrates parallel tasks #162–#165 and the retained-stream
implementation from pending #159. No mapping review flags, dependencies or source assets changed.

The full pinned inventory with `mappings/datadog` now emits **122/251 widgets**, up from
118/251: four Kafka panels move from blocked to `best_effort`. Redis `high_mem` arithmetic
also converts, raising supported monitors from **2/13 to 3/13**. All nine dashboards remain
partial because independent metric/widget gaps persist. `.as_count()`, `.fill()`, ambiguous
modifier chains and unsupported metric kinds still block. Frozen goldens were regenerated;
unreviewed oracle proposals were not accepted or rewritten.

Final verification, uv-managed CPython 3.13.18 and locked dependencies:
`uv run migrator check` passed: ruff, strict mypy (86 files), **971 passed / 621 skipped**.
Explicit live-script ruff and strict mypy also passed (8 files). Four HTTP transport tests
need localhost socket access, so the final required check ran outside the network sandbox.

One actual retained-stream comparison in demo dataset `default`, **2026-11-08 03:44–03:54 UTC**,
passed **8/8 cases**, exit 0, with 10/10 finite samples on each side for every case:

| Case | Relative mean difference | Declared tolerance |
| --- | ---: | ---: |
| Redis weighted memory | 0.351950% | 4.9% |
| Redis average rollup | 0.000000% | 4.9% |
| Redis maximum rollup | 0.068225% | 4.9% |
| PostgreSQL explicit rate | 3.266330% | 4.9% |
| Redis baseline memory | 0.068225% | 3% |
| Dashboard memory ratio | 0.068271% | 3% |
| Average ratio monitor | 0.072932% | 3% |
| Maximum percentage monitor | 0.068223% | 3% |

Both alert threshold levels agreed at every sampled timestamp. All three destination
assets were imported and read back: dashboard `a8939cb3-aaeb-42cf-b084-6ae835835008`,
disabled average check `859023b6-6a73-40eb-80fa-8d8c32353600`, disabled maximum check
`b0dac707-4921-434f-bd4d-1563f7fac3ad`. The stream and assets were retained. No second
comparison run or collection wait was needed. Threshold crossing, UI rendering,
notification delivery and irregular/churning weighted series remain unverified; stable
numeric evidence does not remove the `best_effort` category or prove a universal error bound.
Delayed monitor comparison is explicitly rejected by the harness until source history
shifting is implemented. See [LIVE_EXTENSIONS.md](LIVE_EXTENSIONS.md) for reproduction and
private ignored evidence locations. Compiler `api`/`semantics` validation remains `not_run`.

| Area | State | Evidence |
| --- | --- | --- |
| CLI/runtime/package | `convert` (offline), `publish` (run live 2026-11-07), `fetch` (offline-tested; live is horizon #122) | Python ≥ 3.13 + uv; `uv run migrator {convert,publish,fetch,test,typecheck,lint,check}` |
| Dashboards | Plans 02–05 merged | Golden `fixtures/expected/postgres-p1/` (byte-equal and determinism tests) |
| Monitors | Plan 06 merged; branch #162 adds classic arithmetic and evaluation delay; Redis high-memory now supported, replication anomalies still blocked | [ALERT_CONVERSION.md](ALERT_CONVERSION.md), goldens and live extension comparison |
| Mappings | `postgres`, `kafka`, `docker`, `redis`, `nginx`; every entry `reviewed: null` | `mappings/datadog/`; Redis/nginx notes in `REVIEW-redis-nginx.md` |
| Oracle cases | 9 integrations-core dashboards, 207 requests; Agent0 proposals plus the deterministic rules in `scripts/build_expected.py`; none human-reviewed, so they skip by default | `fixtures/expected/*/*/expected.yaml`; `uv run pytest --include-unreviewed` |
| Dash0 | Import contract checked live; Postgres dashboards and the disabled check rule published and read back | Sections below; sanitized responses in `fixtures/dash0/live-2026-11-07/` |
| Live comparison | Extension run: 8/8 pass at declared 3%/4.9%, all 3 assets read back; earlier 4/6 and infrastructure 9/28 results retain their failures | [LIVE_EXTENSIONS.md](LIVE_EXTENSIONS.md); follow-ups #148/#161 |
| Telemetry | Retained infrastructure stream `demo-live-4c447ebf85d1` is running in `default`; original on-demand stack is stopped | [LIVE_COMPARE.md](LIVE_COMPARE.md), #157 |
| Automated checks | Green on branch `164-best-effort-outcomes`: `uv run migrator check` (ruff, mypy --strict, pytest) | 971 passed, 621 skipped (unreviewed oracle cases); uv-managed Python and locked dependencies |
| Submission | Not started | #2; steps in `handoff/README.md`, "Human-only items" (only on the user's request) |

## Live shared-sample comparison (2026-11-08)

Felix explicitly authorized the credentials, synthetic ingestion and demo publication.
The script loaded the private `.env`, used a PAT for Datadog queries and an API key for
ingestion, and exported the same collected OTel samples to both vendors. Dataset: `default`.
Measurement: **02:32:00–02:42:00 UTC**, end exclusive, 60-second grid. Every case had 10/10
finite samples on both sides.

Datadog ingested OTel names such as `postgresql.backends`, rather than materializing classic
aliases. Native-mode source queries returned no data and the harness correctly exited 2.
An explicit Combined-mode re-evaluation reused the same window, compiler artifacts and
publication receipts. It also exited **2**, with these numeric results:

| Case | Relative mean difference | Result at 3% |
|---|---:|---|
| Postgres fetched-row rate | 0.25285% | passed |
| Redis used memory | 0.08970% | passed |
| nginx connections | 0.21459% | passed |
| Redis memory formula | 0.03672% | passed |
| Postgres connections | 3.27869% | failed |
| Connection monitor value | 3.27869% | failed |

For both failed cases, the Datadog mean was **3.0499999** and Dash0's was **2.95**.
The monitor's degraded/failed threshold decisions agreed at every point, but its numeric
value still failed tolerance. The threshold remains 3%; no cases or samples were dropped.
The cause is not established; investigation is [#148](https://github.com/XNotAGuestX/thinchackdash/issues/148).

Actual destination assets, both read back successfully:

- Dashboard: `7f5f3850-b2d0-4e99-850d-973169f3586e`.
- Check rule: `22cecb88-a883-4c77-bf02-44805efcecc9`, **disabled**.

Re-evaluation retained the same two IDs and two imported receipts. The isolated Compose
project was stopped; a subsequent project `ps -a` returned no containers. The assets remain
in Dash0. This is functional live evidence for the passing cases, not a claim of full parity.

Private, gitignored evidence: `out/live/credentials-run-20261108/comparison.json` and `.md`;
the Native baseline is preserved as `comparison-native.json` and `.md`. No credentials,
raw API responses or run artifacts are committed.

## Recorded decisions

- 2026-11-07 (user): translation does not need to be source-agnostic. Datadog is the only P0 source. Each source provider owns its parsing, mapping, and translation; the requirement is one `SourceProvider` interface with a static table selected by `--source`, plus shared output types (Perses dashboards, PromQL check conditions, diagnostics, outcomes). If a shared contract would limit Datadog functionality, discuss it with the user before compromising features. Contract: `src/migrator/source/provider.py`; decision D1 in `handoff/00-context.md`.
- 2026-11-07 (user): remaining work runs as an orchestrated, parallel handoff (`handoff/README.md`, epic #104); live Datadog is a feature horizon (#122), not scheduled.
- 2026-11-07 (user): the LLM triage of oracle expectations (Agent0 judge, Haiku cross-check, lint, mutations, `TRIAGE.md`, `verified.json`) is removed. An expectation counts only after a human review.
- 2026-11-08 (user): expand #122 into an on-demand shared-OTel-sample comparison environment
  using the full OTel Demo, independently definable workloads/tests/destination dataset,
  publication/read-back and a default 3% per-series window-mean tolerance. Keep checks disabled
  and preserve deterministic conversion artifacts; implementation is #146.

## Known blockers

- **B2 demo telemetry owner** (#4): `default` data exists only while one machine runs the OTel Demo stack.
- **No controlled threshold crossing.** Postgres connection usage is about 0.08 against thresholds 0.8 and 0.9; `scripts/hold-pg-connections.sh` exists, the live run needs B2 and an enabled demo check.
- **B3 comparison credentials resolved:** the authorized PAT and ingestion API key work for
  the live harness. The asset-`fetch` round trip remains unverified (#122); harness PAT support
  does not change the core fetch client's authentication contract.
- **Starter/fork relationship** (#2) unresolved; settle before submission.
- **Mapping review:** every entry is `reviewed: null`; evidence and goldens per service are #111–#115, the sign-off is human.
- **Target labels** follow the data (postgresqlreceiver 0.160.0, legacy `postgresql_database_name`, `postgresql_table_name`); the user still has to confirm them.
- **Series deduplication:** resource-hash churn after a collector restart makes `sum` double-count; mappings deduplicate with `grain` (`max by (service_instance_id, …)`), see [DASH0_INVENTORY.md caveat 2](DASH0_INVENTORY.md#caveats).
- Semantics, manual read-only check (2026-11-07, dataset `default`): Connections `astronomy_db` = 5, `postgres` = 3; `percent_usage_connections` ≈ 0.08; widget 0 `rate(postgresql.tup_fetched)` ≈ 84.7/s; I/O wait ≈ 0.47 %; network receive ≈ 886 kB/s. Not recorded in `report.validation.semantics`.

## Dash0 import contract (live, plan 07 Task 1, 2026-11-07)

Run by Claude with the user's go-ahead, one POST each, no retry, dataset `default`. Read-only calls before that: `GET /api/dashboards` (list of `{id, name, dataset}`, `name` = `metadata.name`), `GET /api/dashboards/{id}`, `GET /api/alerting/check-rules` (empty).

| Asset | Request | Response | Id | Read-back |
|---|---|---|---|---|
| Dashboard `demo-postgres-metrics` ("demo-Postgres - Metrics", P1 golden, 4 `TimeSeriesChart` panels) | `POST /api/import/dashboard?dataset=default` | 200, the stored dashboard (`kind`, `metadata`, `spec`) with **no id anywhere** and no `Location` header | `eebfaf39-969d-4fe3-b379-9234d77e1937`, found only by listing | `GET /api/dashboards/{id}` 200; `spec` byte-equal to what was sent |
| Check rule `demo-[Postgres] Number of connections … {{host.name}}`, `enabled: false` | `POST /api/import/check-rule?dataset=default` | 200, the rule with `id` | `987f6f55-cda3-4afe-b742-71d68b42e267` at `id` | `GET /api/alerting/check-rules/{id}` 200; read-back has no `id` field |

Findings:

- **Dashboard id:** the old `DASHBOARD_ID_PATH = metadata.dash0Extensions.id` was wrong; every dashboard import would have been `unknown`. Fixed on `48-dash0-client`: `publish_dashboard` lists before and after the import and takes the one new id with the dashboard's `metadata.name` (exactly one, else `unknown`).
- **`metadata.project`** is accepted: `datadog-migration` is kept, and Dash0 files the dashboard in folder `/datadog-migration` (annotation `dash0.com/folder-path`). Dash0 adds `labels: {dash0.com/source: ui}`, `dash0Extensions: {dataset}`, `version: 1` and timestamps.
- **Check rule normalization:** `interval` `1m` → `1m0s`; defaults added: `keep_firing_for: 0s`, `dataset`, `metadata.labels`. `name`, `expression` (with `[15m:1m]` and `$__threshold`), `thresholds`, `for`, `annotations` and `enabled: false` come back unchanged. The `{{host.name}}` in the name is stored verbatim; whether it is rendered can only be seen once the rule evaluates.
- **Panel kinds** seen in existing UI dashboards: `Markdown`, `PieChart`, `StatChart`, `TimeSeriesChart` (Grid layout, `PrometheusTimeSeriesQuery`), so `StatChart` and `Markdown` from plan 05 are known kinds. Not yet checked visually: that the imported panels render with data, and `ListVariable`.
- **Cleanup (user-approved, 2026-11-07 20:08 UTC):** `DELETE /api/dashboards/{id}` and `DELETE /api/alerting/check-rules/{id}` (with `?dataset=default`) both returned 200. Deletion is soft: a GET by id still returns 200 with the annotation `dash0.com/deleted-at`, but both list endpoints leave the assets out (dashboards back to the two `telemetry-inventory-*`, check rules back to 0). So the before/after listing in `publish_dashboard` doesn't see deleted dashboards.

## Live publish (plan 07 Task 5, 2026-11-07 ~20:10 UTC)

Run by Claude with the user's go-ahead ("Yes, publish all 3"), from a fresh `convert` of the pinned Postgres fixtures:

```bash
uv run migrator publish --from <run> --allow-partial --name-prefix demo-
```

Output (exit 2, because `replication_delay` stays blocked in convert):

```text
SKIP monitor postgres/monitors/replication_delay.json  (blocked in convert)
IMPORTED check-rules/postgres-number-of-connections-is-approaching-connection-limit-o.json  id=e9092eac-9faf-422f-8092-64996413ef51
IMPORTED dashboards/postgres-metrics.json  id=73d981c4-15e7-4ca9-b3d1-fa43534490e3
IMPORTED dashboards/postgres-overview.json  id=8a2ac1bb-7bee-4bc3-8323-4bbe34224baa
```

- **Receipts:** `import-results.json` has all three as `imported`, HTTP 200, `namePrefix: demo-`, with the ids above (the dashboard ids found by the before/after listing).
- **Read-back:** both dashboards (`demo-Postgres - Metrics`, 4 panels; `demo-Postgres - Overview`, 8 panels) return a `spec` equal to what was sent, project `datadog-migration`. The check rule reads back `enabled: false`, thresholds 0.8 / 0.9; only the known normalizations differ (`interval` `1m0s`, `keep_firing_for`, `dataset`, `metadata`).
- **Rerun:** the same command again reports all three `UNCHANGED (already imported)` and sends nothing.
- **Live data:** the Connections panel's query returned `astronomy_db` = 5, `postgres` = 3 at 20:11 UTC (Dash0 MCP, read-only).
- **UI check (2026-11-07 ~20:15 UTC, Dash0 app, signed in by the user; screenshots kept locally, not committed):**
  - *Check rule:* listed under "Disabled check rules" as `demo-[Postgres] Number of connections … on {{host.name}}`; preview chart shows the ratio ≈ 0.08 under the 0.8 and 0.9 lines; Thresholds field shows critical 0.9 and degraded 0.8. The list subtitle shows the escaped Datadog description literally (`{{ "{{" }}#is_alert{{ "}}" }} …`), as intended (Datadog templates are not executed). Dash0 notes that no notification channel receives the rule, as expected.
  - *demo-Postgres - Metrics:* 3 of 4 panels show live data (Rows fetched/returned/inserted/updated, Connections `astronomy_db`/`postgres`, I/O wait). **Network traffic shows "No data"**, with a Dash0 warning: "The queried metrics have gaps, causing rate, increase, and similar functions to return potentially wrong results. Consider changing the range to at least 120s." The same query with `[5m]` returns ≈ 904 kB/s, so `system.network.io` is too sparse for `[$__rate_interval]`. Follow-up: [#90](https://github.com/XNotAGuestX/thinchackdash/issues/90) (a reviewed per-entry rate window in the mapping).
  - *demo-Postgres - Overview:* groups and panels render, but every panel is only 1–2 grid rows tall, so the charts are squashed to a title and legend. Cause: plan 04 copies Datadog's `height` unchanged (`height = height`) while scaling only `x`/`width` by 2; Dash0's own dashboards use heights of 5–8. Follow-up: [#89](https://github.com/XNotAGuestX/thinchackdash/issues/89) (a reviewed height scale in plan 04; Track A code, `_GridBuilder.place`).
- **Not yet done:** enabling the check and the threshold crossing (blocker B2, `scripts/hold-pg-connections.sh`); whether `{{host.name}}` renders in a firing check's name.
- **Cleanup:** the three assets stay for the demo. Deleting them is a separate, explicit action (ids above).

## Handoff entry template

Post this as a comment on the issue at a meaningful handoff. Update the current-state table above only when the overall state changes, rather than leaving contradictory entries.

```text
Time / contributor:
Task and files owned:
Completed behavior:
Checks run and actual results:
Live evidence, if any (sanitized IDs/links or private evidence location):
Contract changes / decisions:
Remaining blockers:
Next concrete task:
Ownership released or retained:
```
