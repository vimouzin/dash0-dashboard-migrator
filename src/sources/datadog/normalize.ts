// Datadog JSON -> IR (CONTRACT-001). Pure functions, no I/O.
// Accepts the API shape (GET /api/v1/dashboard/{id}, GET /api/v1/monitor) and the integrations-core asset shape
// (monitors wrapped in {version, definition}). Nothing is dropped: an unknown widget becomes an "unsupported" Panel
// with a finding, and every unconverted field stays in `original`.
import { groupTags } from "../../ir/grouping.js";
import type { Alert, Dashboard, Finding, Group, Layout, Panel, PanelKind, QuerySet, SourceQuery, SourceRef, Variable } from "../../ir/index.js";

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** Widget type -> IR panel kind. Everything not listed is "unsupported" (T5 renders a placeholder). */
const KIND: Record<string, PanelKind> = {
  timeseries: "timeseries",
  query_value: "stat",
  toplist: "toplist",
  query_table: "table",
  note: "markdown",
  free_text: "markdown",
  image: "markdown", // only with an http(s) URL, see panel()
  sunburst: "toplist", // only a single-level breakdown, shown as a PieChart, see panel()
  geomap: "toplist", // only a single-level breakdown, shown as a table (Dash0 has no map panel), see panel()
  log_stream: "logs",
};

export function isDashboardJson(x: unknown): boolean {
  return isObj(x) && Array.isArray(x.widgets);
}

export function isMonitorJson(x: unknown): boolean {
  const d = isObj(x) && isObj(x.definition) ? x.definition : x;
  return isObj(d) && typeof d.query === "string" && typeof d.type === "string";
}

// ---------- dashboards ----------

export function dashboardFromDatadog(json: unknown, ref: SourceRef): { dashboard: Dashboard; findings: Finding[] } {
  if (!isDashboardJson(json)) throw new Error(`${ref.origin ?? ref.id}: not a Datadog dashboard (no widgets array)`);
  const d = json as Json;
  const findings: Finding[] = [];
  const dashId = `dd-dash-${ref.id}`;
  const find = (f: Omit<Finding, "itemId" | "itemKind"> & { itemId?: string; itemKind?: Finding["itemKind"] }) =>
    findings.push({ itemKind: "panel", itemId: dashId, ...f } as Finding);

  if (d.layout_type === "free") {
    // Catalog (T17) layout.free: exact-under A.style (positions are presentation, not meaning).
    find({
      status: "exact-under",
      code: "layout.free",
      ruleId: "layout.free",
      itemKind: "dashboard",
      message: "free-layout dashboard: positions are not on Datadog's 12-column grid; T5 repacks them",
      assumptions: ["fonts, colours, alignment, legend placement and free-layout positions are not part of the panel's meaning"],
      original: "layout_type: free",
    });
  }

  const items: (Panel | Group)[] = [];
  // One id per widget in the whole dashboard (groups included), built exactly like T5's payload panel keys:
  // characters outside [A-Za-z0-9_-] become _, and a repeated id gets _2, _3 ... So report item ids, findings and
  // the Dash0 panel keys agree even when an export repeats a widget id (review decisions are keyed by item id).
  const used = new Set<string>();
  const uniq = (raw: string) => {
    const base = raw.replace(/[^A-Za-z0-9_-]/g, "_");
    let k = base;
    for (let n = 2; used.has(k); n++) k = `${base}_${n}`;
    used.add(k);
    return k;
  };
  for (const [i, w] of (d.widgets as unknown[]).entries()) {
    const path = `${dashId}/${uniq(`w-${widgetId(w, String(i))}`)}`;
    if (isObj(w) && isObj(w.definition) && w.definition.type === "group") {
      items.push(group(w, path, find, uniq));
    } else {
      items.push(panel(w, path, find));
    }
  }

  const variables: Variable[] = [];
  for (const v of Array.isArray(d.template_variables) ? d.template_variables : []) {
    if (!isObj(v) || typeof v.name !== "string") continue;
    const defaults = Array.isArray(v.defaults) ? v.defaults.filter((x): x is string => typeof x === "string") : [];
    const def = str(v.default) ?? defaults[0];
    if (defaults.length > 1) {
      find({ status: "bounded", code: "variable.multi_default", itemKind: "variable", itemId: `${dashId}/var-${v.name}`, message: `variable $${v.name} has several defaults; only the first is kept`, original: JSON.stringify(defaults) });
    }
    variables.push({
      name: v.name,
      tagKey: str(v.prefix) ?? null, // null: free-form, e.g. $scope (CONTRACT-002)
      ...(def !== undefined && { default: def }),
      ...(defaults.length > 1 && { multi: true }),
    });
  }

  return {
    dashboard: {
      source: ref,
      title: str(d.title) ?? ref.id,
      ...(str(d.description) ? { description: str(d.description)! } : {}),
      gridColumns: 12,
      variables,
      items,
      original: json,
    },
    findings,
  };
}

function widgetId(w: unknown, fallback: string): string {
  return isObj(w) && (typeof w.id === "number" || typeof w.id === "string") ? String(w.id) : fallback;
}

function layoutOf(w: Json): Layout | null {
  const l = w.layout;
  if (!isObj(l)) return null;
  const n = (k: string) => Number(l[k]);
  const [x, y, wd, h] = [n("x"), n("y"), n("width"), n("height")];
  return [x, y, wd, h].every(Number.isFinite) ? { x, y, w: wd, h } : null;
}

function group(w: Json, path: string, find: (f: Omit<Finding, "itemId" | "itemKind"> & { itemId?: string; itemKind?: Finding["itemKind"] }) => void, uniq: (raw: string) => string): Group {
  const def = w.definition as Json;
  const panels: Panel[] = [];
  for (const [i, c] of (Array.isArray(def.widgets) ? def.widgets : []).entries()) {
    const cpath = `${path}/${uniq(`w-${widgetId(c, String(i))}`)}`;
    if (isObj(c) && isObj(c.definition) && c.definition.type === "group") {
      // Datadog doesn't nest groups; if an export does, keep the children and say so.
      find({ status: "bounded", code: "widget.nested_group", itemKind: "group", itemId: cpath, message: "nested group flattened into its parent group", original: "group" });
      panels.push(...group(c, cpath, find, uniq).panels);
    } else panels.push(panel(c, cpath, find));
  }
  return {
    id: path.split("/").pop()!,
    ...(str(def.title) !== undefined && { title: str(def.title)! }),
    collapsed: false,
    layout: layoutOf(w),
    panels,
    original: w,
  };
}

const isHttpUrl = (u: string | undefined): u is string => u !== undefined && /^https?:\/\/\S+$/i.test(u);

/** Levels of grouping of one query: see groupTags. -1 = not a metric or log query. */
function groupLevels(q: SourceQuery): number {
  const g = groupTags(q);
  return g === null ? -1 : g.length;
}

/** A sunburst with exactly one level on every (visible) query is a plain breakdown, which a pie chart shows faithfully. */
function singleLevel(requests: QuerySet[]): boolean {
  const qs = requests.flatMap((r) => r.queries).filter((q) => !q.hidden);
  return qs.length > 0 && qs.every((q) => groupLevels(q) === 1);
}

function panel(w: unknown, path: string, find: (f: Omit<Finding, "itemId" | "itemKind"> & { itemId?: string; itemKind?: Finding["itemKind"] }) => void): Panel {
  const ww = isObj(w) ? w : {};
  const def = isObj(ww.definition) ? ww.definition : {};
  const type = str(def.type) ?? "unknown";
  const requests = requestsOf(def);
  let kind: PanelKind = KIND[type] ?? "unsupported";
  if (type === "list_stream") kind = requests.some((r) => r.queries.some((q) => q.dataSource.startsWith("logs"))) ? "logs" : "unsupported";
  // Why a widget that COULD be translated is not (reported in the finding, not just "no Dash0 panel").
  let why: string | undefined;
  if (type === "image" && !isHttpUrl(str(def.url))) {
    kind = "unsupported";
    why = `image URL is not an http(s) URL (${str(def.url) === undefined ? "none" : str(def.url)!.startsWith("data:") ? "data URI" : "relative to the Datadog site"}): it cannot be embedded in a Markdown panel`;
  }
  if (type === "geomap" && !singleLevel(requests)) {
    kind = "unsupported";
    why = "geomap is not a single-level breakdown of one metric or log query (no grouping, several levels, or another data source): a table of its values would not show the same thing";
  }
  if (type === "sunburst" && !singleLevel(requests)) {
    kind = "unsupported";
    why = "sunburst is not a single-level breakdown of one metric or log query (several levels, another data source, or no grouping): a pie chart would not show the same thing";
  }
  if (kind === "unsupported") {
    find({ status: "manual", code: "widget.unsupported", itemId: path, message: why ?? `Datadog '${type}' widget has no Dash0 panel; it becomes a placeholder that keeps the original`, original: type });
  }
  return {
    id: path.split("/").pop()!,
    kind,
    ...(str(def.title) !== undefined && { title: str(def.title)! }),
    sourceType: type,
    layout: layoutOf(ww),
    requests,
    options: optionsOf(type, def),
    original: w,
  };
}

/** Both request formats, plus the widget shapes that keep their query somewhere else. */
function requestsOf(def: Json): QuerySet[] {
  const type = str(def.type) ?? "";
  if (type === "log_stream") {
    // Legacy log stream: the query is on the widget itself.
    return [{ queries: [{ vendor: "datadog", refId: "q0", dataSource: "logs_stream", expr: str(def.query) ?? "", raw: { query: def.query, indexes: def.indexes, columns: def.columns } }], formulas: [] }];
  }
  const reqs: unknown[] = Array.isArray(def.requests) ? def.requests : isObj(def.requests) ? Object.values(def.requests) : [];
  return reqs.filter(isObj).map((r) => {
    // list_stream: one structured query under `query`
    if (isObj(r.query) && !Array.isArray(r.queries)) {
      const q = r.query;
      return { queries: [{ vendor: "datadog", refId: "q0", dataSource: str(q.data_source) ?? "unknown", expr: str(q.query_string) ?? "", raw: r }], formulas: [] };
    }
    // legacy: {q: "avg:...", aggregator?}
    if (typeof r.q === "string") {
      const sq: SourceQuery = { vendor: "datadog", refId: "q0", dataSource: "metrics", expr: r.q, raw: r };
      if (str(r.aggregator)) sq.aggregator = str(r.aggregator)!;
      return { queries: [sq], formulas: [] };
    }
    // new: {queries: [...], formulas: [...]}
    const queries: SourceQuery[] = (Array.isArray(r.queries) ? r.queries : []).filter(isObj).map((q, i) => {
      const dataSource = str(q.data_source) ?? "metrics";
      const sq: SourceQuery = {
        vendor: "datadog",
        refId: str(q.name) ?? `query${i + 1}`,
        dataSource,
        // metrics: the query string; logs and other sources: the search string (structure kept in raw)
        expr: str(q.query) ?? (isObj(q.search) ? (str(q.search.query) ?? "") : ""),
        raw: q,
      };
      if (str(q.aggregator)) sq.aggregator = str(q.aggregator)!;
      return sq;
    });
    const formulas = (Array.isArray(r.formulas) ? r.formulas : []).filter(isObj).map((f) => ({
      expr: str(f.formula) ?? "",
      ...(str(f.alias) !== undefined && { alias: str(f.alias)! }),
      ...(isObj(f.limit) && Number.isFinite(Number(f.limit.count)) && { limit: { count: Number(f.limit.count), order: f.limit.order === "asc" ? ("asc" as const) : ("desc" as const) } }),
    }));
    return { queries, formulas };
  });
}

function optionsOf(type: string, def: Json): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const copy = (from: string, to = from) => {
    if (def[from] !== undefined) o[to] = def[from];
  };
  if (type === "note" || type === "free_text") {
    o.text = str(def.content) ?? str(def.text) ?? "";
  }
  if (type === "image" && isHttpUrl(str(def.url))) {
    // Alt text: the widget title. Parentheses and brackets in the URL or title would end the Markdown early.
    const alt = (str(def.title) ?? "image").replace(/[\[\]]/g, "");
    o.text = `![${alt}](${str(def.url)!.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20")})`;
  }
  if (type === "sunburst") o.display = "pie";
  if (type === "geomap") o.display = "geomap";
  copy("precision");
  copy("custom_unit", "unit");
  copy("autoscale");
  copy("show_legend", "showLegend");
  copy("legend_layout", "legendLayout");
  copy("yaxis");
  if (Array.isArray(def.markers) && def.markers.length) o.markers = def.markers;
  copy("time");
  const reqs = Array.isArray(def.requests) ? def.requests.filter(isObj) : [];
  const displayTypes = reqs.map((r) => str(r.display_type)).filter((x): x is string => !!x);
  if (displayTypes.length) o.displayTypes = displayTypes;
  const cond = reqs.flatMap((r) => (Array.isArray(r.conditional_formats) ? r.conditional_formats : []));
  if (cond.length) o.conditionalFormats = cond;
  return o;
}

// ---------- monitors ----------

/** Options Datadog sometimes stores as strings ("0"); coerced to numbers so T6 can compare them. */
const NUMERIC_OPTIONS = ["renotify_interval", "new_host_delay", "new_group_delay", "evaluation_delay", "no_data_timeframe", "timeout_h", "min_location_failed"];

export function alertFromDatadog(json: unknown, ref: SourceRef): { alert: Alert; findings: Finding[] } {
  if (!isMonitorJson(json)) throw new Error(`${ref.origin ?? ref.id}: not a Datadog monitor (no query/type)`);
  const outer = json as Json;
  const m = (isObj(outer.definition) ? outer.definition : outer) as Json; // integrations-core wraps the API shape
  const findings: Finding[] = [];
  const opts = isObj(m.options) ? { ...m.options } : {};
  const t = isObj(opts.thresholds) ? opts.thresholds : {};
  delete opts.thresholds;
  const num = (x: unknown): number | undefined => {
    if (x === null || x === undefined || x === "") return undefined;
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  };
  for (const k of NUMERIC_OPTIONS) {
    if (typeof opts[k] === "string") {
      const n = num(opts[k]);
      if (n !== undefined) opts[k] = n;
    }
  }
  const thresholds: Alert["thresholds"] = {};
  const set = (k: keyof Alert["thresholds"], v: unknown) => {
    const n = num(v);
    if (n !== undefined) thresholds[k] = n;
  };
  set("critical", t.critical);
  set("warning", t.warning);
  set("criticalRecovery", t.critical_recovery);
  set("warningRecovery", t.warning_recovery);
  const tags = (Array.isArray(m.tags) ? m.tags : Array.isArray(outer.tags) ? outer.tags : []).filter((x): x is string => typeof x === "string");
  const alert: Alert = {
    source: ref,
    name: str(m.name) ?? str(outer.title) ?? ref.id,
    message: str(m.message) ?? "",
    type: str(m.type)!,
    query: str(m.query)!,
    thresholds,
    tags,
    options: opts,
    original: json,
  };
  return { alert, findings };
}
