// Datadog markers and conditional formats -> Perses ThresholdOptions ({mode, defaultColor?, steps[{value, color, name?}]}),
// the shape TimeSeriesChart and StatChart share. Colours are presentation (catalog A.style), but nothing is dropped
// silently: every marker or format rule that can't be drawn the same way is named in the returned notes.

export interface ThresholdStep {
  value: number;
  color: string;
  name?: string;
}
export interface Thresholds {
  mode: "absolute";
  defaultColor?: string;
  steps: ThresholdStep[];
}

/** Datadog severities and palette colours -> one fixed colour each, so the output is deterministic. */
const COLOR = { red: "#e5484d", yellow: "#f5a623", green: "#30a46c", blue: "#3e63dd", gray: "#8b8d98" } as const;
const SEVERITY: Record<string, string> = { error: COLOR.red, warning: COLOR.yellow, ok: COLOR.green, info: COLOR.blue };

const NUM = String.raw`(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)`;
const SINGLE = new RegExp(String.raw`^y\s*(=|==|>=|>|<=|<)\s*${NUM}$`, "i");
const RANGE = new RegExp(String.raw`^${NUM}\s*(<=|<)\s*y\s*(<=|<)\s*${NUM}$`, "i");

/** Timeseries markers ("y = 80", "y > 1", "0 < y < 5") -> threshold lines. Bands are drawn as their edge lines. */
export function markersToThresholds(markers: unknown): { thresholds: Thresholds | null; notes: string[]; skipped: string[] } {
  const notes: string[] = [];
  const skipped: string[] = [];
  const steps: ThresholdStep[] = [];
  for (const m of Array.isArray(markers) ? markers : []) {
    const value = typeof m?.value === "string" ? m.value.trim() : "";
    const type = typeof m?.display_type === "string" ? m.display_type.trim().toLowerCase() : "";
    const sev = type.split(/\s+/)[0] ?? "";
    const color = SEVERITY[sev] ?? COLOR.gray;
    const label = typeof m?.label === "string" && m.label.trim() ? m.label.trim() : undefined;
    const push = (v: number) => steps.push({ value: v, color, ...(label ? { name: label } : {}) });
    const one = SINGLE.exec(value);
    const two = RANGE.exec(value);
    if (one) {
      push(Number(one[2]));
      if (one[1] !== "=" && one[1] !== "==") notes.push(`marker '${value}' is a shaded band in Datadog; Dash0 draws its edge line`);
    } else if (two) {
      push(Number(two[1]));
      push(Number(two[4]));
      notes.push(`marker '${value}' is a shaded band in Datadog; Dash0 draws its two edge lines`);
    } else {
      skipped.push(value || JSON.stringify(m));
      continue;
    }
    if (type.includes("bold") || type.includes("thin") || (type.includes("solid") && !type.includes("dashed"))) notes.push(`marker '${value}' line style '${type}' becomes Dash0's default line`);
    if (sev && !SEVERITY[sev]) notes.push(`marker '${value}' severity '${sev}' drawn grey`);
  }
  if (!steps.length) return { thresholds: null, notes, skipped };
  // Ascending, first marker wins on a duplicate value (stable sort keeps source order).
  const seen = new Set<number>();
  const uniq = [...steps].sort((a, b) => a.value - b.value).filter((s) => (seen.has(s.value) ? false : (seen.add(s.value), true)));
  if (uniq.length < steps.length) notes.push("markers with the same value are drawn once (the first one's colour and label)");
  return { thresholds: { mode: "absolute", steps: uniq }, notes, skipped };
}

type Cmp = ">" | ">=" | "<" | "<=";
interface CfRule {
  cmp: Cmp;
  value: number;
  color: string;
}

/** Datadog palette name (or custom colour) -> colour; null when we have no faithful equivalent. */
function paletteColor(r: Record<string, unknown>): string | null {
  const p = typeof r.palette === "string" ? r.palette.toLowerCase() : "";
  if (p.startsWith("custom")) {
    const c = r.custom_bg_color ?? r.custom_fg_color;
    return typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c) ? c.toLowerCase() : null;
  }
  if (p.includes("red")) return COLOR.red;
  if (p.includes("yellow") || p.includes("orange")) return COLOR.yellow;
  if (p.includes("green")) return COLOR.green;
  if (p.includes("blue")) return COLOR.blue;
  if (p.includes("gray") || p.includes("grey")) return COLOR.gray;
  return null;
}

const fmt = (n: number) => String(Number(n.toPrecision(12)));

/**
 * query_value conditional formats -> StatChart thresholds. Datadog applies the FIRST rule that matches; Perses
 * colours a value by the highest step at or below it. The real line is cut at every rule value, each piece (open
 * interval or breakpoint) gets Datadog's colour, and steps are emitted where the colour changes. Pieces Perses
 * can't colour the same way (a strict comparator's breakpoint, a gap no rule covers) are listed in `notes`.
 * Returns null thresholds when a rule has no faithful equivalent (unknown comparator, palette or value).
 */
export function conditionalFormatsToThresholds(formats: unknown): { thresholds: Thresholds | null; notes: string[]; unsupported?: string } {
  const rules: CfRule[] = [];
  for (const r of Array.isArray(formats) ? formats : []) {
    const cmp = r?.comparator;
    const value = typeof r?.value === "number" ? r.value : typeof r?.value === "string" && r.value.trim() !== "" ? Number(r.value) : NaN;
    const color = r && typeof r === "object" ? paletteColor(r) : null;
    if (![">", ">=", "<", "<="].includes(cmp) || !Number.isFinite(value) || !color || r.hide_value || r.image_url || r.metric) {
      return { thresholds: null, notes: [], unsupported: JSON.stringify(r) };
    }
    rules.push({ cmp, value, color });
  }
  if (!rules.length) return { thresholds: null, notes: [] };

  const match = (v: number): string | null => {
    for (const r of rules) {
      if ((r.cmp === ">" && v > r.value) || (r.cmp === ">=" && v >= r.value) || (r.cmp === "<" && v < r.value) || (r.cmp === "<=" && v <= r.value)) return r.color;
    }
    return null;
  };
  const name = (c: string | null) => (c === null ? "no colour" : (Object.entries(COLOR).find(([, v]) => v === c)?.[0] ?? c));
  const bps = [...new Set(rules.map((r) => r.value))].sort((a, b) => a - b);
  const open = (i: number): string | null => {
    // Colour of the open interval above breakpoint i (i = -1: below the first breakpoint).
    if (i < 0) return match(bps[0]! - Math.max(1, Math.abs(bps[0]!)));
    if (i === bps.length - 1) return match(bps[i]! + Math.max(1, Math.abs(bps[i]!)));
    return match((bps[i]! + bps[i + 1]!) / 2);
  };

  const notes: string[] = [];
  const steps: ThresholdStep[] = [];
  const below = open(-1);
  let shown = below; // what Perses shows for the current piece
  for (let i = 0; i < bps.length; i++) {
    const b = bps[i]!;
    const at = match(b);
    const after = open(i);
    const hi = i + 1 < bps.length ? fmt(bps[i + 1]!) : "∞";
    // Perses gives [b, next) one colour. Prefer the interval's colour; a "no colour" interval keeps the previous one.
    const want = after ?? at ?? shown;
    if (want !== shown && want !== null) {
      steps.push({ value: b, color: want });
      shown = want;
    }
    if (at !== shown) notes.push(`a value of exactly ${fmt(b)} is ${name(at)} in Datadog, ${name(shown)} in Dash0`);
    if (after !== shown) notes.push(`values in (${fmt(b)}, ${hi}) are ${name(after)} in Datadog, ${name(shown)} in Dash0`);
  }
  return { thresholds: { mode: "absolute", ...(below ? { defaultColor: below } : {}), steps }, notes };
}
