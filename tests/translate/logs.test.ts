import { describe, expect, it } from "vitest";
import { parseLogSearch } from "../../src/parse/logsearch/index.js";
import { parseFormula, parseQuery } from "../../src/parse/index.js";
import { LOG_RULES, loadLogAttributes, logRef, translateLogMonitor, translateLogQuery } from "../../src/translate/logs/index.js";
import type { DatadogLogQuery, LogTranslateContext } from "../../src/translate/logs/index.js";
import { translateQuery } from "../../src/translate/query/index.js";
import type { FormulaEnv } from "../../src/translate/query/index.js";
import { validatePromQL } from "../../src/validate/promql.js";
import { CATALOG } from "../../src/rules/index.js";

const attributes = loadLogAttributes("mappings/log-attributes.yaml");
const CTX: LogTranslateContext = { attributes, variables: { Host: { tag: "host" }, User: { tag: "@usr.name" }, scope: { tag: null } } };
const L = (m = "") => `{otel_metric_name="dash0.logs"${m}}[$__interval]`;
const used = new Set<string>();
const lq = (search: string, extra: Partial<DatadogLogQuery> = {}) => {
  const r = translateLogQuery({ search: { query: search }, compute: { aggregation: "count" }, ...extra }, CTX);
  r.rules.forEach((x) => used.add(x));
  return r;
};

describe("log-search parser", () => {
  it("parses the corpus shapes", () => {
    for (const q of [
      "source:wazuh service:system @rule.groups:(sshd invalid_login) $Agent_Name",
      '@nvps.objecttype:"Request Response" -@entityName:"" $user_name',
      "@message_id:(101* OR 103*) $Host",
      "status:error (timeout OR refused) -@http.status_code:404",
      "@duration:>1000",
      "*",
      "",
    ])
      expect(parseLogSearch(q).ok, q).toBe(true);
  });
  it("reports a position on errors and never throws", () => {
    const r = parseLogSearch("source:x (unclosed");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.pos).toBeGreaterThan(0);
    expect(parseLogSearch("(".repeat(5000)).ok).toBe(false);
  });
});

/** [rule, search, extra, expected PromQL, status] */
const CASES: [string, string, Partial<DatadogLogQuery>, string, string][] = [
  ["log.count", "", {}, `sum (increase(${L()}))`, "exact-under"],
  ["log.match.reserved", "service:checkout host:web-1", {}, `sum (increase(${L(', host_name="web-1", service_name="checkout"')}))`, "exact-under"],
  ["log.match.reserved.approx", "source:redis", {}, `sum (increase(${L(', source="redis"')}))`, "exact-under"],
  ["log.match.attr", "@http.status_code:502 @db.system:postgresql", {}, `sum (increase(${L(', db_system_name="postgresql", http_status_code="502"')}))`, "exact-under"],
  ["log.match.value", "@evt.name:(login* OR logout) -@usr.id:* -@http.method:GET", {}, `sum (increase(${L(', evt_name=~"^(login.*|logout)$", http_method!="GET", usr_id=""')}))`, "exact-under"],
  ["log.match.status", "status:(error OR warn)", {}, `sum (increase(${L(', otel_log_severity_range=~"^(ERROR|WARN)$"')}))`, "exact-under"],
  ["log.match.status.approx", "status:critical", {}, `sum (increase(${L(', otel_log_severity_range="FATAL"')}))`, "exact-under"],
  ["log.match.text", 'timeout -"card declined"', {}, `sum (increase(${L(', otel_log_body!~"(?i).*card declined.*", otel_log_body=~"(?i).*timeout.*"')}))`, "exact-under"],
  ["log.match.var", "$Host -$User", {}, `sum (increase(${L(', host_name=~"^($Host)$", usr_name!~"^($User)$"')}))`, "exact-under"],
  ["log.match.var.dropped", "service:a $scope", {}, `sum (increase(${L(', service_name="a"')}))`, "exact-under"],
  ["log.group_by", "service:a", { group_by: [{ facet: "@usr.name" }, { facet: "status" }] }, `sum by (otel_log_severity_range, usr_name) (increase(${L(', service_name="a"')}))`, "exact-under"],
  ["log.group_by.limit", "service:a", { group_by: [{ facet: "@usr.name", limit: 10, sort: { order: "asc" } }] }, `bottomk(10, sum by (usr_name) (increase(${L(', service_name="a"')})))`, "exact-under"],
  ["log.group_by.multi-limit", "", { group_by: [{ facet: "host", limit: 5 }, { facet: "service", limit: 3 }] }, `sum by (host_name, service_name) (increase(${L()}))`, "exact-under"],
  ["log.group_by.exclude-missing", "", { group_by: { fields: ["@policy_name"], limit: 10, sort: { order: "desc" }, should_exclude_missing: true } }, `topk(10, sum by (policy_name) (increase(${L(', policy_name!=""')})))`, "exact-under"],
  ["log.cardinality", "service:a", { compute: { aggregation: "cardinality", metric: "@usr.id" }, group_by: [{ facet: "host" }] }, `count by (host_name) (sum by (host_name, usr_id) (increase(${L(', service_name="a"')})) > 0)`, "exact-under"],
  ["log.indexes", "", { indexes: ["main", "security"] }, `sum (increase(${L()}))`, "exact-under"],
  ["log.range.integer", "@http.status_code:>=500", {}, `sum (increase(${L(', http_status_code=~"^([5-9]\\\\d{2}|[1-9]\\\\d{3,})$"')}))`, "exact-under"],
  ["log.or.inclusion-exclusion", "service:a OR host:b", {}, `sum (increase(${L(', service_name="a"')})) + sum (increase(${L(', host_name="b"')})) - sum (increase(${L(', host_name="b", service_name="a"')}))`, "exact-under"],
];

describe("log queries: one exact PromQL string per rule", () => {
  for (const [rule, search, extra, promql, status] of CASES) {
    it(`${rule}: ${search || "(all logs)"}`, () => {
      const r = lq(search, extra);
      expect(r.findings.filter((f) => f.status === "manual")).toEqual([]);
      expect(r.promql).toBe(promql);
      expect(r.rules).toContain(rule);
      expect(r.status).toBe(status);
      expect(validatePromQL(r.promql!).ok).toBe(true);
    });
  }
});

describe("log queries: fail closed", () => {
  for (const [code, search, extra] of [
    ["log.measure", "service:a", { compute: { aggregation: "avg", metric: "@duration" } }],
    ["log.or.cross-key", "service:a OR host:b", { compute: { aggregation: "cardinality", metric: "@usr.id" } }],
    ["log.or.cross-key", "service:a OR host:b OR env:c OR @x:d", {}],
    ["log.range", "@duration:>1.5", {}],
    ["log.not.complex", "NOT (service:a host:b)", {}],
    ["log.status.unknown", "status:verbose", {}],
    ["log.search.parse", "source:x (unclosed", {}],
    ["log.group_by.shape", "", { group_by: "host" as never }],
  ] as const) {
    it(code, () => {
      const r = lq(search, extra as Partial<DatadogLogQuery>);
      expect(r).toMatchObject({ status: "manual", promql: null });
      expect(r.findings.some((f) => f.status === "manual" && f.code === code)).toBe(true);
    });
  }
});

describe("log monitors", () => {
  it("count over the window with Datadog's thresholds", () => {
    const r = translateLogMonitor('logs("source:nginx status:error").index("*").rollup("count").by("host").last("5m") > 10', { critical: 10, warning: 5 }, CTX);
    r.rules.forEach((x) => used.add(x));
    expect(r.promql).toBe(
      'sum by (host_name) (increase({otel_metric_name="dash0.logs", otel_log_severity_range="ERROR", source="nginx"}[5m])) > $__threshold',
    );
    expect(r).toMatchObject({ status: "bounded", thresholds: { failed: 10, degraded: 5 }, negated: false });
  });
  it("formula monitors combine their log queries over the window", () => {
    const vars = [
      { data_source: "logs", name: "query", compute: { aggregation: "count" }, search: { query: "service:api status:error" } },
      { data_source: "logs", name: "query1", compute: { aggregation: "count" }, search: { query: "service:api" } },
    ];
    const r = translateLogMonitor('formula("(query / query1) * 100").last("1h") > 10', { critical: 10, variables: vars }, CTX);
    r.rules.forEach((x) => used.add(x));
    expect(r.promql).toBe(
      'sum (increase({otel_metric_name="dash0.logs", otel_log_severity_range="ERROR", service_name="api"}[1h])) / sum (increase({otel_metric_name="dash0.logs", service_name="api"}[1h])) * 100 > $__threshold',
    );
    expect(r).toMatchObject({ status: "bounded", thresholds: { failed: 10 } });
    expect(r.rules).toContain("log.monitor.formula");
  });

  it("< is negated, and unknown shapes are manual", () => {
    const lt = translateLogMonitor('logs("service:api").index("*").rollup("count").last("15m") < 1', {}, CTX);
    expect(lt.promql).toBe('-sum (increase({otel_metric_name="dash0.logs", service_name="api"}[15m])) > $__threshold');
    expect(lt).toMatchObject({ thresholds: { failed: -1 }, negated: true });
    expect(translateLogMonitor('formula("query1 / query").last("1d") > 10', {}, CTX).status).toBe("manual");
    expect(translateLogMonitor('logs("x").rollup("avg", "@d").last("5m") > 1', {}, CTX).status).toBe("manual");
  });
});

describe("formulas mixing log and metric queries", () => {
  it("error ratio: log query / metric query", () => {
    const errors = translateLogQuery({ search: { query: "service:api status:error" }, compute: { aggregation: "count" } }, CTX);
    const p = parseQuery("sum:trace.http.request.hits{service:api}.as_count()");
    if (!p.ok) throw new Error();
    const env: FormulaEnv = new Map([["query1", logRef(errors)], ["query2", p.value]]);
    const f = parseFormula("100 * query1 / query2");
    if (!f.ok) throw new Error();
    const r = translateQuery(f.value, { ddKind: () => "count" }, env);
    expect(r.promql).toBe(
      `100 * sum (increase(${L(', otel_log_severity_range="ERROR", service_name="api"')})) / sum (increase({otel_metric_name="trace.http.request.hits", service="api"}[$__interval] anchored))`,
    );
    expect(r.status).toBe("exact-under");
    expect(r.rules).toEqual(expect.arrayContaining(["log.count", "time.unmapped.counter.anchored"]));
    expect(r.assumptions).toEqual(expect.arrayContaining(["A.log-count", "A.otel-counter"]));
  });
  it("a manual log query makes the formula manual", () => {
    const bad = translateLogQuery({ search: { query: "@x:>1.5" }, compute: { aggregation: "count" } }, CTX);
    const f = parseFormula("query1 * 2");
    if (!f.ok) throw new Error();
    expect(translateQuery(f.value, {}, new Map([["query1", logRef(bad)]]))).toMatchObject({ status: "manual", promql: null });
  });
});

describe("scalar form (interval $__range): query_value, top list, table", () => {
  const SCALAR: LogTranslateContext = { ...CTX, interval: "$__range" };
  const S = (m = "") => `{otel_metric_name="dash0.logs"${m}}[$__range]`;
  const sq = (search: string, extra: Partial<DatadogLogQuery> = {}) => {
    const r = translateLogQuery({ search: { query: search }, compute: { aggregation: "count" }, ...extra }, SCALAR);
    r.rules.forEach((x) => used.add(x));
    return r;
  };

  it("a count is taken over the whole range, not one chart step", () => {
    const r = sq("service:checkout status:error");
    expect(r.promql).toBe(`sum (increase(${S(', otel_log_severity_range="ERROR", service_name="checkout"')}))`);
    expect(r.rules).toContain("log.scalar.window");
    expect(r.status).toBe("exact-under");
    expect(r.assumptions).toEqual(expect.arrayContaining(["A.log-count", "A.log-range"]));
  });
  it("compute.interval (a time-series setting) is ignored for a scalar", () => {
    const r = sq("service:checkout", { compute: { aggregation: "count", interval: 300000 } });
    expect(r.promql).toBe(`sum (increase(${S(', service_name="checkout"')}))`);
    // ... but still applies to the time-series form of the same query
    const series = translateLogQuery({ search: { query: "service:checkout" }, compute: { aggregation: "count", interval: 300000 } }, CTX);
    expect(series.promql).toContain("[5m]");
    expect(series.rules).not.toContain("log.scalar.window");
  });
  it("cardinality counts distinct values over the whole range (Total Chargebacks)", () => {
    const r = sq("source:adyen @evt.name:CHARGEBACK", { compute: { aggregation: "cardinality", metric: "@pspReference" } });
    expect(r.promql).toBe(`count (sum by (pspReference) (increase(${S(', evt_name="CHARGEBACK", source="adyen"')})) > 0)`);
    expect(r.rules).toEqual(expect.arrayContaining(["log.cardinality", "log.scalar.window"]));
  });
  it("a top list ranks and counts over the same range", () => {
    const r = sq("service:a", { group_by: [{ facet: "@usr.name", limit: 10, sort: { order: "desc" } }] });
    expect(r.promql).toBe(`topk(10, sum by (usr_name) (increase(${S(', service_name="a"')})))`);
  });
  it("an OR across keys keeps the range in every term", () => {
    const r = sq("service:a OR host:b");
    expect(r.promql).toBe(`sum (increase(${S(', service_name="a"')})) + sum (increase(${S(', host_name="b"')})) - sum (increase(${S(', host_name="b", service_name="a"')}))`);
  });
  it("monitors keep their own window", () => {
    const m = translateLogMonitor('logs("service:a").index("*").rollup("count").last("5m") > 10', {}, SCALAR);
    expect(m.promql).toContain("[5m]");
    expect(m.promql).not.toContain("$__range");
    expect(m.rules).not.toContain("log.scalar.window");
  });
  it("a ratio of two scalar log counts is the ratio of the window totals", () => {
    const a = sq("service:api status:error");
    const b = sq("service:api");
    const f = parseFormula("100 * a / b");
    if (!f.ok) throw new Error();
    const r = translateQuery(f.value, {}, new Map([["a", logRef(a)], ["b", logRef(b)]]));
    expect(r.promql).toBe(`100 * sum (increase(${S(', otel_log_severity_range="ERROR", service_name="api"')})) / sum (increase(${S(', service_name="api"')}))`);
    expect(r.status).toBe("exact-under");
  });
  it("fails closed when a scalar log count meets a per-interval value (metric or time-series log)", () => {
    const a = sq("service:api status:error");
    const metric = parseQuery("sum:redis.net.commands{*}");
    if (!metric.ok) throw new Error();
    const f = parseFormula("a / b");
    if (!f.ok) throw new Error();
    for (const per of [metric.value, logRef(translateLogQuery({ search: { query: "service:api" }, compute: { aggregation: "count" } }, CTX))]) {
      for (const env of [new Map([["a", logRef(a)], ["b", per]]), new Map([["b", logRef(a)], ["a", per]])] as FormulaEnv[]) {
        const r = translateQuery(f.value, {}, env);
        expect(r).toMatchObject({ status: "manual", promql: null });
        expect(r.findings.some((x) => x.code === "log.scalar.mixed")).toBe(true);
      }
    }
  });
  it("the finding codes the scalar form raises resolve to catalog rows", () => {
    const codes = new Set(CATALOG.map((r) => r.findingCode ?? r.id));
    expect(codes.has("log.scalar.mixed")).toBe(true);
    expect(CATALOG.find((r) => r.id === "log.scalar.window")).toMatchObject({ status: "exact-under", state: "implemented" });
  });
  it("every emitted scalar query parses", () => {
    for (const s of ["", "service:a", "@http.status_code:>=500", "service:a OR host:b"]) {
      const r = sq(s);
      expect(validatePromQL(r.promql!).ok, r.promql!).toBe(true);
    }
  });
});

describe("coverage of the log rule table", () => {
  it("every log rule is exercised by a test above", () => {
    expect(Object.keys(LOG_RULES).filter((r) => !used.has(r))).toEqual([]);
  });
});
