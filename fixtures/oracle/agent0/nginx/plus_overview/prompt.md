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

Dashboard: `NGINX Plus - Overview` (`nginx/assets/dashboards/plus_overview.json`), template variables: $host (tag `host`, default `*`). A request with empty `formulas` displays its single query directly. A request with empty `queries` is not a metrics request (e.g. logs).

Requests:
- {source_path: 'widgets[1].definition.widgets[1].definition.requests[0]', widget: 'query_value: Accepted connections', queries: {q: 'sum:nginx.connections.accepted{$host}'}, formulas: []}
- {source_path: 'widgets[1].definition.widgets[2].definition.requests[0]', widget: 'query_value: Active connections', queries: {q: 'sum:nginx.connections.active{$host}'}, formulas: []}
- {source_path: 'widgets[1].definition.widgets[3].definition.requests[0]', widget: 'query_value: Idle/waiting connections', queries: {q: 'sum:nginx.connections.idle{$host}'}, formulas: []}
- {source_path: 'widgets[1].definition.widgets[4].definition.requests[0]', widget: 'query_value: Dropped connections', queries: {q: 'per_second(sum:nginx.connections.dropped{$host})'}, formulas: []}
- {source_path: 'widgets[1].definition.widgets[5].definition.requests[0]', widget: 'query_value: Total requests', queries: {q: 'sum:nginx.requests.total{$host}'}, formulas: []}
- {source_path: 'widgets[3].definition.widgets[0].definition.requests.fill', widget: 'hostmap: Request load by host', queries: {q: 'avg:nginx.requests.current{$host} by {host}'}, formulas: []}
- {source_path: 'widgets[4].definition.widgets[0].definition.requests[0]', widget: 'query_table: 4xx & 5xx responses per sec', queries: {q: 'avg:nginx.server_zone.responses.total{$host} by {host}'}, formulas: []}
- {source_path: 'widgets[4].definition.widgets[0].definition.requests[1]', widget: 'query_table: 4xx & 5xx responses per sec', queries: {q: 'avg:nginx.server_zone.responses.4xx{$host} by {host}'}, formulas: []}
- {source_path: 'widgets[4].definition.widgets[0].definition.requests[2]', widget: 'query_table: 4xx & 5xx responses per sec', queries: {q: 'avg:nginx.server_zone.responses.5xx{$host} by {host}'}, formulas: []}
- {source_path: 'widgets[4].definition.widgets[1].definition.requests[0]', widget: 'timeseries: 4xx & 5xx responses per sec', queries: {query1: 'sum:nginx.server_zone.responses.4xx{$host} by {host}', query2: 'sum:nginx.server_zone.responses.5xx{$host} by {host}'}, formulas: [query1, query2]}
- {source_path: 'widgets[5].definition.widgets[0].definition.requests[0]', widget: 'query_value: Avg bytes hit', queries: {q: 'avg:nginx.cache.hit.bytes{$host}'}, formulas: []}
- {source_path: 'widgets[5].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Bytes hit in cache', queries: {query1: 'sum:nginx.cache.hit.bytes{$host}'}, formulas: []}
- {source_path: 'widgets[5].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Bypassed bytes in cached', queries: {query1: 'sum:nginx.cache.bypass.bytes{$host}', query2: 'sum:nginx.cache.bypass.bytes_written{$host}'}, formulas: [query1, query2, query1 + query2]}
- {source_path: 'widgets[5].definition.widgets[3].definition.requests[0]', widget: 'query_value: Hosts loading cache', queries: {q: 'sum:nginx.cache.cold{$host}'}, formulas: []}
- {source_path: 'widgets[5].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Cache size', queries: {query1: 'sum:nginx.cache.max_size{$host}', query2: 'sum:nginx.cache.size{$host}'}, formulas: [query1, query2]}
- {source_path: 'widgets[5].definition.widgets[5].definition.requests[0]', widget: 'timeseries: Missed bytes in cache', queries: {query1: 'sum:nginx.cache.miss.bytes{$host}', query2: 'sum:nginx.cache.miss.bytes_written{$host}'}, formulas: [query1, query2, query1 + query2]}
- {source_path: 'widgets[6].definition.widgets[0].definition.requests[0]', widget: 'timeseries: Current connections (idle & active)', queries: {query1: 'sum:nginx.connections.active{$host}', query2: 'sum:nginx.connections.idle{$host}'}, formulas: [query1, query2]}
- {source_path: 'widgets[6].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Dropped connections per second', queries: {query1: 'sum:nginx.connections.dropped{$host}'}, formulas: [per_second(query1)]}
- {source_path: 'widgets[7].definition.widgets[0].definition.requests[0]', widget: 'query_table: Handshakes per hosts', queries: {q: 'sum:nginx.ssl.handshakes_count{*} by {host}.as_count()'}, formulas: []}
- {source_path: 'widgets[7].definition.widgets[0].definition.requests[1]', widget: 'query_table: Handshakes per hosts', queries: {q: 'sum:nginx.ssl.handshakes_failed_count{*} by {host}.as_count()'}, formulas: []}
- {source_path: 'widgets[7].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Successful vs failed SSL handshakes', queries: {query1: 'sum:nginx.ssl.handshakes_count{$host} by {host}.as_count()'}, formulas: [query1]}
- {source_path: 'widgets[7].definition.widgets[1].definition.requests[1]', widget: 'timeseries: Successful vs failed SSL handshakes', queries: {q: '-sum:nginx.ssl.handshakes_failed_count{*} by {host}.as_count()'}, formulas: []}

OTel candidate metrics (pinned definitions; "in dataset" from a snapshot of dataset `default`):
- nginx.connections_accepted (monotonic sum, unit {connections}; attributes: none; in dataset; collector-contrib/receiver/nginxreceiver/metadata.yaml)
- nginx.connections_current (non-monotonic sum, unit {connections}; attributes: state; in dataset; collector-contrib/receiver/nginxreceiver/metadata.yaml)
- nginx.connections_handled (monotonic sum, unit {connections}; attributes: none; in dataset; collector-contrib/receiver/nginxreceiver/metadata.yaml)
- nginx.requests (monotonic sum, unit {requests}; attributes: none; in dataset; collector-contrib/receiver/nginxreceiver/metadata.yaml)
