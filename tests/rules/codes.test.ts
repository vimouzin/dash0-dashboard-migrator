// Every finding / reason code the pipeline can emit resolves to a catalog rule (CONTRACT-003 §5.3), so the report's
// reasonCodes table never needs a free-text fallback. The list below is what Ali's full-corpus run found unresolved
// (hub #531) plus the codes the rows in this file cover.
import { describe, expect, it } from "vitest";
import { parseQuery } from "../../src/parse/index.js";
import { resolveCode, rule } from "../../src/rules/index.js";
import { translateQuery } from "../../src/translate/query/index.js";

describe("finding codes resolve to catalog rules", () => {
  it("the codes the corpus report could not resolve (hub #531, #554) now resolve", () => {
    for (const code of [
      "layout.clamped",
      "widget.toplist.unranked",
      "query.empty",
      "widget.query_value.default-agg",
      "fn.autosmooth",
      "fn.throughput",
      "fn.rate",
      "fn.forecast",
      "fn.ewma_3",
      "fn.ewma_10",
      "fn.outliers",
      "fn.calendar_shift",
      "fn.sum",
      "source.unreadable",
      "log.measure",
      "log.or.cross-key",
      "log.monitor.shape",
    ])
      expect(resolveCode(code), code).toBeDefined();
  });

  it("an fn.<name> code with no row of its own resolves to the fn.unknown fallback; other unknown codes don't resolve", () => {
    expect(resolveCode("fn.some_future_function")?.id).toBe("fn.unknown");
    expect(resolveCode("metric.unmapped")?.findingCode).toBe("metric.unmapped");
    expect(resolveCode("no.such.code")).toBeUndefined();
  });

  it("T4 really emits these codes, manual, through its fn.<name> fallback (the 'unit' evidence of the rows)", () => {
    for (const [code, src] of [
      ["fn.cumsum", "cumsum(avg:system.cpu.user{*})"],
      ["fn.integral", "integral(avg:system.cpu.user{*})"],
      ["fn.forecast", "forecast(avg:system.cpu.user{*}, 'linear', 1)"],
      ["fn.outliers", "outliers(avg:system.cpu.user{*} by {host}, 'dbscan', 2)"],
      ["fn.autosmooth", "autosmooth(avg:system.cpu.user{*})"],
      ["fn.ewma_3", "ewma_3(avg:system.cpu.user{*})"],
      ["fn.ewma_10", "ewma_10(avg:system.cpu.user{*})"],
      ["fn.calendar_shift", "calendar_shift(avg:system.cpu.user{*}, '-1d', 'UTC')"],
      ["fn.throughput", "throughput(avg:system.cpu.user{*})"],
      ["fn.rate", "rate(avg:system.cpu.user{*})"],
      ["fn.sum", "sum(avg:system.cpu.user{*})"],
    ] as const) {
      const p = parseQuery(src);
      expect(p.ok, src).toBe(true);
      if (!p.ok) continue;
      const t = translateQuery(p.value, {});
      expect(t.status, src).toBe("manual");
      expect(t.findings.some((f) => f.code === code), `${src} -> ${t.findings.map((f) => f.code).join(",")}`).toBe(true);
      expect(rule(code).status).toBe("manual");
    }
  });
});
