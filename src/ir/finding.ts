// Translation status, findings and certificates (CONTRACT-001).
// Status comes from the equivalence lattice in plan 03 §2 (dash0-team workspace):
//   exact        the output means the same as the source, for every input
//   exact-under  exact as long as the listed assumptions hold (each is checkable on live data)
//   bounded      differs by at most `epsilon` (a formula, e.g. from maths.md T3b)
//   manual       no faithful translation; the original is kept and the reason is reported
// The report and the brief use three words. reportLabel() maps exact-under and bounded to "approximate".

export type Status = "exact" | "exact-under" | "bounded" | "manual";

const RANK: Record<Status, number> = { exact: 0, "exact-under": 1, bounded: 2, manual: 3 };

/** The weakest of the given statuses. A composite is only as good as its weakest part. */
export function worst(...statuses: Status[]): Status {
  return statuses.reduce<Status>((a, b) => (RANK[b] > RANK[a] ? b : a), "exact");
}

export function reportLabel(s: Status): "exact" | "approximate" | "manual" {
  return s === "exact" ? "exact" : s === "manual" ? "manual" : "approximate";
}

export type ItemKind = "dashboard" | "group" | "panel" | "query" | "variable" | "alert";

/**
 * A finding is emitted for anything that is not plainly exact. Nothing is dropped without one
 * (the brief: "never silently drop").
 */
export interface Finding {
  status: Exclude<Status, "exact">;
  /** Stable machine id, e.g. "metric.unmapped", "widget.unsupported", "fn.top.per_step". Codes are listed in FINDING_CODES. */
  code: string;
  /** One sentence for the report. */
  message: string;
  itemKind: ItemKind;
  /** e.g. "dd-dash-abc/panel-12/query1". Built by whoever emits the finding. */
  itemId: string;
  /** The translation rule involved, e.g. "fn.rollup.avg". */
  ruleId?: string;
  /** For exact-under: the assumptions, each phrased so it can be checked. */
  assumptions?: string[];
  /** For bounded: the error bound, as a formula or a number with units. */
  epsilon?: string;
  /** The source fragment that triggered the finding (query text, widget type, option name). */
  original?: string;
}

/** Known finding codes. New codes go here, so the report and the UI can group them. */
export const FINDING_CODES = {
  "metric.unmapped": "Datadog metric has no entry in the mapping table; the name is kept as is",
  "metric.no_equivalent": "The OTel receiver emits no equivalent metric; the panel becomes a placeholder",
  "metric.derived": "The equivalent is an expression over several OTel metrics; not translated yet",
  "metric.kind_change": "Datadog and OTel store the metric differently (for example rate vs counter); a function was inserted",
  "tag.unmapped": "Datadog tag has no OTel label mapping; the filter or grouping is kept as is",
  "widget.unsupported": "Widget type has no Dash0 panel; a Markdown placeholder holds the original",
  "query.datasource": "Query reads logs, spans, events or similar; only metrics translate to PromQL",
  "query.parse_error": "Query could not be parsed",
  "fn.unsupported": "Datadog function has no PromQL equivalent",
  "variable.pinned": "Template variable pinned to its default value",
  "monitor.option": "Monitor option has no Dash0 equivalent",
  "monitor.type": "Monitor type is not a metric alert",
} as const;

/** A machine-checkable record of what was preserved for one migrated item (plan 03 §5). */
export interface Certificate {
  itemId: string;
  /** sha256 of the canonical source JSON. */
  sourceHash: string;
  /** sha256 of the canonical output. Absent when nothing was emitted. */
  outputHash?: string;
  status: Status;
  rules: string[];
  assumptions: string[];
  epsilon?: string;
  checks: {
    parses?: boolean;
    typechecks?: boolean;
    /** Number of generated cases the reference evaluator checked this item's rules on. */
    propertyTested?: number;
    importedReadBack?: boolean;
    parity?: { window: string; points: number; maxAbsErr: number; tolerance: number };
  };
}
