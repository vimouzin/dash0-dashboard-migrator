// Two-level explanations (CONTRACT-003 §5.4): every assumption has plain wording, and the templates read as intended.
import { describe, expect, it } from "vitest";
import { ASSUMPTIONS, explain, explainPlain, explainTechnical, PLAIN_ASSUMPTIONS } from "../../src/rules/index.js";

describe("plain explanations", () => {
  it("every assumption in the catalog has a plain clause, free of ids, file names and jargon markers", () => {
    for (const id of Object.keys(ASSUMPTIONS)) {
      const p = PLAIN_ASSUMPTIONS[id];
      expect(p, id).toBeTruthy();
      expect(p, id).not.toMatch(/A\.[a-z]|maths\.md|\$__|\{\{|PromQL|ε/);
      expect(p!.endsWith("."), id).toBe(false); // clauses are joined into a sentence
    }
  });

  it("reads per status", () => {
    expect(explainPlain({ status: "exact", rules: ["select.metric.mapped"], assumptions: [] })).toBe("Same result as in Datadog.");
    expect(explainPlain({ status: "exact-under", rules: ["time.rollup.explicit"], assumptions: ["A.align", "A.boundary"] })).toBe(
      "Same result as in Datadog, as long as both tools cut time into the same buckets and no data point lands exactly on the edge of a time bucket.",
    );
    expect(explainPlain({ status: "bounded", rules: ["time.as_rate.counter"], assumptions: [] })).toMatch(/^Close to Datadog's result/);
    expect(explainPlain({ status: "manual", rules: [], assumptions: [], reasons: ["fn.forecast"] })).toBe(
      "Not migrated automatically: Datadog's forecast model has no PromQL counterpart (predict_linear is a different model). The original is kept so a person can rebuild it.",
    );
    expect(explainPlain({ status: "manual", rules: [], assumptions: [], reasons: ["fn.never_seen"] })).toMatch(/^Not migrated automatically: /);
    expect(explainPlain({ status: "unsupported", rules: [], assumptions: [] })).toMatch(/placeholder keeps the original/);
  });

  it("technical line names the rules and the claim", () => {
    expect(explainTechnical({ status: "exact-under", rules: ["select.metric.mapped", "time.rollup.explicit"], assumptions: ["A.align", "A.boundary", "A.align"] })).toBe(
      "select.metric.mapped + time.rollup.explicit: exact-under(A.align, A.boundary)",
    );
    expect(explainTechnical({ status: "manual", rules: [], assumptions: [], reasons: ["fn.forecast"] })).toBe("(no rules): manual [fn.forecast]");
    expect(explain({ status: "exact", rules: ["map.abs"], assumptions: [] })).toEqual({ technical: "map.abs: exact", plain: "Same result as in Datadog." });
  });

  it("is deterministic", () => {
    const x = { status: "exact-under" as const, rules: ["scope.var"], assumptions: ["A.var-regex"] };
    expect(JSON.stringify(explain(x))).toBe(JSON.stringify(explain(x)));
  });
});
