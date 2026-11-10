// One widget request (QuerySet) -> PromQL queries, through an injected expression translator.
// The translator is T4's translateQuery wrapped by the caller (T8), e.g.
//   (e, o) => translateQuery(e, { ...baseCtx, variables: o.variables, where: o.where }, o.env)
// so this module depends only on the parser and the IR, not on T4's module.
import { formatParseError, parseFormula, parseQuery, parseQueryList, type Expr } from "../../parse/index.js";
import { worst, type Finding, type QuerySet, type Status } from "../../ir/index.js";
import type { FormulaEnv } from "../query/types.js";
import { logRef, type DatadogLogQuery, type LogTranslation } from "../logs/index.js";

/** What T4 returns per expression (structurally; findings may still be in T4's older shape). */
export interface ExprTranslation {
  status: Status;
  promql: string | null;
  rules: string[];
  assumptions: string[];
  findings: unknown[];
}

export interface TranslateOptions {
  /** Formula refs: parsed metric queries, or log queries already lowered by T12 (logRef). */
  env?: FormulaEnv;
  /** Dashboard variables for T4: name -> the tag key it filters, or null (free-form / pinned). */
  variables: Record<string, { tag: string | null }>;
  where: string;
}

export type TranslateExpr = (e: Expr, o: TranslateOptions) => ExprTranslation;

/**
 * T12's translateLogQuery, wrapped by the caller with the log-attribute table:
 *   (q, o) => translateLogQuery(q, { attributes, variables: o.variables, where: o.where })
 * Optional: without it, log queries fail closed as before.
 * scalar: the widget shows one value for the whole timeframe (T5 stat panels): T12 emits the window form,
 * [$__range] (log.scalar.window), instead of one [$__interval] bucket.
 */
export type TranslateLog = (q: DatadogLogQuery, o: Omit<TranslateOptions, "env"> & { scalar?: boolean }) => LogTranslation;

export interface PanelQuery {
  promql: string;
  legend?: string;
}

export interface RequestTranslation {
  queries: PanelQuery[];
  status: Status;
  rules: string[];
  assumptions: string[];
  findings: Finding[];
}

export function translateRequests(
  sets: readonly QuerySet[],
  translate: TranslateExpr,
  variables: TranslateOptions["variables"],
  itemId: string,
  translateLog?: TranslateLog,
): RequestTranslation {
  const out: RequestTranslation = { queries: [], status: "exact", rules: [], assumptions: [], findings: [] };
  const add = (r: ExprTranslation, where: string, legend?: string) => {
    out.status = worst(out.status, r.status);
    for (const x of r.rules) if (!out.rules.includes(x)) out.rules.push(x);
    for (const x of r.assumptions) if (!out.assumptions.includes(x)) out.assumptions.push(x);
    out.findings.push(...r.findings.map((f) => toFinding(f, where, r.status)));
    if (r.promql) out.queries.push({ promql: r.promql, ...(legend ? { legend } : {}) });
  };
  const manual = (code: string, message: string, original?: string) => {
    out.status = "manual";
    out.findings.push({ status: "manual", code, message, itemKind: "query", itemId, ...(original !== undefined ? { original } : {}) });
  };

  for (const [si, set] of sets.entries()) {
    const where = sets.length > 1 ? `${itemId}/request-${si}` : itemId;
    // Parse every metrics query once and lower every log query once (T12); formulas reference both by refId.
    const env: FormulaEnv = new Map();
    const logs = new Map<string, LogTranslation>();
    const translatable = (ds: string) => ds === "metrics" || (ds === "logs" && translateLog !== undefined);
    for (const q of set.queries) {
      if (q.dataSource === "metrics") {
        const p = parseQuery(q.expr);
        if (p.ok) env.set(q.refId, p.value);
      } else if (q.dataSource === "logs" && translateLog) {
        const t = translateLog(q.raw as DatadogLogQuery, { variables, where });
        logs.set(q.refId, t);
        if (t.promql) env.set(q.refId, logRef(t));
      }
    }
    if (set.formulas.length) {
      for (const f of set.formulas) {
        const p = parseFormula(f.expr);
        if (!p.ok) {
          manual("query.parse_error", `formula does not parse: ${formatParseError(p.error)}`, f.expr);
          continue;
        }
        const refs = refsOf(p.value);
        const nonMetric = set.queries.filter((q) => refs.has(q.refId) && !translatable(q.dataSource));
        if (nonMetric.length) {
          manual("query.datasource", `formula '${f.expr}' reads ${nonMetric.map((q) => q.dataSource).join(", ")} data; only metrics and logs translate to PromQL`, nonMetric.map((q) => q.expr).join(" | "));
          continue;
        }
        // A log query T12 couldn't translate: its own (manual) findings say why, and the formula is skipped.
        const failedLogs = [...refs].map((r) => logs.get(r)).filter((t): t is LogTranslation => !!t && !t.promql);
        if (failedLogs.length) {
          for (const t of failedLogs) add(t, where);
          out.status = "manual";
          continue;
        }
        const missing = [...refs].filter((r) => !env.has(r));
        if (missing.length) {
          const bad = set.queries.find((q) => missing.includes(q.refId));
          const pe = bad ? parseQuery(bad.expr) : null;
          manual("query.parse_error", pe && !pe.ok ? `query ${bad!.refId} does not parse: ${formatParseError(pe.error)}` : `formula references unknown queries ${missing.join(", ")}`, bad?.expr ?? f.expr);
          continue;
        }
        add(translate(p.value, { env, variables, where }), where, f.alias);
      }
      continue;
    }
    // No formulas: plot every non-hidden query. Legacy `q` may hold several comma-separated expressions.
    for (const q of set.queries) {
      if (q.hidden) continue;
      const lt = logs.get(q.refId);
      if (lt) {
        add(lt, where);
        continue;
      }
      if (q.dataSource !== "metrics") {
        manual("query.datasource", `query ${q.refId} reads ${q.dataSource} data; only metrics${translateLog ? " and logs" : ""} translate to PromQL`, q.expr);
        continue;
      }
      const p = parseQueryList(q.expr);
      if (!p.ok) {
        manual("query.parse_error", `query ${q.refId} does not parse: ${formatParseError(p.error)}`, q.expr);
        continue;
      }
      for (const e of p.value) add(translate(e, { env, variables, where }), where);
    }
  }
  if (out.queries.length === 0 && out.status !== "manual") manual("query.empty", "the widget has no query to translate");
  return out;
}

/** Formula references (`query1`, `a`) used anywhere in an expression. */
function refsOf(e: Expr): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    const n = x as { type?: string; name?: string };
    if (n.type === "ref" && typeof n.name === "string") out.add(n.name);
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
  };
  walk(e);
  return out;
}

/** Accepts CONTRACT-001 findings and T4's older {severity, code, where, message} shape. */
function toFinding(f: unknown, itemId: string, resultStatus: Status): Finding {
  const x = (f ?? {}) as Record<string, unknown>;
  if (typeof x.status === "string" && typeof x.itemId === "string") return x as unknown as Finding;
  const sev = x.severity;
  const status: Finding["status"] = sev === "unsupported" || sev === "error" ? "manual" : resultStatus === "exact" ? "exact-under" : resultStatus;
  const original = x.original === undefined ? undefined : typeof x.original === "string" ? x.original : JSON.stringify(x.original);
  return {
    status,
    code: typeof x.code === "string" ? x.code : "query.finding",
    message: typeof x.message === "string" ? x.message : String(x.message ?? ""),
    itemKind: "query",
    itemId: typeof x.where === "string" && x.where ? x.where : itemId,
    ...(original !== undefined ? { original } : {}),
  };
}
