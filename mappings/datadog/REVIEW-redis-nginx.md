# Redis and nginx mapping drafts: review notes (plan 08 Tasks 2–3)

Drafted by Track B on 2026-11-07 (Python stack, mapping schema with `rate` and `matchers`). **Nothing here is reviewed.** Only a human sets `reviewed`
(the other person reviews these entries).

## Evidence used

- **Datadog ↔ OTel pairs:** the "Metrics mappings" table at
  <https://docs.datadoghq.com/opentelemetry/guide/metrics_mapping/#metrics-mappings>
  (the Markdown export at `/opentelemetry/guide/metrics_mapping.md`, about 5.7 MB; the `redisreceiver` and
  `nginxreceiver` rows are near lines 3214 and 3781 of that export as fetched on 2026-11-07).
- **Types, units, attributes:** `receiver/redisreceiver/metadata.yaml` and `receiver/nginxreceiver/metadata.yaml` in
  opentelemetry-collector-contrib at tag `v0.160.0` (the receiver version seen in Dash0 for Postgres).
- **Presence, type and labels in Dash0:** checked read-only in dataset `default` on 2026-11-07 through the Dash0 MCP
  server (`promql`). Each query is recorded in its entry's `ref`. Results:
  - **Types:** `redis.memory.{used,rss,fragmentation_ratio}` and `redis.db.{keys,expires}` exist as `gauge`;
    `redis.clients.{connected,blocked}`, `redis.rdb.changes_since_last_save`, `redis.slaves.connected`,
    `nginx.connections_current` and `postgresql.backends` exist as `sum`. All match `redis.json` and `postgres.json`.
  - **Labels:** Redis series carry `host_name` (`docker-desktop`) and `redis_version` (`7.2.4`), so every Redis entry now
    maps `host -> host_name`. `redis.db.keys` carries `db="0"`; Datadog's tag is `redis_db:db0`, so the value formats
    differ, and `db` stays unmapped on purpose.
  - **nginx `state` values present:** `active`, `reading`, `waiting`, `writing` (all four).
  - **Postgres:** `postgresql.backends` has `postgresql_database_name` in {`astronomy_db`, `postgres`} and `host_name`.

## Findings for the reviewer

- **Series churn (affects every `sum:` widget):** one Redis on one host produced **13** `dash0_resource_hash` values for
  `redis.memory.used` in about 3 hours (Postgres: the same pattern). At any instant there's usually one live series, but
  around rollovers up to 3–4 overlap within the staleness window (seen 14:29–14:44 UTC). A plain `sum` across
  series then counts the same Redis 2–4 times. The Redis dashboard uses `sum:` for `redis.mem.rss`, `redis.net.clients`,
  `redis.keys`, `redis.clients.blocked` and others. This is the series-grain/dedup work in plan 05
  (`DASH0_INVENTORY.md` caveat 2, e.g. `max by (host_name)` first). It's not something to patch in these entries.
- **Data gap:** no Redis/Postgres series between about 15:30 and 16:30 UTC on 2026-11-07 (demo stack stopped; see B2).

## Reviewer checklist (per entry in `redis.json` and `nginx.json`)

1. ~~Confirm `otel_metric_type` in Dash0~~: done (above). Re-run the query in the entry's `ref` if you want to confirm.
2. ~~Confirm the series labels~~: done. `host -> host_name` added to every Redis entry.
3. Check each pair against its cited Datadog row and the notes column below, then set `reviewed: {by, date, evidence}` yourself.

## Mapped now (all `reviewed: null`)

Every entry cites its Datadog row, the verbatim `metadata.csv` line at the pinned integrations-core commit, and a
read-only Dash0 query. **Kind follows how the agent check submits the metric, not the `metadata.csv` type column**,
which labels every agent rate `gauge`. For Redis that is `redisdb/datadog_checks/redisdb/constants.py` at `a9b9e42`:
keys in `RATE_KEYS` (submitted via `self.rate()`, e.g. `used_cpu_sys`, `keyspace_hits`) become `rate` over the
cumulative OTel sum; keys in `GAUGE_KEYS` (e.g. `evicted_keys`, `rejected_connections`) stay `gauge` on the cumulative
sum, so values are comparable without `rate()`. (Corrected 2026-11-07 after review: `redis.cpu.sys`/`redis.cpu.user`
were wrongly `gauge`.)

### `redis.json`

| Datadog | Kind | Dash0 target | Notes |
|---|---|---|---|
| `redis.mem.used` | gauge | `redis.memory.used` (gauge) | bytes |
| `redis.mem.rss` | gauge | `redis.memory.rss` (gauge) | bytes |
| `redis.mem.fragmentation_ratio` | gauge | `redis.memory.fragmentation_ratio` (gauge) | ratio |
| `redis.net.clients` | gauge | `redis.clients.connected` (sum) | excludes replica connections (row text) |
| `redis.clients.blocked` | gauge | `redis.clients.blocked` (sum) | |
| `redis.keys` | gauge | `redis.db.keys` (gauge) | `db` deliberately unmapped (`db0` vs `0`) |
| `redis.expires` | gauge | `redis.db.expires` (gauge) | as above |
| `redis.rdb.changes_since_last` | gauge | `redis.rdb.changes_since_last_save` (sum) | |
| `redis.net.slaves` | gauge | `redis.slaves.connected` (sum) | |
| `redis.stats.keyspace_hits` | **rate** | `redis.keyspace.hits` (sum) | Datadog: key per second |
| `redis.stats.keyspace_misses` | **rate** | `redis.keyspace.misses` (sum) | Datadog: key per second |
| `redis.keys.evicted` | gauge | `redis.keys.evicted` (sum) | Datadog: "total number", no per-second unit |
| `redis.keys.expired` | gauge | `redis.keys.expired` (sum) | as above |
| `redis.net.rejected` | gauge | `redis.connections.rejected` (sum) | as above |
| `redis.cpu.sys` | **rate** + `state="sys"` | `redis.cpu.time` (sum) | Dash0 also has `sys_children`, `sys_main_thread`; excluded by the matcher |
| `redis.cpu.user` | **rate** + `state="user"` | `redis.cpu.time` (sum) | as above for `user_*` |

### `nginx.json`

| Datadog | Kind | Dash0 target | Notes |
|---|---|---|---|
| `nginx.net.connections` | gauge + `state="active"` | `nginx.connections_current` (sum) | row filter `state: active` |
| `nginx.net.waiting` | gauge + `state="waiting"` | `nginx.connections_current` (sum) | row filter `state: waiting` |

## Left out: no cited Datadog row

| Datadog | Candidate | Why not mapped |
|---|---|---|
| `nginx.net.reading` | `nginx.connections_current{state="reading"}` | no row; `state="reading"` exists in Dash0 |
| `nginx.net.writing` | `nginx.connections_current{state="writing"}` | no row; `state="writing"` exists in Dash0 |
| `nginx.net.request_per_s` | `rate(nginx.requests)` | no row for `request_per_s` (row pairs `nginx.requests` with `nginx.requests.total_count`) |
| `nginx.net.conn_dropped_per_s` | `rate(nginx.connections_accepted) - rate(nginx.connections_handled)` | no row; reasoning only (both sums exist in Dash0) |

A reviewer who accepts these may add them with their own evidence.

## Needs a human decision

- **`redis.net.commands`: the rows conflict.** The `redisreceiver` row pairs it with `redis.commands` (gauge,
  `{ops}/s`, instantaneous ops/sec). A second row set (integration `redis`) pairs it with
  `redis.commands.processed` (monotonic counter), which would be `rate(redis.commands.processed)`. They differ
  (instantaneous vs averaged over the rate window). Pick one, then add the entry.

## Leave unmapped (diagnostic `MISSING_METRIC_MAPPING` is the correct outcome)

- `redis.mem.maxmemory`: `redis.maxmemory` is disabled by default in the receiver and absent in Dash0. This also
  blocks the `high_mem` monitor.
- `redis.info.latency_ms`, `redis.slowlog.*`, `redis.key.length`, `redis.replication.delay`,
  `redis.replication.master_link_down_since_seconds`: no receiver equivalent.
- `nginx.server_zone.*`, `nginx.upstream.*`, `nginx.stream.*`, `nginx.processes.*`: NGINX Plus or Datadog-check only.
  These block the Plus widget and all 7 nginx monitors (the rest use `anomalies`).
