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

Dashboard: `Kafka, Zookeeper and Kafka Consumer Overview` (`kafka/assets/dashboards/kafka_dashboard.json`), template variables: $env (tag `env`, default `*`), $consumer_group (tag `consumer_group`, default `*`), $topic (tag `topic`, default `*`). A request with empty `formulas` displays its single query directly. A request with empty `queries` is not a metrics request (e.g. logs).

Requests:
- {source_path: 'widgets[2].definition.widgets[1].definition.requests[0]', widget: 'topology_map: Kafka Topology for $topic, $env', queries: {}, formulas: []}
- {source_path: 'widgets[2].definition.widgets[2].definition.requests[0]', widget: 'query_table: Topic Health', queries: {query1: 'count:data_streams.latency{type:kafka AND direction:out AND (pathway_type:edge OR pathway_type:partial_edge) AND $topic AND $env} by {topic,env}.as_rate()', query2: 'count:data_streams.latency{type:kafka AND direction:in AND (pathway_type:edge OR pathway_type:partial_edge) AND $topic AND $env} by {topic,env}.as_rate()', query3: 'max:data_streams.kafka.lag_seconds{$topic,$env} by {topic,env}'}, formulas: [query1, query2, query3]}
- {source_path: 'widgets[3].definition.widgets[0].definition.requests[0]', widget: 'query_value: Offline Partitions', queries: {query1: 'sum:kafka.replication.offline_partitions_count{*}.weighted()'}, formulas: [query1]}
- {source_path: 'widgets[3].definition.widgets[1].definition.requests[0]', widget: 'query_value: Under Replicated Partitions', queries: {query1: 'sum:kafka.replication.under_replicated_partitions{$env}.weighted()'}, formulas: [query1]}
- {source_path: 'widgets[3].definition.widgets[2].definition.requests[0]', widget: 'query_value: ISR Delta', queries: {query1: 'max:kafka.replication.isr_expands.rate{$env}', query2: 'max:kafka.replication.isr_shrinks.rate{$env}'}, formulas: [query1 - query2]}
- {source_path: 'widgets[3].definition.widgets[3].definition.requests[0]', widget: 'query_value: Follower Fetch Latency', queries: {query1: 'avg:kafka.request.fetch_follower.time.avg{$env}'}, formulas: [query1]}
- {source_path: 'widgets[3].definition.widgets[4].definition.requests[0]', widget: 'query_value: Consumer Fetch Latency', queries: {query1: 'avg:kafka.request.fetch_consumer.time.avg{$env}'}, formulas: [query1]}
- {source_path: 'widgets[3].definition.widgets[5].definition.requests[0]', widget: 'query_value: Produce Latency', queries: {query1: 'avg:kafka.request.produce.time.avg{$env}'}, formulas: [query1]}
- {source_path: 'widgets[4].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Clean and Unclean Leader Elections', queries: {query2: 'avg:kafka.replication.leader_elections.rate{$env}', query1: 'avg:kafka.replication.unclean_leader_elections.rate{$env}'}, formulas: [query2, query1]}
- {source_path: 'widgets[4].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Broker Network Throughput', queries: {query1: 'sum:kafka.net.bytes_in.rate{$env} by {env}.weighted()', query2: 'sum:kafka.net.bytes_out.rate{$env} by {env}.weighted()'}, formulas: [query1, query2]}
- {source_path: 'widgets[4].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Producer and Fetch Request Purgatory ', queries: {query1: 'sum:kafka.request.producer_request_purgatory.size{$env} by {env}.weighted()', query2: 'sum:kafka.request.fetch_request_purgatory.size{$env} by {env}.weighted()'}, formulas: [query1, query2]}
- {source_path: 'widgets[4].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Request Times', queries: {query1: 'avg:kafka.request.produce.time.avg{$env} by {env}', query2: 'avg:kafka.request.fetch_consumer.time.avg{$env} by {env}'}, formulas: [query1, query2]}
- {source_path: 'widgets[5].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Bytes Out by Topic', queries: {query1: 'sum:kafka.producer.bytes_out{$env} by {topic,env}.weighted()'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Request and Response Rate', queries: {query1: 'sum:kafka.producer.request_rate{$env} by {host}.weighted()', query2: 'sum:kafka.producer.response_rate{$env} by {host}.weighted()'}, formulas: [abs(query1), abs(query2)]}
- {source_path: 'widgets[5].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Average Request Latency', queries: {query1: 'sum:kafka.producer.request_latency_avg{$env} by {env}.weighted()'}, formulas: [query1]}
- {source_path: 'widgets[5].definition.widgets[4].definition.requests[0]', widget: 'timeseries: I/O Wait Time', queries: {query1: 'sum:kafka.producer.io_wait{$env} by {env}.weighted()'}, formulas: [query1]}
- {source_path: 'widgets[6].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Consumer Lag by Group', queries: {query1: 'sum:kafka.consumer_lag{$env,$consumer_group} by {host,consumer_group,env}', query2: 'sum:kafka.consumer_offset{$env,$consumer_group} by {host,consumer_group,env}'}, formulas: [query1, query2]}
- {source_path: 'widgets[6].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Bytes Consumed', queries: {query1: 'sum:kafka.consumer.bytes_in{$env,$consumer_group} by {consumer_group,env}.weighted()'}, formulas: [query1]}
- {source_path: 'widgets[6].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Messages Consumed', queries: {query1: 'sum:kafka.consumer.messages_in{$env,$consumer_group} by {client-id,env}.weighted()'}, formulas: [abs(query1)]}
- {source_path: 'widgets[6].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Min Fetch Rate', queries: {query1: 'sum:kafka.consumer.fetch_rate{$env,$consumer_group} by {env,consumer_group}.weighted()'}, formulas: [query1]}
- {source_path: 'widgets[7].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Top 10 Max Kafka Lag by env', queries: {query1: 'max:data_streams.kafka.lag_seconds{$topic ,$env} by {env,topic}'}, formulas: ['top(query1, 10, ''max'', ''desc'')']}
- {source_path: 'widgets[7].definition.widgets[2].definition.requests[0]', widget: 'timeseries: Incoming messages by env, producing service for $topic', queries: {upstream_services_throughput: 'count(v: v>=0):data_streams.latency{direction:out,pathway_type:full,type:kafka,$topic,$env} by {service,env}.as_rate().rollup(10)'}, formulas: [default_zero(upstream_services_throughput)]}
- {source_path: 'widgets[7].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Outgoing messages by env, consuming service for $topic', queries: {downstream_services_throughput_by_queues: 'count(v: v>=0):data_streams.latency{direction:in,pathway_type:full,type:kafka,$topic,$env} by {service,env}.as_rate().rollup(10)'}, formulas: [default_zero(downstream_services_throughput_by_queues)]}
- {source_path: 'widgets[7].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Top 10 p95 message size by env for $topic', queries: {query1: 'p95:data_streams.payload_size{type:kafka,$topic,$env} by {topic,env}'}, formulas: ['top(query1, 10, ''mean'', ''desc'')']}
- {source_path: 'widgets[7].definition.widgets[5].definition.requests[0]', widget: 'distribution: Distribution of message size for $topic', queries: {}, formulas: []}
- {source_path: 'widgets[8].definition.widgets[1].definition.requests[0]', widget: 'timeseries: ZK File Descriptors ', queries: {query1: 'avg:zookeeper.max_file_descriptor_count{$env} by {host}', query2: 'avg:zookeeper.open_file_descriptor_count{$env} by {host}'}, formulas: [query1, query2]}
- {source_path: 'widgets[8].definition.widgets[2].definition.requests[0]', widget: 'heatmap: Active Connections', queries: {query1: 'sum:zookeeper.connections{$env} by {service,host}'}, formulas: [query1]}
- {source_path: 'widgets[8].definition.widgets[3].definition.requests[0]', widget: 'timeseries: Pending Syncs (Leader)', queries: {query1: 'sum:zookeeper.pending_syncs{$env}'}, formulas: [query1]}
- {source_path: 'widgets[8].definition.widgets[4].definition.requests[0]', widget: 'timeseries: Average Request Latency', queries: {query1: 'sum:zookeeper.avg_latency{$env}'}, formulas: [query1]}
- {source_path: 'widgets[8].definition.widgets[5].definition.requests[0]', widget: 'heatmap: Outstanding Requests', queries: {query1: 'sum:zookeeper.outstanding_requests{$env} by {host}'}, formulas: [query1]}
- {source_path: 'widgets[8].definition.widgets[6].definition.requests[0]', widget: 'timeseries: Number of Commits (Leader)', queries: {query1: 'sum:zookeeper.commit_count{$env,$consumer_group}'}, formulas: [query1]}
- {source_path: 'widgets[9].definition.widgets[1].definition.requests[0]', widget: 'timeseries: JVM GC Count by Type', queries: {query1: 'sum:jvm.gc.major_collection_count{$env} by {type,env}.weighted()', query2: 'sum:jvm.gc.minor_collection_count{$env} by {type,env}.weighted()'}, formulas: [query1, query2]}
- {source_path: 'widgets[9].definition.widgets[2].definition.requests[0]', widget: 'timeseries: JVM GC Time by Type', queries: {query1: 'sum:jvm.gc.major_collection_time{$env} by {type,env}.weighted()', query2: 'sum:jvm.gc.minor_collection_time{$env} by {type,env}.weighted()'}, formulas: [query1, query2]}
- {source_path: 'widgets[10].definition.widgets[1].definition.requests[0]', widget: 'timeseries: Count per Log Status', queries: {a: null}, formulas: [a]}
- {source_path: 'widgets[10].definition.widgets[2].definition.requests[0]', widget: 'list_stream: Error Logs', queries: {}, formulas: []}

OTel candidate metrics (pinned definitions; "in dataset" from a snapshot of dataset `default`):
- jvm.class.count (non-monotonic sum, unit {class}; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.class.loaded (monotonic sum, unit {class}; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.class.unloaded (monotonic sum, unit {class}; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.cpu.count (non-monotonic sum, unit {cpu}; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.cpu.recent_utilization (gauge, unit 1; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.cpu.time (monotonic sum, unit s; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.file_descriptor.count (non-monotonic sum, unit {file_descriptor}; attributes: none; not in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.file_descriptor.limit (non-monotonic sum, unit {file_descriptor}; attributes: none; not in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.gc.duration (histogram, unit s; attributes: jvm.gc.action, jvm.gc.cause, jvm.gc.name; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.memory.committed (non-monotonic sum, unit By; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.memory.limit (non-monotonic sum, unit By; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.memory.used (non-monotonic sum, unit By; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.memory.used_after_last_gc (non-monotonic sum, unit By; attributes: none; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- jvm.thread.count (non-monotonic sum, unit {thread}; attributes: jvm.thread.daemon, jvm.thread.state; in dataset; semantic-conventions/model/jvm/metrics.yaml)
- kafka.broker.log_retention_period (gauge, unit s; attributes: broker; not in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.brokers (non-monotonic sum, unit {brokers}; attributes: none; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.consumer.bytes-consumed-rate (gauge, unit By; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer.fetch-rate (gauge, unit {request}; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer.fetch-size-avg (gauge, unit By; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer.records-consumed-rate (gauge, unit {record}; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer.records-lag-max (gauge, unit {record}; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer.total.bytes-consumed-rate (gauge, unit By; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer.total.fetch-size-avg (gauge, unit By; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer.total.records-consumed-rate (gauge, unit {record}; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-consumer.yaml)
- kafka.consumer_group.lag (gauge, unit 1; attributes: group, partition, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.consumer_group.lag_sum (gauge, unit 1; attributes: group, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.consumer_group.members (non-monotonic sum, unit {members}; attributes: group; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.consumer_group.offset (gauge, unit 1; attributes: group, partition, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.consumer_group.offset_sum (gauge, unit 1; attributes: group, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.controller.active.count (gauge, unit {controller}; attributes: none; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.isr.operation.count (monotonic sum, unit {operation}; attributes: operation; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.leader.election.rate (monotonic sum, unit {election}; attributes: none; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.logs.flush.count (monotonic sum, unit {flush}; attributes: none; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.logs.flush.time.50p (gauge, unit ms; attributes: none; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.logs.flush.time.99p (gauge, unit ms; attributes: none; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.max.lag (gauge, unit {message}; attributes: none; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.message.count (monotonic sum, unit {message}; attributes: none; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.network.io (monotonic sum, unit By; attributes: direction; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.partition.count (gauge, unit {partition}; attributes: none; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.partition.current_offset (gauge, unit 1; attributes: partition, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.partition.offline (gauge, unit {partition}; attributes: none; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.partition.oldest_offset (gauge, unit 1; attributes: partition, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.partition.replicas (non-monotonic sum, unit {replicas}; attributes: partition, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.partition.replicas_in_sync (non-monotonic sum, unit {replicas}; attributes: partition, topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.partition.under_replicated (gauge, unit {partition}; attributes: none; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.producer.byte-rate (gauge, unit By; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.compression-rate (gauge, unit {ratio}; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.io-wait-time-ns-avg (gauge, unit ns; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.outgoing-byte-rate (gauge, unit By; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.record-error-rate (gauge, unit {record}; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.record-retry-rate (gauge, unit {record}; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.record-send-rate (gauge, unit {record}; attributes: client-id, topic; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.request-latency-avg (gauge, unit ms; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.request-rate (gauge, unit {request}; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.producer.response-rate (gauge, unit {response}; attributes: client-id; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka-producer.yaml)
- kafka.purgatory.size (gauge, unit {request}; attributes: type; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.request.count (monotonic sum, unit {request}; attributes: type; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.request.failed (monotonic sum, unit {request}; attributes: type; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.request.queue (gauge, unit {request}; attributes: none; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.request.time.50p (gauge, unit ms; attributes: type; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.request.time.99p (gauge, unit ms; attributes: type; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.request.time.avg (gauge, unit ms; attributes: type; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.request.time.total (monotonic sum, unit ms; attributes: type; in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- kafka.topic.log_retention_period (gauge, unit s; attributes: topic; not in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.topic.log_retention_size (gauge, unit By; attributes: topic; not in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.topic.min_insync_replicas (gauge, unit {replicas}; attributes: topic; not in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.topic.partitions (non-monotonic sum, unit {partitions}; attributes: topic; in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.topic.replication_factor (gauge, unit 1; attributes: topic; not in dataset; collector-contrib/receiver/kafkametricsreceiver/metadata.yaml)
- kafka.unclean.election.rate (monotonic sum, unit {election}; attributes: none; not in dataset; java-contrib/jmx-scraper/src/main/resources/kafka.yaml)
- messaging.client.consumed.messages (monotonic sum, unit {message}; attributes: messaging.operation.name; not in dataset; semantic-conventions/model/messaging/metrics.yaml)
- messaging.client.operation.duration (histogram, unit s; attributes: messaging.operation.name, messaging.operation.type; not in dataset; semantic-conventions/model/messaging/metrics.yaml)
- messaging.client.sent.messages (monotonic sum, unit {message}; attributes: messaging.operation.name; not in dataset; semantic-conventions/model/messaging/metrics.yaml)
- messaging.process.duration (histogram, unit s; attributes: messaging.operation.name; not in dataset; semantic-conventions/model/messaging/metrics.yaml)
- zookeeper.connection.active (non-monotonic sum, unit {connections}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.data_tree.ephemeral_node.count (non-monotonic sum, unit {nodes}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.data_tree.size (non-monotonic sum, unit By; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.file_descriptor.limit (gauge, unit {file_descriptors}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.file_descriptor.open (non-monotonic sum, unit {file_descriptors}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.follower.count (non-monotonic sum, unit {followers}; attributes: state; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.fsync.exceeded_threshold.count (monotonic sum, unit {events}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.latency.avg (gauge, unit ms; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.latency.max (gauge, unit ms; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.latency.min (gauge, unit ms; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.packet.count (monotonic sum, unit {packets}; attributes: direction; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.request.active (non-monotonic sum, unit {requests}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.ruok (gauge, unit 1; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.sync.pending (non-monotonic sum, unit {syncs}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.watch.count (non-monotonic sum, unit {watches}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
- zookeeper.znode.count (non-monotonic sum, unit {znodes}; attributes: none; not in dataset; collector-contrib/scraper/zookeeperscraper/metadata.yaml)
