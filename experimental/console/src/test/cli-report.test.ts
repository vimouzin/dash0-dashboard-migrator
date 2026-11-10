import { describe, expect, it } from "vitest";
import cliReport from "@/test/fixtures/cli-report.redis.json?raw";
import { parseReport, type Report } from "@/lib/report";

// Real output of: dd2dash0 migrate --from datadog --dry-run on the Redis overview dashboard
// and the high_mem monitor (fixtures/datadog, CLI at cc96292). Not edited.
const load = (): Report => {
  const r = parseReport(cliReport);
  if (!r.ok) throw new Error(r.error);
  return r.report;
};
const raw = JSON.parse(cliReport) as { items: Array<Record<string, unknown>> };
const byRawStatus = (s: string) => raw.items.filter((i) => i["status"] === s).length;

describe("CLI report.json mapping", () => {
  it("is accepted with no warnings and keeps all 37 items", () => {
    const rep = load();
    expect(rep.warnings).toEqual([]);
    expect(rep.items).toHaveLength(37);
  });

  it("maps kind panel to widget and alert to monitor", () => {
    const rep = load();
    expect(rep.items.filter((i) => i.kind === "widget")).toHaveLength(36);
    const monitors = rep.items.filter((i) => i.kind === "monitor");
    expect(monitors.map((m) => m.id)).toEqual(["dd-monitor-redisdb__high_mem"]);
  });

  it("treats exact-under, bounded and manual in status as claims", () => {
    const rep = load();
    const claims = (c: string) => rep.items.filter((i) => i.claim === c).length;
    expect(claims("exact-under")).toBe(byRawStatus("exact-under"));
    expect(claims("bounded")).toBe(byRawStatus("bounded"));
    expect(claims("manual")).toBe(byRawStatus("manual"));
    expect(rep.items.filter((i) => i.claim === undefined)).toHaveLength(byRawStatus("unsupported"));
  });

  it("derives console statuses from those claims", () => {
    const rep = load();
    const status = (s: string) => rep.items.filter((i) => i["status"] === s).length;
    expect(status("exact")).toBe(byRawStatus("exact-under"));
    expect(status("approximate")).toBe(byRawStatus("bounded"));
    expect(status("unsupported")).toBe(byRawStatus("manual") + byRawStatus("unsupported"));
    expect(rep.items.every((i) => ["exact", "approximate", "unsupported"].includes(i.status))).toBe(
      true,
    );
  });

  it("shows an exact-under item as 'Exact if <assumption text>', not 'condition not supplied'", () => {
    const rep = load();
    const note = rep.items.find((i) => i.widget_type === "note" && i.claim === "exact-under");
    expect(note?.condition).toContain("fonts, colours, alignment");
  });

  it("keeps the condition short when an item has many assumptions", () => {
    const rep = load();
    const alert = rep.items.find((i) => i.kind === "monitor");
    expect(alert?.condition).toMatch(/\(\+\d+ more assumptions\)$/);
    expect(alert?.condition?.length).toBeLessThan(200);
  });

  it("reads certificate.checks into verification, only counting PromQL checks when there is PromQL", () => {
    const rep = load();
    const withPromql = rep.items.find((i) => i.promql.length > 0);
    expect(withPromql?.verification).toMatchObject({ promql_valid: true, imported: null });
    const withoutPromql = rep.items.find((i) => i.promql.length === 0);
    expect(withoutPromql?.verification?.promql_valid).toBeNull();
    expect(rep.items.every((i) => i.verification?.imported === null)).toBe(true); // dry run: read-back not tested
  });

  it("reads target into dash0, with no URL", () => {
    const rep = load();
    const alert = rep.items.find((i) => i.kind === "monitor");
    expect(alert?.dash0).toEqual({
      asset_id: "8f2feda9-c3a8-5b04-a601-58a589b122a5",
      url: null,
      import_status: "dry-run",
    });
    expect(rep.items.find((i) => i.kind === "widget")?.dash0?.asset_id).toBe("dd-redisdb-overview");
  });

  it("takes run and schema from the CLI's own field names", () => {
    const rep = load();
    expect(rep.schema_version).toBe("dd2dash0.report/v1");
    expect(rep.run.tool_version).toBe("dd2dash0 0.2.0");
    expect(rep.run.source_sha256).toBe(
      "9bafa06fce9833bda170dc5237ce964732872cd43b44cc271b7d32516ea2f7fc",
    );
    expect(rep.run.mapping_version).toBe("mappings/tags.yaml, datadog/redisdb.yaml");
  });

  it("takes summary counts from summary.byKind and they match the CLI's own numbers", () => {
    const rep = load();
    expect(rep.summary.summaryFromFile).toBe(true);
    expect(rep.summary.widgets).toEqual({
      exact: 18,
      approximate: 10,
      unsupported: 8,
      no_data: 0,
      failed: 0,
      total: 36,
    });
    expect(rep.summary.monitors).toEqual({
      exact: 1,
      approximate: 0,
      unsupported: 0,
      no_data: 0,
      failed: 0,
      total: 1,
    });
  });
});

import { explainCode } from "@/lib/reason-codes";
import { reasonLabel } from "@/lib/presentation";

describe("reason codes in the real CLI report", () => {
  const codes = [
    ...new Set(
      (JSON.parse(cliReport) as { items: Array<{ reason_codes?: string[] }> }).items.flatMap(
        (i) => i.reason_codes ?? [],
      ),
    ),
  ];
  it("finds the 11 distinct codes the CLI writes", () => {
    expect(codes).toHaveLength(11);
  });
  it.each(codes)("%s has a one-sentence explanation and a short chip label", (code) => {
    const text = explainCode(code);
    expect(text, code).toBeTruthy();
    expect(text).not.toContain("(needs wording check)");
    expect(reasonLabel(code)).not.toBe(code);
    expect(reasonLabel(code).length).toBeLessThanOrEqual(26);
  });
  it("shows an unknown code as itself", () => {
    expect(reasonLabel("something.new")).toBe("something.new");
    expect(explainCode("something.new")).toBeUndefined();
  });
});

import { widgetBreakdown } from "@/lib/report";
import { metricWidgetsLine, textAndLogsLine } from "@/lib/presentation";

describe("counts lines", () => {
  it("keep text notes and log panels out of the metric widget counts, computed from the file", () => {
    const rep = load();
    const b = widgetBreakdown(rep.items);
    expect(metricWidgetsLine(b)).toBe(
      "27 metric widgets: 11 exact if a condition holds, 10 approximate, 6 can't migrate automatically",
    );
    expect(textAndLogsLine(b)).toBe("7 text notes copied, 2 log panels");
    expect(b.metrics + b.notesCopied + b.logPanels).toBe(rep.summary.widgets.total); // 27 + 7 + 2 = 36 panels
  });
  it("adds a plain exact count only when there are plain exact widgets", () => {
    const b = {
      metrics: 3,
      exact: 2,
      exactIf: 0,
      differences: 1,
      manual: 0,
      notesCopied: 1,
      logPanels: 0,
      logsUnsupported: 0,
      checkRules: 0,
    };
    expect(metricWidgetsLine(b)).toBe(
      "3 metric widgets: 2 exact, 0 exact if a condition holds, 1 approximate, 0 can't migrate automatically",
    );
    expect(textAndLogsLine(b)).toBe("1 text note copied, 0 log panels");
  });
});
