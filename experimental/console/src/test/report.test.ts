import { describe, expect, it } from "vitest";
import sample from "@/data/report.sample.json?raw";
import { parseReport, fidelityLabel, widgetBreakdown } from "@/lib/report";

describe("Report normalization", () => {
  it("separates 27 metrics, 7 copied notes and 2 unsupported logs", () => {
    const result = parseReport(sample);
    if (!result.ok) throw new Error(result.error);
    expect(result.report.summary.widgets.total).toBe(36);
    expect(result.report.summary.groups.total).toBe(7);
    expect(result.report.summary.monitors.total).toBe(1);
    expect(widgetBreakdown(result.report.items)).toEqual({
      metrics: 27,
      exact: 0,
      exactIf: 0,
      differences: 21,
      manual: 6,
      notesCopied: 7,
      logPanels: 2,
      logsUnsupported: 2,
      checkRules: 1,
    });
  });
  it.each([
    ["exact", "exact"],
    ["exact-under", "exact"],
    ["bounded", "approximate"],
    ["manual", "unsupported"],
  ])("maps %s to %s when status is missing", (claim, status) => {
    const result = parseReport(
      JSON.stringify({ items: [{ id: "widget-1", claim, condition: "maxmemory stays constant" }] }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.report.items[0]?.status).toBe(status);
    expect(result.report.items[0]?.condition).toBe("maxmemory stays constant");
  });
  it("preserves explicit fidelity over claim and retains conditional claims", () => {
    const result = parseReport(
      JSON.stringify({
        items: [
          { id: "a", status: "failed", claim: "exact" },
          { id: "b", claim: "exact-under", condition: "maxmemory stays constant" },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.report.items[0]?.status).toBe("failed");
    const conditional = result.report.items[1];
    if (!conditional) throw new Error("Missing conditional item");
    expect(fidelityLabel(conditional)).toBe("Exact if maxmemory stays constant");
  });
});
