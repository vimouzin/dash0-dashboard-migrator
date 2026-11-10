// The ONLY file that knows report.json field names. If the CLI renames a field, fix it here.

export type Status = "exact" | "approximate" | "unsupported" | "no_data" | "failed";
export const STATUSES: Status[] = ["exact", "approximate", "no_data", "unsupported", "failed"];
export type Kind = "group" | "widget" | "monitor";

export interface GridBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Verification {
  schema_valid?: boolean | null | undefined;
  promql_valid?: boolean | null | undefined;
  imported?: boolean | null | undefined;
  returns_data?: boolean | null | undefined;
  numeric_check?: unknown | undefined;
}

export interface ReportItem {
  id: string;
  status: string;
  claim?: "exact" | "exact-under" | "bounded" | "manual" | undefined;
  condition?: string | undefined;
  kind: Kind;
  title?: string | undefined;
  widget_type?: string | undefined;
  group?: string | null | undefined;
  layout?: GridBox | null | undefined;
  target_layout?: GridBox | null | undefined;
  source_path?: string | undefined;
  source_queries: string[];
  source_formula: string[];
  promql: string[];
  target_panel?: string | undefined;
  reason_codes: string[];
  notes?: string | undefined;
  thresholds?:
    { degraded?: number | undefined | undefined; failed?: number | undefined } | undefined;
  verification?: Verification | undefined;
  dash0?:
    | {
        asset_id?: string | null | undefined | undefined;
        url?: string | null | undefined | undefined;
        import_status?: string | null | undefined;
      }
    | undefined;
  raw: unknown;
}

export type Counts = Record<Status, number> & { total: number };

export interface ReportSummary {
  widgets: Counts;
  groups: Counts;
  monitors: Counts;
  metrics?:
    | {
        mapped?: number | undefined | undefined;
        total?: number | undefined | undefined;
        no_equivalent?: number | undefined;
      }
    | undefined;
  verification: {
    imported: number | null;
    returns_data: number | null;
    numeric_checked: number | null;
  };
  summaryFromFile: boolean;
}

export interface Report {
  schema_version?: string | undefined;
  run: {
    tool_version?: string | undefined;
    source?: string | undefined;
    source_commit?: string | undefined;
    source_sha256?: string | undefined;
    mapping_version?: string | undefined;
    rule_version?: string | undefined;
  };
  sampleNotice?: string | undefined;
  items: ReportItem[];
  summary: ReportSummary;
  diagnostics: unknown[];
  warnings: string[];
}

export type ParseResult = { ok: true; report: Report } | { ok: false; error: string };

type Obj = {
  [
    K in
      | "claim"
      | "condition"
      | "id"
      | "status"
      | "kind"
      | "title"
      | "widget_type"
      | "group"
      | "layout"
      | "target_layout"
      | "source_path"
      | "source_queries"
      | "source_formula"
      | "promql"
      | "target_panel"
      | "reason_codes"
      | "notes"
      | "thresholds"
      | "verification"
      | "dash0"
      | "x"
      | "y"
      | "w"
      | "h"
      | "schema_valid"
      | "promql_valid"
      | "imported"
      | "returns_data"
      | "numeric_check"
      | "asset_id"
      | "url"
      | "import_status"
      | "degraded"
      | "failed"
      | "summary"
      | "metrics"
      | "numerical"
      | "passed"
      | "mapped"
      | "total"
      | "no_equivalent"
      | "run"
      | "tool_version"
      | "source"
      | "source_commit"
      | "source_sha256"
      | "mapping_version"
      | "rule_version"
      | "items"
      | "diagnostics"
      | "schema_version"
      | "SAMPLE"
      | "exact"
      | "approximate"
      | "unsupported"
      | "no_data"
      | "widgets"
      | "monitors"
      | "certificate"
      | "checks"
      | "parses"
      | "importedReadBack"
      | "target"
      | "dash0Id"
      | "action"
      | "byKind"
      | "panel"
      | "alert"
      | "version"
      | "tool"
      | "inputHash"
      | "mappingFiles"
      | "schema"
      | "assumptions"
      | "findings"
      | "exact-under"
      | "bounded"
      | "manual"
  ]?: unknown;
};
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const strArr = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => str(x)).filter((x): x is string => !!x)
    : typeof v === "string" && v
      ? [v]
      : [];

function box(v: unknown): GridBox | null {
  if (!isObj(v)) return null;
  const x = num(v.x),
    y = num(v.y),
    w = num(v.w),
    h = num(v.h);
  if (w === undefined || h === undefined) return null;
  return { x: x ?? 0, y: y ?? 0, w, h };
}

function inferKind(id: string, v: unknown): Kind {
  if (v === "group" || v === "widget" || v === "monitor") return v;
  if (v === "panel") return "widget"; // CLI item kind
  if (v === "alert") return "monitor"; // CLI item kind
  if (id.startsWith("group")) return "group";
  if (id.startsWith("monitor")) return "monitor";
  return "widget";
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function parseClaim(v: unknown): ReportItem["claim"] {
  return v === "exact" || v === "exact-under" || v === "bounded" || v === "manual" ? v : undefined;
}
function statusFromClaim(claim: ReportItem["claim"]): Status | undefined {
  if (claim === "exact" || claim === "exact-under") return "exact";
  if (claim === "bounded") return "approximate";
  if (claim === "manual") return "unsupported";
  return undefined;
}

// The CLI writes its claim vocabulary in `status`. "exact" is also a status, so it is not a claim here.
const CLI_CLAIMS = ["exact-under", "bounded", "manual"] as const;
function claimInStatus(status: string | undefined): ReportItem["claim"] {
  return (CLI_CLAIMS as readonly string[]).includes(status ?? "")
    ? (status as ReportItem["claim"])
    : undefined;
}

// Human text for an exact-under claim, from the assumption sentences the CLI attached to the item's findings.
function conditionFromFindings(v: Obj): string | undefined {
  if (!Array.isArray(v.findings)) return undefined;
  const texts: string[] = [];
  for (const f of v.findings) {
    if (!isObj(f) || !Array.isArray(f.assumptions)) continue;
    for (const a of f.assumptions) {
      const t = str(a);
      if (t && !/^A\./.test(t) && !texts.includes(t)) texts.push(t);
    }
  }
  // First assumption plus a count: the full list is on the item's findings and would swamp the verdict box.
  return texts.length
    ? texts.length > 1
      ? `${texts[0]} (+${texts.length - 1} more assumptions)`
      : texts[0]
    : undefined;
}

function parseItem(v: Obj, id: string, status: string): ReportItem {
  const claim = claimInStatus(str(v.status)) ?? parseClaim(v.claim);
  const promql = strArr(v.promql);
  const cert =
    isObj(v.certificate) && isObj(v.certificate.checks) ? v.certificate.checks : undefined;
  const ver = isObj(v.verification) ? v.verification : undefined;
  // certificate.checks.parses is "every PromQL parses"; it is vacuously true with no PromQL, so only report it when there is some.
  const certVer: Verification | undefined = cert
    ? {
        promql_valid: promql.length ? boolOrNull(cert.parses) : null,
        imported: boolOrNull(cert.importedReadBack),
      }
    : undefined;
  const tg = isObj(v.target) ? v.target : undefined;
  const d0 = isObj(v.dash0) ? v.dash0 : undefined;
  const th = isObj(v.thresholds) ? v.thresholds : undefined;
  return {
    id,
    status,
    claim,
    condition: str(v.condition) ?? (claim === "exact-under" ? conditionFromFindings(v) : undefined),
    kind: inferKind(id, v.kind),
    title: str(v.title),
    widget_type: str(v.widget_type),
    group: str(v.group) ?? null,
    layout: box(v.layout),
    target_layout: box(v.target_layout),
    source_path: str(v.source_path),
    source_queries: strArr(v.source_queries),
    source_formula: strArr(v.source_formula),
    promql,
    target_panel: str(v.target_panel),
    reason_codes: strArr(v.reason_codes),
    notes: str(v.notes) || undefined,
    thresholds: th ? { degraded: num(th.degraded), failed: num(th.failed) } : undefined,
    verification: ver
      ? {
          schema_valid: boolOrNull(ver.schema_valid),
          promql_valid: boolOrNull(ver.promql_valid),
          imported: boolOrNull(ver.imported),
          returns_data: boolOrNull(ver.returns_data),
          numeric_check: ver.numeric_check,
        }
      : certVer,
    dash0:
      !d0 && tg
        ? { asset_id: str(tg.dash0Id) ?? null, url: null, import_status: str(tg.action) ?? null }
        : d0
          ? {
              asset_id: str(d0.asset_id) ?? null,
              url: str(d0.url) ?? null,
              import_status: str(d0.import_status) ?? null,
            }
          : undefined,
    raw: v,
  };
}

const emptyCounts = (): Counts => ({
  exact: 0,
  approximate: 0,
  unsupported: 0,
  no_data: 0,
  failed: 0,
  total: 0,
});

export function countItems(items: ReportItem[]): Counts {
  const c = emptyCounts();
  for (const it of items) {
    c.total++;
    if ((STATUSES as string[]).includes(it.status)) c[it.status as Status]++;
  }
  return c;
}

function countsFrom(v: unknown, fallback: Counts): Counts {
  if (!isObj(v)) return fallback;
  const c = emptyCounts();
  for (const s of STATUSES) c[s] = num(v[s]) ?? fallback[s];
  c.total = num(v.total) ?? fallback.total;
  return c;
}

// The CLI counts per kind in summary.byKind.{panel,alert}, keyed by its claim words. Fold them into the console's statuses.
const CLI_COUNT_KEYS: Record<string, Status> = {
  exact: "exact",
  "exact-under": "exact",
  bounded: "approximate",
  manual: "unsupported",
  unsupported: "unsupported",
  approximate: "approximate",
  no_data: "no_data",
  failed: "failed",
};
function countsFromByKind(v: unknown, fallback: Counts): Counts {
  if (!isObj(v)) return fallback;
  const c = emptyCounts();
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const count = num(n);
    if (count === undefined) continue;
    c.total += count;
    const st = CLI_COUNT_KEYS[k];
    if (st) c[st] += count;
  }
  return c;
}

function countVer(items: ReportItem[], key: "imported" | "returns_data"): number | null {
  const vals = items.map((i) => i.verification?.[key]).filter((x) => typeof x === "boolean");
  return vals.length ? vals.filter(Boolean).length : null;
}

export function parseReport(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `This file is not valid JSON (${(e as Error).message}).` };
  }
  if (!isObj(raw)) return { ok: false, error: "The file does not contain a report object." };
  if (!Array.isArray(raw.items)) return { ok: false, error: "The report has no items list." };

  const warnings: string[] = [];
  const items: ReportItem[] = [];
  raw.items.forEach((v, idx) => {
    const id = isObj(v) ? str(v.id) : undefined;
    const rawStatus = isObj(v) ? str(v.status) : undefined;
    const status = isObj(v)
      ? statusFromClaim(claimInStatus(rawStatus)) ||
        rawStatus ||
        statusFromClaim(parseClaim(v.claim))
      : undefined;
    if (!isObj(v) || !id || !status) {
      warnings.push(`Item ${idx + 1} skipped: missing id or status.`);
      return;
    }
    items.push(parseItem(v, id, status));
  });

  const widgets = items.filter((i) => i.kind === "widget");
  const groups = items.filter((i) => i.kind === "group");
  const monitors = items.filter((i) => i.kind === "monitor");
  const s = isObj(raw.summary) ? raw.summary : undefined;
  const metrics = s && isObj(s.metrics) ? s.metrics : undefined;
  const numerical = s && isObj(s.numerical) ? s.numerical : undefined;
  const numericChecked = numerical
    ? (num(numerical.passed) ?? 0) + (num(numerical.failed) ?? 0)
    : null;

  const run = isObj(raw.run) ? raw.run : {};
  const byKind = s && isObj(s.byKind) ? s.byKind : undefined;
  const mappingFiles = Array.isArray(run.mappingFiles)
    ? strArr(run.mappingFiles).join(", ")
    : undefined;
  const toolVersion =
    str(run.tool_version) ??
    (str(run.version) ? `${str(run.tool) ?? "tool"} ${str(run.version)}` : undefined);
  return {
    ok: true,
    report: {
      schema_version: str(raw.schema_version) ?? str(raw.schema),
      run: {
        tool_version: toolVersion,
        source: str(run.source),
        source_commit: str(run.source_commit),
        source_sha256: str(run.source_sha256) ?? str(run.inputHash),
        mapping_version: str(run.mapping_version) ?? (mappingFiles || undefined),
        rule_version: str(run.rule_version),
      },
      sampleNotice: str(raw.SAMPLE),
      items,
      summary: {
        widgets: s?.widgets
          ? countsFrom(s.widgets, countItems(widgets))
          : countsFromByKind(byKind?.panel, countItems(widgets)),
        groups: countItems(groups),
        monitors: s?.monitors
          ? countsFrom(s.monitors, countItems(monitors))
          : countsFromByKind(byKind?.alert, countItems(monitors)),
        metrics: metrics
          ? {
              mapped: num(metrics.mapped),
              total: num(metrics.total),
              no_equivalent: num(metrics.no_equivalent),
            }
          : undefined,
        verification: {
          imported: countVer(items, "imported"),
          returns_data: countVer(items, "returns_data"),
          numeric_checked: numericChecked && numericChecked > 0 ? numericChecked : null,
        },
        summaryFromFile: !!s,
      },
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
      warnings,
    },
  };
}

export const isTextNote = (i: ReportItem) => i.widget_type === "note";
export const isLogPanel = (i: ReportItem) =>
  i.widget_type === "list_stream" || i.widget_type === "log_stream";
export const isMetricWidget = (i: ReportItem) =>
  i.kind === "widget" && !isTextNote(i) && !isLogPanel(i);
export function widgetBreakdown(items: ReportItem[]) {
  const metrics = items.filter(isMetricWidget);
  return {
    metrics: metrics.length,
    exact: metrics.filter((i) => i.status === "exact" && i.claim !== "exact-under").length,
    exactIf: metrics.filter((i) => i.status === "exact" && i.claim === "exact-under").length,
    differences: metrics.filter((i) => i.status === "approximate").length,
    manual: metrics.filter((i) => ["unsupported", "no_data", "failed"].includes(i.status)).length,
    notesCopied: items.filter((i) => i.kind === "widget" && isTextNote(i) && i.status === "exact")
      .length,
    logPanels: items.filter((i) => i.kind === "widget" && isLogPanel(i)).length,
    logsUnsupported: items.filter(
      (i) => i.kind === "widget" && isLogPanel(i) && i.status === "unsupported",
    ).length,
    checkRules: items.filter((i) => i.kind === "monitor").length,
  };
}
export const fidelityLabel = (i: ReportItem): string | undefined =>
  i.status === "exact" && i.claim === "exact-under"
    ? `Exact if ${i.condition || "condition not supplied"}`
    : undefined;
export const displayTitle = (i: ReportItem) => (isTextNote(i) ? "Text note" : i.title || i.id);
export const noSamplesYet = (i: ReportItem) => i.verification?.returns_data === false;
