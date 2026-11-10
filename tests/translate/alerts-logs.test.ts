// T6 log alerts: "log alert" monitors go through T12's translateLogMonitor, then T6's shared alert/message stages.
// Shapes are from DataDog/integrations-core assets (foundationdb, squid, brevo).
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { translateAlert, makeAlertConverter, checkRuleUuid, type AlertDeps } from "../../src/translate/alerts/index.js";
import { loadLogAttributes, translateLogMonitor } from "../../src/translate/logs/index.js";
import { monitor } from "./alerts.helpers.js";

const attributes = loadLogAttributes(join(import.meta.dirname, "..", "..", "mappings", "log-attributes.yaml"));
const noMetric: AlertDeps["translateMonitor"] = () => {
  throw new Error("a log alert must not reach T4");
};
const deps: AlertDeps = { translateMonitor: noMetric, translateLogMonitor: (q, t) => translateLogMonitor(q, t, { attributes }) };
const log = (query: string, over: Parameters<typeof monitor>[0] extends infer M ? Partial<M> : never = {}) =>
  monitor({ type: "log alert", query, ...over });

describe("T6: log alerts through T12", () => {
  it("count by host (foundationdb errors_logged): a check rule with both thresholds, grouped", () => {
    const a = log('logs("service:foundationdb @Severity:>=40").index("*").rollup("count").by("host").last("10m") > 3', { thresholds: { critical: 3, warning: 1 } });
    const r = translateAlert(a, deps);
    expect(r.status).not.toBe("manual");
    expect(r.rules).toEqual(expect.arrayContaining(["classify.monitor.log", "log.monitor.count", "alert.threshold.both", "alert.group"]));
    expect(r.rules).not.toContain("classify.monitor.metric");
    expect(r.rule!.expression).toMatch(/dash0\.logs|otel_metric_name/);
    expect(r.rule!.expression).toMatch(/> \$__threshold$/);
    expect(r.rule!.thresholds).toEqual({ failed: 3, degraded: 1 });
    expect(r.rule!.id).toBe(checkRuleUuid(a.source.id));
    expect(r.rule!.labels?.dd_monitor_id).toBe(a.source.id);
  });
  it(">= without by() (squid high_latency_requests): not grouped", () => {
    const r = translateAlert(log('logs("source:squid @duration:>6000000000").index("*").rollup("count").last("5m") >= 5', { thresholds: { critical: 5, warning: 2 } }), deps);
    expect(r.rule!.expression).toMatch(/>= \$__threshold$/);
    expect(r.rules).not.toContain("alert.group");
  });
  it("< is negated so Dash0's higher-is-worse thresholds still fire the same way", () => {
    const r = translateAlert(log('logs("service:web").index("*").rollup("count").last("5m") < 1', { thresholds: { critical: 1 } }), deps);
    expect(r.rule!.thresholds).toEqual({ failed: -1 });
    expect(r.rule!.annotations?.description).toMatch(/negates the query/);
  });
  it("formula() log monitors take their queries from options.variables, which is not reported as an unknown option", () => {
    const variables = [
      { data_source: "logs", name: "query", indexes: ["*"], compute: { aggregation: "count" }, search: { query: "service:mail @evt.name:blocked" } },
      { data_source: "logs", name: "query1", indexes: ["*"], compute: { aggregation: "count" }, search: { query: "service:mail" } },
    ];
    const r = translateAlert(log('formula("(query / query1) * 100").last("1d") > 10', { thresholds: { critical: 10 }, options: { variables } }), deps);
    expect(r.rules).toContain("classify.monitor.log");
    expect(r.findings.filter((f) => f.ruleId === "alert.opt.unknown")).toEqual([]);
    if (r.rule) expect(r.rule.expression).toMatch(/\$__threshold$/);
  });
  it("log notification options are listed for manual setup; evaluation_delay fails closed", () => {
    const q = 'logs("service:web status:error").index("*").rollup("count").last("5m") > 10';
    const n = translateAlert(log(q, { thresholds: { critical: 10 }, options: { enable_logs_sample: true, groupby_simple_monitor: true } }), deps);
    expect(n.status).not.toBe("manual");
    expect(n.rules).toContain("alert.opt.notification");
    const d = translateAlert(log(q, { thresholds: { critical: 10 }, options: { evaluation_delay: 60 } }), deps);
    expect(d.status).toBe("manual");
    expect(d.findings.find((f) => f.ruleId === "alert.opt.unknown")!.message).toMatch(/log monitor/);
  });
  it("a shape T12 has no rule for is manual with T12's finding", () => {
    const r = translateAlert(log('logs("x").index("*").rollup("avg", "@duration").last("5m") > 1', { thresholds: { critical: 1 } }), deps);
    expect(r.status).toBe("manual");
    expect(r.rule).toBeNull();
  });
  it("without the log translator (no log-attribute table), log alerts stay classify.monitor.other", () => {
    const r = translateAlert(log('logs("x").index("*").rollup("count").last("5m") > 1'), { translateMonitor: noMetric });
    expect(r.rules).toEqual(["classify.monitor.other"]);
    expect(r.findings[0]!.message).toMatch(/log-attribute table/);
  });
  it("makeAlertConverter passes translateLogMonitor through with the context bound", () => {
    const seen: unknown[] = [];
    const conv = makeAlertConverter(noMetric as never, { translateLogMonitor: (q, t, ctx: { tag?: never; marker: string }) => (seen.push(ctx.marker), translateLogMonitor(q, t, { attributes })) });
    const c = conv(log('logs("service:web").index("*").rollup("count").last("5m") > 1', { thresholds: { critical: 1 } }), { marker: "ctx-1" });
    expect(seen).toEqual(["ctx-1"]);
    expect(c.rule).not.toBeNull();
  });
});
