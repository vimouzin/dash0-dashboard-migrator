// DataDog/integrations-core runs: free-layout ("screenboard") dashboards with their own units, and empty dashboards.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestFolder } from "../../src/sources/datadog/index.js";
import { preflightDashboard } from "../../src/targets/dash0/index.js";
import { toPerses, type TranslateExpr } from "../../src/translate/dashboard/index.js";

const stub: TranslateExpr = () => ({ promql: "vector(1)", status: "exact", rules: [], assumptions: [], findings: [] }) as unknown as ReturnType<TranslateExpr>;
const note = (x: number, y: number, w: number, h: number, text: string) => ({ definition: { type: "note", content: text }, layout: { x, y, width: w, height: h } });

function one(json: unknown) {
  const d = mkdtempSync(join(tmpdir(), "dd2dash0-layout-"));
  writeFileSync(join(d, "dash.json"), JSON.stringify(json));
  const ing = ingestFolder(d);
  return toPerses(ing.dashboards[0]!, stub).dashboard;
}

describe("free layout and empty dashboards", () => {
  it("scales a section wider than its grid (and starting below 0) to fit 24 columns, keeping the order", () => {
    // Shaped like marklogic/assets/dashboards/overview.json: x from -8 to 209.
    const d = one({ title: "Free", layout_type: "free", widgets: [note(-8, 0, 22, 12, "a"), note(24, 0, 47, 5, "b"), note(162, 6, 47, 78, "c")] });
    const items = d.spec.layouts.flatMap((l) => l.spec.items);
    for (const it of items) {
      expect(it.x).toBeGreaterThanOrEqual(0);
      expect(it.x + it.width).toBeLessThanOrEqual(24);
    }
    const xs = items.map((i) => i.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b)); // left to right as in Datadog
    expect(items[2]!.x + items[2]!.width).toBe(24); // the rightmost reaches the edge, nothing clamped on top
    expect(preflightDashboard(d)).toEqual([]);
  });

  it("leaves an ordinary 12-column dashboard exactly as before", () => {
    const d = one({ title: "Grid", layout_type: "ordered", widgets: [note(0, 0, 6, 2, "a"), note(6, 0, 6, 2, "b")] });
    expect(d.spec.layouts[0]!.spec.items.map((i) => [i.x, i.y, i.width, i.height])).toEqual([
      [0, 0, 12, 6],
      [12, 0, 12, 6],
    ]);
  });

  it("lands a dashboard with no widgets as one note instead of being refused", () => {
    const d = one({ title: "Network Metrics", layout_type: "ordered", widgets: [] });
    expect(Object.keys(d.spec.panels)).toHaveLength(1);
    expect(JSON.stringify(d.spec.panels)).toContain("has no widgets");
    expect(preflightDashboard(d)).toEqual([]);
  });
});
