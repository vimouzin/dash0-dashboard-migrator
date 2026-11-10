// `dd2dash0 explain "<datadog query>"`: one query, shown going through the real engine stage by stage: the
// recursive-descent parse (the AST as a tree), the mapping tables, the translation rules that fired with their
// claims, the PromQL (validated with the official grammar), and the final claim with the conditions it rests on.
// It calls exactly the code a migration calls; nothing here translates on its own.
import { basename } from "node:path";
import { metricAvailability, metricLookup, ddKindLookup, tagLookup } from "../ir/index.js";
import { loadDdKinds, loadMappings, type Mappings } from "../ir/mappings.js";
import { parseMonitorQuery, parseQuery, type Arg, type Expr, type MonitorQuery, type ScopeExpr } from "../parse/index.js";
import { ASSUMPTIONS, RULES, translateMonitor, translateQuery, type QueryTranslation, type TranslateContext } from "../translate/query/index.js";
import { validatePromQL } from "../validate/promql.js";
import type { Paint, Ui } from "../ui/style.js";

const isMonitor = (src: string) => /^\s*[a-z_]+\(\s*(last|current|next)_\w+\s*\)\s*:/i.test(src);

function claimPaint(p: Paint, status: string): string {
  if (status === "exact" || status === "exact-under") return p.ok(status);
  if (status === "bounded") return p.accent(status);
  if (status === "manual") return p.warn(status);
  return p.bad(status);
}

/** The AST as an indented tree, using the source spans for scopes so the original text shows. */
export function astTree(e: Expr, src: string): string[] {
  const out: string[] = [];
  const text = (s: { start: number; end: number }) => src.slice(s.start, s.end);
  const scope = (s: ScopeExpr | null): string => (s === null ? "(none)" : s.type === "all" ? "*" : text(s.span));
  const node = (x: Expr, pre: string, last: boolean, label = ""): void => {
    const head = `${pre}${last ? "└─ " : "├─ "}${label}`;
    const kid = pre + (last ? "   " : "│  ");
    switch (x.type) {
      case "metric": {
        out.push(`${head}metric ${x.metric}`);
        const rows = [
          ["space agg", x.spaceAgg ?? "(none, legacy form)"],
          ["scope", scope(x.scope)],
          ...(x.groupBy.length ? [["group by", x.groupBy.join(", ")]] : []),
          ...(x.valueFilter ? [["value filter", `v ${x.valueFilter.op} ${x.valueFilter.value}`]] : []),
        ];
        rows.forEach(([k, v], i) => out.push(`${kid}${i === rows.length - 1 ? "└─ " : "├─ "}${k}: ${v}`));
        return;
      }
      case "number":
        out.push(`${head}number ${x.raw}`);
        return;
      case "ref":
        out.push(`${head}ref ${x.name}`);
        return;
      case "paren":
        return node(x.expr, pre, last, label);
      case "neg":
        out.push(`${head}negate`);
        return node(x.expr, kid, true);
      case "binary":
        out.push(`${head}binary ${x.op}`);
        node(x.left, kid, false);
        return node(x.right, kid, true);
      case "postfix":
        out.push(`${head}.${x.call.name}(${x.call.args.map((a) => argText(a, src)).join(", ")})`);
        return node(x.target, kid, true);
      case "call": {
        out.push(`${head}${x.name}()`);
        x.args.forEach((a, i) => {
          const lastArg = i === x.args.length - 1;
          if (a.type === "expr") node(a.expr, kid, lastArg);
          else out.push(`${kid}${lastArg ? "└─ " : "├─ "}${argText(a, src)}`);
        });
        return;
      }
    }
  };
  node(e, "", true);
  return out;
}

function argText(a: Arg, src: string): string {
  if (a.type === "string") return `'${a.value}'`;
  if (a.type === "word") return a.value;
  if (a.type === "tags") return `{${a.tags.join(", ")}}`;
  if (a.type === "named") return `${a.name}=${argText(a.value, src)}`;
  return src.slice(a.span.start, a.span.end);
}

/** Every metric name and tag key the query uses (for the mapping stage). */
function collect(e: Expr, metrics: Set<string>, tags: Set<string>): void {
  const scopeTags = (s: ScopeExpr | null): void => {
    if (!s) return;
    if (s.type === "tag" && s.key) tags.add(s.key);
    else if (s.type === "in") tags.add(s.key);
    else if (s.type === "and" || s.type === "or") s.items.forEach(scopeTags);
    else if (s.type === "not") scopeTags(s.expr);
  };
  switch (e.type) {
    case "metric":
      metrics.add(e.metric);
      e.groupBy.forEach((g) => tags.add(g));
      scopeTags(e.scope);
      return;
    case "paren":
    case "neg":
      return collect(e.expr, metrics, tags);
    case "binary":
      collect(e.left, metrics, tags);
      return collect(e.right, metrics, tags);
    case "postfix":
      return collect(e.target, metrics, tags);
    case "call":
      for (const a of e.args) if (a.type === "expr") collect(a.expr, metrics, tags);
      return;
  }
}

/** Light PromQL highlighting: metric names in the accent color, functions bold, keywords dim. */
export function highlightPromQL(p: Paint, q: string): string {
  if (!p.on) return q;
  return q
    .replace(/\b(by|without|on|ignoring|group_left|group_right|offset|bool)\b/g, (m) => p.dim(m))
    .replace(/\b([a-z_]+)(?=\s*\()/g, (m) => p.bold(m))
    .replace(/otel_metric_name="([^"]+)"/g, (_m, name: string) => `otel_metric_name="${p.accent(name)}"`);
}

export interface ExplainOptions {
  query: string;
  mappingsDir: string;
  ui: Ui;
  version: string;
  now?: () => number;
}

export function explain(o: ExplainOptions): number {
  const { ui } = o;
  const p = ui.p;
  const now = o.now ?? (() => performance.now());
  const src = o.query.trim();
  ui.header(o.version, "explain: one query through the engine");

  // 1. Parse
  const monitor = isMonitor(src);
  const t0 = now();
  const parsed = monitor ? parseMonitorQuery(src) : parseQuery(src);
  const parseMs = now() - t0;
  if (!parsed.ok) {
    const e = parsed.error;
    ui.line(`${p.bad("●")} ${p.bold("Parse")}  ${p.bad("not a Datadog query")}`);
    ui.line(`    ${src}`);
    ui.line(`    ${" ".repeat(Math.max(0, e.pos))}${p.bad("^")} ${e.message}`);
    return 3;
  }
  const expr: Expr = monitor ? (parsed.value as MonitorQuery).query : (parsed.value as Expr);
  ui.line(`${p.accent("●")} ${p.bold("Parse")}  ${p.dim(`recursive-descent parser, Datadog query grammar → AST  ${parseMs.toFixed(2)} ms`)}`);
  ui.line(`  ${p.dim(src)}`);
  if (monitor) {
    const m = parsed.value as MonitorQuery;
    ui.line(`  ${p.dim("monitor")}  ${m.timeAgg}(${m.window}) ${m.change ? `${m.change.kind}(…, ${m.change.compareWindow}) ` : ""}${m.op} ${m.threshold}`);
  }
  for (const l of astTree(expr, src)) ui.line(`  ${l.replace(/^[│├└─ ]+/, (m) => p.dim(m)).replace(/^(\S*?[│├└─ ]*)([a-z ]+:)/, (_m, a: string, b: string) => a + p.dim(b))}`);
  ui.line();

  // 2. Map
  const mappings: Mappings = loadMappings(o.mappingsDir);
  const kinds = loadDdKinds(o.mappingsDir);
  const ctx: TranslateContext = { metric: metricLookup(mappings), availability: (dd) => metricAvailability(mappings, dd), tag: tagLookup(mappings), ddKind: ddKindLookup(kinds, mappings) };
  const metrics = new Set<string>();
  const tags = new Set<string>();
  collect(expr, metrics, tags);
  ui.line(`${p.accent("●")} ${p.bold("Map")}  ${p.dim(`${mappings.metrics.size} curated metric mappings · ${Object.keys(kinds).length.toLocaleString("en")} Datadog metric kinds`)}`);
  for (const m of metrics) {
    const hit = ctx.metric!(m);
    const avail = ctx.availability!(m);
    const origin = mappings.origin.get(m);
    if (hit) {
      const extra = [hit.kind, hit.status ?? "exact", ...(hit.scale && hit.scale !== 1 ? [`× ${hit.scale}`] : []), ...(hit.sumBy?.length ? [`sum over ${hit.sumBy.join(", ")}`] : []), ...(hit.labels ? Object.entries(hit.labels).map(([k, v]) => `${k}="${v}"`) : [])];
      ui.detail(`${m} ${p.dim("→")} ${p.accent(hit.otel)}  ${p.dim(extra.join(" · "))}${origin ? p.dim(`  mappings/datadog/${basename(origin)}`) : ""}`);
    } else {
      const kind = ctx.ddKind!(m);
      ui.detail(`${m} ${p.dim("→")} ${p.warn(avail === "unmapped" ? "no curated mapping" : avail.replace("_", " "))}${kind ? p.dim(`  Datadog kind ${kind} (integrations-core metadata)`) : ""}`);
    }
  }
  for (const t of tags) {
    const mapped = ctx.tag!(t);
    ui.detail(`tag ${t} ${p.dim("→")} ${mapped ? p.accent(mapped) : `${t.replace(/\./g, "_")} ${p.dim("(default: dots → underscores)")}`}`);
  }
  ui.line();

  // 3. Translate
  const t1 = now();
  const r: QueryTranslation & { thresholds?: { failed: number; degraded?: number } | null } = monitor ? translateMonitor(parsed.value as MonitorQuery, { critical: (parsed.value as MonitorQuery).threshold }, ctx) : translateQuery(expr, ctx);
  const trMs = now() - t1;
  ui.line(`${p.accent("●")} ${p.bold("Rules")}  ${p.dim(`${r.rules.length} applied from the rule table  ${trMs.toFixed(2)} ms`)}`);
  const width = Math.max(0, ...r.rules.map((id) => id.length));
  for (const id of r.rules) {
    const rule = (RULES as Record<string, { status: string; description: string }>)[id];
    ui.detail(`${id.padEnd(width)}  ${claimPaint(p, rule?.status ?? "?").padEnd(p.on ? 22 : 11)}  ${p.dim(rule?.description ?? "")}`);
  }
  ui.line();

  // 4. PromQL
  if (r.promql) {
    const v = validatePromQL(r.promql);
    ui.line(`${p.accent("●")} ${p.bold("PromQL")}  ${v.ok ? p.dim("parsed by the official PromQL grammar (lezer-promql)") + " " + p.ok("✓") : p.bad("does not parse: " + v.errors.map((e) => e.message).join("; "))}`);
    ui.line(`  ${highlightPromQL(p, r.promql)}`);
    if (r.thresholds) ui.detail(p.dim(`Dash0 check rule: failed > ${r.thresholds.failed}${r.thresholds.degraded !== undefined ? ` · degraded > ${r.thresholds.degraded}` : ""} (the expression ends in $__threshold)`));
  } else ui.line(`${p.warn("●")} ${p.bold("PromQL")}  ${p.warn("none: this can't be translated exactly, so a migration lands a placeholder with the original query")}`);
  ui.line();

  // 5. Claim
  ui.line(`${p.accent("●")} ${p.bold("Claim")}  ${claimPaint(p, r.status)}`);
  const meaning: Record<string, string> = {
    exact: "equal to Datadog's result, unconditionally",
    "exact-under": "equal to Datadog's result whenever these conditions hold:",
    bounded: "within a proven error bound of Datadog's result",
    manual: "needs a person; the reason is below",
    unsupported: "no Dash0 equivalent",
  };
  ui.detail(p.dim(meaning[r.status] ?? ""));
  const aw = Math.max(0, ...r.assumptions.map((a) => a.length));
  for (const a of r.assumptions) ui.detail(`${p.dim(a.padEnd(aw))}  ${(ASSUMPTIONS as Record<string, string>)[a] ?? ""}`);
  for (const f of r.findings) ui.detail(`${claimPaint(p, f.status)} ${f.code}: ${f.message}`);
  ui.line();
  ui.line(p.dim("Deterministic: the same query and tables always give this exact output. No AI model is involved."));
  return r.promql ? 0 : 1;
}
