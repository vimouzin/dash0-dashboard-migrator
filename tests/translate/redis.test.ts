// End-to-end check of T3 + T4 with T1's real mapping table on the Redis fixtures (the demo case).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMappings, metricAvailability, metricLookup, tagLookup } from "../../src/ir/index.js";
import { parseFormula, parseMonitorQuery, parseQuery } from "../../src/parse/index.js";
import type { Expr } from "../../src/parse/index.js";
import { translateMonitor, translateQuery } from "../../src/translate/query/index.js";
import type { QueryTranslation, TranslateContext } from "../../src/translate/query/index.js";
import { validatePromQL } from "../../src/validate/promql.js";

const maps = loadMappings("mappings");
const dash = JSON.parse(readFileSync("fixtures/datadog/dashboards/redisdb__overview.json", "utf8"));
const monitor = JSON.parse(readFileSync("fixtures/datadog/monitors/redisdb__high_mem.json", "utf8")).definition;

const variables: TranslateContext["variables"] = {};
for (const v of dash.template_variables ?? []) variables[v.name] = { tag: v.prefix ?? null };
const ctx: TranslateContext = {
  metric: metricLookup(maps),
  availability: (dd) => metricAvailability(maps, dd),
  tag: tagLookup(maps),
  variables,
};

interface Row {
  title: string;
  metrics: string[];
  r: QueryTranslation;
}

/** Every metric formula (or legacy q) on the dashboard, translated. */
function translateDashboard(): Row[] {
  const rows: Row[] = [];
  const walk = (widgets: any[]) => {
    for (const w of widgets) {
      const d = w.definition ?? {};
      if (d.type === "group") {
        walk(d.widgets ?? []);
        continue;
      }
      for (const req of Array.isArray(d.requests) ? d.requests : []) {
        if (req.queries) {
          const env = new Map<string, Expr>();
          for (const q of req.queries)
            if ((q.data_source ?? "metrics") === "metrics") {
              const p = parseQuery(q.query);
              if (!p.ok) throw new Error(p.error.message);
              env.set(q.name, p.value);
            }
          if (env.size === 0) continue; // logs/events queries are not T4's
          for (const f of req.formulas ?? []) {
            const p = parseFormula(f.formula);
            if (!p.ok) throw new Error(p.error.message);
            const metrics = req.queries.map((q: any) => /:([\w.]+)\{/.exec(q.query ?? "")?.[1]).filter(Boolean);
            rows.push({ title: `${d.type} "${d.title ?? ""}"`, metrics, r: translateQuery(p.value, ctx, env) });
          }
        } else if (req.q) {
          const p = parseQuery(req.q);
          if (!p.ok) throw new Error(p.error.message);
          rows.push({ title: `${d.type} "${d.title ?? ""}"`, metrics: [], r: translateQuery(p.value, ctx) });
        }
      }
    }
  };
  walk(dash.widgets);
  return rows;
}

describe("Redis overview dashboard with the real mapping table", () => {
  const rows = translateDashboard();

  it("every emitted query parses as PromQL", () => {
    for (const { r } of rows) if (r.promql) expect(validatePromQL(r.promql).ok, r.promql).toBe(true);
  });

  it("never queries a metric the table says has no usable OTel equivalent", () => {
    for (const { metrics, r } of rows) {
      const unusable = metrics.filter((m) => !["mapped", "unmapped"].includes(metricAvailability(maps, m)));
      if (unusable.length) expect(r.status, `${unusable.join(",")} -> ${r.promql}`).toBe("manual");
    }
  });

  it("variables are anchored, and $scope is dropped under its assumption", () => {
    const mem = rows.find((x) => x.title.includes("Percent Used Memory by Host"))!;
    expect(mem.r.promql).toBe(
      'avg by (host_name) (avg_over_time({otel_metric_name="redis.memory.used", host_name=~"^($host)$"}[$__interval])) / ' +
        'max by (host_name) (avg_over_time({otel_metric_name="redis.maxmemory", host_name=~"^($host)$"}[$__interval])) * 100',
    );
    expect(mem.r.assumptions).toContain("A.var-default");
  });

  it("status totals (update deliberately when rules or mappings change)", () => {
    const totals: Record<string, number> = {};
    for (const { r } of rows) totals[r.status] = (totals[r.status] ?? 0) + 1;
    expect(totals).toMatchInlineSnapshot(`
      {
        "bounded": 10,
        "exact-under": 8,
        "manual": 5,
      }
    `);
  });
});

describe("Redis high_mem monitor", () => {
  it("emits the evaluator's exact subquery form with Datadog's thresholds", () => {
    const p = parseMonitorQuery(monitor.query);
    if (!p.ok) throw new Error(p.error.message);
    const t = monitor.options.thresholds;
    const r = translateMonitor(p.value, { critical: Number(t.critical), warning: Number(t.warning) }, ctx);
    expect(r.promql).toBe(
      'avg_over_time((100 * avg (avg_over_time({otel_metric_name="redis.memory.used"}[1m])) / ' +
        'avg (avg_over_time({otel_metric_name="redis.maxmemory"}[1m])))[5m:1m]) > $__threshold',
    );
    expect(r.thresholds).toEqual({ failed: 90, degraded: 70 });
    expect(r.status).toBe("exact-under");
    expect(r.findings).toEqual([]);
  });
});
