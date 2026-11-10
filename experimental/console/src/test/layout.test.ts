import { expect, it } from "vitest";
import sample from "@/data/report.sample.json?raw";
import { parseReport } from "@/lib/report";
import { buildMapLayout } from "@/lib/layout";
it("packs all seven groups in file order and retains widget geometry", () => {
  const result = parseReport(sample);
  if (!result.ok) throw new Error(result.error);
  const layout = buildMapLayout(result.report.items);
  expect(layout.bands.flatMap((b) => b.groups.map((g) => g.item?.id))).toEqual([
    "group-1",
    "group-2",
    "group-3",
    "group-4",
    "group-5",
    "group-6",
    "group-7",
  ]);
  expect(layout.unplaced).toHaveLength(0);
  expect(layout.bands[1]?.groups[0]?.widgets.find((w) => w.item.id === "widget-3.4")?.box).toEqual({
    x: 4,
    y: 4,
    w: 2,
    h: 2,
  });
});
import cliReport from "@/test/fixtures/cli-report.redis.json?raw";
it("builds a grouped overview from widget group fields when the report has no group layouts", () => {
  const result = parseReport(cliReport);
  if (!result.ok) throw new Error(result.error);
  const layout = buildMapLayout(result.report.items);
  const groups = layout.bands.flatMap((b) => b.groups);
  expect(layout.grouped).toBe(true);
  expect(groups.map((g) => g.title)).toEqual([
    ...new Set(result.report.items.filter((i) => i.kind === "widget").map((i) => i.group)),
  ]);
  expect(layout.unplaced).toHaveLength(0);
  expect(groups.reduce((n, g) => n + g.widgets.length, 0)).toBe(36);
  // grid computed from the widgets' own boxes: "Overview" spans 8 of 24 columns, so 4 of the 12-column band
  const overview = groups.find((g) => g.title === "Overview");
  expect(overview?.cols).toBe(8);
  expect(overview?.w).toBe(4);
  expect(overview?.widgets.find((w) => w.item.title === "Hit rate")?.box).toEqual({
    x: 0,
    y: 0,
    w: 4,
    h: 3,
  });
  for (const b of layout.bands)
    expect(b.groups.reduce((n, g) => n + g.w, 0)).toBeLessThanOrEqual(12);
});
it("uses an even tile grid per group when widgets carry no layout, and keeps unplaced widgets without a group", () => {
  const text = JSON.stringify({
    items: ["a", "b", "c", "d"].map((id, i) => ({
      id,
      kind: "widget",
      status: "exact",
      ...(i < 3 ? { group: "G" } : {}),
    })),
  });
  const result = parseReport(text);
  if (!result.ok) throw new Error(result.error);
  const layout = buildMapLayout(result.report.items);
  const g = layout.bands[0]?.groups[0];
  expect(g?.cols).toBe(3);
  expect(g?.widgets.map((w) => w.box)).toEqual([
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 1, y: 0, w: 1, h: 1 },
    { x: 2, y: 0, w: 1, h: 1 },
  ]);
  expect(layout.unplaced.map((i) => i.id)).toEqual(["d"]);
});
it("keeps the proportional layout when real group layouts exist", () => {
  const result = parseReport(sample);
  if (!result.ok) throw new Error(result.error);
  expect(buildMapLayout(result.report.items).grouped).toBeUndefined();
});
