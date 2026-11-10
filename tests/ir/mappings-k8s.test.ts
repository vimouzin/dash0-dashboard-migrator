// kubernetes.* (kubelet check) and kubernetes_state.* tables: the Kubernetes metrics DataDog/integrations-core
// dashboards query, mapped to kubeletstatsreceiver / k8sclusterreceiver. Rows cite the pinned sources; the logic gates
// (mappings-logic.test.ts) check names, kinds, units, labels and default-off flags. Here: the translations themselves.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ddKindLookup, loadDdKinds, loadMappings, metricAvailability, metricLookup, tagLookup } from "../../src/ir/index.js";
import { parseQuery } from "../../src/parse/index.js";
import { translateQuery } from "../../src/translate/query/index.js";
import { validatePromQL } from "../../src/validate/promql.js";

const dir = join(import.meta.dirname, "..", "..", "mappings");
const m = loadMappings(dir);
const ctx = { metric: metricLookup(m), availability: (d: string) => metricAvailability(m, d), ddKind: ddKindLookup(loadDdKinds(dir), m), tag: tagLookup(m) };
const tr = (src: string) => {
  const p = parseQuery(src);
  if (!p.ok) throw new Error(p.error.message);
  return translateQuery(p.value, ctx);
};
const SEL = (name: string, extra = "") => `{otel_metric_name="${name}"${extra}}`;

describe("kubernetes mapping tables", () => {
  it("every row lives in its own file and cites both sides", () => {
    for (const [k, row] of m.metrics) {
      if (k.startsWith("kubernetes.")) expect(m.origin.get(k), k).toMatch(/kubernetes\.yaml$/);
      if (k.startsWith("kubernetes_state.")) expect(m.origin.get(k), k).toMatch(/kubernetes_state\.yaml$/);
      if (k.startsWith("kubernetes")) expect(row.note, k).toMatch(/metadata\.(csv|yaml)|check source/);
    }
    expect([...m.metrics.keys()].filter((k) => k.startsWith("kubernetes.")).length).toBe(27);
    expect([...m.metrics.keys()].filter((k) => k.startsWith("kubernetes_state.")).length).toBe(50);
  });

  it("CPU: Datadog's nanocore rate is rate() of the CPU-seconds counter times 10^9", () => {
    const t = tr("sum:kubernetes.cpu.usage.total{kube_namespace:prod} by {pod_name}");
    expect(t.promql).toBe(`1000000000 * sum by (k8s_pod_name) (rate(${SEL("container.cpu.time", ', k8s_namespace_name="prod"')}[$__interval] anchored))`);
    expect(t.status).toBe("bounded");
  });

  it("network: one direction of the pod counter, interfaces summed away", () => {
    const t = tr("sum:kubernetes.network.tx_bytes{*} by {pod_name}");
    expect(t.promql).toBe(`sum by (k8s_pod_name) (sum without (interface) (rate(${SEL("k8s.pod.network.io", ', direction="transmit"')}[$__interval] anchored)))`);
  });

  it("gauges map 1:1 and the kube_* tags become k8s_* labels", () => {
    expect(tr("avg:kubernetes.memory.usage{*} by {kube_container_name}").promql).toBe(`avg by (k8s_container_name) (avg_over_time(${SEL("container.memory.usage")}[$__interval]))`);
    expect(tr("sum:kubernetes_state.deployment.replicas_available{*} by {kube_deployment}").promql).toBe(`sum by (k8s_deployment_name) (avg_over_time(${SEL("k8s.deployment.available")}[$__interval]))`);
    expect(tr("sum:kubernetes_state.daemonset.ready{kube_daemon_set:fluentd}").status).toBe("exact-under");
  });

  it("a dotted OTel attribute in the table becomes an underscore label", () => {
    const t = tr("sum:kubernetes_state.container.running{*} by {kube_namespace}");
    expect(t.promql).toBe(`sum by (k8s_namespace_name) (avg_over_time(${SEL("k8s.container.status.state", ', k8s_container_status_state="running"')}[$__interval]))`);
    expect(validatePromQL(t.promql!).ok).toBe(true);
  });

  it("no same-semantic metric: an honest placeholder, not a query that returns nothing", () => {
    for (const q of ["sum:kubernetes_state.pod.status_phase{pod_phase:running}", "sum:kubernetes.pods.running{*}", "sum:kubernetes_state.node.count{*}"]) {
      const t = tr(q);
      expect(t.status, q).toBe("manual");
      expect(t.findings.map((f) => f.code), q).toContain("metric.no_equivalent");
    }
  });
});
