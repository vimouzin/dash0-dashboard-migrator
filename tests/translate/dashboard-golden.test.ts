// Golden: the Redis overview's Dash0 layout and panel thresholds are pinned (Plan 07 item 3). Any change to the
// layout or threshold rules shows up here as a diff. Regenerate after an intended change with:
//   UPDATE_GOLDEN=1 npx vitest run tests/translate/dashboard-golden.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ingestFolder } from "../../src/sources/datadog/index.js";
import { toPerses, type TranslateExpr } from "../../src/translate/dashboard/index.js";

const ROOT = join(import.meta.dirname, "..", "..");
const GOLDEN = join(ROOT, "tests", "golden", "redisdb__overview.layout.json");
const stub: TranslateExpr = () => ({ ok: true, promql: "up", status: "exact", rules: [], assumptions: [], findings: [] }) as never;

function snapshot() {
  const d = ingestFolder(join(ROOT, "fixtures", "datadog")).dashboards.find((x) => x.source.id === "redisdb__overview")!;
  const t = toPerses(d, stub);
  const panels = t.dashboard.spec.panels;
  return {
    sections: t.dashboard.spec.layouts.map((l) => ({
      title: l.spec.display?.title ?? null,
      items: l.spec.items.map((i) => {
        const p = panels[i.content.$ref.replace("#/spec/panels/", "")]!;
        return { panel: p.spec.display.name, kind: p.spec.plugin.kind, x: i.x, y: i.y, width: i.width, height: i.height };
      }),
    })),
    thresholds: Object.fromEntries(
      Object.values(panels)
        .filter((p) => (p.spec.plugin.spec as { thresholds?: unknown }).thresholds)
        .map((p) => [`${p.spec.plugin.kind} ${p.spec.display.name}`, (p.spec.plugin.spec as { thresholds: unknown }).thresholds]),
    ),
  };
}

describe("golden: Redis overview -> Dash0 layout and thresholds", () => {
  const now = snapshot();
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(now, null, 2) + "\n");
  it("matches tests/golden/redisdb__overview.layout.json", () => {
    expect(now).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  });
  it("every group section fills the 24-column grid", () => {
    for (const s of now.sections.filter((s) => s.title)) expect(Math.max(...s.items.map((i) => i.x + i.width)), s.title!).toBe(24);
  });
  it("the memory panel keeps Datadog's 80% / 100% marker lines", () => {
    expect(now.thresholds["TimeSeriesChart Percent Used Memory by Host"]).toEqual({
      mode: "absolute",
      steps: [{ value: 80, color: "#f5a623", name: "80% memory usage" }, { value: 100, color: "#e5484d", name: "Max memory reached" }],
    });
  });
});
