# Third-party fixtures: DataDog/integrations-core

Source repository: https://github.com/DataDog/integrations-core
Pinned commit: a9b9e42b7e484861ecbd1f5919da7c52a694b74d
License: BSD-3-Clause (see LICENSE in this folder)

Copied unmodified from each integration's assets/dashboards and assets/monitors folders:

- docker_daemon/dashboards/docker_dashboard.json
- kafka/dashboards/kafka_dashboard.json
- kafka/monitors/broker_produce_latency.json
- kafka/monitors/kafka_high_producer_request_rate.json
- kafka/monitors/kafka_offline_partition.json
- nginx/dashboards/NGINX-Metrics_dashboard.json
- nginx/monitors/4xx.json
- nginx/monitors/5xx.json
- nginx/monitors/conn_dropped.json
- nginx/monitors/upstream_health_check_failures.json
- nginx/monitors/upstream_latency.json
- nginx/monitors/upstream_peer_fails.json
- nginx/monitors/worker_crashes.json
- postgres/dashboards/postgresql_dashboard.json
- postgres/dashboards/postgresql_screenboard_dashboard.json
- postgres/monitors/percent_usage_connections.json
- postgres/monitors/replication_delay.json
- redisdb/dashboards/overview.json
- redisdb/monitors/high_mem.json

Copied unmodified from each integration's root folder:

- every `<integration>/metadata.csv` at the pinned commit (261 files, #175); names and Git blob SHAs in `metadata-blobs.json`
- the OpenMetrics checks' `datadog_checks/<integration>/{check,metrics}.py` as `<integration>/checks/*.py` (112 files, 55 integrations, #185); upstream paths and Git blob SHAs in `openmetrics-blobs.json`
