// T6 types. Rules come from the catalog (src/rules, T17); every applied rule id is a catalog id.
import type { Finding, Status } from "../../ir/index.js";
import type { MonitorQuery } from "../../parse/index.js";

/**
 * Body of a Dash0 check rule. Structurally a subset of T7's PrometheusAlertRule (src/targets/dash0/schema.ts, PR #5).
 * `id` is a deterministic UUIDv5 of the Datadog monitor id: POST /api/import/check-rule upserts by a UUID id
 * (Ali's live probe, hub #289), so re-imports overwrite. A non-UUID id ("dd-…") is rejected with 400.
 * `origin` (AlertTranslation.origin) stays available for PUT /api/alerting/check-rules/{origin}.
 */
export interface CheckRule {
  id: string;
  name: string;
  expression: string;
  thresholds?: { degraded?: number; failed?: number };
  interval?: string;
  for?: string;
  keep_firing_for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  enabled?: boolean;
}

/** A finding as T4 emits it today (plan 00 shape) or after its move to CONTRACT-001. */
export interface UpstreamFinding {
  code: string;
  message: string;
  severity?: string;
  status?: string;
  ruleId?: string;
  original?: unknown;
}

/** What T6 needs from T4's translateMonitor (src/translate/query, PR #3). */
export interface MonitorTranslationLike {
  status: Status;
  promql: string | null;
  rules: string[];
  assumptions: string[];
  findings: UpstreamFinding[];
  thresholds: { failed?: number; degraded?: number } | null;
  negated: boolean;
}

export type MonitorTranslator = (mq: MonitorQuery, thresholds: { critical?: number; warning?: number }) => MonitorTranslationLike;

/** T12's translateLogMonitor result, as T6 uses it: the monitor shape plus the group-by labels. */
export interface LogMonitorTranslationLike extends MonitorTranslationLike {
  groups: string[] | null;
}
/** T12's translateLogMonitor with its context bound: (query, {critical, warning, variables}) => translation. */
export type LogMonitorTranslator = (query: string, opts: { critical?: number; warning?: number; variables?: unknown[] }) => LogMonitorTranslationLike;

export interface AlertDeps {
  /** T4's translateMonitor with the translate context already bound: (mq, t) => translateMonitor(mq, t, ctx). */
  translateMonitor: MonitorTranslator;
  /** T12's log-monitor translator. Without it, "log alert" monitors stay manual (classify.monitor.other). */
  translateLogMonitor?: LogMonitorTranslator;
  /** Datadog tag key -> PromQL label (T1's tagLookup). Unmapped keys are sanitised. */
  tag?: (ddTag: string) => string | undefined;
  /** Datadog notification handle ("@slack-ops") -> existing Dash0 notification channel id (parseChannelMap). */
  channels?: (handle: string) => string | undefined;
  /** Emit a rule even when the item is manual, imported disabled for review (kb 06 §8 override). Default false. */
  keepManual?: boolean;
}

export interface AlertTranslation {
  /** "dd-monitor-<id>": the report item id. */
  itemId: string;
  /** Dash0 origin of the check rule ("dd-monitor-<id>", same as itemId), for PUT /api/alerting/check-rules/{origin}. The rule body carries the UUID id for POST /api/import/check-rule. */
  origin: string;
  status: Status;
  /** null when the monitor is manual (unless keepManual). Canonical key order, labels sorted. */
  rule: CheckRule | null;
  /** Catalog rule ids in order of application. */
  rules: string[];
  /** Catalog assumption ids. */
  assumptions: string[];
  epsilon: string[];
  findings: Finding[];
  /** Notification handles removed from the message (@slack-…), to recreate in Dash0 by hand. */
  /** Handles with no Dash0 channel in the channel map: recreate these by hand. */
  channels: string[];
}
