// Dashboard → Perses: widget → layout → variable (T5). Sources: docs/research/dash0.md, kb 06 §3-5.
// Panel status = worst(widget rule, every query in it). A widget with no mapper becomes a Markdown placeholder
// holding the original query and the reason (dash0-migrator rule 2: never drop silently).
import type { RuleDef } from "../types.js";
import { section } from "./build.js";

const K = "docs/research/kb/06_TRANSLATION_RULES.md §5; docs/research/dash0.md";
const w = section("widget", "T5", "planned", K);
const panel = section("panel", "T5", "planned", K);
const lay = section("layout", "T5", "planned", "kb 06 §4; docs/research/dash0.md (24-column grid)");
const v = section("variable", "T5", "planned", "kb 06 §3; D-21");
const PLACEHOLDER = "Markdown panel with the original query and the reason";

export const DASHBOARD_RULES: RuleDef[] = [
  // ---------- widget ----------
  w("widget.timeseries", 10, "exact", "timeseries", "TimeSeriesChart, one query per Datadog query/formula"),
  w("widget.query_value", 20, "exact-under", "query_value with aggregator avg|max|min|sum|last", "StatChart with the matching calculation", {
    assumptions: ["A.align", "A.boundary"],
    requires: ["probe:statchart-calculation"],
  }),
  w("widget.query_value.default-agg", 21, "exact-under", "query_value with no aggregator, or one StatChart has no calculation for", "StatChart with calculation mean (Datadog's default avg)", {
    assumptions: ["A.agg-default"],
    note: "T5 panels.ts. With an explicit aggregator that has no StatChart calculation the finding message names it.",
  }),
  w("widget.query_value.multi", 22, "exact-under", "query_value with more than one query", "StatChart; Dash0 shows the first query", { assumptions: ["A.stat-first"] }),
  w("widget.toplist", 30, "exact-under", "toplist", "TimeSeriesTable sorted by value, limited to N (uses fn.top.window for the ranking)", {
    assumptions: ["A.top-uniform"],
    requires: ["probe:at-modifier"],
  }),
  w("widget.toplist.unranked", 31, "exact-under", "toplist while fn.top.window is not shipped", "TimeSeriesTable of every series, without the top-N limit and ranking", {
    assumptions: ["A.top-unlimited"],
    note: "T5 panels.ts interim form; widget.toplist replaces it once fn.top.window ships.",
  }),
  w("widget.query_table", 40, "exact-under", "query_table", "TimeSeriesTable", { assumptions: ["A.table-single-query"] }),
  w("widget.query_table.columns", 41, "exact-under", "query_table with several metric or log columns that all group by the same labels, no conditional formats", "TimeSeriesTable with one query per column", {
    assumptions: ["A.table-columns"],
    note: "Probed on a rendered table: several queries with the same group-by show as one row per group with one value column each. Column headers are Dash0 defaults.",
  }),
  w("widget.query_table.complex", 45, "manual", "query_table with several queries, custom sort or conditional formats", PLACEHOLDER, { findingCode: "widget.unsupported" }),
  w("widget.note", 50, "exact-under", "note / free_text", "Markdown with the same text", { assumptions: ["A.style"] }),
  w("widget.image", 60, "exact-under", "image", "Markdown ![](url)", { assumptions: ["A.style"] }),
  w("widget.alert_graph", 70, "exact-under", "alert_graph (graph of a monitor)", "TimeSeriesChart of the monitor's translated query with its thresholds", {
    assumptions: ["A.style"],
    note: "Reuses the monitor's query translation; status = worst(this, that query).",
  }),
  w("widget.alert_value", 80, "exact-under", "alert_value", "StatChart of the monitor's translated query", { assumptions: ["A.style"], requires: ["probe:statchart-calculation"] }),
  w("widget.pie", 90, "exact-under", "sunburst / pie", "PieChart over the grouped query", { assumptions: ["A.style"], requires: ["probe:piechart"] }),
  panel("panel.unit", 100, "exact", "Datadog unit with a Perses format entry (bytes, percent, seconds, …)", "format.unit"),
  panel("panel.unit.unmapped", 110, "exact-under", "unit without a format entry", "format.unit decimal; original unit in the panel description", { assumptions: ["A.style"] }),
  panel("panel.markers", 120, "exact-under", "markers / y-axis lines", "TimeSeriesChart thresholds", { assumptions: ["A.style"] }),
  panel("panel.conditional-format", 125, "exact-under", "query_value conditional formats (first matching rule wins; > >= < <=; red/yellow/green/blue/gray or custom hex)", "StatChart thresholds: one step wherever the colour changes; pieces Perses can't colour the same way are named in the finding", {
    assumptions: ["A.style"],
  }),
  panel("panel.style", 130, "exact-under", "palette, legend, display type, title alignment", "closest Perses visual option", { assumptions: ["A.style"] }),
  w("widget.logs", 140, "manual", "log_stream / list_stream", `${PLACEHOLDER} (LogTable comes with logs.stream)`, { findingCode: "query.datasource" }),
  w("widget.geomap", 145, "exact-under", "geomap that is a single-level breakdown of one metric or log query", "TimeSeriesTable of the same query (an ALTERNATIVE view: Dash0 has no map panel)", {
    assumptions: ["A.style", "A.alt-view"],
    note: "The values per group are kept; the map drawing is not. Multi-level, ungrouped or other-source geomaps stay placeholders (widget.unsupported).",
  }),
  w("widget.heatmap", 150, "manual", "heatmap / distribution / histogram", PLACEHOLDER, { findingCode: "widget.unsupported" }),
  w("widget.treemap", 160, "manual", "treemap", PLACEHOLDER, { findingCode: "widget.unsupported" }),
  w("widget.scatterplot", 170, "manual", "scatterplot", PLACEHOLDER, { findingCode: "widget.unsupported" }),
  w("widget.unsupported", 180, "manual", "hostmap, service_map, manage_status, check_status, slo, trace_service, geomap, funnel, iframe, event_stream, event_timeline, split_graph", PLACEHOLDER, {
    findingCode: "widget.unsupported",
  }),
  w("query.empty", 190, "manual", "widget with no query to translate", PLACEHOLDER, { note: "Emitted by T5 queries.ts; the id is also the finding code." }),
  w("widget.unknown", 999, "manual", "any other widget type", PLACEHOLDER, { fallback: true, findingCode: "widget.unsupported" }),

  // ---------- layout ----------
  lay("layout.ordered.grid", 10, "exact", "ordered layout x, width (12 columns)", "Perses Grid x = 2x, width = 2·width (24 columns, D-24)"),
  lay("layout.ordered.height", 20, "exact-under", "ordered layout y, height", "y and height unchanged", { assumptions: ["A.row-height"], requires: ["probe:row-height"] }),
  lay("layout.free", 30, "exact-under", "free layout", "deterministic repack into the 24-column grid (row-major by y, then x)", { assumptions: ["A.style"] }),
  lay("layout.group", 40, "exact", "group widget", "its own Grid layout with display.title; children recurse"),
  lay("layout.group.scale", 45, "exact-under", "children of a group w columns wide (Datadog lays them out inside the group, groups sit side by side)", "x and width scale by 24 / w with rounded edges, so each group fills its full-width Grid section", {
    assumptions: ["A.style"],
  }),
  lay("layout.group.collapsed", 50, "exact", "group collapsed / expanded", "display.collapse.open", { requires: ["probe:collapse"] }),
  lay("layout.powerpack", 60, "exact-under", "powerpack", "inlined like a group, title kept", { assumptions: ["A.style"] }),
  lay("layout.clamped", 70, "bounded", "panel whose doubled x + width passes column 24", "x = min(x, 23), width = 24 − x", {
    epsilon: "geometry only: the panel loses at most x + width − 24 of its columns; its queries and data are unchanged",
  }),

  // ---------- variable ----------
  v("variable.list", 10, "exact-under", "template variable with a tag prefix", "ListVariable + PrometheusLabelValuesVariable on the mapped label", {
    assumptions: ["A.var-values"],
    requires: ["probe:listvariable"],
  }),
  v("variable.default.value", 20, "exact", "variable pinned to a default other than *", 'label="<default>" in every query that uses it'),
  v("variable.pinned", 30, "exact-under", "variable with default * (v1, until variable.list ships)", "no variable, no matcher", { assumptions: ["A.var-default"], findingCode: "variable.pinned" }),
  v("variable.unknown", 999, "manual", "any other variable shape (available_values, multi-tag)", "pinned; original kept in the report", { fallback: true, findingCode: "variable.pinned" }),
];
