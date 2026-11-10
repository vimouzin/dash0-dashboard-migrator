// Coverage by query type: every distinct query and monitor in the source, classified the way a Datadog user thinks
// of them (legacy `q` strings, metric queries and formulas, log queries, log formulas, metric monitors, log monitors),
// each run through the same translators the migration uses (T4 metrics, T12 logs).
//
// One implementation for two callers: every run's report (src/flow) and the corpus scorecard
// (scripts/corpus-coverage.ts, the numbers on the slides). Deterministic, no network.
// "Translated" = not manual. "Exact" = exact or exact under the conditions the report states.
import type { Status } from "../ir/index.js";
import { ddKindLookup, loadDdKinds, loadMappings, metricAvailability, metricLookup, tagLookup, worst } from "../ir/index.js";
import type { Mappings } from "../ir/index.js";
import { parseFormula, parseMonitorQuery, parseQuery, parseQueryList } from "../parse/index.js";
import type { Expr } from "../parse/index.js";
import { translateMonitor, translateQuery } from "../translate/query/index.js";
import type { FormulaEnv, TranslateContext } from "../translate/query/index.js";
import { loadLogAttributes, logRef, translateLogMonitor, translateLogQuery } from "../translate/logs/index.js";
import type { DatadogLogQuery, LogTranslateContext } from "../translate/logs/index.js";
import { validatePromQL } from "../validate/promql.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type QueryKind = "metric formula / query" | "legacy q" | "log query" | "log formula" | "metric monitor" | "log monitor";
export const QUERY_KINDS: QueryKind[] = ["metric formula / query", "legacy q", "log query", "log formula", "metric monitor", "log monitor"];
/** How the report names each kind. */
export const KIND_LABELS: Record<QueryKind, string> = {
  "legacy q": "Legacy queries",
  "metric formula / query": "Metric queries",
  "log monitor": "Log monitors",
  "log query": "Log queries",
  "log formula": "Log formulas",
  "metric monitor": "Metric monitors",
};

export interface CoverageItem {
  kind: QueryKind;
  status: Status;
  /** Distinct-ness key: the same query text in two widgets counts once in the distinct numbers. */
  key: string;
  /** First manual finding code, when status is manual. */
  reason?: string;
  unmapped: boolean;
  unmappedNames: string[];
  /** The emitted PromQL failed the official grammar (must stay 0). */
  invalid: boolean;
  /** Where it came from: the integration (corpus) or the dashboard / monitor name (a run). */
  group: string;
}

type T = { status: Status; promql: string | null; findings: { code: string; status: string; message?: string }[] };
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

/** Collects coverage items from raw Datadog dashboard and monitor JSON (exports, the API, integrations-core assets). */
export function coverageCollector(mappingsDir: string, maps: Mappings = loadMappings(mappingsDir)) {
  const ddKind = ddKindLookup(loadDdKinds(mappingsDir), maps);
  const attrFile = join(mappingsDir, "log-attributes.yaml");
  const attributes = existsSync(attrFile) ? loadLogAttributes(attrFile) : undefined;
  const items: CoverageItem[] = [];
  /** Requests outside T4/T12 (events, APM, RUM, ...), by reason, so the denominators stay honest. */
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);

  const record = (kind: QueryKind, key: string, group: string, t: T): void => {
    const reason = t.status === "manual" ? (t.findings.find((f) => f.status === "manual")?.code ?? t.findings[0]?.code ?? "unknown") : undefined;
    const invalid = t.promql !== null && !validatePromQL(t.promql.replace(/\$__threshold/g, "1")).ok;
    items.push({
      kind,
      status: invalid ? "manual" : t.status,
      key: `${kind}|${key}`,
      ...(invalid ? { reason: "promql.invalid" } : reason ? { reason } : {}),
      unmapped: t.findings.some((f) => f.code === "metric.unmapped"),
      unmappedNames: t.findings.flatMap((f) => (f.code === "metric.unmapped" ? [/no mapping for ([^;\s]+)/.exec(f.message ?? "")?.[1] ?? "?"] : [])),
      invalid,
      group,
    });
  };
  const parseFail = (kind: QueryKind, key: string, group: string) => record(kind, key, group, { status: "manual", promql: null, findings: [{ code: "query.parse_error", status: "manual" }] });
  const metricCtx = (variables?: TranslateContext["variables"]): TranslateContext => ({ metric: metricLookup(maps), availability: (dd) => metricAvailability(maps, dd), ddKind, tag: tagLookup(maps), ...(variables ? { variables } : {}) });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const walk = (ws: any[], fn: (d: any) => void): void => {
    for (const w of ws ?? []) {
      const d = w?.definition;
      if (!d) continue;
      if (Array.isArray(d.widgets)) walk(d.widgets, fn);
      else fn(d);
    }
  };

  const dashboard = (json: unknown, group: string): void => {
    const dash = json as any;
    const variables: NonNullable<TranslateContext["variables"]> = {};
    for (const v of dash?.template_variables ?? []) variables[v.name] = { tag: v.prefix ?? null };
    const mctx = metricCtx(variables);
    const lctx: LogTranslateContext | undefined = attributes ? { attributes, variables } : undefined;
    walk(dash?.widgets, (d) => {
      const reqs: any[] = Array.isArray(d.requests) ? d.requests : d.requests && typeof d.requests === "object" ? Object.values(d.requests).flat() : [];
      for (const req of reqs) {
        if (!req || typeof req !== "object") continue;
        if (Array.isArray(req.queries)) {
          const env: FormulaEnv = new Map();
          let sawLog = false;
          let broken = false;
          for (const q of req.queries) {
            const ds = q.data_source ?? "metrics";
            if (ds === "metrics") {
              const p = parseQuery(q.query ?? "");
              if (!p.ok) {
                parseFail("metric formula / query", q.query ?? "", group);
                broken = true;
                continue;
              }
              env.set(q.name, p.value as Expr);
            } else if (ds === "logs" && lctx) {
              sawLog = true;
              const t = translateLogQuery(q as DatadogLogQuery, lctx);
              record("log query", JSON.stringify([q.search, q.compute, q.group_by, q.indexes]), group, t);
              env.set(q.name, logRef(t));
            } else skip(`data_source:${ds}`);
          }
          if (broken || env.size === 0) continue;
          if (Array.isArray(req.formulas) && req.formulas.length) {
            for (const f of req.formulas) {
              const p = parseFormula(f.formula);
              const kind: QueryKind = sawLog ? "log formula" : "metric formula / query";
              const key = JSON.stringify([f.formula, req.queries.map((q: any) => q.query ?? q.search)]);
              if (!p.ok) parseFail(kind, key, group);
              else if (req.queries.some((q: any) => !env.has(q.name)))
                // A formula over a data source we don't translate (events, APM, ...) can't be translated.
                record(kind, key, group, { status: "manual", promql: null, findings: [{ code: "query.datasource", status: "manual" }] });
              else record(kind, key, group, translateQuery(p.value, mctx, env));
            }
          } else {
            for (const q of req.queries) {
              if ((q.data_source ?? "metrics") !== "metrics") continue; // logs already recorded
              const p = parseQuery(q.query);
              if (p.ok) record("metric formula / query", JSON.stringify([q.query]), group, translateQuery(p.value, mctx));
            }
          }
        } else if (typeof req.q === "string") {
          const p = parseQueryList(req.q);
          if (!p.ok) {
            parseFail("legacy q", req.q, group);
            continue;
          }
          for (const e of Array.isArray(p.value) ? p.value : [p.value]) record("legacy q", req.q, group, translateQuery(e as Expr, mctx));
        } else {
          for (const k of ["log_query", "apm_query", "rum_query", "process_query", "event_query", "network_query", "security_query", "profile_metrics_query", "apm_stats_query"])
            if (req[k]) skip(`request.${k}`);
        }
      }
    });
  };

  const monitor = (json: unknown, group: string): void => {
    const doc = json as any;
    const def = doc?.definition ?? doc;
    const type: string = def?.type ?? "";
    const th = def?.options?.thresholds ?? {};
    const opts = { critical: num(th.critical), warning: num(th.warning) };
    if (type === "query alert" || type === "metric alert") {
      const p = parseMonitorQuery(def.query ?? "");
      if (!p.ok) return parseFail("metric monitor", def.query ?? "", group);
      record("metric monitor", def.query, group, translateMonitor(p.value, opts, metricCtx()));
    } else if (type === "log alert" && attributes) {
      record("log monitor", def.query ?? "", group, translateLogMonitor(def.query ?? "", { ...opts, variables: def.options?.variables }, { attributes }));
    } else skip(`monitor type: ${type || "(none)"}`);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { dashboard, monitor, items, skipped };
}

export interface QueryTypeRow {
  kind: QueryKind;
  label: string;
  /** Distinct queries / monitors of this kind. */
  total: number;
  counts: Record<Status, number>;
  translated: number;
  /** exact + exact-under. */
  exact: number;
  /** Why the manual ones stay with a person, most common first. */
  reasons: [string, number][];
}

export interface QueryCoverage {
  /** Distinct queries and monitors, all kinds. */
  total: number;
  translated: number;
  exact: number;
  /** Kinds that occur, best translated first. */
  rows: QueryTypeRow[];
  /** Requests outside the metric and log translators, by reason. */
  skipped: Record<string, number>;
  /** Distinct anomalies() monitors: they count as metric monitors and stay with a person. */
  anomalyMonitors: number;
}

const STATUSES: Status[] = ["exact", "exact-under", "bounded", "manual"];

/** One row per kind, distinct queries only: the same query in two widgets counts once, at its worst status. */
export function summarizeCoverage(items: CoverageItem[], skipped: Map<string, number> = new Map()): QueryCoverage {
  const rows: QueryTypeRow[] = [];
  for (const kind of QUERY_KINDS) {
    const seen = new Map<string, CoverageItem>();
    for (const i of items.filter((x) => x.kind === kind)) {
      const prev = seen.get(i.key);
      seen.set(i.key, prev ? { ...i, status: worst(prev.status, i.status), reason: prev.reason ?? i.reason } : i);
    }
    const xs = [...seen.values()];
    if (!xs.length) continue;
    const counts = Object.fromEntries(STATUSES.map((s) => [s, xs.filter((i) => i.status === s).length])) as Record<Status, number>;
    const why = new Map<string, number>();
    for (const i of xs) if (i.status === "manual") why.set(i.reason ?? "unknown", (why.get(i.reason ?? "unknown") ?? 0) + 1);
    rows.push({ kind, label: KIND_LABELS[kind], total: xs.length, counts, translated: xs.length - counts.manual, exact: counts.exact + counts["exact-under"], reasons: [...why.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) });
  }
  rows.sort((a, b) => b.translated / b.total - a.translated / a.total || b.total - a.total);
  const sum = (f: (r: QueryTypeRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const mm = rows.find((r) => r.kind === "metric monitor");
  return { total: sum((r) => r.total), translated: sum((r) => r.translated), exact: sum((r) => r.exact), rows, skipped: Object.fromEntries(skipped), anomalyMonitors: mm?.reasons.find(([c]) => c === "fn.anomalies")?.[1] ?? 0 };
}

/** Percent with one decimal, rounded down so a number is never rounded up (99.96% shows as 99.9%). */
export const pct1 = (a: number, b: number) => (b === 0 ? "–" : `${(Math.floor((1000 * a) / b) / 10).toFixed(1)}%`);

/** The headline sentence. */
export function coverageHeadline(c: QueryCoverage): string {
  return `${pct1(c.translated, c.total)} of ${c.total.toLocaleString("en")} distinct queries and monitors translate, and ${pct1(c.exact, c.total)} are exact under a stated condition.`;
}
