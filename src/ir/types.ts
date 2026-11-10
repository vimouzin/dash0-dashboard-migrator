// Intermediate representation (CONTRACT-001). Ratifies Ali's v0.1 proposal (plan 00 §4.2), with these changes:
//  - a Finding carries the four-level Status from plan 03 (see finding.ts);
//  - Panel.kind adds "logs" for log list widgets (plan 01 §1: Dash0 LogTable);
//  - SourceQuery keeps the vendor's raw fields (`raw`), so non-metric queries can be translated later
//    (log queries: search.query, compute, group_by).
// The IR is vendor-neutral in structure, but query text stays in the vendor's language and is
// translated only at the edge by a per-vendor QueryTranslator (T4).

import type { Finding } from "./finding.js";

export type Vendor = "datadog" | "newrelic" | "grafana";

export interface SourceRef {
  vendor: Vendor;
  /** The vendor's id, e.g. Datadog dashboard id "abc-def-ghi" or monitor id "12345", or the file stem for exports. */
  id: string;
  url?: string;
  /** Where it came from: "api" or the export file path. */
  origin?: string;
}

/** One vendor query, not translated yet. */
export interface SourceQuery {
  vendor: Vendor;
  /** "query1", "a", ... ; legacy `q` queries get "q0", "q1", ... */
  refId: string;
  /** "metrics" | "logs" | "spans" | "events" | ... Only "metrics" becomes PromQL today. */
  dataSource: string;
  /** Raw query text, e.g. "avg:redis.mem.used{$scope} by {host}". Empty for structured log queries. */
  expr: string;
  /** Widget-level aggregator for scalar widgets (query_value: "avg" | "last" | ...). */
  aggregator?: string;
  hidden?: boolean;
  /** The query object as the vendor wrote it. */
  raw: unknown;
}

export interface Formula {
  expr: string;
  alias?: string;
  /** top-N limit on a formula (toplist): { count, order } */
  limit?: { count: number; order: "asc" | "desc" };
}

/** One widget request or one monitor. formulas: [] means "plot every non-hidden query". */
export interface QuerySet {
  queries: SourceQuery[];
  formulas: Formula[];
}

export interface Variable {
  name: string;
  /**
   * The tag the variable filters on, e.g. "host" (Datadog `prefix`). null for a free-form variable such as `$scope`
   * (`prefix: null`), whose value is a whole tag: T4 drops it under assumption A.var-default with a finding.
   */
  tagKey: string | null;
  default?: string;
  multi?: boolean;
}

export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PanelKind = "timeseries" | "stat" | "toplist" | "table" | "markdown" | "logs" | "unsupported";

export interface Panel {
  id: string;
  kind: PanelKind;
  title?: string;
  /** The vendor's widget type, e.g. "query_value", "hostmap". */
  sourceType: string;
  /** In SOURCE grid units (Datadog: 12 columns). null = auto-flow. T5 rescales to 24. */
  layout: Layout | null;
  requests: QuerySet[];
  /** Unit, precision, markdown text, palette ... */
  options: Record<string, unknown>;
  original: unknown;
}

export interface Group {
  id: string;
  title?: string;
  collapsed?: boolean;
  layout: Layout | null;
  panels: Panel[];
  original: unknown;
}

export interface Dashboard {
  source: SourceRef;
  title: string;
  description?: string;
  /** 12 for Datadog. */
  gridColumns: number;
  variables: Variable[];
  items: (Panel | Group)[];
  original: unknown;
}

export interface Thresholds {
  critical?: number;
  warning?: number;
  criticalRecovery?: number;
  warningRecovery?: number;
}

export interface Alert {
  source: SourceRef;
  name: string;
  /** Notification message with the vendor's template syntax. */
  message: string;
  /** "query alert", "metric alert", "log alert", "service check", ... */
  type: string;
  /** Full monitor query, e.g. "avg(last_5m):100 * a / b > 90". */
  query: string;
  thresholds: Thresholds;
  tags: string[];
  /** Everything else (notify_no_data, require_full_window, evaluation_delay, ...). Each one is either mapped or reported. */
  options: Record<string, unknown>;
  original: unknown;
}

/** What an ingest adapter (T2, or a future New Relic adapter) returns. */
export interface IngestResult {
  dashboards: Dashboard[];
  alerts: Alert[];
  findings: Finding[];
}

export const isGroup = (x: Panel | Group): x is Group => "panels" in x;
