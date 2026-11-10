// Image and sunburst widgets through ingest -> T5 (with T4 + T12). Image becomes a Markdown image only when its URL is
// http(s); a sunburst becomes a PieChart only when it is a single-level breakdown of one metric or log query. Everything
// else stays a placeholder with the reason, never a guess.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { dashboardFromDatadog } from "../../src/sources/datadog/index.js";
import { toPerses, type TranslateExpr, type TranslateLog } from "../../src/translate/dashboard/index.js";
import { translateQuery } from "../../src/translate/query/index.js";
import { loadLogAttributes, translateLogQuery } from "../../src/translate/logs/index.js";
import { loadMappings, metricAvailability, metricLookup, tagLookup } from "../../src/ir/index.js";
import { preflightDashboard } from "../../src/targets/dash0/index.js";
import { validatePromQL } from "../../src/validate/promql.js";

const ROOT = join(import.meta.dirname, "..", "..");
const m = loadMappings(join(ROOT, "mappings"));
const attributes = loadLogAttributes(join(ROOT, "mappings", "log-attributes.yaml"));
const base = { metric: metricLookup(m), availability: (d: string) => metricAvailability(m, d), tag: tagLookup(m) };
const translate: TranslateExpr = (e, o) => translateQuery(e, { ...base, variables: o.variables, where: o.where }, o.env);
const translateLog: TranslateLog = (q, o) => translateLogQuery(q, { attributes, variables: o.variables, where: o.where, ...(o.scalar && { interval: "$__range" as const }) });

const logQ = (name: string, query: string, group_by: object[], extra: object = {}) => ({ data_source: "logs", name, indexes: ["*"], compute: { aggregation: "count" }, search: { query }, group_by, ...extra });
const metricQ = (name: string, query: string, extra: object = {}) => ({ data_source: "metrics", name, query, aggregator: "avg", ...extra });
const widget = (id: number, definition: object) => ({ id, layout: { x: 0, y: 0, width: 4, height: 2 }, definition });
const sunburst = (id: number, title: string, queries: object[]) => widget(id, { type: "sunburst", title, requests: [{ response_format: "scalar", queries, formulas: queries.map((q) => ({ formula: (q as { name: string }).name })) }] });

const geomap = (id: number, title: string, queries: object[]) => widget(id, { type: "geomap", title, requests: [{ response_format: "scalar", queries, formulas: queries.map((q) => ({ formula: (q as { name: string }).name })) }] });
const table = (id: number, title: string, queries: object[], extra: object = {}) =>
  widget(id, { type: "query_table", title, requests: [{ response_format: "scalar", queries, formulas: queries.map((q) => ({ formula: (q as { name: string }).name })), ...extra }] });

const DASH = {
  title: "Widgets",
  layout_type: "ordered",
  widgets: [
    widget(1, { type: "image", title: "Architecture", url: "https://example.com/arch.png" }),
    widget(2, { type: "image", title: "Relative", url: "/static/images/logo.png" }),
    widget(3, { type: "image", title: "Odd (name) [x]", url: "https://example.com/a(1).png" }),
    widget(4, { type: "image", title: "Embedded", url: "data:image/png;base64,AAAA" }),
    sunburst(5, "Errors by service", [logQ("q", "status:error", [{ facet: "service", limit: 10, sort: { order: "desc" } }])]),
    sunburst(6, "Commands by host", [metricQ("c", "sum:redis.net.commands{*} by {host}")]),
    sunburst(7, "Two levels", [logQ("q", "status:error", [{ facet: "service" }, { facet: "status" }])]),
    sunburst(8, "No grouping", [metricQ("c", "sum:redis.net.commands{*}")]),
    sunburst(9, "Logs and metrics", [logQ("e", "status:error", [{ facet: "service" }]), metricQ("c", "sum:redis.net.commands{*} by {host}")]),
    table(11, "Two metric columns", [metricQ("a", "avg:redis.mem.used{*} by {host}"), metricQ("b", "max:redis.mem.used{*} by {host}")]),
    table(12, "Different grouping", [metricQ("a", "avg:redis.mem.used{*} by {host}"), metricQ("b", "avg:redis.mem.used{*} by {env}")]),
    table(13, "With conditional formats", [metricQ("a", "avg:redis.mem.used{*} by {host}"), metricQ("b", "max:redis.mem.used{*} by {host}")], { conditional_formats: [{ comparator: ">", value: 1, palette: "white_on_red" }] }),
    table(14, "Log and metric columns", [logQ("e", "status:error", [{ facet: "host" }]), metricQ("c", "sum:redis.net.commands{*} by {host}")]),
    table(15, "Other data source column", [metricQ("a", "avg:redis.mem.used{*} by {host}"), { data_source: "events", name: "e", search: { query: "x" }, group_by: [{ facet: "host" }] }]),
    geomap(16, "Errors by country", [logQ("q", "status:error", [{ facet: "@network.client.geoip.country.iso_code" }])]),
    geomap(17, "Two levels geomap", [logQ("q", "status:error", [{ facet: "country" }, { facet: "city" }])]),
    geomap(18, "Ungrouped geomap", [logQ("q", "status:error", [])]),
    sunburst(10, "Events", [{ data_source: "events", name: "q", search: { query: "x" }, group_by: [{ facet: "tag" }] }]),
  ],
};

describe("image and sunburst widgets", () => {
  const { dashboard, findings: ingestFindings } = dashboardFromDatadog(DASH, { vendor: "datadog", id: "widgets" });
  const r = toPerses(dashboard, translate, translateLog);
  const p = (title: string) => r.panels.find((x) => x.title === title)!;

  it("an image with an http(s) URL becomes a Markdown image (widget.image, exact-under A.style)", () => {
    const e = p("Architecture");
    expect(e.placeholder).toBe(false);
    expect(e.status).toBe("exact-under");
    expect(e.panel.spec.plugin.kind).toBe("Markdown");
    expect(e.panel.spec.plugin.spec.text).toBe("![Architecture](https://example.com/arch.png)");
    expect(e.rules).toContain("widget.image");
    expect(e.assumptions).toContain("A.style");
  });

  it("brackets in the title and parentheses in the URL cannot end the Markdown early", () => {
    expect(p("Odd (name) [x]").panel.spec.plugin.spec.text).toBe("![Odd (name) x](https://example.com/a%281%29.png)");
  });

  it("a relative or embedded image URL stays a placeholder, with the reason in the finding", () => {
    for (const t of ["Relative", "Embedded"]) {
      const e = p(t);
      expect(e).toMatchObject({ placeholder: true, status: "manual" });
      expect(e.rules).toContain("widget.unsupported");
    }
    expect(ingestFindings.some((f) => /relative to the Datadog site/.test(f.message))).toBe(true);
    expect(ingestFindings.some((f) => /data URI/.test(f.message))).toBe(true);
  });

  it("a single-level log sunburst becomes a PieChart over the window form, last-number", () => {
    const e = p("Errors by service");
    expect(e.placeholder).toBe(false);
    expect(e.panel.spec.plugin.kind).toBe("PieChart");
    expect(e.panel.spec.plugin.spec).toEqual({ calculation: "last-number", mode: "value" });
    expect(e.promql).toHaveLength(1);
    expect(e.promql[0]).toMatch(/\[\$__range\]/);
    expect(e.promql[0]).not.toContain("$__interval");
    expect(e.rules).toEqual(expect.arrayContaining(["widget.pie", "log.scalar.window"]));
    expect(e.promql[0]).toMatch(/^topk\(10, /); // the facet limit is applied by the query itself, so the pie shows the same top 10
  });

  it("a single-level metric sunburst becomes a PieChart whose calculation follows the aggregator", () => {
    const e = p("Commands by host");
    expect(e.placeholder).toBe(false);
    expect(e.panel.spec.plugin.kind).toBe("PieChart");
    expect(e.panel.spec.plugin.spec.calculation).toBe("mean");
    expect(e.rules).toContain("widget.pie");
  });

  it("a multi-level, ungrouped, mixed or non-metric sunburst is not drawn as a pie", () => {
    expect(p("Two levels")).toMatchObject({ placeholder: true, status: "manual" });
    expect(p("No grouping")).toMatchObject({ placeholder: true, status: "manual" });
    expect(p("Events")).toMatchObject({ placeholder: true, status: "manual" });
    const mixed = p("Logs and metrics");
    expect(mixed).toMatchObject({ placeholder: true, status: "manual" });
    expect(mixed.rules).toContain("arith.scalar-log-mixed");
  });

  it("a multi-column table whose columns all group by the same labels is one TimeSeriesTable, one query per column", () => {
    const e = p("Two metric columns");
    expect(e.placeholder).toBe(false);
    expect(e.status).toBe("exact-under");
    expect(e.panel.spec.plugin.kind).toBe("TimeSeriesTable");
    expect(e.promql).toHaveLength(2);
    expect(e.rules).toContain("widget.query_table.columns");
    expect(e.assumptions).toContain("A.table-columns");
  });

  it("a table that would not join per group stays manual: different grouping, conditional formats, another data source", () => {
    for (const t of ["Different grouping", "With conditional formats", "Other data source column"]) {
      const e = p(t);
      expect(e, t).toMatchObject({ placeholder: true, status: "manual" });
      expect(e.rules, t).toContain("widget.query_table.complex");
    }
  });

  it("a table mixing a whole-timeframe log column with a metric column fails closed", () => {
    const e = p("Log and metric columns");
    expect(e).toMatchObject({ placeholder: true, status: "manual" });
    expect(e.rules).toContain("arith.scalar-log-mixed");
  });

  it("a single-level geomap is shown as a TimeSeriesTable of its values per group, labelled as an alternative view", () => {
    const e = p("Errors by country");
    expect(e.placeholder).toBe(false);
    expect(e.status).toBe("exact-under");
    expect(e.panel.spec.plugin.kind).toBe("TimeSeriesTable");
    expect(e.promql[0]).toContain("[$__range]");
    expect(e.rules).toEqual(expect.arrayContaining(["widget.geomap", "log.scalar.window"]));
    expect(e.assumptions).toContain("A.alt-view");
    expect(e.findings.some((f) => f.code === "widget.geomap" && /Dash0 has no map panel/.test(f.message))).toBe(true);
  });

  it("a geomap with several levels or no grouping stays a placeholder", () => {
    expect(p("Two levels geomap")).toMatchObject({ placeholder: true, status: "manual" });
    expect(p("Ungrouped geomap")).toMatchObject({ placeholder: true, status: "manual" });
  });

  it("every emitted query parses and the dashboard passes T7 preflight", () => {
    for (const x of r.panels) for (const q of x.promql) expect(validatePromQL(q).ok, q).toBe(true);
    expect(preflightDashboard(r.dashboard)).toEqual([]);
  });
});
