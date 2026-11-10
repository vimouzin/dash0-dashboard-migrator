// T6: IR Alert (Datadog monitor) -> Dash0 check rule. Plan 04 §2; the rules are catalog rows (src/rules, stages
// classify / monitor / alert / message). Pure: no I/O, no clock. Every option is either a rule or a finding.
import type { Alert, Finding, Status } from "../../ir/index.js";
import { parseMonitorQuery, type Expr, type MonitorQuery, type Span } from "../../parse/index.js";
import { ASSUMPTIONS, CATALOG, compose, findingFor, hasRule, rule, type AssumptionId } from "../../rules/index.js";
import { CHANNEL_ANNOTATION } from "./channels.js";
import { fitTemplate, rewriteMessage } from "./message.js";
import { checkRuleUuid } from "./uuid.js";
import type { AlertDeps, AlertTranslation, CheckRule, UpstreamFinding } from "./types.js";

const METRIC_TYPES = new Set(["metric alert", "query alert"]);

/** Options that only shape notifications or permissions, never when the rule fires. */
const NOTIFICATION_OPTIONS = new Set([
  "renotify_interval",
  "renotify_occurrences",
  "renotify_statuses",
  "escalation_message",
  "notify_audit",
  "include_tags",
  "enable_logs_sample",
  "groupby_simple_monitor",
  "notification_preset_name",
  "groupby_simple_monitor",
  "notify_by",
  "locked",
  "restricted_roles",
  "silenced",
  "enable_logs_sample",
  "enable_samples",
]);

/** No value: the option is at Datadog's default and changes nothing. */
function inert(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** T7's id rule: ^[a-z0-9][a-z0-9-]{0,127}$. */
export function checkRuleId(sourceId: string): string {
  const s = sourceId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `dd-monitor-${s || "unnamed"}`.slice(0, 128).replace(/-$/, "");
}

/** Prometheus label name: [a-zA-Z_][a-zA-Z0-9_]*, and not the reserved __ prefix. */
export function labelName(key: string): string {
  let k = key.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(k)) k = `_${k}`;
  if (k.startsWith("__")) k = `dd${k}`;
  return k;
}

const OWN_LABELS = new Set(["dd_monitor_id", "priority"]);

function wrapTimeshift(mq: MonitorQuery, seconds: number): MonitorQuery {
  const span: Span = mq.query.span;
  const shift: Expr = { type: "number", value: -seconds, raw: String(-seconds), span };
  return {
    ...mq,
    query: { type: "call", name: "timeshift", args: [{ type: "expr", expr: mq.query, span }, { type: "expr", expr: shift, span }], span },
  };
}

/** True when any metric in the query groups by tags: one alert per series (multi-alert). */
function grouped(e: Expr): boolean {
  switch (e.type) {
    case "metric":
      return e.groupBy.length > 0;
    case "call":
      return e.args.some((a) => a.type === "expr" && grouped(a.expr));
    case "postfix":
      return grouped(e.target);
    case "binary":
      return grouped(e.left) || grouped(e.right);
    case "neg":
    case "paren":
      return grouped(e.expr);
    default:
      return false;
  }
}

function priorityOf(original: unknown): number | undefined {
  const o = original as { priority?: unknown; definition?: { priority?: unknown } } | null;
  const p = o?.priority ?? o?.definition?.priority;
  const n = typeof p === "string" ? Number(p) : p;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

export function translateAlert(alert: Alert, deps: AlertDeps): AlertTranslation {
  const itemId = checkRuleId(alert.source.id);
  const applied: string[] = [];
  const extra = new Set<AssumptionId>();
  const findings: Finding[] = [];
  const at = (original?: string, message?: string) => ({
    itemKind: "alert" as const,
    itemId,
    ...(message !== undefined && { message }),
    ...(original !== undefined && { original }),
  });
  const apply = (id: string, original?: string, message?: string) => {
    if (!applied.includes(id)) applied.push(id);
    const f = findingFor(id, at(original, message));
    if (f && !findings.some((x) => x.code === f.code && x.ruleId === f.ruleId && x.original === f.original)) findings.push(f);
  };
  let forcedManual = false;
  const manual = (id: string, original?: string, message?: string) => {
    forcedManual = true;
    if (!applied.includes(id)) applied.push(id);
    findings.push({ status: "manual", code: rule(id).findingCode ?? id, message: message ?? `${rule(id).match}: ${rule(id).emit}`, itemKind: "alert", itemId, ruleId: id, ...(original !== undefined && { original }) });
  };
  const result = (ruleOut: CheckRule | null, channels: string[] = []): AlertTranslation => {
    const c = compose(applied, extra);
    const status: Status = forcedManual ? "manual" : c.status;
    const emit = ruleOut && (status !== "manual" || deps.keepManual) ? ruleOut : null;
    return { itemId, origin: itemId, status, rule: emit, rules: c.rules, assumptions: c.assumptions, epsilon: c.epsilon, findings, channels };
  };

  // ---------- classify ----------
  // Log alerts go through T12 (logs stage) instead of T3/T4; everything after the monitor query is shared.
  const isLog = alert.type === "log alert" && deps.translateLogMonitor !== undefined;
  if (!METRIC_TYPES.has(alert.type) && !isLog) {
    const why = alert.type === "log alert" ? " (no log-attribute table loaded, so T12 can't translate it)" : " yet";
    manual("classify.monitor.other", alert.type, `monitor type "${alert.type}" has no check-rule translation${why}`);
    return result(null);
  }
  apply(isLog ? "classify.monitor.log" : "classify.monitor.metric");

  // ---------- parse (metric monitors; T12 parses log monitor queries itself) ----------
  let mq: MonitorQuery | null = null;
  if (!isLog) {
    const parsed = parseMonitorQuery(alert.query);
    if (!parsed.ok) {
      manual("parse.error", alert.query, `monitor query does not parse: ${parsed.error.message} at ${parsed.error.pos}`);
      return result(null);
    }
    mq = parsed.value;
  }

  // ---------- options (sorted, so the order of findings is stable) ----------
  const opts = alert.options;
  const has = (k: string) => k in opts && !inert(opts[k]);
  for (const key of Object.keys(opts).sort()) {
    const v = opts[key];
    const show = `${key}: ${JSON.stringify(v)}`;
    if (key === "evaluation_delay") {
      if (inert(v)) continue;
      if (isLog || !mq) manual("alert.opt.unknown", show, "evaluation_delay on a log monitor has no rule yet (the dash0.logs translation has no offset)");
      else if (typeof v === "number" && Number.isInteger(v) && v > 0) {
        mq = wrapTimeshift(mq, v);
        apply("alert.opt.evaluation_delay", show);
      } else manual("alert.opt.unknown", show, `evaluation_delay ${JSON.stringify(v)} is not a whole number of seconds`);
    } else if (key === "require_full_window") {
      apply(v === true ? "alert.opt.require_full_window.true" : "alert.opt.require_full_window.false", v === true ? show : undefined);
    } else if (key === "new_group_delay" || key === "new_host_delay") {
      if (!inert(v)) apply("alert.opt.new_group_delay", show);
    } else if (key === "notify_no_data" || key === "no_data_timeframe" || key === "timeout_h") {
      // Reported once, under notify_no_data; the timeframe and auto-resolve only matter when it is on.
      if (key === "notify_no_data" && v === true) {
        const tf = opts.no_data_timeframe;
        apply("alert.opt.no_data.report", `notify_no_data: true, no_data_timeframe: ${JSON.stringify(tf ?? null)}`);
      } else if (key === "timeout_h" && !inert(v) && !has("notify_no_data")) apply("alert.opt.no_data.report", show);
    } else if (key === "on_missing_data") {
      if (v === "default" || inert(v)) continue;
      if (v === "resolve") apply("alert.opt.on_missing_data.resolve", show);
      else if (v === "show_no_data" || v === "show_and_notify_no_data") apply("alert.opt.no_data.report", show);
      else manual("alert.opt.unknown", show);
    } else if (key === "variables" && isLog) {
      // The named log queries of a formula(...) log monitor: part of the query, translated by T12 below.
    } else if (NOTIFICATION_OPTIONS.has(key)) {
      if (!inert(v)) apply("alert.opt.notification", show);
    } else if (!inert(v)) manual("alert.opt.unknown", show, `monitor option ${key} has no rule`);
  }

  // ---------- thresholds ----------
  const t = alert.thresholds;
  if (t.criticalRecovery !== undefined || t.warningRecovery !== undefined)
    manual("alert.threshold.recovery", JSON.stringify({ critical_recovery: t.criticalRecovery, warning_recovery: t.warningRecovery }));

  // ---------- monitor query (T4) ----------
  const crit = { ...(t.critical !== undefined && { critical: t.critical }), ...(t.warning !== undefined && { warning: t.warning }) };
  const variables = Array.isArray(opts.variables) ? opts.variables : undefined;
  const lmt = isLog ? deps.translateLogMonitor!(alert.query, { ...crit, ...(variables && { variables }) }) : null;
  const mt = lmt ?? deps.translateMonitor(mq!, crit);
  for (const id of mt.rules) if (hasRule(id) && !applied.includes(id)) applied.push(id);
  for (const a of mt.assumptions) if (a.startsWith("A.")) extra.add(a as AssumptionId);
  for (const f of mt.findings) {
    const g = upstream(f, itemId, mt.status);
    if (g.ruleId && !applied.includes(g.ruleId)) applied.push(g.ruleId);
    findings.push(g);
  }
  if (mt.promql === null || mt.thresholds === null) {
    forcedManual = true;
    return result(null);
  }
  // The query always carries the critical threshold (T4 maps it to failed); warning is optional.
  apply(mt.thresholds.degraded !== undefined ? "alert.threshold.both" : "alert.threshold.critical");

  if (lmt ? (lmt.groups?.length ?? 0) > 0 : grouped(mq!.query)) apply("alert.group");

  // ---------- labels ----------
  apply("alert.id");
  apply("alert.name");
  const labels: Record<string, string> = { dd_monitor_id: alert.source.id };
  const prio = priorityOf(alert.original);
  if (prio !== undefined) {
    labels.priority = `P${prio}`;
    apply("alert.priority");
  }
  const tagValues = new Map<string, string[]>();
  for (const tag of [...alert.tags].sort()) {
    const i = tag.indexOf(":");
    const key = i < 0 ? tag : tag.slice(0, i);
    const value = i < 0 ? "true" : tag.slice(i + 1);
    let name = labelName(key);
    if (OWN_LABELS.has(name)) name = `dd_tag_${name}`;
    if (name !== key) apply("alert.tags.rename", tag, `tag key '${key}' becomes label '${name}'`);
    else apply("alert.tags");
    const vs = tagValues.get(name) ?? [];
    if (!vs.includes(value)) vs.push(value);
    tagValues.set(name, vs);
  }
  for (const [name, vs] of tagValues) {
    if (vs.length > 1) apply("alert.tags.rename", vs.join(","), `several values for label '${name}' are joined with ','`);
    labels[name] = [...vs].sort().join(",");
  }

  // ---------- message -> annotations ----------
  const label = (k: string) => labelName(deps.tag?.(k) ?? k);
  const msgCtx = { label, ...(t.critical !== undefined && { critical: t.critical }), ...(t.warning !== undefined && { warning: t.warning }) };
  const msg = rewriteMessage(alert.message, msgCtx);
  const summary = rewriteMessage(alert.name, msgCtx);
  apply("alert.msg.summary");
  // Handles: mapped ones bind a Dash0 channel (scope decides :critical-only); unmapped ones are listed for manual setup.
  const bindings: string[] = [];
  const unmapped: string[] = [];
  for (const handle of msg.channels) {
    const id = deps.channels?.(handle);
    if (!id) {
      unmapped.push(handle);
      continue;
    }
    const scopes = msg.handleScopes[handle] ?? ["always"];
    const all = scopes.includes("always") || (scopes.includes("alert") && scopes.includes("warning"));
    if (all) {
      apply("alert.notify.channel");
      bindings.push(id);
    } else if (scopes.length === 1 && scopes[0] === "alert") {
      apply("alert.notify.channel.critical-only");
      bindings.push(`${id}:critical-only`);
    } else {
      apply("alert.notify.channel.wider", handle, `${handle} is only used in ${scopes.join("/")} notifications in Datadog; in Dash0 the channel gets every notification of this rule`);
      bindings.push(id);
    }
  }
  for (const id of [...summary.rules, ...msg.rules]) {
    if (id === "alert.msg.handle" && unmapped.length === 0) continue; // every handle was bound to a channel
    const original =
      id === "alert.msg.unknown-token" ? [...summary.unknown, ...msg.unknown].join(" ") : id === "alert.msg.conditional.drop" ? msg.dropped.join(" ") : id === "alert.msg.handle" ? unmapped.join(" ") : undefined;
    apply(id, original);
  }
  let description = msg.text;
  if (mt.negated) description = `${description}\n\nNote: this rule negates the query to compare with $__threshold, so {{ $value }} is shown negated.`.trim();
  // Dash0 limits (OpenAPI): description 2048, summary 255 characters. Longer text would get the whole rule rejected.
  const fitD = fitTemplate(description, 2048);
  const fitS = fitTemplate(summary.text, 255);
  if (fitD.cut) apply("alert.msg.truncate", `description: ${description.length} characters`);
  if (fitS.cut) apply("alert.msg.truncate", `summary: ${summary.text.length} characters`);
  description = fitD.text;

  // ---------- defaults ----------
  apply("alert.defaults");
  apply("emit.rules-disabled");

  const ruleOut: CheckRule = {
    id: checkRuleUuid(alert.source.id),
    name: alert.name,
    expression: mt.promql,
    thresholds: { ...(mt.thresholds.degraded !== undefined && { degraded: mt.thresholds.degraded }), ...(mt.thresholds.failed !== undefined && { failed: mt.thresholds.failed }) },
    interval: "1m",
    for: "0s",
    keep_firing_for: "0s",
    labels: Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    annotations: {
      ...(bindings.length > 0 && { [CHANNEL_ANNOTATION]: [...new Set(bindings)].sort().join(",") }),
      description,
      summary: fitS.text,
    },
    enabled: false,
  };
  return result(ruleOut, unmapped);
}

/**
 * T4 finding -> CONTRACT-001 Finding. When the code is a catalog rule, the rule's claim is the finding's status
 * (and the caller adds the rule to the item's rules, so compose() sees it). Otherwise the translation's own status.
 */
function upstream(f: UpstreamFinding, itemId: string, translationStatus: Status): Finding {
  // T4's IR findings carry ruleId; older ones only a code, which is either a rule id or a rule's findingCode.
  const known =
    f.ruleId && hasRule(f.ruleId) ? rule(f.ruleId) : hasRule(f.code) ? rule(f.code) : CATALOG.find((r) => r.state === "implemented" && r.findingCode === f.code);
  let status: Status = known && known.status !== "exact" ? known.status : translationStatus === "exact" ? "exact-under" : translationStatus;
  if (f.severity === "error" || f.severity === "unsupported") status = "manual";
  return {
    status: status as Finding["status"],
    code: f.code,
    message: f.message,
    itemKind: "alert",
    itemId,
    ...(known && { ruleId: known.id }),
    ...(known && known.assumptions.length > 0 && { assumptions: known.assumptions.map((a) => ASSUMPTIONS[a]) }),
    ...(known?.epsilon !== undefined && { epsilon: known.epsilon }),
    ...(f.original !== undefined && { original: typeof f.original === "string" ? f.original : JSON.stringify(f.original) }),
  };
}
