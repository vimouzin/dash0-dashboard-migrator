import { describe, expect, it } from "vitest";
import { parseFormula, parseMonitorQuery, parseQuery, parseQueryList } from "../../src/parse/index.js";
import type { Expr, ParseResult } from "../../src/parse/index.js";

function ok<T>(r: ParseResult<T>): T {
  if (!r.ok) throw new Error(`${r.error.message} at ${r.error.pos} in ${r.error.source}`);
  return r.value;
}

/** Strip spans so structural assertions stay readable. */
function strip(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(strip);
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (k !== "span") o[k] = strip(v);
    return o;
  }
  return x;
}

describe("metric query", () => {
  it("parses agg, metric, scope, group by and postfix (plan 02 example)", () => {
    const e = ok(parseQuery("avg:redis.mem.used{$scope} by {host}.rollup(avg,60)"));
    expect(strip(e)).toEqual({
      type: "postfix",
      target: {
        type: "metric",
        spaceAgg: "avg",
        valueFilter: null,
        metric: "redis.mem.used",
        scope: { type: "var", name: "scope", field: null, negated: false },
        groupBy: ["host"],
      },
      call: {
        name: "rollup",
        args: [
          { type: "word", value: "avg" },
          { type: "expr", expr: { type: "number", value: 60, raw: "60" } },
        ],
      },
    });
  });

  it("records spans into the source", () => {
    const src = "sum:a.b{*} + max:c.d{*}";
    const e = ok(parseQuery(src));
    if (e.type !== "binary") throw new Error("expected binary");
    expect(src.slice(e.right.span.start, e.right.span.end)).toBe("max:c.d{*}");
  });

  it("parses the legacy form without aggregator or scope", () => {
    expect(strip(ok(parseQuery("riakcs.block_get.latency_mean{$scope}")))).toMatchObject({
      type: "metric",
      spaceAgg: null,
      metric: "riakcs.block_get.latency_mean",
    });
    const e = ok(parseQuery("sum:system.load.1.as_count()"));
    expect(strip(e)).toMatchObject({ type: "postfix", target: { metric: "system.load.1", scope: null } });
  });

  it("chains postfix calls in order", () => {
    const e = ok(parseQuery("sum:k.c{$a,$b} by {x}.as_count().fill(null)"));
    expect(e.type).toBe("postfix");
    if (e.type !== "postfix") return;
    expect(e.call.name).toBe("fill");
    expect(e.target.type === "postfix" && e.target.call.name).toBe("as_count");
  });

  it("accepts percentile and count aggregators, rejects unknown ones with position", () => {
    expect(ok(parseQuery("p99:req.latency{*}"))).toMatchObject({ spaceAgg: "p99" });
    expect(ok(parseQuery("count:req.latency{*}"))).toMatchObject({ spaceAgg: "count" });
    const r = parseQuery("median:req.latency{*}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.pos).toBe(0);
  });

  it("parses multi-tag group by with spaces", () => {
    expect(ok(parseQuery("sum:a{*} by {ecs_cluster, task_arn,ecs_service}"))).toMatchObject({
      groupBy: ["ecs_cluster", "task_arn", "ecs_service"],
    });
  });
});

describe("scope", () => {
  const scopeOf = (q: string) => {
    const e = ok(parseQuery(q));
    if (e.type !== "metric") throw new Error("expected metric");
    return strip(e.scope);
  };

  it("comma is AND; tags, negation, wildcards, bare tags", () => {
    expect(scopeOf("avg:m{env:prod,!host:a,-host:b,host:web-*,canary}")).toEqual({
      type: "and",
      items: [
        { type: "tag", key: "env", value: "prod", negated: false },
        { type: "tag", key: "host", value: "a", negated: true },
        { type: "tag", key: "host", value: "b", negated: true },
        { type: "tag", key: "host", value: "web-*", negated: false },
        { type: "tag", key: null, value: "canary", negated: false },
      ],
    });
  });

  it("star and template variables with .value", () => {
    expect(scopeOf("avg:m{*}")).toEqual({ type: "all" });
    expect(scopeOf("avg:m{$env.value}")).toEqual({ type: "var", name: "env", field: "value", negated: false });
  });

  it("boolean syntax: AND / OR / parens / IN / NOT IN / NOT", () => {
    expect(scopeOf("avg:m{(type:a OR type:b) AND $h}")).toEqual({
      type: "and",
      items: [
        {
          type: "or",
          items: [
            { type: "tag", key: "type", value: "a", negated: false },
            { type: "tag", key: "type", value: "b", negated: false },
          ],
        },
        { type: "var", name: "h", field: null, negated: false },
      ],
    });
    expect(scopeOf("avg:m{kind IN (helmchart,kustomization)}")).toEqual({
      type: "in",
      key: "kind",
      values: ["helmchart", "kustomization"],
      negated: false,
    });
    expect(scopeOf("avg:m{kind NOT IN (a, b)}")).toMatchObject({ type: "in", negated: true, values: ["a", "b"] });
    expect(scopeOf("avg:m{NOT env:dev}")).toEqual({
      type: "not",
      expr: { type: "tag", key: "env", value: "dev", negated: false },
    });
  });

  it("errors on empty scope with position", () => {
    const r = parseQuery("avg:m{}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.pos).toBe(6);
  });
});

describe("arithmetic and functions", () => {
  it("respects precedence and parentheses", () => {
    const e = ok(parseQuery("100 * sum:a{*} / (sum:a{*} + sum:b{*})"));
    expect(strip(e)).toMatchObject({
      type: "binary",
      op: "/",
      left: { type: "binary", op: "*", left: { type: "number", value: 100 } },
      right: { type: "paren", expr: { type: "binary", op: "+" } },
    });
  });

  it("parses wrapping functions with mixed args", () => {
    const e = ok(parseQuery("top(avg:a{*} by {host}, 10, 'mean', 'desc')"));
    expect(strip(e)).toMatchObject({
      type: "call",
      name: "top",
      args: [
        { type: "expr", expr: { type: "metric" } },
        { type: "expr", expr: { type: "number", value: 10 } },
        { type: "string", value: "mean" },
        { type: "string", value: "desc" },
      ],
    });
    expect(strip(ok(parseQuery("timeshift(avg:a{*}, -3600)")))).toMatchObject({
      args: [{}, { type: "expr", expr: { type: "neg", expr: { value: 3600 } } }],
    });
  });

  it("parses named arguments (anomalies)", () => {
    const e = ok(parseQuery("anomalies(avg:a{*}, 'basic', 2, direction='both', interval=120)"));
    expect(strip(e)).toMatchObject({
      args: [
        {},
        { type: "string", value: "basic" },
        {},
        { type: "named", name: "direction", value: { type: "string", value: "both" } },
        { type: "named", name: "interval", value: { type: "expr", expr: { value: 120 } } },
      ],
    });
  });

  it("legacy q may hold several comma-separated queries", () => {
    const list = ok(parseQueryList("sum:riak.node_gets{$scope},sum:riak.node_puts{$scope}"));
    expect(list.map((e: Expr) => e.type === "metric" && e.metric)).toEqual(["riak.node_gets", "riak.node_puts"]);
  });
});

describe("formula", () => {
  it("bare identifiers are query references", () => {
    expect(strip(ok(parseFormula("100 * query1 / (query1 + query2)")))).toMatchObject({
      type: "binary",
      left: { type: "binary", right: { type: "ref", name: "query1" } },
    });
    expect(strip(ok(parseFormula("per_minute(query1)")))).toEqual({
      type: "call",
      name: "per_minute",
      args: [{ type: "expr", expr: { type: "ref", name: "query1" } }],
    });
  });
});

describe("monitor query", () => {
  it("parses the canonical form", () => {
    const m = ok(parseMonitorQuery("avg(last_5m):avg:system.cpu.user{*} by {host} > 90"));
    expect(strip(m)).toMatchObject({
      timeAgg: "avg",
      window: "last_5m",
      windowSeconds: 300,
      change: null,
      op: ">",
      threshold: 90,
      query: { type: "metric", metric: "system.cpu.user", groupBy: ["host"] },
    });
  });

  it("parses change / pct_change with a compare window", () => {
    const m = ok(parseMonitorQuery("pct_change(sum(last_30m),last_5m):avg:t.c{code:4* OR code:5*}.as_count() > 10"));
    expect(m).toMatchObject({
      timeAgg: "sum",
      window: "last_30m",
      windowSeconds: 1800,
      change: { kind: "pct_change", compareWindow: "last_5m", compareWindowSeconds: 300 },
    });
  });

  it("parses arithmetic queries, ==, >=, and negative thresholds", () => {
    expect(ok(parseMonitorQuery("avg(last_5m):100 * avg:r.m.a{*} / avg:r.m.t{*} < 5"))).toMatchObject({ op: "<" });
    expect(ok(parseMonitorQuery("change(avg(last_5m),last_1d):avg:v.ts{*} == 0"))).toMatchObject({ op: "==" });
    expect(ok(parseMonitorQuery("min(last_1h):avg:a{*} <= -2.5"))).toMatchObject({ op: "<=", threshold: -2.5 });
    expect(ok(parseMonitorQuery("avg(last_1w):avg:a{*} >= 1"))).toMatchObject({ windowSeconds: 604800 });
  });

  it("reports the position of a missing comparator", () => {
    const src = "avg(last_5m):avg:a{*}";
    const r = parseMonitorQuery(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.pos).toBe(src.length);
  });

  it("parses current_ and next_ windows (calendar / forecast monitors)", () => {
    expect(ok(parseMonitorQuery("max(current_1h):avg:a{*} > 1"))).toMatchObject({ windowKind: "current", windowSeconds: 3600 });
    expect(ok(parseMonitorQuery("max(next_12h):forecast(avg:a{*}, 'linear', 1) >= 90"))).toMatchObject({
      windowKind: "next",
      query: { type: "call", name: "forecast" },
    });
  });

  it("rejects an unknown window", () => {
    const r = parseMonitorQuery("avg(prev_5m):avg:a{*} > 1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.pos).toBe(4);
  });

  it("parses re-aggregation with a tag-list argument", () => {
    const m = ok(
      parseMonitorQuery("max(last_5m):sum(max:s.r{role:primary} by {srv,ag}.rollup(max, 60), { ag }) > 1"),
    );
    expect(strip(m.query)).toMatchObject({ type: "call", name: "sum", args: [{ type: "expr" }, { type: "tags", tags: ["ag"] }] });
  });
});

describe("corpus edge cases", () => {
  const scopeOf = (q: string) => {
    const e = ok(parseQuery(q));
    if (e.type !== "metric") throw new Error("expected metric");
    return strip(e.scope);
  };

  it("template variable names with '-' and '.'; trailing .value is the field", () => {
    expect(scopeOf("avg:m{$availability-zone,$openai.user.api_key,$queue.value}")).toEqual({
      type: "and",
      items: [
        { type: "var", name: "availability-zone", field: null, negated: false },
        { type: "var", name: "openai.user.api_key", field: null, negated: false },
        { type: "var", name: "queue", field: "value", negated: false },
      ],
    });
  });

  it("lower-case boolean keywords and whitespace after '!'", () => {
    expect(scopeOf("avg:m{not a:b and (c:d or c:e)}")).toMatchObject({
      type: "and",
      items: [{ type: "not" }, { type: "or" }],
    });
    expect(scopeOf("avg:m{x:y, ! fstype:rootfs}")).toMatchObject({
      items: [{}, { type: "tag", key: "fstype", value: "rootfs", negated: true }],
    });
  });

  it("distribution value filter count(v: v>=0)", () => {
    expect(ok(parseQuery("count(v: v>=0):data_streams.latency{type:kafka} by {service}.as_rate()"))).toMatchObject({
      type: "postfix",
      target: { spaceAgg: "count", valueFilter: { op: ">=", value: 0 }, metric: "data_streams.latency" },
    });
  });

  it("unary plus is a no-op", () => {
    expect(strip(ok(parseQuery("+ avg:a{*}")))).toMatchObject({ type: "metric", metric: "a" });
  });
});

// Regressions from Amir's review of PR #1, numbered as in the review.
describe("PR #1 review", () => {
  const scopeOf = (q: string) => {
    const e = ok(parseQuery(q));
    if (e.type !== "metric") throw new Error("expected metric");
    return strip(e.scope);
  };

  it("1. tags starting with not/and/or followed by - . : stay tags", () => {
    expect(scopeOf("avg:m{not-ready}")).toEqual({ type: "tag", key: null, value: "not-ready", negated: false });
    expect(scopeOf("avg:m{env:prod,not.flag:1}")).toEqual({
      type: "and",
      items: [
        { type: "tag", key: "env", value: "prod", negated: false },
        { type: "tag", key: "not.flag", value: "1", negated: false },
      ],
    });
    expect(scopeOf("avg:m{and-x:1 OR or:2}")).toMatchObject({
      type: "or",
      items: [{ key: "and-x" }, { key: "or" }],
    });
    // The keywords themselves still work, also directly before '('.
    expect(scopeOf("avg:m{NOT(env:dev)}")).toMatchObject({ type: "not" });
    expect(scopeOf("avg:m{kind NOT IN (a,b)}")).toMatchObject({ type: "in", negated: true });
  });

  it("2. a formula ref followed by a postfix call stays a ref", () => {
    expect(strip(ok(parseFormula("query1.rollup(sum, 60)")))).toEqual({
      type: "postfix",
      target: { type: "ref", name: "query1" },
      call: { name: "rollup", args: [{ type: "word", value: "sum" }, { type: "expr", expr: { type: "number", value: 60, raw: "60" } }] },
    });
    expect(strip(ok(parseFormula("query1 .as_count()")))).toMatchObject({ target: { type: "ref", name: "query1" } });
  });

  it("3. a single-segment bare metric in a function argument is a query, not a word", () => {
    expect(strip(ok(parseQuery("abs(uptime)")))).toMatchObject({
      type: "call",
      args: [{ type: "expr", expr: { type: "metric", metric: "uptime", spaceAgg: null } }],
    });
    // Postfix args keep bare words.
    expect(strip(ok(parseQuery("avg:m{*}.fill(null)")))).toMatchObject({ call: { args: [{ type: "word", value: "null" }] } });
  });

  it("4. decimal percentile aggregators", () => {
    expect(ok(parseQuery("p99.9:latency{*}"))).toMatchObject({ spaceAgg: "p99.9", metric: "latency" });
  });

  it("5. deep nesting fails with a position instead of throwing", () => {
    for (const src of ["(".repeat(20000), "-".repeat(20000) + "1", "avg:m{" + "(".repeat(20000) + "a:b}"]) {
      const r = parseQuery(src);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/nesting deeper than|too complex/);
    }
  });

  it("6. signed thresholds with + and whitespace", () => {
    expect(ok(parseMonitorQuery("avg(last_5m):avg:a{*} > +5"))).toMatchObject({ threshold: 5 });
    expect(ok(parseMonitorQuery("avg(last_5m):avg:a{*} > - 5"))).toMatchObject({ threshold: -5 });
  });

  it("7. backslash escapes in string arguments", () => {
    expect(strip(ok(parseQuery("top(avg:a{*}, 10, 'it\\'s', \"a\\\\b\")")))).toMatchObject({
      args: [{}, {}, { type: "string", value: "it's" }, { type: "string", value: "a\\b" }],
    });
    expect(parseQuery("top(avg:a{*}, 'open").ok).toBe(false);
  });

  it("8. whitespace before a postfix call", () => {
    expect(strip(ok(parseQuery("avg:m{*} .as_count()")))).toMatchObject({ type: "postfix", call: { name: "as_count" } });
    expect(strip(ok(parseQuery("avg:m{*}.rollup (sum, 60)")))).toMatchObject({ type: "postfix", call: { name: "rollup" } });
  });
});
