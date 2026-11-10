import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { ingestFolder } from "../../src/sources/datadog/index.js";
import { preflightDashboard } from "../../src/targets/dash0/index.js";
import { toPerses, translateRequests, ROW_SCALE, type TranslateExpr } from "../../src/translate/dashboard/index.js";
import type { Expr } from "../../src/parse/index.js";
import type { Dashboard } from "../../src/ir/index.js";

const FIX = join(import.meta.dirname, "..", "..", "fixtures", "datadog");
const ingested = ingestFolder(FIX, "dashboards");
const dash = (stem: string) => ingested.dashboards.find((d) => d.source.id === stem)!;

/** Stand-in for T4: names the first metric it finds; `top()` is "untranslatable", as in T4 today. */
const firstMetric = (e: unknown): string | null => {
  if (!e || typeof e !== "object") return null;
  const n = e as { type?: string; metric?: string };
  if (n.type === "metric" && n.metric) return n.metric;
  for (const v of Object.values(e)) {
    const m = firstMetric(v);
    if (m) return m;
  }
  return null;
};
const stub: TranslateExpr = (e: Expr, o) => {
  if (e.type === "call" && e.name === "top") return { status: "manual", promql: null, rules: [], assumptions: [], findings: [{ severity: "unsupported", code: "fn.top", where: o.where, message: "no exact rule for top()" }] };
  const m = firstMetric(e) ?? (e.type === "ref" ? `ref_${e.name}` : "x");
  return { status: "exact-under", promql: `avg({otel_metric_name="${m}"})`, rules: ["stub"], assumptions: ["A.align"], findings: [] };
};

describe("Redis overview -> Dash0", () => {
  const r = toPerses(dash("redisdb__overview"), stub);
  it("passes T7's preflight: every $ref resolves, the grid fits 24 columns, nothing unplaced", () => {
    expect(preflightDashboard(r.dashboard)).toEqual([]);
  });
  it("keeps all 36 widgets: one panel each, in 7 titled group sections", () => {
    expect(Object.keys(r.dashboard.spec.panels)).toHaveLength(36);
    expect(r.panels).toHaveLength(36);
    const titled = r.dashboard.spec.layouts.filter((l) => l.spec.display?.title);
    expect(titled).toHaveLength(7);
    expect(r.dashboard.metadata.dash0Extensions?.id).toBe("dd-redisdb-overview");
  });
  it("maps kinds exactly: 14 charts, 10 stats, 1 table, 7 notes, and 4 placeholders", () => {
    const kinds: Record<string, number> = {};
    for (const p of r.panels) {
      const k = p.placeholder ? `placeholder:${p.sourceType}` : p.persesKind;
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    // The timeseries placeholder is the widget whose only query is top(): manual in T4 (and in this stub) today.
    expect(kinds).toEqual({
      TimeSeriesChart: 14,
      StatChart: 10,
      TimeSeriesTable: 1,
      Markdown: 7,
      "placeholder:timeseries": 1,
      "placeholder:distribution": 1,
      "placeholder:list_stream": 2,
    });
  });
  it("placeholders say what wasn't migrated, keep the original query and point at the report", () => {
    const logs = r.panels.find((p) => p.title === "Error Logs")!;
    const text = String(logs.panel.spec.plugin.spec.text);
    expect(text).toMatch(/^\*\*Not migrated:\*\* Datadog `list_stream` widget "Error Logs"/);
    expect(text).toContain("source:redis $scope $host status:error");
    expect(text).toContain(logs.itemId);
    expect(logs.status).toBe("manual");
    expect(logs.findings.map((f) => f.code)).toContain("query.datasource"); // catalog: widget.logs reports query.datasource
    expect(logs.rules).toContain("widget.logs");
  });
  it("stat panels take the calculation from the Datadog aggregator", () => {
    const stats = r.panels.filter((p) => p.persesKind === "StatChart");
    expect(stats.length).toBeGreaterThan(0);
    for (const s of stats) expect(["mean", "sum", "min", "max", "last-number"]).toContain(s.panel.spec.plugin.spec.calculation);
  });
  it("scales group children by 24 / group width, scales height, and keeps everything on the 24-column grid", () => {
    const d = dash("redisdb__overview");
    const firstGroup = d.items.find((x) => "panels" in x) as { layout: { w: number }; panels: { layout: { x: number; w: number; h: number } | null }[] };
    const src = firstGroup.panels[0]!.layout!;
    const f = 24 / firstGroup.layout.w; // "About Redis" is 8 of 12 columns wide: children scale by 3, not 2
    const out = r.dashboard.spec.layouts.find((l) => l.spec.display?.title)!.spec.items[0]!;
    expect([out.x, out.width, out.height]).toEqual([src.x * f, src.w * f, src.h * ROW_SCALE]);
    for (const l of r.dashboard.spec.layouts) for (const i of l.spec.items) expect(i.x + i.width).toBeLessThanOrEqual(24);
  });
  it("every group section reaches column 24 (Datadog's side-by-side groups become full-width sections)", () => {
    for (const l of r.dashboard.spec.layouts.filter((l) => l.spec.display?.title)) {
      expect(Math.max(...l.spec.items.map((i) => i.x + i.width)), l.spec.display!.title).toBe(24);
    }
  });
  it("pins every template variable with an exact-under finding (D-21)", () => {
    const pinned = r.findings.filter((f) => f.code === "variable.pinned");
    expect(pinned.map((f) => f.itemId.split("/").pop())).toEqual(dash("redisdb__overview").variables.map((v) => `var-${v.name}`));
    expect(pinned.every((f) => f.status === "exact-under" && f.assumptions?.length === 1)).toBe(true);
  });
  it("is deterministic", () => {
    expect(JSON.stringify(toPerses(dash("redisdb__overview"), stub))).toBe(JSON.stringify(r));
  });
});

describe("all fixture dashboards", () => {
  for (const d of ingested.dashboards) {
    it(`${d.source.id}: valid for Dash0 and every widget accounted for`, () => {
      const r = toPerses(d, stub);
      expect(preflightDashboard(r.dashboard)).toEqual([]);
      const widgets = d.items.flatMap((x) => ("panels" in x ? x.panels : [x])).length;
      expect(r.panels).toHaveLength(widgets);
    });
  }
  it("NGINX: the 5 unsupported widgets become placeholders that keep their queries", () => {
    const r = toPerses(dash("nginx__NGINX-Overview_dashboard"), stub);
    const hostmap = r.panels.find((p) => p.sourceType === "hostmap")!;
    expect(hostmap.placeholder).toBe(true);
    expect(String(hostmap.panel.spec.plugin.spec.text)).toContain("avg:nginx.net.request_per_s{*} by {host}");
    expect(r.panels.filter((p) => p.placeholder && p.sourceType !== "log_stream")).toHaveLength(5);
  });
  it("postgres 4-column query_table (all columns by {table}) is one TimeSeriesTable with four queries; the column names are listed in order", () => {
    const r = toPerses(dash("postgres__postgresql_screenboard_dashboard"), stub);
    const t = r.panels.find((p) => p.title === "Resources by table")!;
    expect(t).toMatchObject({ persesKind: "TimeSeriesTable", placeholder: false });
    expect(t.promql).toHaveLength(4);
    expect(t.rules).toContain("widget.query_table.columns");
    expect(String(t.panel.spec.display.description)).toContain("Columns, in order: Disk Usage | Index Scans | Live Rows | Dead Rows.");
  });
  it("every panel cites a catalog widget.* rule; exact-under rules carry their assumptions", () => {
    for (const d of ingested.dashboards) {
      for (const p of toPerses(d, stub).panels) {
        expect(p.rules.some((x) => x.startsWith("widget.")), p.itemId).toBe(true);
        for (const f of p.findings.filter((x) => x.status === "exact-under" && x.ruleId?.startsWith("widget."))) expect(f.assumptions?.length, f.code).toBeGreaterThan(0);
      }
    }
  });
});

describe("request translation", () => {
  const vars = {};
  it("formulas resolve their query refs through env", () => {
    let env: Map<string, Expr> | undefined;
    const spy: TranslateExpr = (e, o) => ((env = o.env), stub(e, o));
    const r = translateRequests([{ queries: [{ vendor: "datadog", refId: "a", dataSource: "metrics", expr: "avg:m{*}", raw: {} }], formulas: [{ expr: "a * 100" }] }], spy, vars, "it");
    expect(r.queries).toHaveLength(1);
    expect([...env!.keys()]).toEqual(["a"]);
  });
  it("non-metric data sources and parse errors fail closed with findings", () => {
    const r = translateRequests(
      [
        { queries: [{ vendor: "datadog", refId: "q", dataSource: "logs", expr: "status:error", raw: {} }], formulas: [] },
        { queries: [{ vendor: "datadog", refId: "q0", dataSource: "metrics", expr: "avg:m{", raw: {} }], formulas: [] },
      ],
      stub, vars, "it",
    );
    expect(r.status).toBe("manual");
    expect(r.findings.map((f) => f.code)).toEqual(["query.datasource", "query.parse_error"]);
  });
  it("converts T4's older finding shape to CONTRACT-001", () => {
    const r = translateRequests([{ queries: [{ vendor: "datadog", refId: "q0", dataSource: "metrics", expr: "top(avg:m{*} by {h}, 10, 'mean', 'desc')", raw: {} }], formulas: [] }], stub, vars, "it");
    expect(r.findings[0]).toEqual({ status: "manual", code: "fn.top", message: "no exact rule for top()", itemKind: "query", itemId: "it" });
  });
  it("a widget with no query at all is reported, not silently empty", () => {
    const d: Dashboard = { source: { vendor: "datadog", id: "e" }, title: "E", gridColumns: 12, variables: [], items: [{ id: "w-1", kind: "timeseries", sourceType: "timeseries", layout: null, requests: [], options: {}, original: {} }], original: {} };
    const r = toPerses(d, stub);
    expect(r.panels[0]).toMatchObject({ placeholder: true, status: "manual" });
    expect(r.panels[0]!.findings.map((f) => f.code)).toEqual(["query.empty"]);
    expect(preflightDashboard(r.dashboard)).toEqual([]);
  });
});
