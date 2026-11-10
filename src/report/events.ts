// A run as a sequence of events (JSON lines), for the live UI and the voice narrator.
// Derived purely from the finished report, so a recorded run replays exactly. Same report -> same events.
import type { Report, ReportStatus } from "./types.js";

export type RunEvent =
  | { seq: number; type: "run.start"; version: string; mode: string; dashboards: number; alerts: number; inputHash: string }
  | { seq: number; type: "dashboard.start"; dashboard: string; panels: number }
  | {
      seq: number;
      type: "item.done";
      kind: "panel" | "alert";
      id: string;
      title: string;
      dashboard: string | null;
      group: string | null;
      widget_type: string;
      status: ReportStatus;
      promql: string[];
      source_queries: string[];
      reason_codes: string[];
      manual_actions: string[];
    }
  | { seq: number; type: "dashboard.done"; dashboard: string; byStatus: Partial<Record<ReportStatus, number>> }
  | { seq: number; type: "import.done"; mode: string; written: number; imported: number; failed: number; rejected: number; readBackMatch: number }
  | {
      seq: number;
      type: "run.done";
      coverageExact: number;
      coverageTranslated: number;
      byKind: Report["summary"]["byKind"];
      /** The biggest remaining gaps, by finding code: what an improvement loop should attack next. */
      topGaps: { code: string; count: number; meaning: string }[];
      outputHash: string;
    };

/**
 * Exact-under only by assumption, but in practice the biggest gaps: an unmapped metric or tag is kept under its
 * Datadog name, which usually doesn't exist in Dash0. So they always count as gaps to close.
 */
const ALWAYS_GAP = new Set(["metric.unmapped", "tag.unmapped"]);

/** Plain-language meaning of the common gap codes, for the narrator. */
const MEANING: Record<string, string> = {
  "metric.unmapped": "no mapping-table entry for the Datadog metric yet",
  "metric.approximate": "the OpenTelemetry metric is only an approximate match",
  "panel.conditional_format": "conditional colour formats are not migrated",
  "panel.toplist.table": "top lists become tables without the top-N limit",
  "metric.no_equivalent": "the OpenTelemetry receiver emits no equivalent metric",
  "tag.unmapped": "a Datadog tag has no known OpenTelemetry label",
  "logs.not_translated": "log widgets are not translated yet",
  "fn.anomalies": "anomaly detection has no PromQL equivalent",
  "fn.top": "top() ranks over the whole window; PromQL ranks per step",
  "widget.unsupported": "Dash0 has no panel for this widget type",
  "time.kind-unknown": "the metric's type is unknown, so .as_count()/.as_rate() can't be chosen",
  "scope.var.free-form": "a free-form template variable was pinned to '*'",
};

export function reportToEvents(r: Report): RunEvent[] {
  const ev: RunEvent[] = [];
  let seq = 0;
  ev.push({ seq: seq++, type: "run.start", version: r.run.version, mode: String(r.run.options.mode), dashboards: r.summary.dashboards, alerts: r.summary.alerts, inputHash: r.run.inputHash });
  const dashboards = [...new Set(r.items.filter((i) => i.kind === "panel").map((i) => i.dashboard!))];
  for (const d of dashboards) {
    const panels = r.items.filter((i) => i.kind === "panel" && i.dashboard === d);
    ev.push({ seq: seq++, type: "dashboard.start", dashboard: d, panels: panels.length });
    const by: Partial<Record<ReportStatus, number>> = {};
    for (const i of panels) {
      by[i.status] = (by[i.status] ?? 0) + 1;
      ev.push(item(seq++, i));
    }
    ev.push({ seq: seq++, type: "dashboard.done", dashboard: d, byStatus: by });
  }
  for (const a of r.items.filter((i) => i.kind === "alert")) ev.push(item(seq++, a));
  if (r.summary.import) ev.push({ seq: seq++, type: "import.done", ...r.summary.import });
  const gaps = Object.entries(
    // Real gaps only: findings that are themselves bounded or manual, counted once per item. An exact-under finding
    // (e.g. a pinned variable) is exact while its assumption holds, even when the item has another, real gap.
    r.items
      .flatMap((i) => [...new Set(i.findings.filter((f) => f.status === "bounded" || f.status === "manual" || ALWAYS_GAP.has(f.code)).map((f) => f.code))])
      .reduce<Record<string, number>>((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {}),
  )
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, 5)
    .map(([code, count]) => ({ code, count, meaning: MEANING[code] ?? code }));
  ev.push({ seq: seq++, type: "run.done", coverageExact: r.summary.coverageExact, coverageTranslated: r.summary.coverageTranslated, byKind: r.summary.byKind, topGaps: gaps, outputHash: r.run.outputHash });
  return ev;
}

function item(seq: number, i: Report["items"][number]): RunEvent {
  return {
    seq,
    type: "item.done",
    kind: i.kind as "panel" | "alert",
    id: i.id,
    title: i.title,
    dashboard: i.dashboard,
    group: i.group,
    widget_type: i.widget_type,
    status: i.status,
    promql: i.promql,
    source_queries: i.source_queries,
    reason_codes: i.reason_codes,
    manual_actions: i.manual_actions ?? [],
  };
}
