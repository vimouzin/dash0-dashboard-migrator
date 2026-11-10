# mappings (T1, HOT)

Schema and loader: `src/ir/mappings.ts`. Format changes need a CONTRACT.

- `datadog/<integration>.yaml`: Datadog metric → `{otel, labels, ddKind, otelKind, unit, status, derived?, note}`.
  - `status`: `exact` | `approximate` | `none` (no equivalent: the panel becomes a placeholder with a finding).
  - `ddKind` says how **Datadog stores** the metric (gauge | rate | count | distribution).
  - `otelKind` says how the **OTel receiver emits** it (gauge | counter | updowncounter | histogram).
  - A kind change (Datadog `rate` → OTel `counter`) makes the translator insert `rate()` (D-18).
  - `labels` selects series of a shared OTel metric, e.g. `redis.cpu.sys` → `redis.cpu.time{state="sys"}`.
- `tags.yaml`: Datadog tag → Dash0 PromQL label (OTel attribute, dots → underscores).
- `notification-channels.yaml`: Datadog `@handle` → an **existing** Dash0 notification channel id, written by the user for their org. It ships empty. T6 binds mapped handles on the check rule, and the report lists unmapped ones as manual actions. `--channels <file>` points at another file. Nothing is ever created in Dash0.

`datadog/redisdb.yaml` is **generated**. Don't edit it by hand. Regenerate from the dash0-team workspace:
```
node scripts/build-redis-mapping.mjs <fork>/mappings/datadog/redisdb.yaml
```
Its sources (Datadog check constants, metadata.csv, OTel receiver metadata v0.164.0, the research crosswalk) are in the workspace at `docs/research/sources/redisdb/`. Current totals: 271 metrics: 39 exact, 22 approximate, 5 derived, 205 no equivalent. All 24 metrics used by the Redis overview dashboard and the high-memory monitor are covered, and 18 of them have an equivalent. 23 of its rows map to receiver metrics that are **disabled by default**, and each note says so; that includes `redis.maxmemory`, the high-memory monitor's denominator, so the Collector must enable it.

**Logic gates (plan 09).** `tests/ir/mappings-logic.test.ts` checks every row of every table against its pinned sources: the OTel name exists in the receiver metadata (L1), kind, unit and labels agree (L2-L4), a ddKind that differs from metadata.csv cites the check source (L5), default-off receiver metrics are declared in the note (L6), and `exact` only when no kind change is needed (L7). The receiver facts come from `datadog/_receivers.json`, **generated** in the workspace with `node scripts/build-receiver-facts.mjs <fork>/mappings/datadog/_receivers.json` from `docs/research/sources/`. A new integration needs its receiver metadata pinned there first.

## Collector setup (data only appears if the receiver emits the metric)

The tables say which OTel metric stands in for a Datadog one. They cannot make the receiver emit it. Today nothing in the report warns about this (a report-level "enable these metrics" action is a planned contract change), so panels over a metric the receiver does not emit simply show no data.

**PostgreSQL** (`postgresqlreceiver`, checked against v0.164.0 `metadata.yaml`). These nine mapped metrics are **disabled by default** and must be enabled:

```yaml
receivers:
  postgresql:
    endpoint: <host>:5432
    username: <user>
    password: <password>
    collection_interval: 10s
    metrics:
      postgresql.tup_inserted: { enabled: true }
      postgresql.tup_updated: { enabled: true }
      postgresql.tup_deleted: { enabled: true }
      postgresql.tup_fetched: { enabled: true }
      postgresql.tup_returned: { enabled: true }
      postgresql.sequential_scans: { enabled: true }
      postgresql.temp.io: { enabled: true }
      postgresql.function.calls: { enabled: true }
      postgresql.database.locks: { enabled: true }
```
- `postgresql.function.calls` also depends on Postgres's `track_functions` setting. In the live check (`track_functions=all`, no user-defined functions called) it had no series, so its panel ("Top function calls") stayed empty.
- Verified live with this config: the Postgres and NGINX fixture dashboards return data in Dash0 (44 of 53 items with queries, `scripts/returns-data.ts`). Not tested: the receiver's default config, where these nine metrics are simply not emitted.
- The receiver logs a warning that the feature gate `receiver.postgresql.separateSchemaAttr` is off. It changes how schema and table are labelled on table-level metrics, and the db/table/schema tags are not mapped yet.

**NGINX** (`nginxreceiver`): needs `stub_status` exposed (for example `location /status { stub_status; }`) and `endpoint: http://<host>/status`. The mapped metrics (`nginx.connections_current`, `nginx.requests`) are enabled by default.

**Kubernetes** (`kubernetes.yaml` → `kubeletstatsreceiver` + `k8sclusterreceiver`; `kubernetes_state.yaml` → `k8sclusterreceiver`; both checked against v0.164.0). Usage (CPU, memory, network, filesystem) comes from `kubeletstats` on every node. Requests, limits, restarts and the workload counts (deployment, daemonset, statefulset, replicaset, job) come from one `k8s_cluster` receiver. Datadog's `kube_*` and `pod_name` tags map to the `k8s.*` resource attributes (`tags.yaml`). Two mapped metrics are **disabled by default**:

```yaml
receivers:
  kubeletstats:
    auth_type: serviceAccount
    endpoint: https://${env:K8S_NODE_NAME}:10250
    metrics:
      k8s.container.memory_limit_utilization: { enabled: true }   # kubernetes.memory.usage_pct
  k8s_cluster:
    metrics:
      k8s.container.status.state: { enabled: true }               # kubernetes_state.container.running / .terminated
```
- 40 of the 77 rows are `status: none`. These are object counts (`*.count`, `pods.running`), node capacity and allocatable (k8s_cluster v0.164.0 doesn't emit them), `pod.status_phase` and `node.by_condition` (the receiver encodes the phase or status in the value, not in a label), probe results and disk IO. They become placeholders that say so, not panels that stay empty.
- `kubernetes.filesystem.usage_pct` and `kubernetes.node.filesystem.usage_pct` are `derived` (usage / capacity) and stay manual until derived expressions are translated.
- Not verified on a live cluster yet.

**Host metrics** (`system.*`, `hostmetricsreceiver`, `datadog/system.yaml`; Datadog side from the datadog-agent 7.60.0 core checks). Scrapers needed: `cpu`, `load`, `memory`, `disk`, `network`. These mapped metrics are **disabled by default** and must be enabled:

```yaml
receivers:
  hostmetrics:
    collection_interval: 10s
    scrapers:
      cpu:
        metrics:
          system.cpu.utilization: { enabled: true }   # system.cpu.idle/iowait/stolen (+ derived user/system/interrupt)
      load: {}
      memory:
        metrics:
          system.memory.limit: { enabled: true }            # system.mem.total
          system.linux.memory.available: { enabled: true }  # system.mem.usable (Linux only)
          system.memory.linux.shared: { enabled: true }     # system.mem.shared
      disk: {}
      network: {}
```
- `system.cpu.utilization` is averaged over CPUs by default (`attributes: [state]`, `aggregation_strategy: avg`), which is what Datadog's `system.cpu.*` percent means. Don't opt in the `cpu` attribute, or the series must be averaged again.
- Rows with `scale` (CPU percent = fraction x 100, memory MiB = bytes / 1048576) stay `metric.needs_transform` (manual) until `select.metric.transform` ships. Rows with `derived` (`system.cpu.user`/`system`/`interrupt`, `system.io.util`, `system.mem.used`, ...) stay manual until derived expressions are translated.
