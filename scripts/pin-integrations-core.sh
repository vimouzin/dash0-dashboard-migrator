#!/usr/bin/env bash
# Re-download the pinned DataDog/integrations-core fixtures (BSD-3-Clause).
# Usage: scripts/pin-integrations-core.sh   (needs an authenticated `gh`)
set -euo pipefail
SHA=a9b9e42b7e484861ecbd1f5919da7c52a694b74d
D=fixtures/datadog/integrations-core

fetch() {
  mkdir -p "$(dirname "$D/$2")"
  gh api "repos/DataDog/integrations-core/contents/$1?ref=$SHA" --jq .content | base64 -d > "$D/$2"
}

fetch postgres/assets/dashboards/postgresql_dashboard.json postgres/dashboards/postgresql_dashboard.json
fetch postgres/assets/dashboards/postgresql_screenboard_dashboard.json postgres/dashboards/postgresql_screenboard_dashboard.json
fetch postgres/assets/monitors/percent_usage_connections.json postgres/monitors/percent_usage_connections.json
fetch postgres/assets/monitors/replication_delay.json postgres/monitors/replication_delay.json
fetch kafka/assets/dashboards/kafka_dashboard.json kafka/dashboards/kafka_dashboard.json
fetch kafka/assets/monitors/kafka_offline_partition.json kafka/monitors/kafka_offline_partition.json
fetch kafka/assets/monitors/broker_produce_latency.json kafka/monitors/broker_produce_latency.json
fetch kafka/assets/monitors/kafka_high_producer_request_rate.json kafka/monitors/kafka_high_producer_request_rate.json
fetch docker_daemon/assets/dashboards/docker_dashboard.json docker_daemon/dashboards/docker_dashboard.json
fetch redisdb/assets/dashboards/overview.json redisdb/dashboards/overview.json
fetch redisdb/assets/monitors/high_mem.json redisdb/monitors/high_mem.json
fetch nginx/assets/dashboards/NGINX-Metrics_dashboard.json nginx/dashboards/NGINX-Metrics_dashboard.json
fetch nginx/assets/monitors/4xx.json nginx/monitors/4xx.json
fetch nginx/assets/monitors/5xx.json nginx/monitors/5xx.json
fetch nginx/assets/monitors/conn_dropped.json nginx/monitors/conn_dropped.json
fetch nginx/assets/monitors/upstream_health_check_failures.json nginx/monitors/upstream_health_check_failures.json
fetch nginx/assets/monitors/upstream_latency.json nginx/monitors/upstream_latency.json
fetch nginx/assets/monitors/upstream_peer_fails.json nginx/monitors/upstream_peer_fails.json
fetch nginx/assets/monitors/worker_crashes.json nginx/monitors/worker_crashes.json
# Every integration's metadata.csv (#175); the list and blob SHAs live in metadata-blobs.json.
for svc in $(python3 -c "import json; print(' '.join(json.load(open('$D/metadata-blobs.json'))))"); do
  fetch "$svc/metadata.csv" "$svc/metadata.csv"
done
# OpenMetrics checks' check.py/metrics.py (#185); paths and blob SHAs in openmetrics-blobs.json.
for path in $(python3 -c "import json; print(' '.join(json.load(open('$D/openmetrics-blobs.json'))))"); do
  fetch "$path" "${path%%/*}/checks/${path##*/}"
done
fetch LICENSE LICENSE
