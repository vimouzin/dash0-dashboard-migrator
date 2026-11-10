import { describe, expect, it } from "vitest";
import { parseFormula, parseMonitorQuery, parseQuery } from "../../src/parse/index.js";
import type { Expr } from "../../src/parse/index.js";
import { validatePromQL } from "../../src/validate/promql.js";
import { RULES, translateMonitor, translateQuery } from "../../src/translate/query/index.js";
import type { MetricAvailability, MetricMapping, TranslateContext } from "../../src/translate/query/index.js";

const METRICS: Record<string, MetricMapping> = {
  "redis.mem.used": { otel: "redis.memory.used", kind: "gauge" },
  "redis.mem.maxmemory": { otel: "redis.maxmemory", kind: "gauge" },
  "system.cpu.user": { otel: "system.cpu.utilization", kind: "gauge" },
  "nginx.requests": { otel: "nginx.requests", kind: "counter" },
  "app.events": { otel: "app.events", kind: "delta" },
  "http.duration": { otel: "http.server.request.duration", kind: "histogram" },
  // fn.histogram.quantile fixtures: a curated Datadog distribution read from an OTel histogram.
  "http.dd.dist": { otel: "http.client.request.duration", kind: "histogram", ddKind: "distribution", status: "exact" },
  "http.dd.dist_ms": { otel: "http.client.request.duration", kind: "histogram", ddKind: "distribution", status: "exact", scale: 1000 },
  "http.dd.dist_split": { otel: "rpc.server.duration", kind: "histogram", ddKind: "distribution", status: "exact", sumBy: ["rpc_method"] },
  "http.dd.gauge_on_hist": { otel: "http.server.request.duration", kind: "histogram", ddKind: "gauge", status: "exact" },
  // Shaped like T1's metricLookup() output (PR #4), taken from mappings/datadog/redisdb.yaml.
  "redis.cpu.sys": { otel: "redis.cpu.time", kind: "counter", ddKind: "rate", labels: { state: "sys" }, status: "exact" },
  "redis.net.commands": { otel: "redis.commands.processed", kind: "counter", ddKind: "rate", status: "exact" },
  "redis.net.clients": { otel: "redis.clients.connected", kind: "gauge", ddKind: "gauge", status: "exact" },
  "redis.dd.gauge_on_counter": { otel: "redis.connections.received", kind: "counter", ddKind: "gauge", status: "exact" },
  "redis.dd.approx": { otel: "redis.memory.rss", kind: "gauge", ddKind: "gauge", status: "approximate", note: "RSS vs used" },
  "redis.dd.count": { otel: "redis.keys.evicted", kind: "counter", ddKind: "count", status: "exact" },
  // Datadog stores these running totals as gauges; the OTel receiver emits counters (as in redisdb.yaml).
  "redis.keys.evicted": { otel: "redis.keys.evicted", kind: "counter", ddKind: "gauge", status: "exact" },
  "redis.net.rejected": { otel: "redis.connections.rejected", kind: "counter", ddKind: "gauge", status: "exact" },
  // select.metric.transform fixtures: Datadog value = scale x OTel value; sumBy labels are summed away first.
  "redis.dd.scaled": { otel: "redis.dd.fraction", kind: "gauge", ddKind: "gauge", status: "exact", scale: 100 },
  "redis.dd.cpu_ms": { otel: "redis.cpu.time", kind: "counter", ddKind: "rate", status: "exact", scale: 1000 },
  "redis.dd.keys": { otel: "redis.db.keys", kind: "gauge", ddKind: "gauge", status: "exact", sumBy: ["db"] },
  "redis.dd.keys_kb": { otel: "redis.db.bytes", kind: "gauge", ddKind: "gauge", status: "exact", scale: 0.001, sumBy: ["db"] },
  "redis.dd.negscale": { otel: "redis.dd.neg", kind: "gauge", ddKind: "gauge", status: "exact", scale: -1 },
  // The table names OTel attributes as emitted (dotted); Dash0 labels use underscores (kubernetes_state.yaml).
  "k8s.dd.dotted": { otel: "k8s.container.status.state", kind: "gauge", ddKind: "gauge", labels: { "k8s.container.status.state": "running" }, status: "exact", sumBy: ["k8s.dd.split"] },
};
/** Mirrors T1's metricAvailability(): known to the table but not usable. */
const AVAILABILITY: Record<string, MetricAvailability> = {
  "redis.info.latency_ms": "no_equivalent",
  "redis.dd.derived": "derived",
  // A context that knows the entry needs a transform but can't pass scale/sumBy to T4.
  "redis.dd.opaque": "needs_transform",
};
/** Mirrors the metadata.csv kind table for metrics without a curated entry. */
const DD_KINDS: Record<string, "gauge" | "count" | "rate" | "distribution"> = {
  "dd.gauge.temp": "gauge",
  "dd.count.hits": "count",
  "dd.rate.bytes": "rate",
  "dd.dist.latency": "distribution",
};
const CTX: TranslateContext = {
  metric: (n) => METRICS[n],
  ddKind: (n) => DD_KINDS[n],
  availability: (n) => AVAILABILITY[n] ?? (METRICS[n] ? "mapped" : "unmapped"),
  tag: (t) => ({ host: "host_name", env: "deployment_environment_name", service: "service_name" })[t],
  variables: { host: { tag: "host" }, scope: { tag: null } },
};

function q(src: string, ctx: TranslateContext = CTX) {
  const p = parseQuery(src);
  if (!p.ok) throw new Error(p.error.message);
  return translateQuery(p.value, ctx);
}
function mon(src: string, opts: { critical?: number; warning?: number } = {}, ctx: TranslateContext = CTX) {
  const p = parseMonitorQuery(src);
  if (!p.ok) throw new Error(p.error.message);
  return translateMonitor(p.value, opts, ctx);
}

const SEL = (name: string, extra = "") => `{otel_metric_name="${name}"${extra}}`;
const used = new Set<string>();
const track = <T extends { rules: string[] }>(r: T): T => {
  r.rules.forEach((x) => used.add(x));
  return r;
};

/** [rule under test, Datadog query, expected PromQL, expected status] */
const CASES: [string, string, string, string][] = [
  ["select.metric.mapped", "avg:system.cpu.user{*}", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["select.metric.unmapped", "avg:foo.bar{*}", `avg (avg_over_time(${SEL("foo.bar")}[$__interval]))`, "exact-under"],
  ["scope.all", "sum:system.cpu.user{*}", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["scope.tag.eq", "avg:system.cpu.user{env:prod}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name="prod"')}[$__interval]))`, "exact-under"],
  ["scope.tag.neq", "avg:system.cpu.user{!env:dev}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name!="dev"')}[$__interval]))`, "exact-under"],
  ["scope.tag.wildcard", "avg:system.cpu.user{host:web-*.a}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', host_name=~"^web-.*\\\\.a$"')}[$__interval]))`, "exact-under"],
  ["scope.in", "avg:system.cpu.user{env IN (prod,stage)}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name=~"^(prod|stage)$"')}[$__interval]))`, "exact-under"],
  ["scope.or.same-key", "avg:system.cpu.user{env:prod OR env:stage}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name=~"^(prod|stage)$"')}[$__interval]))`, "exact-under"],
  ["scope.not", "avg:system.cpu.user{NOT env:dev}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name!="dev"')}[$__interval]))`, "exact-under"],
  ["scope.var", "avg:redis.mem.used{$host} by {host}", `avg by (host_name) (avg_over_time(${SEL("redis.memory.used", ', host_name=~"^($host)$"')}[$__interval]))`, "exact-under"],
  ["select.metric.transform", "avg:redis.dd.scaled{*}", `100 * avg (avg_over_time(${SEL("redis.dd.fraction")}[$__interval]))`, "exact-under"],
  ["select.metric.transform", "sum:redis.dd.scaled{*} by {host}", `100 * sum by (host_name) (avg_over_time(${SEL("redis.dd.fraction")}[$__interval]))`, "exact-under"],
  ["select.metric.transform", "max:redis.dd.scaled{*}.rollup(min, 60)", `100 * max (min_over_time(${SEL("redis.dd.fraction")}[1m]))`, "exact-under"],
  ["select.metric.transform", "count:redis.dd.scaled{*}", `count (avg_over_time(${SEL("redis.dd.fraction")}[$__interval]))`, "exact-under"],
  ["select.metric.transform", "sum:redis.dd.scaled{*}.rollup(count, 60)", `sum (count_over_time(${SEL("redis.dd.fraction")}[1m]))`, "exact-under"],
  ["select.metric.transform", "avg:redis.dd.cpu_ms{*}", `1000 * avg (rate(${SEL("redis.cpu.time")}[$__interval] anchored))`, "exact-under"],
  ["select.metric.transform", "sum:redis.dd.keys{*} by {host}", `sum by (host_name) (sum without (db) (avg_over_time(${SEL("redis.db.keys")}[$__interval])))`, "exact-under"],
  ["select.metric.transform", "sum:redis.dd.keys{*}.rollup(sum, 60)", `sum (sum without (db) (sum_over_time(${SEL("redis.db.keys")}[1m])))`, "exact-under"],
  ["select.metric.transform", "avg:redis.dd.keys{host:a}", `avg (sum without (db) (avg_over_time(${SEL("redis.db.keys", ', host_name="a"')}[$__interval])))`, "exact-under"],
  ["select.metric.transform", "max:redis.dd.keys_kb{*} by {host}", `0.001 * max by (host_name) (sum without (db) (avg_over_time(${SEL("redis.db.bytes")}[$__interval])))`, "exact-under"],
  ["time.rollup.default", "max:system.cpu.user{*}", `max (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.rollup.explicit", "avg:redis.mem.used{*} by {host}.rollup(max, 300)", `avg by (host_name) (max_over_time(${SEL("redis.memory.used")}[5m]))`, "exact-under"],
  ["time.as_count.gauge", "sum:system.cpu.user{*}.as_count()", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.as_rate.gauge", "sum:system.cpu.user{*}.as_rate()", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.as_count.delta", "sum:app.events{*}.as_count()", `sum (sum_over_time(${SEL("app.events")}[$__interval]))`, "exact-under"],
  ["time.as_count.counter.anchored", "sum:nginx.requests{*} by {host}.as_count()", `sum by (host_name) (increase(${SEL("nginx.requests")}[$__interval] anchored))`, "exact-under"],
  ["time.as_rate.counter.anchored", "sum:nginx.requests{*}.as_rate()", `sum (rate(${SEL("nginx.requests")}[$__interval] anchored))`, "exact-under"],
  ["time.fill.null", "avg:system.cpu.user{*}.fill(null)", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["space.agg", "count:system.cpu.user{*} by {host,env}", `count by (deployment_environment_name, host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["space.default-avg", "system.cpu.user{*}", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["map.abs", "abs(avg:system.cpu.user{*})", `abs(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["map.log2", "log2(avg:system.cpu.user{*})", `log2(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["map.log10", "log10(avg:system.cpu.user{*})", `log10(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["map.clamp_min", "clamp_min(avg:system.cpu.user{*}, 0)", `clamp_min(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])), 0)`, "exact-under"],
  ["map.clamp_max", "clamp_max(avg:system.cpu.user{*}, 100)", `clamp_max(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])), 100)`, "exact-under"],
  ["map.timeshift", "timeshift(avg:system.cpu.user{*}, -3600)", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval] offset 1h))`, "exact-under"],
  ["arith.number", "100 * avg:system.cpu.user{*}", `100 * avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["arith.same-groups", "avg:redis.mem.used{*} by {host} - avg:redis.mem.maxmemory{*} by {host}", `avg by (host_name) (avg_over_time(${SEL("redis.memory.used")}[$__interval])) - avg by (host_name) (avg_over_time(${SEL("redis.maxmemory")}[$__interval]))`, "exact-under"],
  ["arith.div", "avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*}", `avg (avg_over_time(${SEL("redis.memory.used")}[$__interval])) / avg (avg_over_time(${SEL("redis.maxmemory")}[$__interval]))`, "exact-under"],
  ["label.default", "avg:system.cpu.user{region:eu-1}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', region="eu-1"')}[$__interval]))`, "exact-under"],
  ["fn.per_unit.counter", "per_minute(sum:redis.keys.evicted{*} by {host})", `60 * sum by (host_name) (rate(${SEL("redis.keys.evicted")}[$__rate_interval]))`, "bounded"],
  ["fn.per_unit.counter", "per_second(avg:redis.keys.evicted{*})", `avg (rate(${SEL("redis.keys.evicted")}[$__rate_interval]))`, "bounded"],
  ["fn.per_unit.counter", "per_hour(sum:redis.keys.evicted{*})", `3600 * sum (rate(${SEL("redis.keys.evicted")}[$__rate_interval]))`, "bounded"],
  ["fn.diff", "diff(sum:redis.net.rejected{*})", `sum (avg_over_time(${SEL("redis.connections.rejected")}[$__interval])) - sum (avg_over_time(${SEL("redis.connections.rejected")}[$__interval] offset $__interval))`, "exact-under"],
  ["select.metric.kind-metadata", "avg:dd.gauge.temp{*}.as_count()", `avg (avg_over_time(${SEL("dd.gauge.temp")}[$__interval]))`, "exact-under"],
  ["time.unmapped.counter.anchored", "sum:dd.count.hits{*} by {host}.as_count()", `sum by (host_name) (increase(${SEL("dd.count.hits")}[$__interval] anchored))`, "exact-under"],
  ["time.unmapped.counter.anchored", "sum:dd.count.hits{*}.as_rate()", `sum (rate(${SEL("dd.count.hits")}[$__interval] anchored))`, "exact-under"],
  ["time.unmapped.counter.anchored", "avg:dd.rate.bytes{*}", `avg (rate(${SEL("dd.rate.bytes")}[$__interval] anchored))`, "exact-under"],
  ["fn.top", "top(avg:system.cpu.user{*} by {host}, 10, 'mean', 'desc')", `topk(10, avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["fn.top", "top(avg:system.cpu.user{*} by {host}, 5, 'max', 'asc')", `bottomk(5, avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["fn.top", "bottom5_max(avg:system.cpu.user{*} by {host})", `bottomk(5, avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["fn.top", "top10(avg:system.cpu.user{*} by {host})", `topk(10, avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["fn.cutoff", "cutoff_min(avg:system.cpu.user{*}, 5)", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) >= 5`, "exact-under"],
  ["fn.cutoff", "cutoff_max(avg:system.cpu.user{*}, 95)", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) <= 95`, "exact-under"],
  ["fn.count_not_null", "count_not_null(avg:system.cpu.user{*} by {host})", `count (avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))) or vector(0)`, "exact-under"],
  ["fn.count_nonzero", "count_nonzero(avg:system.cpu.user{*} by {host})", `count (avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) != 0) or vector(0)`, "exact-under"],
  ["fn.default_zero.single", "default_zero(sum:system.cpu.user{*})", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) or vector(0)`, "exact-under"],
  ["fn.derivative.counter", "derivative(sum:redis.net.rejected{*})", `sum (rate(${SEL("redis.connections.rejected")}[$__rate_interval]))`, "bounded"],
  ["time.weighted", "avg:system.cpu.user{*}.weighted()", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["time.fill.null", "avg:system.cpu.user{*}.fill(null, 300)", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["scope.var.negated", "avg:system.cpu.user{!$host}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', host_name!~"^($host)$"')}[$__interval]))`, "exact-under"],
  ["scope.not.set", "avg:system.cpu.user{NOT (env:dev OR env:test*)}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name!~"^(dev|test.*)$"')}[$__interval]))`, "exact-under"],
  ["scope.not.set", "avg:system.cpu.user{NOT env IN (a,b)}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name!~"^(a|b)$"')}[$__interval]))`, "exact-under"],
  ["time.count.default.anchored", "sum:dd.count.hits{*} by {host}", `sum by (host_name) (increase(${SEL("dd.count.hits")}[$__interval] anchored))`, "exact-under"],
  ["time.count.counter.anchored", "sum:redis.dd.count{*} by {host}", `sum by (host_name) (increase(${SEL("redis.keys.evicted")}[$__interval] anchored))`, "exact-under"],
  ["time.rollup.counter.anchored", "sum:dd.count.hits{*}.as_count().rollup(sum, 300)", `sum (increase(${SEL("dd.count.hits")}[5m] anchored))`, "exact-under"],
  ["time.rollup.counter.anchored", "sum:nginx.requests{*}.as_rate().rollup(avg, 120)", `sum (rate(${SEL("nginx.requests")}[2m] anchored))`, "exact-under"],
  ["time.fill.zero.single", "sum:system.cpu.user{*}.fill(zero)", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) or vector(0)`, "exact-under"],
  ["fn.per_unit.counter", "per_second(sum:dd.count.hits{*})", `sum (rate(${SEL("dd.count.hits")}[$__rate_interval]))`, "bounded"],
  ["fn.per_unit.counter", "per_minute(avg:dd.count.hits{*}.as_count())", `60 * avg (rate(${SEL("dd.count.hits")}[$__rate_interval]))`, "bounded"],
  ["time.unmapped.suffix-counter.anchored", "sum:kong.http.status.count{*} by {code}.as_count()", `sum by (code) (increase(${SEL("kong.http.status.count")}[$__interval] anchored))`, "exact-under"],
  ["fn.round", "round(avg:system.cpu.user{*})", `round(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])))`, "exact-under"],
  ["fn.exclude_null", "exclude_null(avg:system.cpu.user{*} by {host})", `avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization", ', host_name!=""')}[$__interval]))`, "exact-under"],
  ["fn.exclude_null", "exclude_null(avg:system.cpu.user{*})", `avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  ["fn.monotonic_diff", "monotonic_diff(sum:system.cpu.user{*})", `sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) - sum (avg_over_time(${SEL("system.cpu.utilization")}[$__interval] offset $__interval)) >= 0`, "exact-under"],
  ["fn.max_min.scalar", "min(100, avg:system.cpu.user{*} * 2)", `clamp_max(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) * 2, 100)`, "exact-under"],
  ["fn.max_min.scalar", "max(avg:system.cpu.user{*}, 0)", `clamp_min(avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])), 0)`, "exact-under"],
  ["fn.max_min.series", "max(avg:redis.mem.used{*}, avg:redis.mem.maxmemory{*})", `avg (avg_over_time(${SEL("redis.memory.used")}[$__interval])) >= avg (avg_over_time(${SEL("redis.maxmemory")}[$__interval])) or avg (avg_over_time(${SEL("redis.maxmemory")}[$__interval]))`, "exact-under"],
  ["fn.default_zero.grouped", "default_zero(avg:system.cpu.user{*} by {host})", `avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__interval])) or 0 * avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[$__range] @ end()))`, "exact-under"],
  ["fn.per_unit.gauge", "per_minute(avg:system.cpu.user{*})", `60 * avg (rate(${SEL("system.cpu.utilization")}[$__rate_interval]))`, "bounded"],
  ["fn.per_unit.gauge", "derivative(sum:system.cpu.user{*})", `sum (rate(${SEL("system.cpu.utilization")}[$__rate_interval]))`, "bounded"],
  ["scope.same-key.var", "avg:system.cpu.user{host:web-*,$host}", `avg (avg_over_time(${SEL("system.cpu.utilization", ', host_name=~"^($host)$", host_name=~"^web-.*$"')}[$__interval]))`, "exact-under"],
  ["arith.neg", "-avg:system.cpu.user{*}", `-avg (avg_over_time(${SEL("system.cpu.utilization")}[$__interval]))`, "exact-under"],
  // T1 mapping fields (ddKind, labels, status)
  ["select.metric.mapped", "avg:redis.net.clients{*}", `avg (avg_over_time(${SEL("redis.clients.connected")}[$__interval]))`, "exact-under"],
  ["select.labels", "avg:redis.cpu.sys{*} by {host}", `avg by (host_name) (rate(${SEL("redis.cpu.time", ', state="sys"')}[$__interval] anchored))`, "exact-under"],
  ["select.labels", "sum:k8s.dd.dotted{*}", `sum (sum without (k8s_dd_split) (avg_over_time(${SEL("k8s.container.status.state", ', k8s_container_status_state="running"')}[$__interval])))`, "exact-under"],
  ["time.ddrate.plain.anchored", "sum:redis.net.commands{*}", `sum (rate(${SEL("redis.commands.processed")}[$__interval] anchored))`, "exact-under"],
  ["select.metric.mapped", "avg:redis.dd.gauge_on_counter{*}", `avg (avg_over_time(${SEL("redis.connections.received")}[$__interval]))`, "exact-under"],
  ["select.metric.approximate", "avg:redis.dd.approx{*}", `avg (avg_over_time(${SEL("redis.memory.rss")}[$__interval]))`, "bounded"],
];

describe("rule table: one exact PromQL string per rule", () => {
  for (const [rule, src, promql, status] of CASES) {
    it(`${rule}: ${src}`, () => {
      const r = track(q(src));
      expect(r.findings.filter((f) => f.status === "manual")).toEqual([]);
      expect(r.promql).toBe(promql);
      expect(r.rules).toContain(rule);
      expect(r.status).toBe(status);
      expect(validatePromQL(r.promql!).ok).toBe(true);
    });
  }

  it("unmapped metric warns and records the gauge assumption", () => {
    const r = q("avg:foo.bar{*}");
    expect(r.findings).toMatchObject([{ status: "exact-under", code: "metric.unmapped", itemKind: "query" }]);
    expect(r.assumptions).toContain("A.kind-gauge");
  });

  it("free-form $scope is dropped under the A.var-default assumption", () => {
    const r = track(q("avg:redis.mem.used{$scope,$host} by {host}"));
    expect(r.promql).toBe(`avg by (host_name) (avg_over_time(${SEL("redis.memory.used", ', host_name=~"^($host)$"')}[$__interval]))`);
    expect(r.assumptions).toContain("A.var-default");
    expect(r.findings).toMatchObject([{ code: "scope.var.free-form" }]);
  });

  it("findings use the CONTRACT-001 shape, with checkable assumption text", () => {
    const r = q("avg:foo.bar{region:eu}", { ...CTX, where: "dd-dash-1/panel-3/query1" });
    expect(r.findings).toEqual([
      {
        status: "exact-under",
        code: "metric.unmapped",
        message: "no mapping for foo.bar; kept the Datadog name and assumed a gauge",
        itemKind: "query",
        itemId: "dd-dash-1/panel-3/query1",
        ruleId: "select.metric.unmapped",
        assumptions: ["the metric is a gauge; there is no mapping-table entry to confirm its kind"],
      },
      {
        status: "exact-under",
        code: "tag.unmapped",
        message: "tag 'region' has no tag-table entry; using label 'region'",
        itemKind: "query",
        itemId: "dd-dash-1/panel-3/query1",
        ruleId: "label.default",
        assumptions: [
          "the Datadog tag maps to the OTel label of the same name with dots replaced by underscores (no tag-table entry)",
        ],
      },
    ]);
  });

  it("a variable used as a tag value is anchored too", () => {
    expect(q("avg:system.cpu.user{env:$env.value}", { ...CTX, variables: { env: { tag: "env" } } }).promql).toBe(
      `avg (avg_over_time(${SEL("system.cpu.utilization", ', deployment_environment_name=~"^($env)$"')}[$__interval]))`,
    );
  });

  it("a counter with an explicit width keeps it (no $__rate_interval)", () => {
    expect(q("sum:nginx.requests{*}.as_rate()", { ...CTX, interval: 60 }).promql).toBe(`sum (rate(${SEL("nginx.requests")}[1m] anchored))`);
  });

  it("interval can be fixed per dashboard", () => {
    expect(q("avg:system.cpu.user{*}", { ...CTX, interval: 60 }).promql).toBe(
      `avg (avg_over_time(${SEL("system.cpu.utilization")}[1m]))`,
    );
  });

  it("is deterministic: same input, same bytes", () => {
    const src = "avg:redis.mem.used{env:prod,$host,service:a} by {service,host}";
    expect(q(src).promql).toBe(q(src).promql);
    expect(q(src).promql).toBe(q("avg:redis.mem.used{service:a,$host,env:prod} by {host,service}").promql);
  });
});

describe("formulas", () => {
  it("substitutes query refs and keeps Datadog's arithmetic", () => {
    const env = new Map<string, Expr>();
    for (const [k, s] of [
      ["query1", "avg:redis.mem.used{*} by {host}"],
      ["query2", "max:redis.mem.maxmemory{*} by {host}"],
    ] as const) {
      const p = parseQuery(s);
      if (p.ok) env.set(k, p.value);
    }
    const f = parseFormula("100 * query1 / query2");
    if (!f.ok) throw new Error();
    const r = translateQuery(f.value, CTX, env);
    expect(r.promql).toBe(
      `100 * avg by (host_name) (avg_over_time(${SEL("redis.memory.used")}[$__interval])) / max by (host_name) (avg_over_time(${SEL("redis.maxmemory")}[$__interval]))`,
    );
    expect(r.status).toBe("exact-under");
  });

  it("a query referenced twice reports its findings once", () => {
    const env = new Map<string, Expr>();
    const p = parseQuery("avg:foo.hits{*}");
    if (p.ok) env.set("query1", p.value);
    const f = parseFormula("query1 / (query1 + 1)");
    if (!f.ok) throw new Error();
    expect(translateQuery(f.value, CTX, env).findings.filter((x) => x.code === "metric.unmapped")).toHaveLength(1);
  });

  it("an unknown ref is manual", () => {
    const f = parseFormula("query9 * 2");
    if (!f.ok) throw new Error();
    expect(translateQuery(f.value, CTX, new Map())).toMatchObject({ status: "manual", promql: null });
  });
});

describe("select.metric.transform", () => {
  it("sumBy under avg_over_time/rate/increase adds A.sumby-together; sum_over_time does not", () => {
    expect(q("sum:redis.dd.keys{*}").assumptions).toContain("A.sumby-together");
    expect(q("sum:redis.dd.keys{*}.rollup(sum, 60)").assumptions).not.toContain("A.sumby-together");
    expect(q("avg:redis.dd.scaled{*}").assumptions).not.toContain("A.sumby-together");
  });

  it("per_second over a scaled running total scales the rate form", () => {
    const r = track(q("per_second(sum:redis.dd.scaled{*})"));
    expect(r.promql).toBe(`100 * sum (rate(${SEL("redis.dd.fraction")}[$__rate_interval]))`);
  });

  it("diff over a summed-by query stays linear", () => {
    const r = track(q("diff(sum:redis.dd.keys{*})"));
    expect(r.promql).toBe(
      `sum (sum without (db) (avg_over_time(${SEL("redis.db.keys")}[$__interval]))) - sum (sum without (db) (avg_over_time(${SEL("redis.db.keys")}[$__interval] offset $__interval)))`,
    );
  });

  it("monitors: the scale stays inside the 1m bucket query, in Datadog units against the threshold", () => {
    const r = track(mon("avg(last_5m):avg:redis.dd.scaled{*} by {host} > 90", { critical: 90 }));
    expect(r.promql).toBe(`avg_over_time((100 * avg by (host_name) (avg_over_time(${SEL("redis.dd.fraction")}[1m])))[5m:1m]) > $__threshold`);
    expect(r.thresholds).toEqual({ failed: 90 });
  });

  it("every emitted transform validates as PromQL", () => {
    for (const s of ["avg:redis.dd.scaled{*}", "sum:redis.dd.keys{*} by {host}", "max:redis.dd.keys_kb{*} by {host}"]) {
      const r = q(s);
      expect(validatePromQL(r.promql!).ok, r.promql!).toBe(true);
    }
  });
});

describe("fn.histogram.quantile: pXX on a distribution (maths.md §12, T11)", () => {
  const H = (name: string, extra = "", w = "$__rate_interval") => `rate(${SEL(name, extra)}[${w}])`;
  const HQ_ASSUMPTIONS = ["A.finite-quantile", "A.histogram-buckets", "A.histogram-samples"];

  it("p95 on a curated distribution -> histogram_quantile over sum by (le) of the bucket rates", () => {
    const r = track(q("p95:http.dd.dist{*}"));
    expect(r.promql).toBe(`histogram_quantile(0.95, sum by (le) (${H("http.client.request.duration")}))`);
    expect(r.status).toBe("bounded");
    expect(r.rules).toEqual(expect.arrayContaining(["select.metric.mapped", "fn.histogram.quantile"]));
    expect(r.rules).not.toContain("space.agg");
    expect(r.assumptions).toEqual(HQ_ASSUMPTIONS);
    expect(validatePromQL(r.promql!).ok).toBe(true);
  });

  it("p99.9 keeps the decimal quantile exactly (0.999, no float noise)", () => {
    const r = track(q("p99.9:http.duration{*}"));
    expect(r.promql).toBe(`histogram_quantile(0.999, sum by (le) (${H("http.server.request.duration")}))`);
    expect(r.status).toBe("bounded");
  });

  it("by {g} and filters: le joins the group-by labels, scope becomes matchers", () => {
    const r = track(q("p50:http.dd.dist{env:prod} by {service,host}"));
    expect(r.promql).toBe(
      `histogram_quantile(0.5, sum by (host_name, le, service_name) (${H("http.client.request.duration", ', deployment_environment_name="prod"')}))`,
    );
    expect(validatePromQL(r.promql!).ok).toBe(true);
  });

  it("a fixed dashboard interval is used as the rate window", () => {
    const r = q("p90:http.dd.dist{*}", { ...CTX, interval: 300 });
    expect(r.promql).toBe(`histogram_quantile(0.9, sum by (le) (${H("http.client.request.duration", "", "5m")}))`);
  });

  it("a metadata.csv distribution without a curated entry keeps its name, under A.kind-metadata", () => {
    const r = track(q("p99:dd.dist.latency{*}"));
    expect(r.promql).toBe(`histogram_quantile(0.99, sum by (le) (${H("dd.dist.latency")}))`);
    expect(r.status).toBe("bounded");
    expect(r.assumptions).toEqual(["A.kind-metadata", ...HQ_ASSUMPTIONS].sort());
    expect(r.rules).toContain("select.metric.kind-metadata");
  });

  it("scale k > 0 multiplies the quantile (quantiles commute with positive scaling); sumBy labels are summed by sum by (le, g)", () => {
    expect(track(q("p95:http.dd.dist_ms{*}")).promql).toBe(`1000 * histogram_quantile(0.95, sum by (le) (${H("http.client.request.duration")}))`);
    const s = track(q("p95:http.dd.dist_split{*} by {service}"));
    expect(s.promql).toBe(`histogram_quantile(0.95, sum by (le, service_name) (${H("rpc.server.duration")}))`);
    expect(s.rules).toContain("select.metric.transform");
    expect(s.assumptions).not.toContain("A.sumby-together");
  });

  it("monitors reuse it on 1m buckets inside the window subquery", () => {
    const r = track(mon("avg(last_5m):p95:http.dd.dist{*} by {service} > 0.5", { critical: 0.5 }));
    expect(r.promql).toBe(
      `avg_over_time((histogram_quantile(0.95, sum by (le, service_name) (${H("http.client.request.duration", "", "1m")})))[5m:1m]) > $__threshold`,
    );
    expect(r.status).toBe("bounded");
    expect(r.thresholds).toEqual({ failed: 0.5 });
    expect(r.assumptions).toEqual(expect.arrayContaining(["A.monitor-rollup-60s", ...HQ_ASSUMPTIONS]));
  });

  it("avg:/max: on a distribution are unchanged (still manual)", () => {
    expect(q("avg:http.dd.dist{*}")).toMatchObject({ status: "manual", promql: null });
    expect(q("max:http.duration{*}")).toMatchObject({ status: "manual", promql: null });
    expect(q("avg:dd.dist.latency{*}").findings.some((f) => f.code === "metric.distribution")).toBe(true);
  });

  for (const [code, src, why] of [
    ["fn.histogram.kind-unknown", "p95:unmapped.latency{*}", /no mapping entry/],
    ["fn.histogram.kind", "p99:system.cpu.user{*}", /OTel gauge/],
    ["fn.histogram.kind", "p99:nginx.requests{*}", /OTel counter/],
    ["fn.histogram.kind", "p95:http.dd.gauge_on_hist{*}", /Datadog stores it as a gauge/],
    ["fn.histogram.modifier", "p95:http.dd.dist{*}.rollup(max, 60)", /rollup/],
    ["fn.histogram.le", "p95:http.dd.dist{*} by {le}", /le/],
    ["query.value-filter", "p95(v: v>=0):http.dd.dist{*}", /value filter/],
  ] as const) {
    it(`fails closed: ${code}: ${src}`, () => {
      const r = q(src);
      expect(r).toMatchObject({ status: "manual", promql: null });
      const f = r.findings.find((x) => x.status === "manual" && x.code === code);
      expect(f, r.findings.map((x) => x.code).join(",")).toBeDefined();
      expect(f!.message).toMatch(why);
    });
  }

  it("a pXX query cannot feed per_second/diff (no rate form, not linear in the series)", () => {
    expect(q("per_second(p95:http.dd.dist{*})").status).toBe("manual");
    expect(q("diff(p95:http.dd.dist{*})").status).toBe("manual");
  });
});

describe("fail closed: manual, no PromQL, original kept", () => {
  for (const [code, src] of [
    ["fn.anomalies", "anomalies(avg:system.cpu.user{*}, 'basic', 2)"],
    ["fn.top.args", "top(avg:system.cpu.user{*} by {host}, 10, 'median', 'desc')"],
    ["fn.default_zero.scalar", "default_zero(5)"],
    ["fn.derivative.kind", "derivative(max:system.cpu.user{*})"],
    ["scope.var.negated", "avg:system.cpu.user{!$scope}"],
    ["scope.not.complex", "avg:system.cpu.user{NOT (env:a AND host:b)}"],
    ["metric.distribution", "avg:dd.dist.latency{*}"],
    ["time.rollup.counter", "sum:dd.count.hits{*}.rollup(max, 60)"],
    ["time.fill", "avg:system.cpu.user{*} by {host}.fill(zero)"],
    ["time.kind", "per_second(sum:nginx.requests{*})"],
    ["fn.diff.offset", "diff(timeshift(avg:system.cpu.user{*}, -3600))"],
    ["time.fill", "avg:system.cpu.user{*}.fill(last)"],
    ["time.kind", "sum:nginx.requests{*}"],
    ["time.kind", "avg:http.duration{*}"],
    ["fn.histogram.kind", "p99:system.cpu.user{*}"],
    ["scope.bare-tag", "avg:system.cpu.user{canary}"],
    ["scope.or.cross-key", "avg:system.cpu.user{env:prod OR host:a}"],
    ["scope.same-key", "avg:system.cpu.user{host:a,host:b}"],
    ["arith.group-mismatch", "avg:redis.mem.used{*} by {host} / avg:redis.mem.maxmemory{*}"],
    ["query.value-filter", "count(v: v>=0):system.cpu.user{*}"],
    ["time.kind-unknown", "sum:unmapped.hits{*}.as_count()"],
    ["arith.group-mismatch", "max(avg:redis.mem.used{*} by {host}, avg:redis.mem.maxmemory{*})"],
    ["fn.max_min.constants", "max(1, 2)"],
    ["fn.top.args", "bottom(avg:system.cpu.user{*} by {host}, 5, 'mean', 'asc')"],
    ["fn.diff.agg", "diff(max:system.cpu.user{*} by {host})"],
    ["fn.monotonic_diff.agg", "monotonic_diff(count:system.cpu.user{*})"],
    ["fn.diff.agg", "diff(abs(avg:system.cpu.user{*}))"],
    ["time.kind-unknown", "sum:custom.requests.count2{*}.as_count()"],
    ["time.kind", "sum:redis.net.commands{*}.as_count()"],
    ["time.kind", "sum:redis.net.commands{*}.as_rate()"],
    ["time.kind", "sum:redis.dd.cpu_ms{*} by {host}.as_count()"],
    ["select.labels.clash", "avg:redis.cpu.sys{state:user}"],
    ["metric.no_equivalent", "avg:redis.info.latency_ms{*}"],
    ["metric.derived", "avg:redis.dd.derived{*}"],
    ["metric.needs_transform", "avg:redis.dd.opaque{*}"],
    ["metric.needs_transform", "avg:redis.dd.negscale{*}"],
    ["metric.needs_transform", "sum:redis.dd.keys{db:0}"],
    ["metric.needs_transform", "sum:redis.dd.keys{*} by {db}"],
    ["metric.needs_transform", "sum:redis.dd.keys{*}.rollup(max, 60)"],
    ["metric.needs_transform", "sum:redis.dd.keys{*}.rollup(count, 60)"],
    ["arith.div-zero", "avg:system.cpu.user{*} / 0"],
    ["fn.per_unit.kind", "per_minute(min:system.cpu.user{*})"],
    ["fn.per_unit.kind", "per_minute(max:redis.keys.evicted{*})"],
    ["fn.per_unit.kind", "per_minute(sum:redis.keys.evicted{*}.rollup(sum, 60))"],
  ] as const) {
    it(`${code}: ${src}`, () => {
      const r = q(src);
      expect(r.status).toBe("manual");
      expect(r.promql).toBeNull();
      expect(r.findings.some((f) => f.status === "manual" && f.code === code)).toBe(true);
    });
  }
});

describe("monitors", () => {
  it("redis high_mem: the evaluator's exact subquery form (maths.md §5)", () => {
    const r = track(mon("avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90", { critical: 90, warning: 70 }));
    expect(r.promql).toBe(
      `avg_over_time((100 * avg (avg_over_time(${SEL("redis.memory.used")}[1m])) / avg (avg_over_time(${SEL("redis.maxmemory")}[1m])))[5m:1m]) > $__threshold`,
    );
    expect(r.thresholds).toEqual({ failed: 90, degraded: 70 });
    expect(r.negated).toBe(false);
    expect(r.status).toBe("exact-under");
    expect(r.assumptions).toEqual(["A.boundary", "A.monitor-rollup-60s", "A.nonzero-denominator"]);
    expect(r.rules).toEqual(expect.arrayContaining(["monitor.window", "monitor.cmp.gt", "time.rollup.monitor-bucket"]));
  });

  it("< becomes a negated > with negated thresholds (maths.md T7)", () => {
    const r = track(mon("min(last_15m):avg:system.cpu.user{*} by {host} < 10", { critical: 10, warning: 20 }));
    expect(r.promql).toBe(
      `-min_over_time((avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[1m])))[15m:1m]) > $__threshold`,
    );
    expect(r.thresholds).toEqual({ failed: -10, degraded: -20 });
    expect(r.negated).toBe(true);
  });

  it(">= keeps >=; missing warning means no degraded threshold", () => {
    const r = mon("max(last_1h):max:system.cpu.user{env:prod} >= 95");
    expect(r.promql?.endsWith(">= $__threshold")).toBe(true);
    expect(r.thresholds).toEqual({ failed: 95 });
  });

  it("warns when options.thresholds.critical disagrees with the query", () => {
    const r = mon("avg(last_5m):avg:system.cpu.user{*} > 90", { critical: 80 });
    expect(r.thresholds).toEqual({ failed: 90 });
    expect(r.findings.some((f) => f.code === "monitor.threshold.mismatch")).toBe(true);
    expect(r.assumptions).toContain("A.query-threshold");
  });

  it("sum(last_W) with .as_count() on a counter is the window's increase (no subquery)", () => {
    const r = track(mon("sum(last_5m):sum:redis.dd.count{*} by {host}.as_count() > 100", { critical: 100, warning: 50 }));
    expect(r.promql).toBe(`sum by (host_name) (increase(${SEL("redis.keys.evicted")}[5m])) > $__threshold`);
    expect(r).toMatchObject({ status: "bounded", thresholds: { failed: 100, degraded: 50 } });
    expect(r.rules).toContain("monitor.sum.as_count");
  });

  it("monitors keep the extrapolated counter forms (bounded, no `anchored`): a check rule with it has not been probed", () => {
    const cases: [string, string][] = [
      ["avg(last_5m):avg:redis.net.commands{*} > 100", "time.ddrate.plain"],
      ["avg(last_5m):sum:nginx.requests{*}.as_rate() > 100", "time.as_rate.counter"],
      ["sum(last_5m):sum:dd.count.hits{*}.as_count() > 100", "time.unmapped.counter"],
      ["sum(last_5m):sum:dd.count.hits{*} > 100", "time.count.default"],
      ["sum(last_5m):sum:redis.dd.count{*} > 100", "time.count.counter"],
      ["sum(last_5m):sum:kong.http.status.count{*}.as_count() > 100", "time.unmapped.suffix-counter"],
      ["avg(last_5m):sum:nginx.requests{*}.as_rate().rollup(avg, 60) > 100", "time.rollup.counter"],
    ];
    for (const [src, rule] of cases) {
      const r = track(mon(src));
      expect(r.rules, src).toContain(rule);
      expect(r.status, src).toBe("bounded");
      expect(r.promql, src).not.toContain("anchored");
    }
  });

  it("sum(last_W) totals survive linear arithmetic and fail closed otherwise (no W/60x overcount)", () => {
    const tot = (q: string) => `sum (increase(${SEL(q)}[5m]))`;
    const lin = mon("sum(last_5m):sum:redis.dd.count{*}.as_count() * 2 - sum:nginx.requests{*}.as_count() > 100");
    expect(lin.promql).toBe(`${tot("redis.keys.evicted")} * 2 - ${tot("nginx.requests")} > $__threshold`);
    expect(lin.rules).toContain("monitor.sum.as_count");
    expect(lin.promql).not.toContain("[5m:1m]");
    for (const q of [
      "sum(last_5m):sum:redis.dd.count{*}.as_count() / sum:nginx.requests{*}.as_count() > 1",
      "sum(last_5m):sum:redis.dd.count{*}.as_count() + 5 > 1",
      "sum(last_5m):abs(sum:redis.dd.count{*}.as_count()) > 1",
    ]) {
      const r = mon(q);
      expect(r, q).toMatchObject({ status: "manual", promql: null });
      expect(r.findings.some((f) => f.code === "monitor.as_count"), q).toBe(true);
    }
  });

  it(".as_count() on a counter in a non-sum monitor stays manual", () => {
    const r = mon("avg(last_5m):sum:redis.net.commands{*}.as_count() > 100");
    expect(r).toMatchObject({ status: "manual", promql: null, thresholds: null });
    expect(r.findings).toMatchObject([{ status: "manual", code: "monitor.as_count", itemKind: "alert" }]);
  });

  it("change() and pct_change() compare the window value with the same value C earlier", () => {
    const c = track(mon("change(avg(last_5m),last_1h):avg:system.cpu.user{*} > 10"));
    const X = `avg_over_time((avg (avg_over_time(${SEL("system.cpu.utilization")}[1m])))[5m:1m])`;
    const Xc = `avg_over_time((avg (avg_over_time(${SEL("system.cpu.utilization")}[1m] offset 1h)))[5m:1m])`;
    expect(c.promql).toBe(`${X} - ${Xc} > $__threshold`);
    expect(c.rules).toContain("monitor.change");
    const p = mon("pct_change(avg(last_5m),last_1h):avg:system.cpu.user{*} > 10");
    expect(p.promql).toBe(`100 * ((${X} - ${Xc}) / ${Xc}) > $__threshold`);
    expect(p.assumptions).toContain("A.nonzero-denominator");
  });

  it("default_zero on a grouped monitor query fills from the evaluation window", () => {
    const r = track(mon("avg(last_10m):default_zero(avg:system.cpu.user{*} by {host}) > 5"));
    expect(r.promql).toBe(
      `avg_over_time((avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[1m])) or 0 * avg by (host_name) (avg_over_time(${SEL("system.cpu.utilization")}[10m])))[10m:1m]) > $__threshold`,
    );
    expect(r.rules).toContain("fn.default_zero.grouped.monitor");
  });

  it("== and != compare the distance to the threshold against 0", () => {
    const eq = track(mon("avg(last_5m):avg:system.cpu.user{*} == 0"));
    expect(eq.promql).toBe(`-abs(avg_over_time((avg (avg_over_time(${SEL("system.cpu.utilization")}[1m])))[5m:1m]) - 0) >= $__threshold`);
    expect(eq.thresholds).toEqual({ failed: 0 });
    const ne = mon("avg(last_5m):avg:system.cpu.user{*} != 3");
    expect(ne.promql).toBe(`abs(avg_over_time((avg (avg_over_time(${SEL("system.cpu.utilization")}[1m])))[5m:1m]) - 3) > $__threshold`);
  });

  for (const [code, src] of [
    ["monitor.window.kind", "max(next_12h):avg:system.cpu.user{*} > 1"],
    ["monitor.cmp.eq.warning", "avg(last_5m):avg:system.cpu.user{*} == 0"],
    ["fn.anomalies", "avg(last_1h):anomalies(avg:system.cpu.user{*}, 'basic', 2) >= 1"],
    ["time.rollup.monitor-width", "avg(last_5m):avg:system.cpu.user{*}.rollup(avg, 300) > 1"],
  ] as const) {
    it(`manual: ${code}`, () => {
      const r = mon(src, code === "monitor.cmp.eq.warning" ? { warning: 1 } : {});
      expect(r).toMatchObject({ status: "manual", promql: null, thresholds: null });
      expect(r.findings.some((f) => f.code === code)).toBe(true);
    });
  }
});

describe("coverage of the rule table", () => {
  it("every non-manual rule is exercised by a test above", () => {
    const missing = Object.keys(RULES).filter((r) => !used.has(r));
    expect(missing).toEqual([]);
  });
});

describe("diff with a fixed interval", () => {
  it("adds the step to an existing fixed offset (monitors, fixed-interval dashboards)", () => {
    expect(q("diff(timeshift(avg:system.cpu.user{*}, -3600))", { ...CTX, interval: 60 }).promql).toBe(
      `avg (avg_over_time(${SEL("system.cpu.utilization")}[1m] offset 1h)) - avg (avg_over_time(${SEL("system.cpu.utilization")}[1m] offset 61m))`,
    );
  });
});
