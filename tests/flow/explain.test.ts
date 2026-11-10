// `dd2dash0 explain`: one query through the real engine, stage by stage.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { astTree, explain } from "../../src/flow/explain.js";
import { parseQuery } from "../../src/parse/index.js";
import { Ui } from "../../src/ui/style.js";

const MAPPINGS = join(import.meta.dirname, "..", "..", "mappings");
const run = (query: string) => {
  const out: string[] = [];
  const ui = new Ui({ write: (s) => void out.push(s), isTTY: false, columns: 100 }, { NO_COLOR: "1" });
  const code = explain({ query, mappingsDir: MAPPINGS, ui, version: "test", now: () => 0 });
  return { code, text: out.join("") };
};

describe("explain", () => {
  it("shows parse tree, mapping, rules with claims, validated PromQL and the claim's conditions", () => {
    const { code, text } = run("avg:redis.mem.used{env:prod} by {host}.rollup(avg, 60)");
    expect(code).toBe(0);
    expect(text).toContain("└─ .rollup(avg, 60)");
    expect(text).toMatch(/redis\.mem\.used → redis\.memory\.used\s+gauge · exact\s+mappings\/datadog\/redisdb\.yaml/);
    expect(text).toContain("tag host → host_name");
    expect(text).toMatch(/time\.rollup\.explicit\s+exact-under/);
    expect(text).toContain("lezer-promql) ✓");
    expect(text).toContain('avg by (host_name) (avg_over_time({otel_metric_name="redis.memory.used", deployment_environment_name="prod"}[1m]))');
    expect(text).toMatch(/Claim\s+exact-under/);
    expect(text).toMatch(/A\.align\s+PromQL evaluation step/);
  });

  it("explains a monitor, with its Dash0 thresholds", () => {
    const { code, text } = run("avg(last_5m):100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90");
    expect(code).toBe(0);
    expect(text).toContain("monitor  avg(last_5m) > 90");
    expect(text).toContain("> $__threshold");
    expect(text).toContain("failed > 90");
  });

  it("points at the exact position of a parse error and exits 3", () => {
    const { code, text } = run("avg:redis.mem.used{env:prod by {host}");
    expect(code).toBe(3);
    expect(text).toContain("not a Datadog query");
    expect(text).toMatch(/\n\s{4}\s{28}\^ expected '}'/);
  });

  it("draws the AST as a tree with the original scope text", () => {
    const p = parseQuery("sum:a.b{x:1,!y:2} by {h} / 2");
    if (!p.ok) throw new Error("parse");
    expect(astTree(p.value, "sum:a.b{x:1,!y:2} by {h} / 2")).toEqual(["└─ binary /", "   ├─ metric a.b", "   │  ├─ space agg: sum", "   │  ├─ scope: x:1,!y:2", "   │  └─ group by: h", "   └─ number 2"]);
  });
});
