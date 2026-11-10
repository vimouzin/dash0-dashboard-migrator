import { describe, expect, it } from "vitest";
import { evalFormula, prepareDash0, scopeDatadog, verdictOf } from "../../scripts/parity.js";

describe("parity helpers", () => {
  it("scopes a Datadog query to one host and drops by{}", () => {
    expect(scopeDatadog("sum:redis.keys{$scope,$host} by {host}", "h1")).toBe("sum:redis.keys{host:h1}");
  });
  it("prepares Dash0 PromQL: placeholders and the host pin", () => {
    expect(prepareDash0('sum(rate({otel_metric_name="a.b"}[$__rate_interval]))', "h1", "30m")).toBe('sum(rate({otel_metric_name="a.b", host_name="h1"}[5m]))');
  });
  it("evaluates Datadog formulas and refuses anything else", () => {
    expect(evalFormula("(query1/(query1+query2))*100", { query1: 3, query2: 1 })).toBe(75);
    expect(evalFormula("per_minute(query1)", { query1: 2 })).toBe(120);
    expect(evalFormula("-query1+1", { query1: 3 })).toBe(-2);
    expect(evalFormula("query1/0", { query1: 3 })).toBeNull();
    expect(evalFormula("query9", { query1: 3 })).toBeNull();
    expect(evalFormula("process.exit(1)", {})).toBeNull();
  });
  it("classifies close, differs and trivial", () => {
    expect(verdictOf(100, 100.5, 1).verdict).toBe("close");
    expect(verdictOf(100, 90, 1).verdict).toBe("differs");
    expect(verdictOf(0, 0, 1).verdict).toBe("trivial");
    expect(verdictOf(0, 5, 1).verdict).toBe("differs");
  });
});
