// report.json (schema "dd2dash0.report/v2"; v2 adds fields only, CONTRACT-003 §5, src/report/CONTRACT.md). Follows Henry's proposal (dash0-team docs/report-schema-proposal.md)
// for the flat per-item fields the review console reads, with CONTRACT-001's Finding and Status.
// One difference from the proposal: findings use CONTRACT-001's {status, code, ...}, not {severity, ...}.
// A placeholder panel gets the report-only status "unsupported".
import type { Finding, Status } from "../ir/index.js";

export type ReportStatus = Status | "unsupported";

export interface ReportCertificate {
  sourceHash: string;
  outputHash: string | null;
  rules: string[];
  status: ReportStatus;
  assumptions: string[];
  epsilon?: string;
  checks: { parses: boolean; importedReadBack?: boolean | null };
}

export interface Layout4 {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReportItem {
  id: string;
  /** v2 adds "group": one per Datadog group, placed before its panels. */
  kind: "panel" | "alert" | "group";
  title: string;
  widget_type: string;
  /** Dashboard title (panels) or null (alerts). */
  dashboard: string | null;
  /** Title of the containing group, or null. */
  group: string | null;
  /** In the 24-column Dash0 grid; null for alerts. */
  layout: { x: number; y: number; w: number; h: number } | null;
  /** Source file or "api". */
  source: string;
  source_queries: string[];
  source_formula: string[] | null;
  promql: string[];
  status: ReportStatus;
  reason_codes: string[];
  certificate: ReportCertificate;
  findings: Finding[];
  thresholds?: { failed: number; degraded?: number };
  manual_actions?: string[];
  target: { dash0Id: string; kind: "dashboard" | "check-rule"; action: string; readBack: string } | null;
  // ---- v2 ----
  /** Parent group item's id, or null. */
  group_id: string | null;
  /** Datadog position (12 columns, relative to its group; groups: dashboard-relative). `layout` stays the Dash0 one. */
  source_layout: Layout4 | null;
  /** exact-under only: the assumptions as sentences, joined with "; ". */
  condition: string | null;
  /** The same item in two levels of words, from catalog templates (src/rules/plain.ts). */
  explain: { technical: string; plain: string };
  /** True exactly for the items in summary.reviewOrder (apply needs a decision for them). */
  decision_required: boolean;
}

export interface ReasonCode {
  label: string;
  explanation: string;
  plain: string;
  catalogRule: string | null;
}

export interface Report {
  schema: "dd2dash0.report/v2";
  run: {
    tool: "dd2dash0";
    version: string;
    /** sha256 over every source document (canonical JSON), so a changed input is visible. */
    inputHash: string;
    /** sha256 over `items`. Same input and same tool version give the same hash: the determinism check. */
    outputHash: string;
    options: Record<string, unknown>;
    mappingFiles: string[];
    // ---- v2 ----
    source: { kind: "api" | "folder"; site: string | null; path: string | null };
    toolCommit: string | null;
    /** sha256 of the canonical rule catalog: the rule version behind this report. */
    catalogHash: string;
    /** The resolved dd2dash0.yaml + flags, when the run came from `plan` (no secrets). */
    config?: Record<string, unknown>;
    /** Only in apply/report.json: the plan this import applied (a plan's own report can't hold its hash). */
    planHash?: string;
  };
  summary: {
    dashboards: number;
    alerts: number;
    byKind: Record<string, Partial<Record<ReportStatus, number>>>;
    /** (exact + exact-under) / panels with queries or text. Never rounded up. */
    coverageExact: number;
    /** (exact + exact-under + bounded) / same denominator. */
    coverageTranslated: number;
    findingsByCode: Record<string, number>;
    /** written = payloads written to <out>/dash0 in a dry run. */
    import: { mode: "dry-run" | "live" | "none"; written: number; imported: number; failed: number; rejected: number; readBackMatch: number } | null;
    // ---- v2 ----
    /** Distinct Datadog metric names in metric queries, by mapping-table status. The parts add up to total. */
    metrics: { total: number; mapped: number; approximate: number; derived: number; needsTransform: number; noEquivalent: number; unmapped: number };
    groups: number;
    /** Items that need a decision, in review order. */
    reviewOrder: string[];
    /** Manual codes ranked by how many items they block. */
    gaps: { code: string; items: number; fixKind: "mapping" | "rule" | "dash0-limit" | "source"; example: string }[];
    /** Datadog construct (catalog stage) -> rule -> the rule's claim, with how many items used it. */
    flow: { construct: string; ruleId: string; claim: string; count: number }[];
  };
  /** One entry per code used in this file's reason_codes and findings. */
  reasonCodes: Record<string, ReasonCode>;
  /** Dashboard- and run-level findings (variables, unreadable files, layout). */
  findings: Finding[];
  items: ReportItem[];
}
