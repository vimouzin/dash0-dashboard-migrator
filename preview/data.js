// Local mock data for the demo. No network, no AI: every query and "suggestion" below is fixed text.
window.MIGRATION_ITEMS = [
  { id: "overview", name: "Service overview", status: "converted",
    why: "Layout, 14 panels and the env and region filters.",
    from: "dashboard · 14 widgets · $env $region",
    to: "dashboard · 14 panels · env region" },
  { id: "rate", name: "Request rate", status: "converted",
    why: "Same metric, grouping and per-second rate.",
    from: "sum:http.requests{service:checkout}.as_rate()",
    to: 'sum(rate(http_requests_total{service="checkout"}[1m]))' },
  { id: "latency", name: "Latency p95", status: "converted",
    why: "Maps directly onto the latency histogram.",
    from: "p95:http.server.duration{service:checkout}",
    to: "histogram_quantile(0.95, rate(http_server_duration_bucket[5m]))" },
  { id: "errors", name: "Error-rate alert", status: "converted",
    why: "Threshold, 5-minute window and severity carried over.",
    from: "avg(last_5m):errors / requests > 0.05",
    to: "errors / requests > 0.05 for 5m" },
  { id: "cpu", name: "CPU by zone", status: "converted",
    why: "Same percentage, grouped by zone.",
    from: "avg:system.cpu.user{*} by {zone}",
    to: 'avg by (zone) (system_cpu_utilization{state="user"})' },

  { id: "db", name: "DB connections", status: "review",
    why: "Datadog averages per host; this version sums all hosts.",
    from: "avg:postgresql.connections{service:checkout}",
    to: 'sum(postgresql_backends{service="checkout"})',
    compare: { datadog: 12, dash0: 48, unit: " connections" } },
  { id: "disk", name: "Disk-full alert", status: "review",
    why: "The 5-minute rollup was approximated.",
    from: "max(last_10m):system.disk.in_use{*}.rollup(max, 300) > 0.9",
    to: "max_over_time(system_filesystem_utilization[10m]) > 0.9",
    compare: { datadog: 91.2, dash0: 88.4, unit: "%" } },

  { id: "anomaly", name: "Anomaly alert", status: "unsupported",
    why: "Uses Datadog anomaly detection. Dash0 has no equivalent.",
    from: "anomalies(sum:checkout.orders{*}, 'agile', 2) >= 1",
    to: "no Dash0 equivalent",
    suggestion: { code: "sum(rate(checkout_orders_total[15m])) < 0.5 * sum(rate(checkout_orders_total[15m] offset 1w))",
                  note: "A workaround that compares with last week. Not anomaly detection." } }
];

// More converted panels, so the demo shows a migration of realistic size. Interleaved with the items above.
(() => {
  const names = ["Cart size", "Payment errors", "Queue depth", "GC pauses", "Pod restarts", "Memory by pod",
    "Cache hit rate", "Kafka lag", "Request size", "4xx rate", "5xx rate", "Thread count", "Heap usage",
    "DNS errors", "TLS handshakes", "Upstream latency", "Slow queries", "Lock waits", "Replication lag",
    "Disk IO", "Network in", "Network out", "Login failures", "Search latency", "Resize time",
    "Email queue", "Cron failures", "Active sessions"];
  const extra = names.map((name, i) => ({
    id: `p${i + 1}`, name, status: "converted",
    why: "Same metric, grouping and time window.",
    from: `avg:checkout.${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}{*}`,
    to: `avg(checkout_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")})`
  }));
  const key = window.MIGRATION_ITEMS;
  const at = { overview: 0, rate: 2, db: 7, latency: 11, anomaly: 16, errors: 21, disk: 26, cpu: 31 };
  const out = [...extra];
  for (const it of key.slice().sort((a, b) => at[a.id] - at[b.id])) out.splice(at[it.id], 0, it);
  window.MIGRATION_ITEMS = out;
})();
