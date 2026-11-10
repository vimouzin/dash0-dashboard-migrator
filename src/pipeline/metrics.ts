// summary.metrics (CONTRACT-003 §5.2): distinct Datadog metric names in this run's metric queries, by what the mapping
// table says about each. Uses the T3 parser, so a name inside a formula, function or filter is found the same way the
// translator finds it.
import type { Alert, Dashboard, Mappings } from "../ir/index.js";
import { isGroup, metricAvailability } from "../ir/index.js";
import { parseMonitorQuery, parseQuery, type Arg, type Expr } from "../parse/index.js";

export interface MetricSummary {
  total: number;
  mapped: number;
  approximate: number;
  derived: number;
  needsTransform: number;
  noEquivalent: number;
  unmapped: number;
}

function walk(e: Expr, out: Set<string>): void {
  switch (e.type) {
    case "metric":
      out.add(e.metric);
      return;
    case "call":
      for (const a of e.args) walkArg(a, out);
      return;
    case "postfix":
      walk(e.target, out);
      return;
    case "binary":
      walk(e.left, out);
      walk(e.right, out);
      return;
    case "neg":
    case "paren":
      walk(e.expr, out);
      return;
    default:
      return;
  }
}
function walkArg(a: Arg, out: Set<string>): void {
  if (a.type === "expr") walk(a.expr, out);
  else if (a.type === "named") walkArg(a.value, out);
}

/** Distinct metric names in metric queries (logs/spans/events queries are not metric queries). */
export function metricNames(dashboards: Dashboard[], alerts: Alert[]): string[] {
  const out = new Set<string>();
  for (const d of dashboards)
    for (const it of d.items)
      for (const p of isGroup(it) ? it.panels : [it])
        for (const qs of p.requests)
          for (const q of qs.queries) {
            if (q.dataSource !== "metrics" || !q.expr) continue;
            const r = parseQuery(q.expr);
            if (r.ok) walk(r.value, out);
          }
  for (const a of alerts) {
    const r = parseMonitorQuery(a.query);
    if (r.ok) walk(r.value.query, out);
  }
  return [...out].sort();
}

export function summarizeMetrics(names: string[], mappings: Mappings): MetricSummary {
  const s: MetricSummary = { total: names.length, mapped: 0, approximate: 0, derived: 0, needsTransform: 0, noEquivalent: 0, unmapped: 0 };
  for (const n of names) {
    const a = metricAvailability(mappings, n);
    if (a === "mapped") {
      if (mappings.metrics.get(n)?.status === "approximate") s.approximate++;
      else s.mapped++;
    } else if (a === "derived") s.derived++;
    else if (a === "needs_transform") s.needsTransform++;
    else if (a === "no_equivalent") s.noEquivalent++;
    else s.unmapped++;
  }
  return s;
}
