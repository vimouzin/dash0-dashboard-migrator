import type { ReportItem } from "./report";

const TYPE_LABELS: Record<string, string> = {
  timeseries: "Chart",
  query_value: "Stat",
  toplist: "Top list",
  distribution: "Distribution",
  list_stream: "Logs",
  log_stream: "Logs",
  note: "Text",
};
export const typeLabel = (item: ReportItem) =>
  item.kind === "monitor"
    ? "Check rule"
    : item.kind === "group"
      ? "Group"
      : (TYPE_LABELS[item.widget_type ?? ""] ?? item.widget_type ?? "Widget");
const REASON_LABELS: Record<string, string> = {
  RATE_CONVERSION: "Rate rebuilt",
  DB_SUM_REQUIRED: "Summed across DBs",
  DEFAULT_ROLLUP_DIFFERENCE: "Sampling differs",
  NO_EQUIVALENT_METRIC: "No metric",
  UNSUPPORTED_WIDGET: "No chart type",
  NON_METRIC_DATA_SOURCE: "Logs",
  LABEL_MAPPING_MISSING: "Host split dropped",
  TEMPLATE_VARIABLE_PINNED: "Filters pinned",
  ZERO_DENOMINATOR_RISK: "Zero divide risk",
  LABELS_DROPPED_BY_AGGREGATION: "No instance labels",
  MONITOR_OPTION_UNSUPPORTED: "Alert option",
  METRIC_NOT_ENABLED: "Metric switched on",
  LAYOUT_APPROXIMATE: "Layout shifted",
  APPROXIMATE_FUNCTION: "Function differs",
  "widget.note": "Text note kept",
  "metric.approximate": "Approximate metric",
  "scope.var.free-form": "Filter dropped",
  "widget.query_value": "Stat panel",
  "panel.style": "Styling not kept",
  "metric.no_equivalent": "No metric",
  "widget.unsupported": "No chart type",
  "query.datasource": "Logs not wired yet",
  "monitor.option": "Notifications by hand",
  "alert.msg.conditional": "Message not conditional",
  "alert.defaults": "Default schedule",
};
export const reasonLabel = (code: string) => REASON_LABELS[code] ?? code;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
type Breakdown = ReturnType<typeof import("./report").widgetBreakdown>;
/** "27 metric widgets: 11 exact if a condition holds, 10 approximate, 6 can't migrate automatically" (all from the file). */
export const metricWidgetsLine = (c: Breakdown) =>
  `${plural(c.metrics, "metric widget", "metric widgets")}: ${[
    ...(c.exact > 0 ? [`${c.exact} exact`] : []),
    `${c.exactIf} exact if a condition holds`,
    `${c.differences} approximate`,
    `${c.manual} can't migrate automatically`,
  ].join(", ")}`;
/** "7 text notes copied, 2 log panels", kept apart from the metric widget counts. */
export const textAndLogsLine = (c: Breakdown) =>
  `${plural(c.notesCopied, "text note", "text notes")} copied, ${plural(c.logPanels, "log panel", "log panels")}`;
