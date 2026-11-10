// The axioms of plan 05, checked on the data. A catalog that breaks one cannot be merged.
import { describe, expect, it } from "vitest";
import { FINDING_CODES } from "../../src/ir/index.js";
import { ASSUMPTIONS, CATALOG, PROBES, STAGES, compose, findingFor, rule, stageRules } from "../../src/rules/index.js";

const ID = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;

describe("rule catalog: well-formed", () => {
  it("ids are unique and namespaced", () => {
    const ids = CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(ID);
  });

  it("every rule belongs to a known stage", () => {
    const stages = new Set(STAGES.map((s) => s.id));
    for (const r of CATALOG) expect(stages.has(r.stage), r.id).toBe(true);
  });

  it("priorities are unique inside a stage (D2: a fixed order)", () => {
    for (const s of STAGES) {
      const p = stageRules(s.id).map((r) => r.priority);
      expect(new Set(p).size, s.id).toBe(p.length);
    }
  });

  it("total stages have exactly one fallback, tried last (D1)", () => {
    for (const s of STAGES) {
      const rules = stageRules(s.id);
      const fb = rules.filter((r) => r.fallback);
      if (!s.total) {
        expect(fb, s.id).toHaveLength(0);
        continue;
      }
      expect(fb, s.id).toHaveLength(1);
      expect(rules[rules.length - 1]!.id, s.id).toBe(fb[0]!.id);
    }
  });
});

describe("rule catalog: claims (plan 03 §2)", () => {
  it("exact claims carry no assumptions and no ε", () => {
    for (const r of CATALOG.filter((r) => r.status === "exact")) {
      expect(r.assumptions, r.id).toEqual([]);
      expect(r.epsilon, r.id).toBeUndefined();
    }
  });

  it("exact-under claims name at least one assumption and no ε", () => {
    for (const r of CATALOG.filter((r) => r.status === "exact-under")) {
      expect(r.assumptions.length, r.id).toBeGreaterThan(0);
      expect(r.epsilon, r.id).toBeUndefined();
    }
  });

  it("bounded claims state ε", () => {
    for (const r of CATALOG.filter((r) => r.status === "bounded")) expect(r.epsilon, r.id).toBeTruthy();
  });

  it("manual rules claim nothing", () => {
    for (const r of CATALOG.filter((r) => r.status === "manual")) {
      expect(r.assumptions, r.id).toEqual([]);
      expect(r.epsilon, r.id).toBeUndefined();
    }
  });

  it("every assumption and probe referenced exists, and every one is used", () => {
    const usedA = new Set(CATALOG.flatMap((r) => r.assumptions));
    for (const a of usedA) expect(a in ASSUMPTIONS, a).toBe(true);
    for (const a of Object.keys(ASSUMPTIONS)) expect(usedA.has(a as never), `unused ${a}`).toBe(true);
    const usedP = new Set(CATALOG.flatMap((r) => r.requires));
    for (const p of usedP) expect(p in PROBES, p).toBe(true);
    for (const p of Object.keys(PROBES)) expect(usedP.has(p as never), `unused ${p}`).toBe(true);
  });

  it("implemented rules have a unit test; planned rules never claim one", () => {
    for (const r of CATALOG) {
      if (r.state === "implemented") expect(r.evidence, r.id).toContain("unit");
      else expect(r.evidence, r.id).not.toContain("unit");
    }
  });

  it("findingCode, when set, is a dotted code (CONTRACT-002: codes are free-form, grouped by first segment)", () => {
    for (const r of CATALOG.filter((r) => r.findingCode)) expect(r.findingCode!, r.id).toMatch(ID);
    // The CONTRACT-001 codes that name a rule outcome are used by at least one rule.
    const used = new Set(CATALOG.map((r) => r.findingCode ?? r.id));
    for (const c of ["metric.unmapped", "metric.no_equivalent", "metric.derived", "tag.unmapped", "widget.unsupported", "query.parse_error", "fn.unsupported", "variable.pinned", "monitor.option", "monitor.type"])
      expect(c in FINDING_CODES && used.has(c), c).toBe(true);
  });
});

describe("rule catalog: composition", () => {
  it("takes the worst status, unions assumptions, collects ε, dedupes in order", () => {
    const c = compose(["select.metric.mapped", "time.rollup.explicit", "space.agg", "time.rollup.explicit"]);
    expect(c.status).toBe("exact-under");
    expect(c.rules).toEqual(["select.metric.mapped", "time.rollup.explicit", "space.agg"]);
    expect(c.assumptions).toEqual(["A.align", "A.boundary"]);
    expect(compose(["select.metric.mapped", "time.as_rate.counter"]).epsilon).toHaveLength(1);
    expect(compose(["select.metric.mapped", "fn.unknown"]).status).toBe("manual");
    expect(compose([]).status).toBe("exact");
    expect(compose(["scope.all"], ["A.var-default"]).status).toBe("exact-under");
  });

  it("unknown ids throw instead of passing as exact", () => {
    expect(() => rule("time.rollup.typo")).toThrow(/unknown rule id/);
    expect(() => compose(["time.rollup.typo"])).toThrow();
  });

  it("findingFor: none for exact rules, a CONTRACT-001 Finding otherwise", () => {
    expect(findingFor("scope.tag.eq", { itemKind: "query", itemId: "q" })).toBeNull();
    const f = findingFor("select.metric.unmapped", { itemKind: "query", itemId: "dd-dash-1/panel-2/query1", original: "avg:foo{*}" })!;
    expect(f).toMatchObject({ status: "exact-under", code: "metric.unmapped", ruleId: "select.metric.unmapped", original: "avg:foo{*}" });
    expect(f.assumptions).toEqual([ASSUMPTIONS["A.kind-gauge"]]);
    expect(findingFor("time.as_rate.counter", { itemKind: "query", itemId: "q" })!.epsilon).toMatch(/T3b/);
  });

  it("the catalog is frozen and in pipeline order", () => {
    expect(Object.isFrozen(CATALOG)).toBe(true);
    const order = STAGES.map((s) => s.id);
    const seen = CATALOG.map((r) => order.indexOf(r.stage));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
