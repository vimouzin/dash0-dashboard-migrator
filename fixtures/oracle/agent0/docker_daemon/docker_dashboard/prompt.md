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

Dashboard: `Docker - Overview` (`docker_daemon/assets/dashboards/docker_dashboard.json`), template variables: $scope (default `*`). A request with empty `formulas` displays its single query directly. A request with empty `queries` is not a metrics request (e.g. logs).

Requests:
- {source_path: 'widgets[0].definition.requests[0]', widget: 'timeseries: Running containers by image', queries: {q: 'sum:docker.containers.running{$scope} by {docker_image}.fill(0)'}, formulas: []}
- {source_path: 'widgets[1].definition.requests[0]', widget: 'toplist: Most RAM-intensive containers', queries: {q: 'top(avg:docker.mem.rss{$scope} by {container_name}, 5, ''max'', ''desc'')'}, formulas: []}
- {source_path: 'widgets[2].definition.requests[0]', widget: 'toplist: Most CPU-intensive containers', queries: {q: 'top(avg:docker.cpu.user{$scope} by {container_name}, 5, ''max'', ''desc'')'}, formulas: []}
- {source_path: 'widgets[3].definition.requests[0]', widget: 'heatmap: Memory by container', queries: {q: 'avg:docker.mem.rss{$scope} by {container_name}'}, formulas: []}
- {source_path: 'widgets[4].definition.requests[0]', widget: 'query_value: Running containers', queries: {q: 'sum:docker.containers.running{$scope}'}, formulas: []}
- {source_path: 'widgets[5].definition.requests[0]', widget: 'query_value: Stopped containers', queries: {q: 'sum:docker.containers.stopped{$scope}'}, formulas: []}
- {source_path: 'widgets[6].definition.requests[0]', widget: 'heatmap: CPU by container', queries: {q: 'avg:docker.cpu.user{$scope} by {container_name}'}, formulas: []}
- {source_path: 'widgets[7].definition.requests[0]', widget: 'timeseries: CPU user by image', queries: {q: 'avg:docker.cpu.user{$scope} by {docker_image}.fill(0)'}, formulas: []}
- {source_path: 'widgets[8].definition.requests[0]', widget: 'timeseries: RSS memory by image', queries: {q: 'avg:docker.mem.rss{$scope} by {docker_image}.fill(0)'}, formulas: []}
- {source_path: 'widgets[11].definition.requests[0]', widget: 'query_value: Running container change', queries: {q: '100*(sum:docker.containers.running{$scope}/timeshift(sum:docker.containers.running{$scope}, -300))'}, formulas: []}
- {source_path: 'widgets[12].definition.requests[0]', widget: 'timeseries: CPU system by image', queries: {q: 'avg:docker.cpu.system{$scope} by {docker_image}.fill(0)'}, formulas: []}
- {source_path: 'widgets[14].definition.requests[0]', widget: 'timeseries: Cache memory by image', queries: {q: 'sum:docker.mem.cache{$scope} by {docker_image}'}, formulas: []}
- {source_path: 'widgets[18].definition.requests[0]', widget: 'timeseries: Swap by image', queries: {q: 'avg:docker.mem.swap{$scope} by {docker_image}'}, formulas: []}
- {source_path: 'widgets[20].definition.requests[0]', widget: 'timeseries: Avg. I/O bytes read by image', queries: {q: 'avg:docker.io.read_bytes{$scope} by {docker_image}'}, formulas: []}
- {source_path: 'widgets[21].definition.requests[0]', widget: 'timeseries: Avg. I/O bytes written by image', queries: {q: 'avg:docker.io.write_bytes{$scope} by {docker_image}'}, formulas: []}
- {source_path: 'widgets[23].definition.requests[0]', widget: 'timeseries: Avg. rx bytes by image', queries: {q: 'avg:docker.net.bytes_rcvd{$scope} by {docker_image}'}, formulas: []}
- {source_path: 'widgets[24].definition.requests[0]', widget: 'timeseries: Avg. tx bytes by image', queries: {q: 'avg:docker.net.bytes_sent{$scope} by {docker_image}'}, formulas: []}
- {source_path: 'widgets[25].definition.requests[0]', widget: 'toplist: Most tx-intensive containers', queries: {q: 'top(avg:docker.net.bytes_sent{$scope} by {container_name}, 5, ''max'', ''desc'')'}, formulas: []}
- {source_path: 'widgets[26].definition.requests[0]', widget: 'heatmap: tx by container', queries: {q: 'avg:docker.net.bytes_sent{$scope} by {container_name}'}, formulas: []}
- {source_path: 'widgets[27].definition.requests[0]', widget: 'toplist: Running containers by image', queries: {q: 'top(timeshift(sum:docker.containers.running{$scope} by {docker_image}.fill(60), 40), 20, ''last'', ''desc'')'}, formulas: []}

OTel candidate metrics (pinned definitions; "in dataset" from a snapshot of dataset `default`):
- container.blockio.io_merged_recursive (monotonic sum, unit {operations}; attributes: device_major, device_minor, operation; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.blockio.io_queued_recursive (monotonic sum, unit {operations}; attributes: device_major, device_minor, operation; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.blockio.io_service_bytes_recursive (monotonic sum, unit By; attributes: device_major, device_minor, operation; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.blockio.io_service_time_recursive (monotonic sum, unit ns; attributes: device_major, device_minor, operation; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.blockio.io_serviced_recursive (monotonic sum, unit {operations}; attributes: device_major, device_minor, operation; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.blockio.io_time_recursive (monotonic sum, unit ms; attributes: device_major, device_minor, operation; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.blockio.io_wait_time_recursive (monotonic sum, unit ns; attributes: device_major, device_minor, operation; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.blockio.sectors_recursive (monotonic sum, unit {sectors}; attributes: device_major, device_minor, operation; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.limit (gauge, unit {cpus}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.logical.count (gauge, unit {cpus}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.shares (gauge, unit 1; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.throttling_data.periods (monotonic sum, unit {periods}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.throttling_data.throttled_periods (monotonic sum, unit {periods}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.throttling_data.throttled_time (monotonic sum, unit ns; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.time (monotonic sum, unit s; attributes: cpu.mode; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.cpu.usage (gauge, unit {cpu}; attributes: cpu.mode; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.cpu.usage.kernelmode (monotonic sum, unit ns; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.usage.percpu (monotonic sum, unit ns; attributes: core; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.usage.system (monotonic sum, unit ns; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.usage.total (monotonic sum, unit ns; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.usage.usermode (monotonic sum, unit ns; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.cpu.utilization (gauge, unit 1; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.disk.io (monotonic sum, unit By; attributes: disk.io.direction, system.device.name; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.filesystem.available (non-monotonic sum, unit By; attributes: none; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.filesystem.capacity (non-monotonic sum, unit By; attributes: none; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.filesystem.usage (non-monotonic sum, unit By; attributes: none; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.memory.active_anon (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.active_file (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.anon (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.available (non-monotonic sum, unit By; attributes: none; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.memory.cache (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.dirty (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.fails (monotonic sum, unit {fails}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.file (non-monotonic sum, unit By; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.hierarchical_memory_limit (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.hierarchical_memsw_limit (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.inactive_anon (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.inactive_file (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.mapped_file (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.percent (gauge, unit 1; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.pgfault (monotonic sum, unit {faults}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.pgmajfault (monotonic sum, unit {faults}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.pgpgin (monotonic sum, unit {operations}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.pgpgout (monotonic sum, unit {operations}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.rss (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.rss_huge (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_active_anon (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_active_file (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_cache (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_dirty (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_inactive_anon (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_inactive_file (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_mapped_file (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_pgfault (monotonic sum, unit {faults}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_pgmajfault (monotonic sum, unit {faults}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_pgpgin (monotonic sum, unit {operations}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_pgpgout (monotonic sum, unit {operations}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_rss (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_rss_huge (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_unevictable (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.total_writeback (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.unevictable (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.usage (non-monotonic sum, unit By; attributes: none; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.memory.usage.limit (non-monotonic sum, unit By; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.usage.max (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.usage.total (non-monotonic sum, unit By; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.memory.working_set (non-monotonic sum, unit By; attributes: none; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.memory.writeback (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io (monotonic sum, unit By; attributes: network.interface.name, network.io.direction; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.network.io.usage.rx_bytes (monotonic sum, unit By; attributes: interface; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io.usage.rx_dropped (monotonic sum, unit {packets}; attributes: interface; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io.usage.rx_errors (monotonic sum, unit {errors}; attributes: interface; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io.usage.rx_packets (monotonic sum, unit {packets}; attributes: interface; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io.usage.tx_bytes (monotonic sum, unit By; attributes: interface; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io.usage.tx_dropped (monotonic sum, unit {packets}; attributes: interface; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io.usage.tx_errors (monotonic sum, unit {errors}; attributes: interface; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.network.io.usage.tx_packets (monotonic sum, unit {packets}; attributes: interface; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.paging.faults (monotonic sum, unit {fault}; attributes: system.paging.fault.type; not in dataset; semantic-conventions/model/container/metrics.yaml)
- container.pids.count (non-monotonic sum, unit {pids}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.pids.limit (non-monotonic sum, unit {pids}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.restarts (monotonic sum, unit {restarts}; attributes: none; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.state.health.status (non-monotonic sum, unit {container}; attributes: container.state.health.state; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.state.status (non-monotonic sum, unit {status}; attributes: container.state.status; not in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
- container.uptime (gauge, unit s; attributes: none; in dataset; collector-contrib/receiver/dockerstatsreceiver/metadata.yaml)
