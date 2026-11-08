Read-only task, do not create or change anything. Answer with one YAML code block only.

You are helping define expected test outcomes for migrating a Datadog dashboard to a Perses dashboard backed by OpenTelemetry metrics, checked against this Dash0 organization (dataset `default`).

Which metric to use:
- First choice: a metric that exists in this dataset (verify with the metric catalog and PromQL).
- If no metric in this dataset measures the same thing, use a metric that OpenTelemetry defines, from the candidate list at the end of this prompt (collector-contrib receivers and scrapers, semantic conventions, OTel Java JMX scraper). Then set `in_dataset: no`, name the defining file in `otel_source`, and write `live_check: not in dataset`. The request is still `translated`.
- Block with "no OTel metric" only if neither this dataset nor the candidate list has a metric that measures the same quantity.
- Equivalence must come from the metric definitions (what is measured, unit, instrument type), never from similar names alone. Use the attribute keys given for a candidate (dots become `_` in labels).

Dash0 PromQL conventions:
- Select a metric as `{otel_metric_name="<dotted.name>", otel_metric_type="<sum|gauge|histogram>"}`, with further matchers appended as `, <label>="<value>"`.
- Attribute keys become labels with dots replaced by `_`.
- Use `rate(<selector>[$__rate_interval])` for monotonic sums.
- Template variables with a tag prefix and default `*` (e.g. `$host` on tag `host`) become a matcher `<dash0 label>=~"$<name>"`. Template variables without a prefix (e.g. `$scope`) and default `*` are dropped (all series).

Hard rules. The converter is deterministic; anything these rules do not allow is blocked:
- Any Datadog function blocks the whole request, with reason "unsupported function: <name>". That includes trailing functions (`.rollup()`, `.as_count()`, `.as_rate()`, `.weighted()`, `.fill()`) and wrapping functions (`top()`, `per_second()`, `per_minute()`, `diff()`, `timeshift()`, `week_before()`, `abs()`, `default_zero()`, `count_nonzero()`, `anomalies()`, …), in queries or in formulas. Do not approximate a function with `increase`, `topk`, `*_over_time` or `offset`, and do not drop it. Put the closest PromQL you would have used in `notes` only.
- No numeric constants that are not in the Datadog source. If the units differ (percent vs ratio, ns vs s), say so in `notes` and propose a scale with a documentation link; do not apply it in `promql`.
- Use only `$__rate_interval` as a range. Never `$__interval`, `$__range`, subqueries or fixed windows such as `[15m]`.
- Use `rate()` only on monotonic sums, never on gauges.
- If the Datadog metric has no direct OTel equivalent and would have to be computed from other metrics (e.g. dropped = accepted − handled), block the request and put the proposed expression in `notes`.
- If the Datadog series grain differs from the OTel one (per-CPU vs per-host, series duplicated by restarts), say so in `notes`, naming the label that would collapse it.

For every request below, answer with one YAML list item:
- source_path: <as given>
  outcome: translated | blocked
  promql: [<one PromQL string per displayed formula, in formula order>]   # translated only
  reason: <why blocked: no equivalent metric in this dataset / unsupported function / unit mismatch ...>
  otel_metrics: [<dotted OTel metric names you used>]
  in_dataset: yes | no | partly   # translated only: are all otel_metrics present in dataset `default`?
  otel_source: [<defining file from the candidate list, one per metric not in the dataset>]   # only when in_dataset is no/partly
  labels: {<datadog tag>: <dash0 label>}
  live_check: <did the PromQL return series in the data window? yes/no, number of series; "not in dataset" when in_dataset is no>
  notes: <semantic caveats>

Rules: a request is all-or-nothing; if any formula cannot be expressed exactly, mark the whole request blocked. Never drop a series. Never invent a metric. Quote every YAML string value that contains a colon.

Note: receiver data in this dataset only exists between about 2026-11-07T14:05Z and 15:21Z, so run live checks over that window.

Dashboard: `Redis - Overview` (`redisdb/assets/dashboards/overview.json`), template variables: $scope (default `*`), $host (tag `host`, default `*`), $key (tag `key`, default `*`). A request with empty `formulas` displays its single query directly. A request with empty `queries` is not a metrics request (e.g. logs).

Requests:
- {source_path: 'widgets[1].definition.widgets[0].definition.requests[0]', widget: 'query_value: Hit rate', queries: {query1: 'avg:redis.stats.keyspace_hits{$scope,$host}', query2: 'avg:redis.stats.keyspace_misses{$scope,$host}'}, formulas: [(query1 / (query1 + query2)) * 100]}
- {source_path: 'widgets[1].definition.widgets[1].definition.requests[0]', widget: 'query_value: Blocked clients', queries: {query1: 'sum:redis.clients.blocked{$scope,$host}'}, formulas: []}
- {source_path: 'widgets[1].definition.widgets[2].definition.requests[0]', widget: 'query_value: Redis keyspace', queries: {query1: 'sum:redis.keys{$scope,$host}'}, formulas: []}
- {source_path: 'widgets[1].definition.widgets[3].definition.requests[0]', widget: 'query_value: Unsaved changes', queries: {query1: 'sum:redis.rdb.changes_since_last{$scope,$host}'}, formulas: []}
- {source_path: 'widgets[1].definition.widgets[4].definition.requests[0]', widget: 'query_value: Primary link down', queries: {query1: 'sum:redis.replication.master_link_down_since_seconds{$scope,$host}'}, formulas: []}
- {source_path: 'widgets[2].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Latency by Host', queries: {query2: 'avg:redis.info.latency_ms{$scope,$host} by {host}'}, formulas: [query2]}
- {source_path: 'widgets[2].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Slowlog duration', queries: {query1: 'sum:redis.slowlog.micros.95percentile{$scope,$host} by {name,command}'}, formulas: ['top(query1 / 1000, 10, ''mean'', ''desc'')']}
- {source_path: 'widgets[2].definition.widgets[3].definition.requests[0]', widget: 'toplist: Slowlog query rates', queries: {query1: 'sum:redis.slowlog.micros.count{$host,$scope} by {command,name}'}, formulas: [query1]}
- {source_path: 'widgets[2].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Average replication delay (offset)', queries: {query1: 'avg:redis.replication.delay{$host,$scope}'}, formulas: [query1]}
- {source_path: 'widgets[2].definition.widgets[5].definition.requests[0]', widget: 'timeseries: Average CPU usage', queries: {query1: 'avg:redis.cpu.sys{$host,$scope}', query2: 'avg:redis.cpu.user{$host,$scope}'}, formulas: [query1, query2]}
- {source_path: 'widgets[2].definition.widgets[6].definition.requests[0]', widget: 'query_value: Cache hit rate', queries: {query1: 'avg:redis.stats.keyspace_hits{$scope,$host}', query2: 'avg:redis.stats.keyspace_misses{$scope,$host}'}, formulas: [(query1 / (query1 + query2)) * 100]}
- {source_path: 'widgets[2].definition.widgets[7].definition.requests[0]', widget: 'timeseries: Cache hit rate', queries: {query1: 'avg:redis.stats.keyspace_hits{$scope,$host}', query2: 'avg:redis.stats.keyspace_misses{$scope,$host}'}, formulas: [(query1 / (query1 + query2)) * 100]}
- {source_path: 'widgets[3].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Percent Used Memory by Host', queries: {query1: 'avg:redis.mem.used{$scope,$host} by {host}', query2: 'max:redis.mem.maxmemory{$scope,$host} by {host}'}, formulas: [(query1 / query2) * 100]}
- {source_path: 'widgets[3].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Evictions', queries: {query2: 'sum:redis.keys.evicted{$scope,$host} by {host}'}, formulas: [per_minute(query2)]}
- {source_path: 'widgets[3].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Total allocated memory', queries: {query1: 'sum:redis.mem.rss{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[3].definition.widgets[4].definition.requests[0]', widget: 'query_value: Fragmentation ratio', queries: {query1: 'avg:redis.mem.fragmentation_ratio{$scope,$host}'}, formulas: []}
- {source_path: 'widgets[3].definition.widgets[5].definition.requests[0]', widget: 'timeseries: Fragmentation ratio', queries: {query1: 'avg:redis.mem.fragmentation_ratio{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[4].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Connected clients', queries: {query1: 'sum:redis.net.clients{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[4].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Blocked clients', queries: {query2: 'sum:redis.clients.blocked{$scope,$host}'}, formulas: [query2]}
- {source_path: 'widgets[4].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Connected replicas', queries: {query1: 'sum:redis.net.slaves{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[4].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Rejected connections', queries: {query1: 'sum:redis.net.rejected{$scope,$host}'}, formulas: [diff(query1)]}
- {source_path: 'widgets[4].definition.widgets[5].definition.requests[0]', widget: 'query_value: Commands per second', queries: {query1: 'sum:redis.net.commands{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Total keys', queries: {query1: 'sum:redis.keys{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[1].definition.requests[0]', widget: 'query_value: Current total', queries: {query1: 'sum:redis.keys{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Expired keys', queries: {query1: 'sum:redis.keys.expired{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[4].definition.requests[0]', widget: 'query_value: Keys with expiration', queries: {query1: 'sum:redis.expires{$scope,$host}'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[5].definition.requests[0]', widget: 'distribution: Key length distribution', queries: {query1: 'sum:redis.key.length{$scope, $host, $key} by {key}'}, formulas: [query1]}
- {source_path: 'widgets[6].definition.widgets[0].definition.requests[0]', widget: 'list_stream: Error Logs', queries: {}, formulas: []}
- {source_path: 'widgets[6].definition.widgets[1].definition.requests[0]', widget: 'list_stream: All Logs', queries: {}, formulas: []}

OTel candidate metrics (pinned definitions; "in dataset" from a snapshot of dataset `default`):
- redis.clients.blocked (non-monotonic sum, unit {client}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.clients.connected (non-monotonic sum, unit {client}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.clients.max_input_buffer (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.clients.max_output_buffer (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.cluster_enabled (gauge, unit 1; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.known_nodes (gauge, unit {node}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.links_buffer_limit_exceeded.count (monotonic sum, unit {count}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.node.count (gauge, unit {node}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.node.uptime (gauge, unit s; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.slots_assigned (gauge, unit {slot}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.slots_fail (gauge, unit {slot}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.slots_ok (gauge, unit {slot}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.slots_pfail (gauge, unit {slot}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.state (gauge, unit {state}; attributes: cluster_state; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.stats_messages_received (monotonic sum, unit {message}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.stats_messages_sent (monotonic sum, unit {message}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cluster.uptime (gauge, unit s; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cmd.calls (monotonic sum, unit {call}; attributes: cmd; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cmd.latency (gauge, unit s; attributes: cmd, percentile; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cmd.usec (monotonic sum, unit us; attributes: cmd; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.commands (gauge, unit {ops}/s; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.commands.processed (monotonic sum, unit {command}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.connections.received (monotonic sum, unit {connection}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.connections.rejected (monotonic sum, unit {connection}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.cpu.time (monotonic sum, unit s; attributes: state; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.db.avg_ttl (gauge, unit ms; attributes: db; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.db.expires (gauge, unit {key}; attributes: db; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.db.keys (gauge, unit {key}; attributes: db; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.keys.evicted (monotonic sum, unit {key}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.keys.expired (monotonic sum, unit {event}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.keyspace.hits (monotonic sum, unit {hit}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.keyspace.misses (monotonic sum, unit {miss}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.latest_fork (gauge, unit us; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.maxmemory (gauge, unit By; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.memory.fragmentation_ratio (gauge, unit 1; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.memory.lua (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.memory.peak (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.memory.rss (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.memory.used (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.memory.used_memory_overhead (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.memory.used_memory_startup (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.mode (gauge, unit {mode}; attributes: mode; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.net.input (monotonic sum, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.net.output (monotonic sum, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.pubsub.channel.status (non-monotonic sum, unit {channel}; attributes: redis.pubsub.channel.state; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.pubsub.connection.count (non-monotonic sum, unit {client}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.pubsub.pattern.status (non-monotonic sum, unit {pattern}; attributes: redis.pubsub.pattern.state; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.rdb.changes_since_last_save (non-monotonic sum, unit {change}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.replication.backlog_first_byte_offset (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.replication.offset (gauge, unit By; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.replication.replica_offset (gauge, unit By; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.role (non-monotonic sum, unit {role}; attributes: role; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.sentinel.masters (gauge, unit {master}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.sentinel.running_scripts (gauge, unit {script}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.sentinel.scripts_queue_length (gauge, unit {script}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.sentinel.simulate_failure_flags (gauge, unit {flag}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.sentinel.tilt_since_seconds (gauge, unit s; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.sentinel.total_tilt (monotonic sum, unit {event}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.slaves.connected (non-monotonic sum, unit {replica}; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.tracking_total_keys (non-monotonic sum, unit {key}; attributes: none; not in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
- redis.uptime (monotonic sum, unit s; attributes: none; in dataset; collector-contrib/receiver/redisreceiver/metadata.yaml)
