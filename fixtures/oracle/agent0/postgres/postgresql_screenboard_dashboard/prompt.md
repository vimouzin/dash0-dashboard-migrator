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

Dashboard: `Postgres - Overview` (`postgres/assets/dashboards/postgresql_screenboard_dashboard.json`), template variables: $scope (default `*`), $table (tag `table`, default `*`), $db (tag `db`, default `*`), $host (tag `host`, default `*`). A request with empty `formulas` displays its single query directly. A request with empty `queries` is not a metrics request (e.g. logs).

Requests:
- {source_path: 'widgets[1].definition.widgets[0].definition.requests[0]', widget: 'query_value: Max connections in use', queries: {query1: 'max:postgresql.percent_usage_connections{$scope,$host}'}, formulas: [query1 * 100]}
- {source_path: 'widgets[1].definition.widgets[1].definition.requests[0]', widget: 'query_value: Rows fetched / returned', queries: {query1: 'sum:postgresql.rows_fetched{$scope,$host}', query2: 'sum:postgresql.rows_returned{$scope,$host}'}, formulas: [query1 / (query1 + query2) * 100]}
- {source_path: 'widgets[2].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Dead rows', queries: {query1: 'sum:postgresql.dead_rows{$scope,$db,$table,$host}'}, formulas: [query1]}
- {source_path: 'widgets[2].definition.widgets[1].definition.requests[0]', widget: 'query_table: Resources by table', queries: {query1: 'avg:postgresql.total_size{$scope,$db,$table,$host} by {table}', query2: 'avg:postgresql.index_scans{$scope,$db,$table,$host} by {table}', query3: 'avg:postgresql.live_rows{$scope,$db,$table,$host} by {table}', query4: 'avg:postgresql.dead_rows{$scope,$db,$table,$host} by {table}'}, formulas: [query1, query2, query3, query4]}
- {source_path: 'widgets[2].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Temp bytes', queries: {query1: 'sum:postgresql.temp_bytes{$scope,$db,$table,$host}'}, formulas: [query1]}
- {source_path: 'widgets[2].definition.widgets[3].definition.requests[0]', widget: 'toplist: Most frequently scanned indexes', queries: {query1: 'avg:postgresql.index_scans{$scope,$db,$host} by {index}'}, formulas: [query1]}
- {source_path: 'widgets[2].definition.widgets[4].definition.requests[0]', widget: 'toplist: Least frequently scanned indexes', queries: {query1: 'avg:postgresql.index_scans{$scope,$db,$host} by {index}'}, formulas: [query1]}
- {source_path: 'widgets[2].definition.widgets[5].definition.requests[0]', widget: 'toplist: Tables with most disk usage (top 5)', queries: {query1: 'avg:postgresql.total_size{$scope,$table,$host} by {table}'}, formulas: [query1]}
- {source_path: 'widgets[2].definition.widgets[6].definition.requests[0]', widget: 'toplist: Tables with most live rows', queries: {query1: 'avg:postgresql.live_rows{$scope,$table,$host} by {table}'}, formulas: [query1]}
- {source_path: 'widgets[3].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Locks by lock mode', queries: {query1: 'sum:postgresql.locks{$scope,$host} by {lock_mode,table}'}, formulas: ['top(query1, 5, ''mean'', ''desc'')']}
- {source_path: 'widgets[3].definition.widgets[1].definition.requests[0]', widget: 'toplist: Locks by lock mode', queries: {query1: 'sum:postgresql.locks{$scope,$host} by {lock_mode,table}'}, formulas: [query1]}
- {source_path: 'widgets[3].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Deadlocks count', queries: {query1: 'max:postgresql.deadlocks.count{$scope,$host} by {db}.as_count()'}, formulas: [query1]}
- {source_path: 'widgets[4].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Inserted', queries: {query3: 'avg:postgresql.rows_inserted{$scope,$db,$host} by {db}'}, formulas: [query3]}
- {source_path: 'widgets[4].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Updated', queries: {query1: 'avg:postgresql.rows_updated{$scope,$db,$host} by {db}'}, formulas: [query1]}
- {source_path: 'widgets[4].definition.widgets[2].definition.requests[0]', widget: 'query_table: Actions', queries: {query1: 'avg:postgresql.rows_inserted{$db,$scope,$host} by {db}', query2: 'avg:postgresql.rows_updated{$db,$scope,$host} by {db}', query3: 'avg:postgresql.rows_deleted{$db,$scope,$host} by {db}'}, formulas: [query1, query2, query3]}
- {source_path: 'widgets[4].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Deleted', queries: {query2: 'avg:postgresql.rows_deleted{$scope,$db,$host} by {db}'}, formulas: [query2]}
- {source_path: 'widgets[4].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Heap-only updates ', queries: {query1: 'avg:postgresql.rows_hot_updated{$scope,$db,$host} by {db}'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Connections per database', queries: {query1: 'avg:postgresql.connections{$scope,$db,$host} by {db}.rollup(max)'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[0].definition.requests[1]', widget: 'timeseries: Connections per database', queries: {query1: 'min:postgresql.max_connections{$scope,$db,$host} by {db}'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[1].definition.requests[0]', widget: 'toplist: Most connected databases', queries: {query1: 'max:postgresql.connections{$scope,$db,$host} by {db}'}, formulas: [query1]}
- {source_path: 'widgets[6].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Sequential scans vs index scans', queries: {query1: 'avg:postgresql.index_scans{$scope,$db,$host} by {db}', query2: 'avg:postgresql.seq_scans{$scope,$db,$host} by {db}'}, formulas: [query1, query2]}
- {source_path: 'widgets[6].definition.widgets[1].definition.requests[0]', widget: 'query_table: Top table scans', queries: {query1: 'avg:postgresql.index_scans{$scope,$db,$table,$host} by {db}', query2: 'avg:postgresql.seq_scans{$scope,$db,$table,$host} by {db}'}, formulas: [query1, query2]}
- {source_path: 'widgets[6].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Sequential scans vs. week before', queries: {query1: 'sum:postgresql.seq_scans{$scope,$db,$table,$host}'}, formulas: [query1]}
- {source_path: 'widgets[6].definition.widgets[2].definition.requests[1]', widget: 'timeseries: Sequential scans vs. week before', queries: {query1: 'sum:postgresql.seq_scans{$scope,$db,$table,$host}'}, formulas: [week_before(query1)]}
- {source_path: 'widgets[6].definition.widgets[3].definition.requests[0]', widget: 'toplist: Top function calls', queries: {query1: 'avg:postgresql.function.calls{$scope,$db,$table,$host} by {function}'}, formulas: [query1]}
- {source_path: 'widgets[7].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Number of hosts with replication delay', queries: {query1: 'sum:postgresql.replication_delay_bytes{$scope,$host} by {host}'}, formulas: [count_nonzero(query1)]}
- {source_path: 'widgets[7].definition.widgets[1].definition.requests[0]', widget: 'toplist: Max replication delay', queries: {query1: 'max:postgresql.replication_delay{$scope,$host} by {host}'}, formulas: [query1]}
- {source_path: 'widgets[8].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Scheduled vs requested checkpoints', queries: {query1: 'sum:postgresql.bgwriter.checkpoints_timed{$scope,$db,$host}.as_count()', query2: 'sum:postgresql.bgwriter.checkpoints_requested{$scope,$db,$host}.as_count()'}, formulas: [query1, query2]}
- {source_path: 'widgets[8].definition.widgets[0].definition.requests[1]', widget: 'timeseries: Scheduled vs requested checkpoints', queries: {query1: 'sum:postgresql.bgwriter.checkpoints_requested{$scope,$db,$host}.as_count()'}, formulas: [query1]}

OTel candidate metrics (pinned definitions; "in dataset" from a snapshot of dataset `default`):
- postgresql.backends (non-monotonic sum, unit 1; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.bgwriter.buffers.allocated (monotonic sum, unit {buffers}; attributes: none; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.bgwriter.buffers.writes (monotonic sum, unit {buffers}; attributes: bg_buffer_source; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.bgwriter.checkpoint.count (monotonic sum, unit {checkpoints}; attributes: bg_checkpoint_type; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.bgwriter.duration (monotonic sum, unit ms; attributes: bg_duration_type; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.bgwriter.maxwritten (monotonic sum, unit 1; attributes: none; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.blks_hit (monotonic sum, unit {blks_hit}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.blks_read (monotonic sum, unit {blks_read}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.blocks_read (monotonic sum, unit 1; attributes: db.collection.name, db.namespace, source; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.commits (monotonic sum, unit 1; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.connection.max (gauge, unit {connections}; attributes: none; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.database.count (non-monotonic sum, unit {databases}; attributes: none; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.database.locks (gauge, unit {lock}; attributes: db.namespace, lock_type, mode, relation; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.db_size (non-monotonic sum, unit By; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.deadlocks (monotonic sum, unit {deadlock}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.function.calls (monotonic sum, unit {call}; attributes: db.namespace, function; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.index.scans (monotonic sum, unit {scans}; attributes: db.collection.name, db.namespace, postgresql.index.name; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.index.size (gauge, unit By; attributes: db.collection.name, db.namespace, postgresql.index.name; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.operations (monotonic sum, unit 1; attributes: db.collection.name, db.namespace, operation; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.query.conflicts (monotonic sum, unit {query}; attributes: db.namespace, postgresql.conflict.type; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.query.execution.time (monotonic sum, unit s; attributes: db.namespace; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.replication.data_delay (gauge, unit By; attributes: replication_client; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.rollbacks (monotonic sum, unit 1; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.rows (non-monotonic sum, unit 1; attributes: db.collection.name, db.namespace, state; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.sequential_scans (monotonic sum, unit {sequential_scan}; attributes: db.collection.name, db.namespace; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.table.count (non-monotonic sum, unit {table}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.table.size (non-monotonic sum, unit By; attributes: db.collection.name, db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.table.vacuum.count (monotonic sum, unit {vacuum}; attributes: db.collection.name, db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.temp.io (monotonic sum, unit By; attributes: db.namespace; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.temp_files (monotonic sum, unit {temp_file}; attributes: db.namespace; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.tup_deleted (monotonic sum, unit {tup_deleted}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.tup_fetched (monotonic sum, unit {tup_fetched}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.tup_inserted (monotonic sum, unit {tup_inserted}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.tup_returned (monotonic sum, unit {tup_returned}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.tup_updated (monotonic sum, unit {tup_updated}; attributes: db.namespace; in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.vector.insert.duration (monotonic sum, unit s; attributes: db.namespace; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.vector.insert.rows (monotonic sum, unit {vectors}; attributes: db.namespace; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.vector.search.calls (monotonic sum, unit {search}; attributes: db.namespace, postgresql.distance.function.name; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.vector.search.duration (monotonic sum, unit s; attributes: db.namespace, postgresql.distance.function.name; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.vector.search.rows_returned (monotonic sum, unit {rows}; attributes: db.namespace, postgresql.distance.function.name; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.wal.age (gauge, unit s; attributes: none; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.wal.delay (gauge, unit s; attributes: replication_client, wal_operation_lag; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
- postgresql.wal.lag (gauge, unit s; attributes: replication_client, wal_operation_lag; not in dataset; collector-contrib/receiver/postgresqlreceiver/metadata.yaml)
