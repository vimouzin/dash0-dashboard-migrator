// Coverage by query type: the same translators as the migration, over every distinct query and monitor.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageCollector, coverageHeadline, pct1, summarizeCoverage, type CoverageItem } from "../../src/report/query-coverage.js";
import { coverageMarkdown } from "../../src/flow/score.js";
import { reportHtml } from "../../src/flow/report-html.js";

const ROOT = join(import.meta.dirname, "..", "..");
const FIX = join(ROOT, "fixtures", "datadog");
const item = (kind: CoverageItem["kind"], key: string, status: CoverageItem["status"], reason?: string): CoverageItem => ({ kind, key: `${kind}|${key}`, status, ...(reason ? { reason } : {}), unmapped: false, unmappedNames: [], invalid: false, group: "g" });

describe("coverage by query type", () => {
  it("classifies the fixtures: every query and monitor is counted once, each in its kind", () => {
    const c = coverageCollector(join(ROOT, "mappings"));
    for (const f of readdirSync(join(FIX, "dashboards"))) c.dashboard(JSON.parse(readFileSync(join(FIX, "dashboards", f), "utf8")), f);
    for (const f of readdirSync(join(FIX, "monitors"))) c.monitor(JSON.parse(readFileSync(join(FIX, "monitors", f), "utf8")), f);
    const s = summarizeCoverage(c.items, c.skipped);
    expect(s.total).toBe(s.rows.reduce((a, r) => a + r.total, 0));
    expect(s.rows.find((r) => r.kind === "metric monitor")).toMatchObject({ total: 6 });
    expect(s.anomalyMonitors).toBe(4); // the nginx + postgres anomalies() monitors stay with a person
    expect(c.items.every((i) => !i.invalid)).toBe(true); // every emitted PromQL parses
    // Best translated first.
    const rates = s.rows.map((r) => r.translated / r.total);
    expect(rates).toEqual([...rates].sort((a, b) => b - a));
  });

  it("counts a query used twice once, at its worst result; rounds down; says why the rest stays", () => {
    const s = summarizeCoverage([
      item("legacy q", "a", "exact-under"),
      item("legacy q", "a", "manual", "time.kind"), // the same query again, worse
      item("legacy q", "b", "bounded"),
      item("metric monitor", "m", "manual", "fn.anomalies"),
      item("metric monitor", "n", "exact-under"),
      item("metric monitor", "o", "exact-under"),
    ]);
    expect(s.rows.map((r) => [r.label, r.total, r.translated, r.exact])).toEqual([
      ["Metric monitors", 3, 2, 2],
      ["Legacy queries", 2, 1, 0],
    ]);
    expect(s.rows[1]!.reasons).toEqual([["time.kind", 1]]);
    expect(s.anomalyMonitors).toBe(1);
    expect(pct1(2, 3)).toBe("66.6%"); // never rounded up
    expect(coverageHeadline(s)).toBe("60.0% of 5 distinct queries and monitors translate, and 40.0% are exact under a stated condition.");
  });

  it("shows in report.md and report.html, and not at all when there is nothing to count", () => {
    const s = summarizeCoverage([item("log query", "x", "exact-under"), item("metric monitor", "m", "manual", "fn.anomalies")]);
    const md = coverageMarkdown(s).join("\n");
    expect(md).toContain("## Coverage by query type");
    expect(md).toContain("| Log queries | 1 | 100.0% | 100.0% | – |");
    expect(md).toContain("Anomaly monitors (1) count as metric monitors");
    expect(coverageMarkdown(summarizeCoverage([]))).toEqual([]);
    const score = { panels: 0, monitors: 0, total: 0, translated: { count: 0, total: 0, pct: 0 }, landed: null, live: null, success: null, liveCounts: null, topGaps: [] } as never;
    const facts = { version: "t", source: "s", target: "t", mode: "dry-run", inputHash: "0".repeat(16), outputHash: "0".repeat(16), planHash: "0".repeat(16), windowSeconds: 3600, startedAt: "2026-11-08T00:00:00Z" } as never;
    const html = reportHtml(score, [], facts, s);
    expect(html).toContain("Coverage by query type");
    expect(html).toContain("exact under a stated condition");
    expect(reportHtml(score, [], facts)).not.toContain("Coverage by query type");
  });
});
