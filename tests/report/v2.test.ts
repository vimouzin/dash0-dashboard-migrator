// report.json v2 (CONTRACT-003 §5): additive over v1, every code explained, groups, review order, summaries.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/pipeline/migrate.js";
import { reviewQueue } from "../../src/pipeline/review-session.js";
import { resolveCode } from "../../src/rules/index.js";

const ROOT = join(import.meta.dirname, "..", "..");

describe("report v2 on the fixtures", async () => {
  const { report: r } = await migrate({
    ingest: { input: join(ROOT, "fixtures", "datadog") },
    mappingsDir: join(ROOT, "mappings"),
    outDir: mkdtempSync(join(tmpdir(), "v2-")),
    mode: "dry-run",
    version: "v2",
    source: { kind: "folder", site: null, path: "fixtures/datadog" },
  });

  it("keeps every v1 field (a v1 reader still works) and says v2", () => {
    expect(r.schema).toBe("dd2dash0.report/v2");
    for (const k of ["tool", "version", "inputHash", "outputHash", "options", "mappingFiles"]) expect(r.run, k).toHaveProperty(k);
    for (const k of ["dashboards", "alerts", "byKind", "coverageExact", "coverageTranslated", "findingsByCode", "import"]) expect(r.summary, k).toHaveProperty(k);
    for (const i of r.items)
      for (const k of ["id", "kind", "title", "widget_type", "dashboard", "group", "layout", "source", "source_queries", "source_formula", "promql", "status", "reason_codes", "certificate", "findings", "target"])
        expect(i, `${i.id}.${k}`).toHaveProperty(k);
  });

  it("run: source as given (no machine paths), catalog hash, no commit unless stamped", () => {
    expect(r.run.source).toEqual({ kind: "folder", site: null, path: "fixtures/datadog" });
    expect(r.run.catalogHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.run).not.toHaveProperty("planHash");
  });

  it("reasonCodes: exactly the codes used, every one from the catalog", () => {
    const used = new Set([...r.findings.map((f) => f.code), ...r.items.flatMap((i) => [...i.reason_codes, ...i.findings.map((f) => f.code)])]);
    expect(Object.keys(r.reasonCodes).sort()).toEqual([...used].sort());
    for (const [code, e] of Object.entries(r.reasonCodes)) {
      expect(e.catalogRule, code).not.toBeNull();
      expect(e.label && e.explanation && e.plain, code).toBeTruthy();
    }
  });

  it("group items come before their panels, and every group_id points at one", () => {
    const groups = new Map(r.items.filter((i) => i.kind === "group").map((g) => [g.id, r.items.indexOf(g)]));
    expect(r.summary.groups).toBe(groups.size);
    expect(groups.size).toBeGreaterThan(0);
    for (const [n, i] of r.items.entries()) {
      if (i.kind !== "panel" || !i.group_id) continue;
      expect(groups.has(i.group_id), i.id).toBe(true);
      expect(groups.get(i.group_id)!, i.id).toBeLessThan(n);
      expect(i.id.startsWith(i.group_id + "/"), i.id).toBe(true);
    }
    for (const g of r.items.filter((i) => i.kind === "group")) expect(g).toMatchObject({ status: "exact", layout: null, decision_required: false, widget_type: "group" });
  });

  it("panels carry the Datadog position next to the Dash0 one", () => {
    const placed = r.items.filter((i) => i.kind === "panel" && i.source_layout);
    expect(placed.length).toBeGreaterThan(0);
    for (const i of placed) expect(i.source_layout!.x + i.source_layout!.w, i.id).toBeLessThanOrEqual(12);
  });

  it("review order: the same queue review and apply use; decision_required marks exactly those", () => {
    expect(r.summary.reviewOrder).toEqual(reviewQueue(r).map((i) => i.id));
    expect(r.items.filter((i) => i.decision_required).map((i) => i.id).sort()).toEqual([...r.summary.reviewOrder].sort());
    expect(r.items.some((i) => i.status === "exact-under" && i.kind === "panel" && i.decision_required)).toBe(false);
  });

  it("condition only for exact-under; every item explained in two levels, without bookkeeping rules", () => {
    for (const i of r.items) {
      if (i.status !== "exact-under") expect(i.condition, i.id).toBeNull();
      expect(i.explain.plain.length, i.id).toBeGreaterThan(10);
      expect(i.explain.technical, i.id).not.toMatch(/emit\.|validate\./);
    }
    expect(r.items.filter((i) => i.status === "exact-under" && i.condition).length).toBeGreaterThan(0);
  });

  it("summary.metrics adds up; gaps rank blocking codes; flow counts translation rules", () => {
    const m = r.summary.metrics;
    expect(m.mapped + m.approximate + m.derived + m.needsTransform + m.noEquivalent + m.unmapped).toBe(m.total);
    expect(m.total).toBeGreaterThan(0);
    const g = r.summary.gaps;
    for (let n = 1; n < g.length; n++) expect(g[n - 1]!.items).toBeGreaterThanOrEqual(g[n]!.items);
    for (const x of g) expect(x.code === "widget.unsupported" || resolveCode(x.code)?.status === "manual", x.code).toBe(true);
    expect(r.summary.flow.every((f) => f.count > 0 && !["emit", "validate", "canonical", "ingest"].includes(f.construct))).toBe(true);
  });
});
