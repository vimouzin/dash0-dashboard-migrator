// T6 unit tests with a stub T4, one assertion per catalog rule the alert stages implement.
import { describe, expect, it } from "vitest";
import type { MonitorQuery } from "../../src/parse/index.js";
import { CATALOG } from "../../src/rules/index.js";
import { CHANNEL_ANNOTATION, checkRuleId, checkRuleUuid, fitTemplate, labelName, NAMESPACE_DD2DASH0, parseChannelMap, rewriteMessage, translateAlert, uuidv5, type MonitorTranslationLike } from "../../src/translate/alerts/index.js";
import { fixtureMonitors, monitor } from "./alerts.helpers.js";
import { join } from "node:path";
import { loadLogAttributes, translateLogMonitor } from "../../src/translate/logs/index.js";

/** Stands in for T4's translateMonitor: records what it was given and answers like T4 does for > and <. */
function stubT4(over: Partial<MonitorTranslationLike> = {}) {
  const seen: MonitorQuery[] = [];
  const fn = (mq: MonitorQuery, t: { critical?: number; warning?: number }): MonitorTranslationLike => {
    seen.push(mq);
    const lt = mq.op === "<" || mq.op === "<=";
    const s = lt ? -1 : 1;
    return {
      status: "exact-under",
      promql: `${lt ? "-(" : ""}avg_over_time(x[5m:1m])${lt ? ")" : ""} > $__threshold`,
      rules: ["select.metric.mapped", "monitor.window", lt ? "monitor.cmp.lt" : "monitor.cmp.gt"],
      assumptions: ["A.boundary", "A.monitor-rollup-60s"],
      findings: [],
      thresholds: { failed: s * mq.threshold, ...(t.warning !== undefined && { degraded: s * t.warning }) },
      negated: lt,
      ...over,
    };
  };
  return { fn, seen };
}

const T = (over: Partial<MonitorTranslationLike> = {}) => stubT4(over).fn;

describe("T6: classify and parse", () => {
  it("non-metric monitors are manual with monitor.type (classify.monitor.other)", () => {
    const r = translateAlert(monitor({ type: "service check", query: '"http.can_connect".over("*").last(2).count_by_status()' }), { translateMonitor: T() });
    expect(r.status).toBe("manual");
    expect(r.rule).toBeNull();
    expect(r.findings[0]).toMatchObject({ code: "monitor.type", ruleId: "classify.monitor.other", original: "service check" });
  });

  it("an unparseable query is manual with the original kept (parse.error)", () => {
    const r = translateAlert(monitor({ query: "avg(last_5m):avg:foo{*} >>> 3" }), { translateMonitor: T() });
    expect(r.status).toBe("manual");
    expect(r.findings[0]).toMatchObject({ ruleId: "parse.error", code: "query.parse_error", original: "avg(last_5m):avg:foo{*} >>> 3" });
  });

  it("T4 returning no PromQL makes the item manual and keeps T4's findings", () => {
    const r = translateAlert(monitor({ query: "avg(last_5m):anomalies(avg:foo{*}, 'basic', 2) >= 1" }), {
      translateMonitor: T({ status: "manual", promql: null, thresholds: null, rules: [], findings: [{ severity: "unsupported", code: "fn.anomalies", message: "no rule" }] }),
    });
    expect(r.status).toBe("manual");
    expect(r.rule).toBeNull();
    expect(r.findings).toEqual([expect.objectContaining({ status: "manual", code: "fn.anomalies" })]);
  });
});

describe("T6: the check rule", () => {
  const base = monitor({ query: "avg(last_5m):avg:redis.mem.used{*} > 90", thresholds: { critical: 90, warning: 70 }, name: "[Redis] High memory" });

  it("has the canonical shape: UUIDv5 id, $__threshold, {failed, degraded}, defaults, disabled; origin dd-monitor-<id>", () => {
    const r = translateAlert(base, { translateMonitor: T() });
    expect(r.origin).toBe("dd-monitor-12345");
    expect(r.rule!.id).toBe(checkRuleUuid("12345"));
    expect(r.rule).toEqual({
      id: checkRuleUuid("12345"),
      name: "[Redis] High memory",
      expression: "avg_over_time(x[5m:1m]) > $__threshold",
      thresholds: { degraded: 70, failed: 90 },
      interval: "1m",
      for: "0s",
      keep_firing_for: "0s",
      labels: { dd_monitor_id: "12345" },
      annotations: { description: "", summary: "[Redis] High memory" },
      enabled: false,
    });
    expect(Object.keys(r.rule!)).toEqual(["id", "name", "expression", "thresholds", "interval", "for", "keep_firing_for", "labels", "annotations", "enabled"]);
    expect(r.rules).toEqual(expect.arrayContaining(["classify.monitor.metric", "monitor.window", "monitor.cmp.gt", "alert.threshold.both", "alert.id", "alert.defaults", "emit.rules-disabled"]));
    expect(r.status).toBe("exact-under");
    expect(r.assumptions).toEqual(["A.boundary", "A.eval-1m", "A.monitor-rollup-60s"]);
  });

  it("critical only → alert.threshold.critical", () => {
    const r = translateAlert({ ...base, thresholds: { critical: 90 } }, { translateMonitor: T() });
    expect(r.rule!.thresholds).toEqual({ failed: 90 });
    expect(r.rules).toContain("alert.threshold.critical");
  });

  it("< monitors keep T4's negation and say so in the description", () => {
    const r = translateAlert(monitor({ query: "avg(last_5m):avg:disk.free{*} < 10", thresholds: { critical: 10, warning: 20 } }), { translateMonitor: T() });
    expect(r.rule!.thresholds).toEqual({ degraded: -20, failed: -10 });
    expect(r.rule!.annotations!.description).toMatch(/shown negated/);
  });

  it("recovery thresholds make it manual (alert.threshold.recovery); keepManual still emits it disabled", () => {
    const m = { ...base, thresholds: { critical: 90, criticalRecovery: 80 } };
    const r = translateAlert(m, { translateMonitor: T() });
    expect(r.status).toBe("manual");
    expect(r.rule).toBeNull();
    expect(r.findings.some((f) => f.ruleId === "alert.threshold.recovery" && f.code === "monitor.option")).toBe(true);
    const k = translateAlert(m, { translateMonitor: T(), keepManual: true });
    expect(k.rule!.enabled).toBe(false);
  });

  it("ids follow T7's id rule", () => {
    expect(checkRuleId("redisdb__high_mem")).toBe("dd-monitor-redisdb-high-mem");
    expect(checkRuleId("12345")).toBe("dd-monitor-12345");
    expect(checkRuleId("__")).toBe("dd-monitor-unnamed");
    expect(checkRuleId("x".repeat(300))).toMatch(/^[a-z0-9][a-z0-9-]{0,127}$/);
  });
});

describe("T6: options, each one a rule or a finding", () => {
  const q = "avg(last_5m):avg:foo{*} by {host} > 1";
  const run = (options: Record<string, unknown>) => {
    const s = stubT4();
    return { r: translateAlert(monitor({ query: q, thresholds: { critical: 1 }, options }), { translateMonitor: s.fn }), seen: s.seen };
  };

  it("evaluation_delay wraps the query in timeshift(q, -s) before T4 (alert.opt.evaluation_delay)", () => {
    const { r, seen } = run({ evaluation_delay: 300 });
    const inner = seen[0]!.query;
    expect(inner).toMatchObject({ type: "call", name: "timeshift" });
    expect(inner.type === "call" && inner.args[1]?.type === "expr" && inner.args[1].expr).toMatchObject({ type: "number", value: -300 });
    expect(r.rules).toContain("alert.opt.evaluation_delay");
    expect(r.findings.some((f) => f.ruleId === "alert.opt.evaluation_delay")).toBe(false); // exact: no finding
  });

  it("require_full_window, new_host_delay, notify_no_data, notification options → their rules and assumptions", () => {
    const { r } = run({ require_full_window: true, new_host_delay: 300, notify_no_data: true, no_data_timeframe: 10, renotify_interval: 60, include_tags: true, notify_audit: false });
    expect(r.rules).toEqual(expect.arrayContaining(["alert.opt.require_full_window.true", "alert.opt.new_group_delay", "alert.opt.no_data.report", "alert.opt.notification"]));
    expect(r.assumptions).toEqual(expect.arrayContaining(["A.full-window", "A.no-new-groups", "A.no-data-manual", "A.notify-manual"]));
    expect(r.status).toBe("exact-under");
    expect(r.findings.filter((f) => f.ruleId === "alert.opt.notification").map((f) => f.original)).toEqual(["include_tags: true", "renotify_interval: 60"]);
  });

  it("options at their default value apply no rule", () => {
    const { r } = run({ notify_no_data: false, renotify_interval: 0, escalation_message: "", no_data_timeframe: null, timeout_h: 0, evaluation_delay: 0, locked: false });
    expect(r.rules.filter((x) => x.startsWith("alert.opt."))).toEqual([]);
    expect(r.findings.filter((f) => f.ruleId?.startsWith("alert.opt."))).toEqual([]);
  });

  it("on_missing_data: resolve is exact; unknown options are manual (alert.opt.unknown)", () => {
    expect(run({ on_missing_data: "resolve" }).r.rules).toContain("alert.opt.on_missing_data.resolve");
    const { r } = run({ threshold_windows: { trigger_window: "last_15m" } });
    expect(r.status).toBe("manual");
    expect(r.findings[0]).toMatchObject({ ruleId: "alert.opt.unknown", code: "monitor.option" });
    expect(r.findings[0]!.original).toMatch(/^threshold_windows: /);
  });

  it("grouped monitors record alert.group", () => {
    expect(run({}).r.rules).toContain("alert.group");
  });
});

describe("T6: labels", () => {
  it("tags become sorted labels; renames and clashes are reported (alert.tags, alert.tags.rename)", () => {
    const r = translateAlert(
      monitor({ query: "avg(last_5m):avg:foo{*} > 1", thresholds: { critical: 1 }, tags: ["team:db", "integration:redisdb", "service.name:api", "priority:high", "team:ops", "critical"], original: { priority: 2 } }),
      { translateMonitor: T() },
    );
    expect(r.rule!.labels).toEqual({
      critical: "true",
      dd_monitor_id: "12345",
      dd_tag_priority: "high",
      integration: "redisdb",
      priority: "P2",
      service_name: "api",
      team: "db,ops",
    });
    expect(Object.keys(r.rule!.labels!)).toEqual([...Object.keys(r.rule!.labels!)].sort());
    expect(r.rules).toEqual(expect.arrayContaining(["alert.tags", "alert.tags.rename", "alert.priority"]));
    expect(labelName("9lives")).toBe("_9lives");
    expect(labelName("__x")).toBe("dd__x");
  });
});

describe("T6: message → annotations", () => {
  const ctx = { label: (k: string) => labelName(({ host: "host.name" } as Record<string, string>)[k] ?? k), critical: 90, warning: 70 };

  it("rewrites {{value}}, {{threshold}}, {{tag.name}}; keeps firing sections; drops recovery sections", () => {
    const m = rewriteMessage(
      "{{#is_alert}}Memory {{value}} > {{threshold}} on {{host.name}}{{/is_alert}}\n{{#is_warning}}warn at {{warn_threshold}}{{/is_warning}}\n{{#is_recovery}}All good{{/is_recovery}}\n{{^is_alert}}not alerting{{/is_alert}}",
      ctx,
    );
    expect(m.text).toBe("Memory {{ $value }} > 90 on {{ $labels.host_name }}\nwarn at 70");
    expect(m.rules).toEqual(["alert.msg.conditional", "alert.msg.value", "alert.msg.threshold", "alert.msg.label", "alert.msg.conditional.drop"]);
    expect(m.dropped).toEqual(["#is_recovery", "^is_alert"]);
  });

  it("strips @handles into channels; escapes unknown tokens and stray braces so the Go template parses", () => {
    const m = rewriteMessage("Disk full @slack-ops-alerts @pagerduty-db\nSee {{event.title}} and {{#is_match \"env\" \"prod\"}}prod{{/is_match}} }} done. Mail ops@example.com", ctx);
    expect(m.channels).toEqual(["@slack-ops-alerts", "@pagerduty-db"]);
    expect(m.text).not.toMatch(/@slack|@pagerduty/);
    expect(m.text).toContain("ops@example.com"); // an e-mail inside a word is text, not a handle
    expect(m.text).toContain('{{ "{{event.title}}" }}');
    expect(m.text).toContain('{{ "}}" }}');
    expect(m.rules).toEqual(expect.arrayContaining(["alert.msg.unknown-token", "alert.msg.handle"]));
    // Every {{ opens an action that is either $value/$labels.x or a string literal: what Go's text/template accepts.
    for (const action of m.text.match(/\{\{.*?\}\}(?!")/g) ?? []) expect(action).toMatch(/^\{\{ (\$value|\$labels\.[A-Za-z_][A-Za-z0-9_]*|".*") \}\}$/);
  });
});

describe("T6: fixtures and the catalog", () => {
  it("every fixture monitor gives a rule or a manual result with a finding, never a crash or a silent drop", () => {
    for (const { name, alert } of fixtureMonitors()) {
      const r = translateAlert(alert, { translateMonitor: T() });
      expect(r.status === "manual" ? r.rule === null && r.findings.length > 0 : r.rule !== null, name).toBe(true);
      if (r.status !== "exact") expect(r.findings.length + r.assumptions.length, name).toBeGreaterThan(0);
    }
  });

  it("is deterministic: same input, same output", () => {
    for (const { alert } of fixtureMonitors()) expect(JSON.stringify(translateAlert(alert, { translateMonitor: T() }))).toBe(JSON.stringify(translateAlert(alert, { translateMonitor: T() })));
  });

  it("every rule id T6 applies is a catalog row, and every implemented T6 row is exercised by these tests", () => {
    const used = new Set<string>();
    const s = stubT4();
    const all = [
      ...fixtureMonitors().map((f) => f.alert),
      monitor({ query: "avg(last_5m):avg:foo{*} by {host} < 1", thresholds: { critical: 1, criticalRecovery: 2 }, tags: ["a:b", "a.b:c"], original: { priority: 1 }, message: "{{#is_alert}}{{value}} {{threshold}} {{host.name}} {{x}}{{/is_alert}}{{#is_recovery}}ok{{/is_recovery}} @slack-x", options: { evaluation_delay: 60, require_full_window: false, on_missing_data: "resolve", new_group_delay: 60, notify_no_data: true, renotify_interval: 5, weird: 1 } }),
      monitor({ type: "event alert", query: "events('x').rollup('count').last('5m') > 1" }),
      monitor({ query: "nope(" }),
    ];
    const channels = parseChannelMap('channels:\n  "@slack-x": c-all\n  "@pagerduty-db": c-crit\n  "@slack-warn": c-warn\n');
    for (const a of all) for (const id of translateAlert(a, { translateMonitor: s.fn, keepManual: true }).rules) used.add(id);
    const withChannels = monitor({ query: "avg(last_5m):avg:foo{*} > 1", thresholds: { critical: 1, warning: 0.5 }, message: "@slack-x {{#is_alert}}@pagerduty-db{{/is_alert}}{{#is_warning}}@slack-warn{{/is_warning}} " + "x".repeat(3000), name: "n".repeat(300) });
    for (const id of translateAlert(withChannels, { translateMonitor: s.fn, channels }).rules) used.add(id);
    const attributes = loadLogAttributes(join(import.meta.dirname, "..", "..", "mappings", "log-attributes.yaml"));
    const logAlert = monitor({ type: "log alert", query: 'logs("service:web").index("*").rollup("count").by("host").last("5m") > 1', thresholds: { critical: 1 } });
    for (const id of translateAlert(logAlert, { translateMonitor: s.fn, translateLogMonitor: (q, t) => translateLogMonitor(q, t, { attributes }) }).rules) used.add(id);
    const ids = new Set(CATALOG.map((r) => r.id));
    for (const id of used) expect(ids.has(id), id).toBe(true);
    const t6 = CATALOG.filter((r) => r.owner === "T6" && r.state === "implemented").map((r) => r.id);
    expect(t6.filter((id) => !used.has(id))).toEqual([]);
  });
});

describe("T6 as T8's AlertConverter", () => {
  it("passes the T4 context through and returns T8's AlertConversion shape", async () => {
    const { makeAlertConverter } = await import("../../src/translate/alerts/index.js");
    const seenCtx: unknown[] = [];
    const s = stubT4();
    const convert = makeAlertConverter((mq, t, ctx: { tag?: (k: string) => string | undefined; where?: string }) => {
      seenCtx.push(ctx);
      return s.fn(mq, t);
    });
    const ctx = { tag: (k: string) => (k === "host" ? "host_name" : undefined), where: "x" };
    const out = convert(monitor({ query: "avg(last_5m):avg:foo{*} > 1", thresholds: { critical: 1 }, message: "on {{host.name}}" }), ctx);
    expect(seenCtx).toEqual([ctx]);
    expect(out.promql).toBe(out.rule!.expression);
    expect(Object.keys(out).sort()).toEqual(["assumptions", "channels", "epsilon", "findings", "origin", "promql", "rule", "rules", "status"]);
    expect(out.origin).toBe("dd-monitor-12345");
    expect(out.rule!.annotations!.description).toBe("on {{ $labels.host_name }}");
  });
});

describe("T6: check-rule ids for POST /api/import/check-rule", () => {
  it("uuidv5 follows RFC 4122 (Appendix B example) and our name space is pinned", () => {
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    expect(uuidv5("https://github.com/vimouzin/dash0-dashboard-migrator", "6ba7b811-9dad-11d1-80b4-00c04fd430c8")).toBe(NAMESPACE_DD2DASH0);
  });

  it("same monitor, same id; different monitors, different ids; valid version-5 UUIDs that also pass T7's id rule", () => {
    const a = checkRuleUuid("130187664");
    expect(checkRuleUuid("130187664")).toBe(a);
    expect(checkRuleUuid("130187665")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).toMatch(/^[a-z0-9][a-z0-9-]{0,127}$/);
  });
});

describe("T6: notification channels (brief p.7) and Dash0 annotation limits", () => {
  const channels = parseChannelMap('# handle -> Dash0 channel id\nchannels:\n  "@slack-ops": ch-ops\n  pagerduty-db: ch-pd\n  "@slack-warn": ch-warn\n');
  const base = { query: "avg(last_5m):avg:foo{*} > 90", thresholds: { critical: 90, warning: 70 } };

  it("binds mapped handles: main message -> all notifications, is_alert only -> :critical-only", () => {
    const r = translateAlert(monitor({ ...base, message: "Memory high @slack-ops\n{{#is_alert}}Page now @pagerduty-db{{/is_alert}}" }), { translateMonitor: T(), channels });
    expect(r.rule!.annotations![CHANNEL_ANNOTATION]).toBe("ch-ops,ch-pd:critical-only");
    expect(r.rules).toEqual(expect.arrayContaining(["alert.notify.channel", "alert.notify.channel.critical-only"]));
    expect(r.rules).not.toContain("alert.msg.handle");
    expect(r.channels).toEqual([]);
    expect(r.rule!.annotations!.description).not.toMatch(/@slack|@pagerduty/);
  });

  it("a handle used only for warnings binds for all notifications, with a finding (alert.notify.channel.wider)", () => {
    const r = translateAlert(monitor({ ...base, message: "{{#is_warning}}heads up @slack-warn{{/is_warning}}" }), { translateMonitor: T(), channels });
    expect(r.rule!.annotations![CHANNEL_ANNOTATION]).toBe("ch-warn");
    expect(r.findings.some((f) => f.ruleId === "alert.notify.channel.wider" && f.original === "@slack-warn")).toBe(true);
    expect(r.assumptions).toContain("A.notify-wider");
  });

  it("unmapped handles stay manual (alert.msg.handle) and no annotation is invented", () => {
    const r = translateAlert(monitor({ ...base, message: "@opsgenie-team and @slack-ops" }), { translateMonitor: T(), channels });
    expect(r.channels).toEqual(["@opsgenie-team"]);
    expect(r.rule!.annotations![CHANNEL_ANNOTATION]).toBe("ch-ops");
    expect(r.findings.find((f) => f.ruleId === "alert.msg.handle")!.original).toBe("@opsgenie-team");
    const none = translateAlert(monitor({ ...base, message: "@slack-ops" }), { translateMonitor: T() });
    expect(none.rule!.annotations).not.toHaveProperty(CHANNEL_ANNOTATION);
    expect(none.channels).toEqual(["@slack-ops"]);
  });

  it("parseChannelMap rejects malformed files instead of dropping channels", () => {
    expect(() => parseChannelMap("channels:\n  - a\n")).toThrow(/map/);
    expect(() => parseChannelMap('channels:\n  "@x": ""\n')).toThrow(/channel id/);
    expect(parseChannelMap("")("@x")).toBeUndefined();
  });

  it("fits Dash0's limits without splitting a {{ }} action (alert.msg.truncate)", () => {
    const long = "a".repeat(2040) + " {{ $value }} tail";
    const f = fitTemplate(long, 2048);
    expect(f.cut).toBe(true);
    expect(f.text.length).toBeLessThanOrEqual(2048);
    expect(f.text).not.toMatch(/\{\{[^}]*$/);
    expect(fitTemplate("short", 2048)).toEqual({ text: "short", cut: false });
    const r = translateAlert(monitor({ ...base, name: "N".repeat(300), message: "m".repeat(5000) }), { translateMonitor: T() });
    expect(r.rule!.annotations!.summary!.length).toBeLessThanOrEqual(255);
    expect(r.rule!.annotations!.description!.length).toBeLessThanOrEqual(2048);
    expect(r.findings.filter((x) => x.ruleId === "alert.msg.truncate").map((x) => x.original)).toEqual(["description: 5000 characters", "summary: 300 characters"]);
  });
});
