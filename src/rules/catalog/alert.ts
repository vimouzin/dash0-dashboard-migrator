// Monitor → Dash0 check rule: classify → (query stages) → monitor → alert → message. Plan 04 §2 (T6).
// Implemented in src/translate/alerts (T6). Behavioural options are claims about when the rule fires;
// notification options are not (A.notify-manual).
import type { RuleDef } from "../types.js";
import { section } from "./build.js";

const P04 = "plan 04 §2; docs/research/kb/06_TRANSLATION_RULES.md §8";
const classify = section("classify", "T6", "implemented", P04);
const alert = section("alert", "T6", "implemented", P04);
const alertPlan = section("alert", "T6", "planned", P04);
const msg = section("message", "T6", "implemented", "plan 04 §2.5");
const msgPlan = section("message", "T6", "planned", "plan 04 §2.5");

export const ALERT_RULES: RuleDef[] = [
  // ---------- classify ----------
  classify("classify.monitor.metric", 10, "exact", 'monitor type "metric alert" or "query alert"', "goes through the query stages and the monitor stage"),
  classify("classify.monitor.log", 20, "exact", 'monitor type "log alert", with the log-attribute table loaded', "goes through the logs stage (T12 translateLogMonitor: log.monitor.count, log.monitor.formula), then the shared alert and message stages", {
    note: "Without mappings/log-attributes.yaml, log alerts take classify.monitor.other.",
  }),
  classify("classify.monitor.other", 999, "manual", "composite, service check, event, synthetics, SLO, process, log alert without a log-attribute table, and any other monitor", "no rule; original kept", {
    fallback: true,
    findingCode: "monitor.type",
  }),

  // ---------- alert: identity and thresholds ----------
  alert("alert.id", 10, "exact", "monitor id", 'id = UUIDv5("datadog:monitor:<id>") in our fixed name space, so POST /api/import/check-rule upserts (live 2026-11-07, hub #289); origin "dd-monitor-<id>" for PUT by origin; label dd_monitor_id="<id>"'),
  alert("alert.name", 20, "exact", "monitor name", "name as is (template tokens in names are not expanded)"),
  alert("alert.threshold.both", 30, "exact", "critical (from the query) and warning thresholds", "thresholds {failed: critical, degraded: warning}"),
  alert("alert.threshold.critical", 40, "exact", "critical threshold only", "thresholds {failed: critical}"),
  alert("alert.threshold.recovery", 50, "manual", "critical_recovery / warning_recovery", "no output: value hysteresis has no Dash0 form (keep_firing_for is time-based)", {
    findingCode: "monitor.option",
    note: "Policy (kb 06 §8): never import a weaker active alert silently. keepManual emits it disabled for review.",
  }),
  alert("alert.group", 60, "exact", "multi-alert by {tags}", "grouping stays in the expression, one alert per series", {
    note: "Carried by T4's space.agg: the by-labels survive into the alert expression.",
  }),
  alert("alert.defaults", 70, "exact-under", "evaluation schedule", 'interval "1m", for "0s", keep_firing_for "0s"', { assumptions: ["A.eval-1m"] }),

  // ---------- alert: behavioural options ----------
  alert("alert.opt.evaluation_delay", 100, "exact", "options.evaluation_delay = s (whole seconds)", "the inner query is wrapped in timeshift(q, -s), so T4's map.timeshift puts offset s on every selector", {
    findingCode: "monitor.option",
    note: "Plan 04 had it as a warn-only finding; kb 06 §8 proposes the offset.",
  }),
  alert("alert.opt.require_full_window.true", 110, "exact-under", "require_full_window: true", "expression unchanged", { assumptions: ["A.full-window"], findingCode: "monitor.option" }),
  alert("alert.opt.require_full_window.false", 120, "exact", "require_full_window: false", "expression unchanged (PromQL evaluates partial windows)"),
  alert("alert.opt.new_group_delay", 130, "exact-under", "new_group_delay / new_host_delay > 0", "expression unchanged", { assumptions: ["A.no-new-groups"], findingCode: "monitor.option" }),
  alert("alert.opt.no_data.report", 140, "exact-under", "notify_no_data: true (with no_data_timeframe, timeout_h) or on_missing_data: show_no_data", "main rule unchanged; the no-data alert is listed in the report", {
    assumptions: ["A.no-data-manual"],
    findingCode: "monitor.option",
  }),
  alertPlan("alert.opt.no_data", 135, "exact-under", "notify_no_data + no_data_timeframe T, ungrouped monitor", 'companion rule absent_over_time(<selector>[T]), id "dd-monitor-<id>-nodata", behind a CLI flag', {
    assumptions: ["A.boundary"],
    findingCode: "monitor.option",
    note: "Replaces alert.opt.no_data.report for ungrouped monitors once built (needs the inner selector from T4).",
  }),
  alert("alert.opt.on_missing_data.resolve", 150, "exact", "on_missing_data: resolve", "expression unchanged: with no samples a PromQL comparison returns nothing, so the alert resolves"),

  // ---------- alert: notification and metadata options ----------
  alert("alert.opt.notification", 200, "exact-under", "renotify_*, escalation_message, notify_audit, include_tags, enable_logs_sample, groupby_simple_monitor, notification_preset_name, notify_by, locked, restricted_roles, silenced", "not emitted; listed in the report as manual setup", {
    assumptions: ["A.notify-manual"],
    findingCode: "monitor.option",
  }),
  alert("alert.priority", 210, "exact", "priority n (1-5)", 'label priority="P<n>"'),
  alert("alert.tags", 220, "exact", "tags k:v with valid label keys", "labels {k: v}; a tag without ':' becomes {tag: \"true\"}"),
  alert("alert.tags.rename", 230, "exact-under", "tags whose keys are not valid label names, clash with our labels, or repeat with several values", "key sanitised to [a-zA-Z_][a-zA-Z0-9_]* (dd_tag_ prefix on a clash), repeated values joined with ','", {
    assumptions: ["A.label-rename"],
  }),
  alert("alert.opt.unknown", 999, "manual", "any other option with a non-default value", "no output; option kept in the report", { fallback: true, findingCode: "monitor.option" }),

  // ---------- message ----------
  msg("alert.msg.summary", 10, "exact", "monitor name and message", "annotations {summary: name, description: rewritten message}"),
  msg("alert.msg.value", 20, "exact", "{{value}}", "{{ $value }} (negated rules carry a note: the value shown is negated)"),
  msg("alert.msg.threshold", 25, "exact", "{{threshold}} / {{warn_threshold}}", "the threshold number itself"),
  msg("alert.msg.label", 30, "exact", "{{<tag>.name}}", "{{ $labels.<label> }} through the tag mapping, then sanitised"),
  msgPlan("alert.msg.conditional.label", 40, "exact", "{{#is_alert}} / {{#is_warning}} / {{#is_recovery}} blocks", '{{ if eq $labels.<threshold> "failed" }} … {{ end }}', {
    requires: ["probe:threshold-label"],
  }),
  msg("alert.msg.conditional", 50, "exact-under", "{{#is_alert}} / {{#is_warning}} blocks (until probe:threshold-label is yes)", "markers removed, the block's text kept unconditionally", { assumptions: ["A.msg-conditional"] }),
  msg("alert.msg.conditional.drop", 55, "exact-under", "{{#is_recovery}}, {{#is_no_data}}, {{#is_renotify}}, {{^is_alert}} … blocks", "block removed (never part of a firing notification)", { assumptions: ["A.msg-recovery"] }),
  msg("alert.msg.handle", 60, "exact-under", "@slack-… / @pagerduty-… / @user@… handles with no entry in the channel file", "removed from the text, listed in the report as channels to create", { assumptions: ["A.notify-manual"] }),
  msg("alert.notify.channel", 61, "exact", "@handle in the main message, mapped in the channel file", 'annotation dash0.com/notification-channel-ids: "<channel id>"'),
  msg("alert.notify.channel.critical-only", 62, "exact", "@handle only inside {{#is_alert}}, mapped in the channel file", '"<channel id>:critical-only" (Dash0 sends this channel only critical = failed notifications)'),
  msg("alert.notify.channel.wider", 63, "exact-under", "@handle only inside {{#is_warning}} or a recovery section, mapped in the channel file", '"<channel id>": the channel gets every notification of the rule', { assumptions: ["A.notify-wider"] }),
  msg("alert.msg.truncate", 70, "exact-under", "description over 2048 or summary over 255 characters", "cut at the limit on a {{ … }} boundary, ending in …", { assumptions: ["A.msg-length"] }),
  msg("alert.msg.unknown-token", 999, "exact-under", "any other {{…}} token, and stray {{ / }} in text", 'escaped as a Go string literal {{ "{{token}}" }} so the template still parses', {
    assumptions: ["A.msg-verbatim"],
    fallback: true,
  }),
];
