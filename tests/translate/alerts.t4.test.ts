// T6 end to end with the real T4 (src/translate/query, PR #3) and the real Redis mapping table.
// Skipped until PR #3 is merged into this branch.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMappings, metricAvailability, metricLookup, tagLookup } from "../../src/ir/index.js";
import { translateAlert, type MonitorTranslator } from "../../src/translate/alerts/index.js";
import { fixtureMonitors } from "./alerts.helpers.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const t4 = `${root}src/translate/query/index.ts`;
const validator = `${root}src/validate/promql.ts`;
const ready = existsSync(t4) && existsSync(validator);

describe.skipIf(!ready)("T6 + T4 end to end", async () => {
  const q = ready ? await import(t4) : null;
  const v = ready ? await import(validator) : null;
  const m = loadMappings(`${root}mappings`);
  const ctx = { metric: metricLookup(m), tag: tagLookup(m), availability: (d: string) => metricAvailability(m, d) };
  const deps = { translateMonitor: ((mq, t) => q.translateMonitor(mq, t, ctx)) as MonitorTranslator, tag: tagLookup(m) };

  it("redis high_mem: the evaluator's exact subquery form, {failed: 90, degraded: 70}, firing text kept", () => {
    const { alert } = fixtureMonitors().find((f) => f.name === "redisdb__high_mem.json")!;
    const r = translateAlert(alert, deps);
    expect(r.rule).not.toBeNull();
    expect(r.origin).toBe("dd-monitor-redisdb-high-mem");
    expect(r.rule!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
    expect(r.rule!.thresholds).toEqual({ degraded: 70, failed: 90 });
    expect(r.rule!.expression).toMatch(/^avg_over_time\(.*\[5m:1m\]\) > \$__threshold$/);
    expect(r.rule!.expression).toContain('otel_metric_name="redis.memory.used"');
    expect(r.rule!.labels).toMatchObject({ integration: "redisdb" });
    expect(r.rule!.annotations!.description).toContain("{{ $value }}");
    expect(r.rule!.annotations!.description).not.toMatch(/\{\{#|\{\{\//);
    expect(r.status).toBe("exact-under");
    expect(r.assumptions).toEqual(expect.arrayContaining(["A.full-window", "A.no-new-groups", "A.notify-manual", "A.msg-conditional"]));
    expect(v.validatePromQL(r.rule!.expression).ok).toBe(true);
  });

  it("every fixture monitor: valid PromQL or manual with findings", () => {
    for (const { name, alert } of fixtureMonitors()) {
      const r = translateAlert(alert, deps);
      if (r.rule) expect(v.validatePromQL(r.rule.expression).ok, name).toBe(true);
      else expect(r.status === "manual" && r.findings.length > 0, name).toBe(true);
    }
  });

  it("evaluation_delay becomes offset on every selector", () => {
    const { alert } = fixtureMonitors().find((f) => f.name === "redisdb__high_mem.json")!;
    const r = translateAlert({ ...alert, options: { ...alert.options, evaluation_delay: 120 } }, deps);
    const selectors = r.rule!.expression.match(/\{otel_metric_name="[^"]+"[^}]*\}/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    expect((r.rule!.expression.match(/offset 2m/g) ?? []).length).toBe(selectors.length);
  });
});
