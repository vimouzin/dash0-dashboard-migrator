import type { GridBox, ReportItem } from "./report";

export interface PlacedWidget {
  item: ReportItem;
  box: GridBox;
}
export interface PlacedGroup {
  item: ReportItem | null;
  title: string;
  x: number;
  w: number; // columns this group spans in the 12-column band
  cols?: number | undefined; // columns of the group's own grid; defaults to w
  rows: number; // rows actually used by widgets
  widgets: PlacedWidget[];
}
export interface Band {
  groups: PlacedGroup[];
}
export interface MapLayout {
  bands: Band[];
  unplaced: ReportItem[];
  warnings: string[];
  /** Set when the report has no group items with a layout and the groups were built from each widget's `group` field. */
  grouped?: boolean | undefined;
}

const COLS = 12;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Datadog flows groups in order, and group y values restart, so groups are packed in
 * file order into bands of 12 columns. Widgets keep their relative x, y, w, h inside a
 * grid that is group.w columns wide.
 */
export function buildMapLayout(items: ReportItem[]): MapLayout {
  const warnings: string[] = [];
  const groups = items.filter((i) => i.kind === "group");
  const widgets = items.filter((i) => i.kind === "widget");
  if (!groups.some((g) => g.layout)) return buildGroupedOverview(widgets);
  const unplaced: ReportItem[] = [];
  const placed: PlacedGroup[] = [];

  for (const g of groups) {
    if (!g.layout) continue;
    const w = clamp(Math.round(g.layout.w), 1, COLS);
    const x = clamp(Math.round(g.layout.x), 0, COLS - w);
    if (w !== g.layout.w || x !== g.layout.x)
      warnings.push(`${g.id}: position clamped to the grid.`);
    placed.push({ item: g, title: g.title || g.id, x, w, rows: 0, widgets: [] });
  }
  const byTitle = new Map(placed.map((p) => [p.title, p]));

  for (const it of widgets) {
    const grp = it.group ? byTitle.get(it.group) : undefined;
    if (!grp || !it.layout) {
      unplaced.push(it);
      continue;
    }
    const w = clamp(Math.round(it.layout.w), 1, grp.w);
    const x = clamp(Math.round(it.layout.x), 0, grp.w - w);
    const h = Math.max(1, Math.round(it.layout.h));
    const y = Math.max(0, Math.round(it.layout.y));
    if (w !== it.layout.w || x !== it.layout.x)
      warnings.push(`${it.id}: position clamped to its group.`);
    grp.widgets.push({ item: it, box: { x, y, w, h } });
    grp.rows = Math.max(grp.rows, y + h);
  }

  const bands: Band[] = [];
  let cur: Band | null = null;
  let cursor = 0;
  for (const g of placed) {
    if (!cur || g.x < cursor || g.x + g.w > COLS) {
      cur = { groups: [] };
      bands.push(cur);
    }
    cur.groups.push(g);
    cursor = g.x + g.w;
  }
  return { bands, unplaced, warnings };
}

const pack = (placed: PlacedGroup[]): Band[] => {
  const bands: Band[] = [];
  let cur: Band | null = null;
  let cursor = 0;
  for (const g of placed) {
    if (!cur || cursor + g.w > COLS) {
      cur = { groups: [] };
      bands.push(cur);
      cursor = 0;
    }
    g.x = cursor;
    cur.groups.push(g);
    cursor += g.w;
  }
  return bands;
};

/**
 * Fallback when the report has no group items with a layout: one group per distinct widget `group`, in
 * first-seen order. A group whose widgets all carry a layout gets a grid computed from their own x, y, w, h
 * (its column count is the furthest right edge, and its span in the 12-column band is proportional to that,
 * relative to Dash0's 24-column grid). Otherwise its widgets sit on an even grid of three tiles per row.
 * Widgets with no group stay unplaced.
 */
function buildGroupedOverview(widgets: ReportItem[]): MapLayout {
  const byGroup = new Map<string, ReportItem[]>();
  const unplaced: ReportItem[] = [];
  for (const w of widgets) {
    if (!w.group) {
      unplaced.push(w);
      continue;
    }
    byGroup.set(w.group, [...(byGroup.get(w.group) ?? []), w]);
  }
  const placed: PlacedGroup[] = [];
  for (const [title, members] of byGroup) {
    const withLayout = members.every((m) => m.layout);
    let cols: number;
    let span: number;
    let boxes: PlacedWidget[];
    if (withLayout) {
      cols = Math.max(
        1,
        ...members.map((m) => Math.round((m.layout?.x ?? 0) + (m.layout?.w ?? 1))),
      );
      span = clamp(Math.round((COLS * cols) / 24), 2, COLS);
      boxes = members.map((item) => ({
        item,
        box: {
          x: Math.max(0, Math.round(item.layout?.x ?? 0)),
          y: Math.max(0, Math.round(item.layout?.y ?? 0)),
          w: Math.max(1, Math.round(item.layout?.w ?? 1)),
          h: Math.max(1, Math.round(item.layout?.h ?? 1)),
        },
      }));
    } else {
      cols = Math.min(3, members.length);
      span = clamp(cols * 2, 4, COLS);
      boxes = members.map((item, i) => ({
        item,
        box: { x: i % cols, y: Math.floor(i / cols), w: 1, h: 1 },
      }));
    }
    placed.push({
      item: null,
      title,
      x: 0,
      w: span,
      cols,
      rows: Math.max(...boxes.map((b) => b.box.y + b.box.h)),
      widgets: boxes,
    });
  }
  return { bands: pack(placed), unplaced, warnings: [], grouped: true };
}

/** True when the smallest widget would render under the minimum tile height at this row unit. */
export function needsStretch(
  layout: MapLayout,
  rowUnit: number,
  gap: number,
  minTile: number,
): boolean {
  return layout.bands.some((b) =>
    b.groups.some((g) => g.widgets.some((w) => w.box.h * rowUnit + (w.box.h - 1) * gap < minTile)),
  );
}
