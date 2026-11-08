# Dash0 inventory (M0)

This file records a read-only inventory of the Dash0 organization, taken on **2026-11-07 at about 14:50 UTC** through the `dash0` MCP server. It contains only names, counts and label keys. Raw responses, token labels and organization IDs are deliberately left out.

Data changes over time. Re-run the checks in [Method](#method) before relying on this file.

## Summary

- The organization is in EU (`eu-west-1`) and has two datasets: `default` and `dash0-demo` ("OTel Demo").
- **`default`** holds a local OpenTelemetry Demo (Astronomy Shop) run. It includes live Postgres, Redis, nginx, Kafka, host, Docker and HTTP-check receiver metrics, plus traces and logs. **The data is ephemeral:** every signal starts at 2026-11-07 14:06 UTC and comes from a single `docker-desktop` host.
- **`dash0-demo`** is Dash0's shared, always-on demo. It has Kubernetes, JVM, AWS and GCP data, but **no database receiver metrics**. Treat it as read-only and never import into it.
- Postgres stays the golden case: it has the richest data in `default`, and its Datadog dashboard and monitors map to it. The service order is in [Service order](#service-order).

## `default` dataset

### Origin

| Property | Value |
|---|---|
| First data (logs, spans and metrics) | 2026-11-07 14:06 UTC |
| Host | `docker-desktop` (arm64), the only `host.name` |
| `service.namespace` | `opentelemetry-demo` |
| Collector | `otelcol-contrib`; receivers at version 0.160.0 |
| Collector restart | About 14:48 UTC. The resource hashes rotated, so each logical series is split across two hashes (see [Caveats](#caveats)) |
| Existing dashboards | `telemetry-inventory-overview`, `telemetry-inventory-by-source` |

### Traces and logs

- **Spans, 24 h, 19 services:** frontend, frontend-proxy, flagd, frontend-web, product-catalog, cart, image-provider, recommendation, load-generator, currency, ad, checkout, quote, shipping, telemetry-docs, email, accounting, payment, fraud-detection.
- **Logs, 18 services:** the same set without flagd, frontend-web, image-provider and telemetry-docs, plus kafka and otelcol-contrib, plus one group without a `service.name`.

### Receiver metrics

Label keys below are in PromQL form: attribute dots become underscores.

#### postgresqlreceiver 0.160.0 (27 metrics)

| Metric | Type | Unit |
|---|---|---|
| `postgresql.backends` | sum | `1` |
| `postgresql.connection.max` | gauge | `{connections}` |
| `postgresql.commits` | sum | `1` |
| `postgresql.rollbacks` | sum | `1` |
| `postgresql.deadlocks` | sum | `{deadlock}` |
| `postgresql.db_size` | sum | `By` |
| `postgresql.database.count` | sum | `{databases}` |
| `postgresql.table.count` | sum | `{table}` |
| `postgresql.table.size` | sum | `By` |
| `postgresql.table.vacuum.count` | sum | `{vacuum}` |
| `postgresql.index.scans` | sum | `{scans}` |
| `postgresql.index.size` | gauge | `By` |
| `postgresql.operations` | sum | `1` |
| `postgresql.rows` | sum | `1` |
| `postgresql.blocks_read` | sum | `1` |
| `postgresql.blks_hit`, `postgresql.blks_read` | sum | `{blks_hit}`, `{blks_read}` |
| `postgresql.bgwriter.{buffers.allocated, buffers.writes, checkpoint.count, duration, maxwritten}` | sum | various |
| `postgresql.tup_{fetched, returned, inserted, updated, deleted}` | sum | `{tup_*}` |

**Labels:**

- `postgresql_database_name`: `astronomy_db`, `postgres`.
- `postgresql_table_name`: for example `accounting.order`, `accounting.orderitem`, `accounting.shipping`, `catalog.products`.
- `operation`: `ins`, `upd`, `del`, `hot_upd`.
- `source`: `heap_hit`, `heap_read`, `idx_hit`, `idx_read`, `tidx_hit`, `tidx_read`, `toast_hit`, `toast_read`.
- `service_instance_id`: `astronomy-db:5432`.
- `host_name`.

**Not present:**

- The semconv attribute names `db_namespace` and `db_collection_name`.
- `server_address` and `service_name`.
- The replication and WAL metrics; there's no replica.

**Observed values:**

- `postgresql.connection.max` is 100.
- `max by (postgresql_database_name)` of `backends` is about 5 for `astronomy_db` and about 3 for `postgres`, so connection usage is about 0.08.

#### redisreceiver (29 metrics)

- `redis.clients.{blocked, connected, max_input_buffer, max_output_buffer}`
- `redis.commands`, `redis.commands.processed`
- `redis.connections.{received, rejected}`
- `redis.cpu.time`
- `redis.db.{avg_ttl, expires, keys}`
- `redis.keys.{evicted, expired}`
- `redis.keyspace.{hits, misses}`
- `redis.latest_fork`
- `redis.memory.{fragmentation_ratio, lua, peak, rss, used}`
- `redis.net.{input, output}`
- `redis.rdb.changes_since_last_save`
- `redis.replication.{backlog_first_byte_offset, offset}`
- `redis.slaves.connected`
- `redis.uptime`

Label: `redis_version=7.2.4`. **`redis.maxmemory` is not present.**

#### nginxreceiver (4 metrics)

`nginx.connections_accepted`, `nginx.connections_current` (label `state`), `nginx.connections_handled`, `nginx.requests`.

#### kafkametricsreceiver (11 metrics)

- `kafka.brokers`
- `kafka.consumer_group.{lag, lag_sum, members, offset, offset_sum}`
- `kafka.partition.{current_offset, oldest_offset, replicas, replicas_in_sync}`
- `kafka.topic.partitions`

Labels: `group` (`accounting`, `fraud-detection`), `topic` (`orders`).

#### Kafka broker JMX (`io.opentelemetry.jmx`, 20 metrics)

- `kafka.controller.active.count`
- `kafka.isr.operation.count`
- `kafka.lag.max`
- `kafka.leaderElection.unclean.count`
- `kafka.logs.flush.{Count, time.50p, time.99p}`
- `kafka.message.count`
- `kafka.network.io`
- `kafka.partition.{count, offline, underReplicated}`
- `kafka.purgatory.size`
- `kafka.request.{count, failed, queue, time.50p, time.99p, time.total}`

**Labels:**

- `service_name=kafka`.
- `type` on `request.*`: `Produce`, `FetchConsumer`, `FetchFollower`.
- `service_instance_id`: a random UUID per broker start, so it rotates on each restart.

**Observed values:** `kafka.partition.offline` is 0, and the Produce p99 is about 14 ms.

#### hostmetricsreceiver (about 34 metrics)

- `system.cpu.{load_average.1m, load_average.5m, load_average.15m, logical.count, time, utilization}`
- `system.memory.{limit, usage, utilization}`
- `system.network.{connection.count, dropped, errors, io, packets}`
- `system.disk.{io, io_time, merged, operation_time, operations, pending_operations, weighted_io_time}`
- `system.filesystem.{inodes.usage, usage}`
- `system.paging.{faults, operations, usage, utilization}`
- `system.process.{count, created}`, `system.uptime`
- `process.{cpu.time, disk.io, memory.usage, memory.virtual}`

**Labels use the newer semconv names:** `cpu_mode`, `cpu_logical_number`, `system_memory_state`, `system_network_direction`, `system_device`, `network_interface_name`. There are **no** `state` or `direction` labels on these metrics.

#### Other receivers and app instrumentation

| Source | Metrics |
|---|---|
| dockerstatsreceiver | `container.cpu.*`, `container.memory.*`, `container.network.io.usage.*`, `container.blockio.io_service_bytes_recursive`, `container.uptime` (labels `container_name`, `container_image_name`) |
| httpcheckreceiver | `httpcheck.{duration, error, status}` (label `http_url`) |
| SDK and app | `db.client.operation.duration`, `db.client.operation.npgsql.*`, `db.sql.connection.*` (otelsql), `http.{client,server}.*`, `jvm.*`, `kafka.consumer.*`, `dotnet.*`, `aspnetcore.*`, `cpython.gc.*` |
| Dash0 platform | `dash0.*` (spans, logs, web, synthetic checks, `gen_ai`). These come back for every catalog filter; ignore them when ranking services |

## `dash0-demo` dataset

- Kubernetes cluster `demo-eu-west-1-demo`, with about 49 `service.name` values (OTel Demo services, argocd, falco, parca, grafana, prometheus, `pixelforge-*`, `postgres`, `redis-server`).
- `cloud.provider` values: `aws`, `gcp` and others.
- Instrumentation scopes include k8sclusterreceiver, kubeletstatsreceiver, prometheusreceiver, JMX, Java runtime, Kafka clients, and the Dash0 AWS and GCP integrations.
- 13 existing dashboards, including MySQL, JVM, kubeletstats, container metrics and the Dash0 operator.
- **No `postgresql.*`, `redis.*`, `nginx.*`, `mysql.*`, `mongodb.*` or `elasticsearch.*` metrics**, and no `pg_*`, `mysql_*` or `redis_*` Prometheus-style names apart from argocd's own Redis client metrics.

## Caveats

1. **The data is ephemeral.** `default` has data only while one machine runs the OTel Demo stack. A migrated dashboard is empty, and a check has no data, while that stack is off. The 15-minute monitor window needs at least 15 continuous minutes of data.
2. **Resource-hash churn.** After the collector restart at about 14:48, each Postgres series showed up under two `dash0_resource_hash` values for about one scrape window. A plain `sum` briefly doubled the value (5 → 10). Mappings that sum across series must deduplicate first, e.g. `max by (service_instance_id, postgresql_database_name)`, and be checked at a 1-minute step.
3. **Coarse-step artifacts.** `sum` over a 7-day range at a 6-hour step returned 48 backends and a usage ratio of 0.805, while the true values were 5 and 0.08. Check values over short ranges at the target evaluation step.
4. **No controlled threshold crossing yet.** Connection usage is about 0.08. The golden monitor's thresholds are 0.8 (warning) and 0.9 (critical). Crossing them needs a connection-holder script or a deliberate demo `max_connections`; changing the source thresholds isn't allowed.
5. **The MCP server is read-only.** It can't export a dashboard's JSON, list or import check rules, or import anything. The known-good dashboard export and publishing still need a `DASH0_AUTH_TOKEN`, or a manual JSON export from the UI.

## Service order

Ranking criteria: metrics present in Dash0 (required), then integrations-core dashboards and monitors exist, then metrics_mapping coverage, then simple query features.

integrations-core assets were checked at commit `a9b9e42b7e484861ecbd1f5919da7c52a694b74d`.

| # | Service | Dash0 data | integrations-core assets | Expected outcome |
|---|---|---|---|---|
| 1 | **Postgres (golden)** | 27 metrics, live | "Postgres - Metrics" (9 timeseries), "Postgres - Overview"; monitors `percent_usage_connections`, `replication_delay` | The Connections widget and the connection-usage monitor translate. `replication_delay` is the blocked example (`anomalies`; no replication data) |
| 2 | Host (`system.*`) | live | Widgets 3–8 of "Postgres - Metrics" | Load and network translate. CPU and I/O wait need a ×100 scale. Disk utilization and memory need derived or formula support |
| 3 | Kafka | 20 broker JMX metrics + 11 kafkametrics (consumer-group lag, partitions) | `kafka_dashboard.json` (23 timeseries, groups, query_value, topology_map…); monitors `kafka_offline_partition`, `broker_produce_latency`, `kafka_high_producer_request_rate` | **2 of 3 monitors have direct counterparts:** `offline_partitions_count > 1` → `kafka.partition.offline`, and `request.produce.time.99percentile by {instance} > 200` → `kafka.request.time.99p{type="Produce"}` (grouped alert, P1). The producer-rate monitor uses `anomalies`, so it's blocked. Zookeeper, data-streams and producer-client widgets are blocked |
| 4 | Redis | 29 metrics | `overview.json` (15 timeseries, 10 query_value, toplist, distribution, notes); monitor `high_mem` | Most widgets map. `high_mem` (`100 * redis.mem.used / redis.mem.maxmemory`) is blocked: there's no `redis.maxmemory` in Dash0, and it uses a formula |
| 5 | Nginx | 4 metrics | `NGINX-Metrics_dashboard.json` (5 timeseries), Overview, Plus; 7 monitors | Connection states and request rate map; the Plus-only `server_zone` widget is blocked. Every monitor uses `anomalies` or Plus-only metrics, so all are blocked |
| 6 | Docker | `container.*` | `docker_daemon/docker_dashboard.json`; no monitors | Later |
| — | MySQL | none in either dataset | dashboards and monitors exist | Skip |
| — | HTTP check | `httpcheck.*` | no assets | Skip |

### Postgres "Postgres - Metrics" widget ladder

| Widget | Datadog queries | Dash0 target | Iteration |
|---|---|---|---|
| 1 Connections | `avg:postgresql.connections{$scope} by {db}` | `postgresql.backends`, `by (postgresql_database_name)` | **P0** |
| 0 Rows (per sec) | `avg:postgresql.rows_{fetched,returned,inserted,updated}{$scope}` | `rate(postgresql.tup_*)` | 2 (`rate` kind, several queries) |
| 2 Ins/upd/del (per sec) | `postgresql.rows_{inserted,deleted,updated}{$scope}`, no aggregator | `rate(postgresql.tup_*)` | 2 (default aggregator) |
| 4 System load | `system.load.{1,5,15}` | `system.cpu.load_average.{1m,5m,15m}` | 2 |
| 8 Network (per sec) | `sum:system.net.bytes_{rcvd,sent}` | `rate(system.network.io{system_network_direction=…})` | 2 |
| 5 CPU (%) | `system.cpu.{idle,system,iowait,user,stolen,guest}` | `system.cpu.utilization{cpu_mode=…}` ×100; `guest` has no mode | 3 (scale; partial) |
| 6 I/O wait (%) | `max:system.cpu.iowait` | `system.cpu.utilization{cpu_mode="wait"}` ×100 | 3 (scale) |
| 3 Disk util (%) | `avg:system.io.util` | derived from `system.disk.io_time` | 3 (reviewed derived expression) |
| 7 Memory | `sum:system.mem.total - sum:system.mem.usable` | `system.memory.limit` and `system.memory.usage{system_memory_state=…}` | 3 (formula; check unit and meaning) |

## Method

Every call was read-only, made through the `dash0` MCP tools:

- `listDatasets` and `listDashboards` for each dataset.
- `getAttributeValues` (scope `metrics`) for `otel.scope.name`, `service.name`, `host.name`, `service.namespace` and `k8s.cluster.name`. This identifies the receivers present.
- `getMetricCatalog`, filtered by `otel.scope.name` (`contains <receiver>`), across all pages.
- `getMetricDetails` for `postgresql.backends`, giving labels, resource and scope version.
- `getAttributeKeys`, filtered to the host, container and nginx metrics, for their label keys.
- PromQL:
  - `count by (...)` over `last_over_time` for label sets;
  - `max by (postgresql_database_name)` of `backends` over 40 minutes at a 5-minute step;
  - raw series and `count by (dash0_resource_hash)` to confirm the churn;
  - `min_over_time(timestamp(...))` and `count_over_time(...[24h:10m])` for data age.
- SQL over `spans` and `logs`: `count()` and `min(timestamp)` grouped by `service.name`.
- `gh api` against DataDog/integrations-core for the asset lists and query strings.
