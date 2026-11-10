// T12: Datadog log queries and log monitors -> PromQL on Dash0's synthetic dash0.logs counter.
// Deterministic, no I/O (loadLogAttributes is the only function that reads a file). Fail closed: anything without a
// rule is `manual` with no PromQL. Label names were verified live (docs/research/dash0.md, "dash0.logs labels").
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Finding, Status } from "../../ir/index.js";
import { worst } from "../../ir/index.js";
import { parseLogSearch, type LogNode, type LogValue } from "../../parse/logsearch/index.js";
import { render, type Duration, type PMatcher, type PNode } from "../query/promql.js";
import { ASSUMPTIONS } from "../query/rules.js";
import { validatePromQL } from "../../validate/promql.js";
import { parseFormula } from "../../parse/index.js";
import { translateQuery, type FormulaEnv } from "../query/index.js";

// ---------------- rules (data) ----------------

// Assumptions shared with T4 reuse T4's exact text, so the catalog has one wording per id.
export const LOG_ASSUMPTIONS = {
  "A.log-count": "Dash0's dash0.logs counter counts the same log records Datadog indexed (no sampling or exclusion filters on either side)",
  "A.log-source": "logs carry Datadog's `source` as a `source` attribute (set by the shipper); OTel has no built-in equivalent",
  "A.log-attr-default": "a log attribute without a table entry keeps its name in OTel (dots become underscores in the label)",
  "A.log-fulltext": "Datadog's free-text match of a word equals a case-insensitive substring match on the log body",
  "A.align": ASSUMPTIONS["A.align"],
  "A.boundary": ASSUMPTIONS["A.boundary"],
  "A.var-regex": ASSUMPTIONS["A.var-regex"],
  "A.var-default": ASSUMPTIONS["A.var-default"],
  "A.top-stable": ASSUMPTIONS["A.top-stable"],
  "A.group-limit": "the number of groups stays within the widget's group limit, so Datadog shows every group too",
  "A.severity-map": "the Datadog status maps to the OTel severity range listed in mappings/log-attributes.yaml (no 1:1 level)",
  "A.all-indexes": "every Datadog log index is queried (Dash0 has no indexes)",
  "A.log-range": "the panel's $__range is the dashboard's visible time range and the panel shows the value at the end of that range (a stat uses calculation last-number; a TimeSeriesTable shows the last point), so a scalar covers the same timeframe Datadog aggregates over",
} as const;
export type LogAssumptionId = keyof typeof LOG_ASSUMPTIONS;

interface LogRule {
  status: Status;
  assumptions: LogAssumptionId[];
  description: string;
}
const r = (status: Status, assumptions: LogAssumptionId[], description: string): LogRule => ({ status, assumptions, description });

export const LOG_RULES = {
  "log.count": r("exact-under", ["A.log-count", "A.align", "A.boundary"], "count of logs matching Q -> sum by (g) (increase({otel_metric_name=\"dash0.logs\", m(Q)}[w]))"),
  "log.cardinality": r("exact-under", ["A.log-count", "A.align", "A.boundary"], "cardinality of @a -> count by (g) (sum by (g, a) (increase(...[w])) > 0)"),
  "log.match.reserved": r("exact", [], "service/host/env/version:x -> the resource label (service_name, ...)"),
  "log.match.reserved.approx": r("exact-under", ["A.log-source"], "source:x -> source=\"x\" (no OTel counterpart)"),
  "log.match.attr": r("exact-under", ["A.log-attr-default"], "@a.b:x -> a_b=\"x\" (renames from mappings/log-attributes.yaml applied)"),
  "log.match.value": r("exact", [], "k:v -> =, k:v* -> =~\"^v.*$\", k:(a OR b) -> =~\"^(a|b)$\", k:* -> =~\".+\", negations -> != / !~"),
  "log.match.status": r("exact", [], "status:error -> otel_log_severity_range=\"ERROR\""),
  "log.match.status.approx": r("exact-under", ["A.severity-map"], "status:critical/notice/ok/... -> the nearest OTel severity range"),
  "log.match.text": r("exact-under", ["A.log-fulltext"], "free text w -> otel_log_body=~\"(?i).*w.*\""),
  "log.match.var": r("exact-under", ["A.var-regex"], "$var on a facet -> label=~\"^($var)$\""),
  "log.match.var.dropped": r("exact-under", ["A.var-default"], "$var without a facet -> dropped while it is '*'"),
  "log.group_by": r("exact", [], "group_by facets -> by (labels)"),
  "log.group_by.limit": r("exact-under", ["A.top-stable"], "one facet with a limit N -> topk(N, ...) (bottomk for asc)"),
  "log.group_by.multi-limit": r("exact-under", ["A.group-limit"], "several facets with limits -> by (labels), limits not applied"),
  "log.group_by.exclude-missing": r("exact", [], "should_exclude_missing: true -> label!=\"\" for each group-by label"),
  "log.range.integer": r("exact", [], "@a:>=500 / @a:[200 TO 299] on integers -> a=~ an exact regex over the decimal digits"),
  "log.or.inclusion-exclusion": r("exact-under", ["A.log-count", "A.align", "A.boundary"], "count(A OR B ...) across keys -> sum of counts by inclusion-exclusion (up to 3 branches)"),
  "log.monitor.formula": r("bounded", ["A.log-count"], "formula(\"...\").last(W) over log queries -> the formula over windowed counts"),
  "log.indexes": r("exact-under", ["A.all-indexes"], "indexes other than '*' -> all logs (Dash0 has no indexes)"),
  "log.monitor.count": r("bounded", ["A.log-count"], "logs(Q).rollup(count).by(g).last(W) op T -> sum by (g) (increase(...[W])) op $__threshold"),
  "log.scalar.window": r("exact-under", ["A.log-count", "A.log-range"], "scalar log query (query_value, top list, table): the same count over [$__range] instead of one [$__interval] bucket; the panel must show the last value"),
} as const satisfies Record<string, LogRule>;
export type LogRuleId = keyof typeof LOG_RULES;

// ---------------- attribute table ----------------

export interface LogAttributes {
  reserved: Record<string, { label: string; status: "exact" | "approximate" }>;
  renames: Record<string, string>;
  severity: Record<string, { range: string; status: "exact" | "approximate" }>;
}

/** Parse mappings/log-attributes.yaml. Pure; fails loudly on a malformed table. */
export function parseLogAttributes(text: string): LogAttributes {
  const doc = parseYaml(text) as any;
  if (!doc || doc.version !== 1) throw new Error("log-attributes: expected version: 1");
  for (const k of ["reserved", "renames", "severity"]) if (typeof doc[k] !== "object" || doc[k] === null) throw new Error(`log-attributes: missing '${k}'`);
  return { reserved: doc.reserved, renames: doc.renames, severity: doc.severity };
}

/** The only I/O here: read the table from disk. */
export function loadLogAttributes(path: string): LogAttributes {
  return parseLogAttributes(readFileSync(path, "utf8"));
}

// ---------------- translation ----------------

export interface LogTranslateContext {
  attributes: LogAttributes;
  /** Dashboard template variables: name -> the facet or tag it filters (Datadog `prefix`), or null. */
  variables?: Record<string, { tag: string | null }>;
  /**
   * Default bucket width: seconds or "$__interval" (default, one value per chart step: right for time series).
   * "$__range" is the SCALAR form for query_value, top list and table widgets: Datadog aggregates a scalar over the
   * whole timeframe, so the count is taken over the dashboard's visible range and the panel must show the last
   * value (T5: calculation last-number). It ignores compute.interval, which only applies to time series.
   */
  interval?: number | "$__interval" | "$__range";
  /** Item id copied into every finding. */
  where?: string;
}

/** Same shape as T4's QueryTranslation, plus the tree and group labels so formulas can combine log and metric queries. */
export interface LogTranslation {
  status: Status;
  promql: string | null;
  rules: string[];
  assumptions: string[];
  findings: Finding[];
  node: PNode | null;
  groups: string[] | null;
}

/** The parts of a Datadog `data_source: logs` query that matter. */
export interface DatadogLogQuery {
  search?: { query?: string };
  compute?: { aggregation?: string; metric?: string; interval?: number };
  /** A list of facets, or the newer object form {fields, limit, sort, should_exclude_missing}. */
  group_by?: { facet?: string; limit?: number; sort?: { order?: string } }[] | { fields?: string[]; limit?: number; sort?: { order?: string }; should_exclude_missing?: boolean };
  indexes?: string[];
}

class Manual extends Error {}

class LogLowerer {
  rules: LogRuleId[] = [];
  findings: Finding[] = [];
  constructor(
    readonly ctx: LogTranslateContext,
    readonly itemKind: "query" | "alert",
  ) {}

  use(id: LogRuleId): void {
    if (!this.rules.includes(id)) this.rules.push(id);
  }
  find(status: Finding["status"], code: string, message: string, original?: string): void {
    if (this.findings.some((f) => f.code === code && f.message === message)) return;
    this.findings.push({ status, code, message, itemKind: this.itemKind, itemId: this.ctx.where ?? "", ...(original !== undefined && { original }) });
  }
  manual(code: string, message: string, original?: string): never {
    this.find("manual", code, message, original);
    throw new Manual(message);
  }

  /** Datadog key (reserved tag or @facet) -> Dash0 label. */
  label(key: string): string {
    if (key.startsWith("@")) {
      let attr = key.slice(1);
      attr = this.ctx.attributes.renames[attr] ?? attr;
      this.use("log.match.attr");
      return attr.replace(/[^A-Za-z0-9_]/g, "_");
    }
    const res = this.ctx.attributes.reserved[key];
    if (res) {
      this.use(res.status === "exact" ? "log.match.reserved" : "log.match.reserved.approx");
      return res.label;
    }
    // A tag without '@' (env, region, kube_namespace ...): a resource attribute of the same name.
    this.use("log.match.attr");
    const attr = this.ctx.attributes.renames[key] ?? key;
    return attr.replace(/[^A-Za-z0-9_]/g, "_");
  }

  matchers(n: LogNode | null): PMatcher[] {
    if (n === null) return [];
    switch (n.type) {
      case "and":
        return n.items.flatMap((i) => this.matchers(i));
      case "or":
        return this.orSameKey(n);
      case "not":
        this.manual("log.not.complex", "NOT over a compound log search has no matcher form");
      case "range": {
        const re = intRangeRegex(n.raw);
        if (!re) this.manual("log.range", `numeric range on ${n.key} (${n.raw}): only integer ranges have a matcher form`);
        this.use("log.range.integer");
        return [{ label: this.label(n.key), op: "=~", value: re }];
      }
      case "var":
        return this.variable(n.name, n.negated);
      case "text":
        return [this.text(n.value, n.quoted, n.negated)];
      case "term":
        return [this.term(n.key, n.values, n.negated)];
    }
  }

  /** DNF of a log search: a list of matcher sets (OR of ANDs). Same-key ORs stay one regex matcher. */
  alternatives(n: LogNode | null): PMatcher[][] {
    if (n === null) return [[]];
    if (n.type === "or") {
      const sameKey = n.items.every((i) => i.type === "term" && !i.negated) && new Set(n.items.map((i) => (i as { key: string }).key)).size === 1;
      if (sameKey) return [this.orSameKey(n)];
      return n.items.flatMap((i) => this.alternatives(i));
    }
    if (n.type === "and") {
      let acc: PMatcher[][] = [[]];
      for (const item of n.items) {
        const alts = this.alternatives(item);
        acc = acc.flatMap((a) => alts.map((b) => [...a, ...b]));
        if (acc.length > 3) this.manual("log.or.cross-key", "OR across keys expands to more than 3 alternatives");
      }
      return acc;
    }
    return [this.matchers(n)];
  }

  orSameKey(n: Extract<LogNode, { type: "or" }>): PMatcher[] {
    const terms = n.items.filter((i): i is Extract<LogNode, { type: "term" }> => i.type === "term" && !i.negated);
    if (terms.length !== n.items.length || new Set(terms.map((t) => t.key)).size !== 1)
      this.manual("log.or.cross-key", "OR across different keys (or with free text) is not a matcher set");
    return [this.term(terms[0]!.key, terms.flatMap((t) => t.values), false)];
  }

  term(key: string, values: LogValue[], negated: boolean): PMatcher {
    if (key === "status") return this.status(values, negated);
    const label = this.label(key);
    this.use("log.match.value");
    if (values.length === 1 && !values[0]!.quoted && values[0]!.text === "*")
      return { label, op: negated ? "=" : "=~", value: negated ? "" : ".+" }; // exists / doesn't exist
    const pats = values.map((v) => (v.quoted ? escapeRe(v.text) : pattern(v.text)));
    const plain = values.length === 1 && (values[0]!.quoted || !values[0]!.text.includes("*"));
    if (plain) return { label, op: negated ? "!=" : "=", value: values[0]!.text };
    return { label, op: negated ? "!~" : "=~", value: `^(${pats.join("|")})$` };
  }

  status(values: LogValue[], negated: boolean): PMatcher {
    const ranges = values.map((v) => {
      const s = this.ctx.attributes.severity[v.text.toLowerCase()];
      if (!s || v.text.includes("*")) this.manual("log.status.unknown", `status:${v.text} has no OTel severity range`);
      this.use(s.status === "exact" ? "log.match.status" : "log.match.status.approx");
      return s.range;
    });
    const uniq = [...new Set(ranges)];
    if (uniq.length === 1) return { label: "otel_log_severity_range", op: negated ? "!=" : "=", value: uniq[0]! };
    return { label: "otel_log_severity_range", op: negated ? "!~" : "=~", value: `^(${uniq.join("|")})$` };
  }

  text(value: string, quoted: boolean, negated: boolean): PMatcher {
    this.use("log.match.text");
    const body = quoted ? escapeRe(value) : pattern(value);
    return { label: "otel_log_body", op: negated ? "!~" : "=~", value: `(?i).*${body}.*` };
  }

  variable(name: string, negated: boolean): PMatcher[] {
    const raw = this.ctx.variables?.[name];
    const def = raw && raw.tag !== null && raw.tag.trim() === "" ? { tag: null } : raw;
    if (!def || def.tag === null) {
      if (negated) this.manual("log.var.negated", `negated free-form template variable $${name}`);
      this.use("log.match.var.dropped");
      this.find("exact-under", "scope.var.free-form", `template variable $${name} has no facet; dropped (exact while it is left at '*')`);
      return [];
    }
    const label = this.label(def.tag);
    this.use("log.match.var");
    return [{ label, op: negated ? "!~" : "=~", value: `^($${name})$` }];
  }

  /** Selector + compute + group_by -> PromQL. `window` overrides the bucket width (monitors). */
  query(q: DatadogLogQuery, window?: number): { node: PNode; groups: string[] } {
    // Exported JSON is not always well-formed: anything unexpected fails closed instead of throwing.
    // Newer group_by form: {fields: [...], limit, sort, should_exclude_missing} -> the list form.
    let excludeMissing = false;
    let gb = q.group_by;
    if (gb !== undefined && !Array.isArray(gb)) {
      if (typeof gb !== "object" || gb === null || !Array.isArray(gb.fields)) this.manual("log.group_by.shape", "group_by is neither a list nor {fields: [...]}", JSON.stringify(q.group_by));
      const o = gb;
      excludeMissing = o.should_exclude_missing === true;
      gb = o.fields!.map((facet, i) => ({ facet, ...(i === 0 && o.limit !== undefined && { limit: o.limit }), ...(o.sort && { sort: o.sort }) }));
      if (o.fields!.length > 1 && o.limit !== undefined) gb = gb.map((g) => ({ ...g, limit: o.limit }));
    }
    if (q.indexes !== undefined && !Array.isArray(q.indexes)) this.manual("log.indexes.shape", "indexes is not a list", JSON.stringify(q.indexes));
    if (q.search?.query !== undefined && typeof q.search.query !== "string") this.manual("log.search.shape", "search.query is not a string");
    const indexes = q.indexes ?? [];
    if (indexes.length && !indexes.every((i) => i === "*")) {
      this.use("log.indexes");
      this.find("exact-under", "log.indexes", `log indexes ${indexes.join(",")} have no Dash0 counterpart; querying all logs`);
    }
    const parsed = parseLogSearch(q.search?.query ?? "");
    if (!parsed.ok) this.manual("log.search.parse", `log search does not parse: ${parsed.error.message} at ${parsed.error.pos}`, q.search?.query);
    // Disjunctive normal form: each alternative is one matcher set. One alternative is the usual case.
    const alts = this.alternatives(parsed.value);
    const name: PMatcher = { label: "otel_metric_name", op: "=", value: "dash0.logs" };
    const matchers: PMatcher[] = [name, ...alts[0]!];

    const by: string[] = [];
    const facets = (gb ?? []) as { facet?: string; limit?: number; sort?: { order?: string } }[];
    for (const g of facets) {
      if (!g.facet) this.manual("log.group_by.facet", "group_by without a facet");
      by.push(g.facet === "status" ? "otel_log_severity_range" : this.label(g.facet));
    }
    if (facets.length) this.use("log.group_by");
    const groups = [...new Set(by)].sort();
    if (excludeMissing) {
      this.use("log.group_by.exclude-missing");
      for (const label of groups) if (!matchers.some((m) => m.label === label && m.op === "!=" && m.value === "")) matchers.push({ label, op: "!=", value: "" });
    }

    const scalar = window === undefined && this.ctx.interval === "$__range";
    if (scalar) this.use("log.scalar.window");
    const width: Duration = window ?? (scalar ? "$__range" : q.compute?.interval ? Math.round(q.compute.interval / 1000) : (this.ctx.interval ?? "$__interval"));
    const sel: PNode = { k: "selector", matchers, range: width };
    const inc: PNode = { k: "call", fn: "increase", args: [sel] };

    const agg = q.compute?.aggregation ?? "count";
    let node: PNode;
    if (agg === "count" && alts.length > 1) {
      // |A ∪ B ∪ C| by inclusion-exclusion; every intersection is again a matcher set (maths.md §8).
      if (alts.length > 3) this.manual("log.or.cross-key", "OR across keys with more than 3 branches");
      this.use("log.count");
      this.use("log.or.inclusion-exclusion");
      const extra = matchers.slice(1 + alts[0]!.length); // group-by exclusions added below apply to every term
      const term = (ms: PMatcher[]): PNode => ({ k: "agg", op: "sum", by: groups, expr: { k: "call", fn: "increase", args: [{ k: "selector", matchers: [name, ...ms, ...extra], range: width }] } });
      const idx = alts.map((_, i) => i);
      const subsets: number[][] = [];
      for (let mask = 1; mask < 1 << alts.length; mask++) subsets.push(idx.filter((i) => mask & (1 << i)));
      let acc: PNode | null = null;
      for (const sub of subsets) {
        const t = term(sub.flatMap((i) => alts[i]!));
        if (acc === null) acc = t;
        else acc = { k: "binary", op: sub.length % 2 === 1 ? "+" : "-", lhs: acc, rhs: t };
      }
      node = acc!;
    } else if (alts.length > 1) {
      this.manual("log.or.cross-key", "OR across different keys is only translated for counts");
    } else if (agg === "count") {
      this.use("log.count");
      node = { k: "agg", op: "sum", by: groups, expr: inc };
    } else if (agg === "cardinality") {
      if (!q.compute?.metric) this.manual("log.cardinality.metric", "cardinality without a facet");
      const attr = this.label(q.compute.metric);
      this.use("log.cardinality");
      const perValue: PNode = { k: "agg", op: "sum", by: [...new Set([...groups, attr])].sort(), expr: inc };
      node = { k: "agg", op: "count", by: groups, expr: { k: "binary", op: ">", lhs: perValue, rhs: { k: "num", value: 0 } } };
    } else {
      this.manual("log.measure", `${agg} of ${q.compute?.metric ?? "a measure"}: dash0.logs only counts log records`);
    }

    // Group limits: one facet -> topk/bottomk; several -> recorded assumption.
    const limited = facets.filter((g) => g.limit !== undefined);
    if (limited.length === 1 && facets.length === 1) {
      const g = limited[0]!;
      this.use("log.group_by.limit");
      node = { k: "call", fn: g.sort?.order === "asc" ? "bottomk" : "topk", args: [{ k: "num", value: g.limit! }, node] };
    } else if (limited.length > 0) {
      this.use("log.group_by.multi-limit");
      this.find("exact-under", "log.group_by.multi-limit", "several group-by facets with limits; limits are not applied");
    }
    return { node, groups };
  }

  result(node: PNode | null, groups: string[] | null): LogTranslation {
    let status: Status = "exact";
    const assumptions: string[] = [];
    for (const id of this.rules) {
      const rule = LOG_RULES[id];
      status = worst(status, rule.status);
      for (const a of rule.assumptions) if (!assumptions.includes(a)) assumptions.push(a);
    }
    const fail = (): LogTranslation => ({ status: "manual", promql: null, rules: this.rules, assumptions: [], findings: this.findings, node: null, groups: null });
    if (!node) return fail();
    const promql = render(node);
    const v = validatePromQL(promql);
    if (!v.ok) {
      this.find("manual", "promql.invalid", `emitted PromQL does not parse: ${v.errors.map((e) => e.message).join("; ")}`, promql);
      return fail();
    }
    return { status, promql, rules: this.rules, assumptions: assumptions.sort(), findings: this.findings, node, groups };
  }
}

function run(ctx: LogTranslateContext, kind: "query" | "alert", f: (l: LogLowerer) => { node: PNode; groups: string[] }): LogTranslation {
  const l = new LogLowerer(ctx, kind);
  try {
    const { node, groups } = f(l);
    return l.result(node, groups);
  } catch (e) {
    if (e instanceof Manual) return l.result(null, null);
    throw e;
  }
}

/** A log translation as a T4 formula ref, so `query1 / query2` can mix log and metric queries. */
export function logRef(t: LogTranslation): import("../query/types.js").LoweredRef {
  return { type: "lowered", node: t.node ?? { k: "num", value: 0 }, groups: t.groups, status: t.status, rules: t.rules, assumptions: t.assumptions, findings: t.findings };
}

/** A dashboard query with `data_source: "logs"`. */
export function translateLogQuery(q: DatadogLogQuery, ctx: LogTranslateContext, window?: number): LogTranslation {
  return run(ctx, window === undefined ? "query" : "alert", (l) => l.query(q, window));
}

// ---------------- log monitors ----------------

export interface LogMonitorTranslation extends LogTranslation {
  thresholds: { failed: number; degraded?: number } | null;
  negated: boolean;
}

const LOG_MONITOR =
  /^\s*logs\("((?:[^"\\]|\\.)*)"\)(?:\.index\("([^"]*)"\))?(?:\.rollup\("(count|cardinality)"(?:\s*,\s*"([^"]+)")?\))?(?:\.by\("([^"]*)"\))?\.last\("(\d+)([smhd])"\)\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)\s*$/;
const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** A `log alert` monitor query: logs("Q").index("*").rollup("count").by("host").last("5m") > 10. */
export function translateLogMonitor(
  query: string,
  /** `variables`: the monitor's options.variables, needed for formula(...) monitors. */
  opts: { critical?: number; warning?: number; variables?: unknown[] },
  ctx: LogTranslateContext,
): LogMonitorTranslation {
  let thresholds: LogMonitorTranslation["thresholds"] = null;
  let negated = false;
  if (/^\s*formula\(/.test(query)) return translateLogFormulaMonitor(query, opts, ctx);
  const t = run(ctx, "alert", (l) => {
    const m = LOG_MONITOR.exec(query);
    if (!m) return l.manual("log.monitor.shape", "log monitor query has a shape with no rule", query);
    const [, search, index, rollup, rollupAttr, by, n, unit, op, th] = m;
    const window = Number(n) * UNIT[unit!]!;
    const q: DatadogLogQuery = {
      search: { query: search!.replace(/\\"/g, '"') },
      ...(index && { indexes: index.split(",").map((s) => s.trim()) }),
      compute: { aggregation: rollup ?? "count", ...(rollupAttr && { metric: rollupAttr }) },
      group_by: (by ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((facet) => ({ facet })),
    };
    const { node, groups } = l.query(q, window);
    l.use("log.monitor.count");
    const crit = Number(th);
    let expr = node;
    let cmp: ">" | ">=" = op === ">=" || op === "<=" ? ">=" : ">";
    if (op === "<" || op === "<=") {
      negated = true;
      expr = { k: "neg", expr };
      thresholds = { failed: -crit, ...(opts.warning !== undefined && { degraded: -opts.warning }) };
    } else thresholds = { failed: crit, ...(opts.warning !== undefined && { degraded: opts.warning }) };
    if (opts.critical !== undefined && opts.critical !== crit)
      l.find("exact-under", "monitor.threshold.mismatch", `options.thresholds.critical (${opts.critical}) differs from the query threshold (${crit}); using the query's`);
    return { node: { k: "binary", op: cmp, lhs: expr, rhs: { k: "placeholder", name: "$__threshold" } }, groups };
  });
  if (!t.promql) return { ...t, thresholds: null, negated: false };
  return { ...t, thresholds, negated };
}

// ---------------- helpers ----------------

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
}

/** Datadog wildcard text -> regex body: `*` matches anything, `?` one character; everything else is literal. */
function pattern(v: string): string {
  return v
    .split("*")
    .map((p) => p.split("?").map((q) => q.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("."))
    .join(".*");
}

// ---------------- formula log monitors ----------------

const FORMULA_MONITOR = /^\s*formula\("((?:[^"\\]|\\.)*)"\)\.last\("(\d+)([smhd])"\)\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)\s*$/;

/** formula("(query / query1) * 100").last("1d") > 10, with the log queries in options.variables. */
function translateLogFormulaMonitor(
  query: string,
  opts: { critical?: number; warning?: number; variables?: unknown[] },
  ctx: LogTranslateContext,
): LogMonitorTranslation {
  const fail = (code: string, message: string): LogMonitorTranslation => ({
    status: "manual", promql: null, rules: [], assumptions: [], node: null, groups: null, thresholds: null, negated: false,
    findings: [{ status: "manual", code, message, itemKind: "alert", itemId: ctx.where ?? "", original: query }],
  });
  const m = FORMULA_MONITOR.exec(query);
  if (!m) return fail("log.monitor.shape", "log formula monitor has a shape with no rule");
  const [, formula, n, unit, op, th] = m;
  const vars = (opts as { variables?: { name?: string; data_source?: string }[] }).variables ?? [];
  if (!vars.length) return fail("log.monitor.variables", "formula monitor without query variables");
  const window = Number(n) * UNIT[unit!]!;
  const env: FormulaEnv = new Map();
  for (const v of vars) {
    if (v.data_source !== "logs" || !v.name) return fail("log.monitor.variables", "formula monitor variable is not a named log query");
    env.set(v.name, logRef(translateLogQuery(v as DatadogLogQuery, ctx, window)));
  }
  const f = parseFormula(formula!.replace(/\\"/g, '"'));
  if (!f.ok) return fail("log.monitor.formula", `formula does not parse: ${f.error.message}`);
  const t = translateQuery(f.value, {}, env);
  if (!t.promql) return { ...t, node: null, groups: null, thresholds: null, negated: false, findings: t.findings };
  const crit = Number(th);
  const lt = op === "<" || op === "<=";
  const cmp = op === ">=" || op === "<=" ? ">=" : ">";
  const promql = `${lt ? `-(${t.promql})` : t.promql} ${cmp} $__threshold`;
  const v = validatePromQL(promql);
  if (!v.ok) return fail("promql.invalid", "emitted PromQL does not parse");
  const rules = [...t.rules, "log.monitor.formula"];
  const thresholds = lt
    ? { failed: -crit, ...(opts.warning !== undefined && { degraded: -opts.warning }) }
    : { failed: crit, ...(opts.warning !== undefined && { degraded: opts.warning }) };
  return { status: worst(t.status, LOG_RULES["log.monitor.formula"].status), promql, rules, assumptions: t.assumptions, findings: t.findings, node: null, groups: null, thresholds, negated: lt };
}

// ---------------- integer ranges -> regex ----------------

/** `>=500`, `>499`, `<100`, `<=99`, `[200 TO 299]` on non-negative integers -> an anchored regex, or null. */
export function intRangeRegex(raw: string): string | null {
  let lo: number, hi: number;
  const cmp = /^(>=|>|<=|<)(\d+)$/.exec(raw);
  const br = /^\[(\d+) TO (\d+)\]$/.exec(raw);
  if (cmp) {
    const v = Number(cmp[2]);
    if (cmp[1] === ">=") [lo, hi] = [v, Infinity];
    else if (cmp[1] === ">") [lo, hi] = [v + 1, Infinity];
    else if (cmp[1] === "<=") [lo, hi] = [0, v];
    else [lo, hi] = [0, v - 1];
  } else if (br) [lo, hi] = [Number(br[1]), Number(br[2])];
  else return null;
  if (!Number.isSafeInteger(lo) || (hi !== Infinity && !Number.isSafeInteger(hi)) || lo > hi) return null;
  const parts = rangeParts(lo, hi === Infinity ? null : hi);
  return parts ? `^(${parts.join("|")})$` : null;
}

/** Regex alternatives for integers in [lo, hi] (hi null = unbounded), without leading zeros. */
function rangeParts(lo: number, hi: number | null): string[] | null {
  const out: string[] = [];
  const loLen = String(lo).length;
  if (hi === null) {
    // Same digit count as lo, from lo up; then every number with more digits.
    out.push(...digitRanges(String(lo), "9".repeat(loLen)));
    out.push(`[1-9]\\d{${loLen},}`);
    return out;
  }
  for (let len = loLen; len <= String(hi).length; len++) {
    const a = len === loLen ? String(lo) : "1" + "0".repeat(len - 1);
    const b = len === String(hi).length ? String(hi) : "9".repeat(len);
    out.push(...digitRanges(a, b));
    if (out.length > 40) return null;
  }
  return out;
}

/** Same-length decimal strings a <= b -> regex pieces covering exactly [a, b]. */
function digitRanges(a: string, b: string): string[] {
  if (a === b) return [a];
  let i = 0;
  while (a[i] === b[i]) i++;
  const prefix = a.slice(0, i);
  const restLen = a.length - i - 1;
  const d = (x: string) => (restLen === 0 ? "" : `\\d{${restLen}}`);
  const aTail = a.slice(i + 1), bTail = b.slice(i + 1);
  const allZero = /^0*$/.test(aTail), allNine = /^9*$/.test(bTail);
  const ai = Number(a[i]), bi = Number(b[i]);
  const out: string[] = [];
  if (allZero && allNine) return [`${prefix}${cls(ai, bi)}${d("")}`];
  if (allZero) out.push(`${prefix}${cls(ai, bi - 1)}${d("")}`);
  else out.push(...digitRanges(a.slice(i), String(ai) + "9".repeat(restLen)).map((x) => prefix + x));
  if (!allZero && bi - ai > 1) out.push(`${prefix}${cls(ai + 1, bi - 1)}${d("")}`);
  if (allNine && !allZero) out.push(`${prefix}${cls(bi, bi)}${d("")}`);
  else if (!allNine) out.push(...digitRanges(String(bi) + "0".repeat(restLen), b.slice(i)).map((x) => prefix + x));
  return out.filter((x, k, arr) => arr.indexOf(x) === k);
}

function cls(a: number, b: number): string {
  return a === b ? String(a) : `[${a}-${b}]`;
}
