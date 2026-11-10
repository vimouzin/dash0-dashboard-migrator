// Reference evaluator for the plan algebra (plan 03 §4). Pure and deterministic: no I/O, no randomness,
// with output sorted by label key and then by time.
// Purpose: give a Datadog-semantics plan and a PromQL-semantics plan a meaning over the SAME in-memory data, so
// translation rules can be checked for exact equality (translation error e_T = 0, maths.md §9).
// It is a model of each engine, not the engine. It must be diffed against promtool / Dash0 / Datadog
// (maths.md §11 probes) before its verdicts count for the real systems.
import type { EvalOptions, Grid, Labels, Matcher, Plan, Sample, Series, SpaceFn, Store, TimeFn } from "./types.js";

export const DEFAULT_LOOKBACK = 300;

/** Result of an evaluation. `aligned` series carry one point per evaluation timestamp that has a value. */
interface Value {
  readonly aligned: boolean;
  readonly series: Series[];
}

export class PlanError extends Error {}

export function evaluate(plan: Plan, store: Store, grid: Grid, opts: EvalOptions = {}): Series[] {
  const out = evalNode(plan, store, grid, opts);
  if (!out.aligned) throw new PlanError("top-level plan returns raw samples; wrap it in instant/timeAgg/counter");
  return canonical(out.series);
}

function evalNode(p: Plan, store: Store, grid: Grid, opts: EvalOptions): Value {
  switch (p.op) {
    case "select":
      return { aligned: false, series: store.filter((s) => s.labels.__name__ === p.metric && matchAll(s.labels, p.matchers ?? [], opts)) };
    case "const":
      return { aligned: true, series: [{ labels: {}, samples: gridTimes(grid).map((t) => ({ t, v: p.value })) }] };
    case "instant": {
      const lb = p.lookback ?? DEFAULT_LOOKBACK;
      return alignedFromRaw(raw(p.input, store, grid, opts), gridTimes(grid), (s, t) => lastIn(s, t - lb, t));
    }
    case "timeAgg": {
      const input = raw(p.input, store, grid, opts);
      if (p.mode === "window") {
        return alignedFromRaw(input, gridTimes(grid), (s, t) => reduceTime(p.fn, valuesIn(s, t - p.width, t, "leftOpen")));
      }
      return alignedFromRaw(input, bucketStarts(grid, p.width), (s, t) => reduceTime(p.fn, valuesIn(s, t, t + p.width, "rightOpen")));
    }
    case "counter": {
      const input = raw(p.input, store, grid, opts);
      return alignedFromRaw(input, gridTimes(grid), (s, t) => {
        const inc = p.anchored ? anchoredIncrease(s, t - p.width, t) : extrapolatedIncrease(s, t - p.width, t);
        if (inc === undefined) return undefined;
        return p.fn === "rate" ? inc / p.width : inc;
      });
    }
    case "spaceAgg":
      return { aligned: true, series: spaceAgg(p.fn, p.by, aligned(p.input, store, grid, opts)) };
    case "binary":
      return { aligned: true, series: binary(p, store, grid, opts) };
    case "neg":
      return mapPoints(aligned(p.input, store, grid, opts), (v) => -v);
    case "compare": {
      const keep = compareFn(p.operator, p.threshold);
      const series = aligned(p.input, store, grid, opts).map((s) => ({ labels: s.labels, samples: s.samples.filter((x) => keep(x.v)) }));
      return { aligned: true, series: series.filter((s) => s.samples.length > 0) };
    }
    case "subquery":
      return { aligned: true, series: subquery(p, store, grid, opts) };
  }
}

// ---------- helpers: alignment ----------

function raw(p: Plan, store: Store, grid: Grid, opts: EvalOptions): Series[] {
  const v = evalNode(p, store, grid, opts);
  if (v.aligned) throw new PlanError(`${p.op} produces aligned points where raw samples are required`);
  return v.series;
}

function aligned(p: Plan, store: Store, grid: Grid, opts: EvalOptions): Series[] {
  const v = evalNode(p, store, grid, opts);
  if (!v.aligned) throw new PlanError(`${p.op} produces raw samples; apply instant/timeAgg/counter first`);
  return v.series;
}

function alignedFromRaw(input: Series[], times: number[], f: (s: Series, t: number) => number | undefined): Value {
  const series = input.map((s) => {
    const samples: Sample[] = [];
    for (const t of times) {
      const v = f(s, t);
      if (v !== undefined) samples.push({ t, v });
    }
    return { labels: s.labels, samples };
  });
  return { aligned: true, series: series.filter((s) => s.samples.length > 0) };
}

function mapPoints(series: Series[], f: (v: number) => number): Value {
  return { aligned: true, series: series.map((s) => ({ labels: dropName(s.labels), samples: s.samples.map((x) => ({ t: x.t, v: f(x.v) })) })) };
}

export function gridTimes(g: Grid): number[] {
  if (!(g.step > 0)) throw new PlanError("grid step must be > 0");
  const out: number[] = [];
  for (let i = 0; g.start + i * g.step <= g.end; i++) out.push(g.start + i * g.step);
  return out;
}

/** Unix-aligned bucket starts kW that fall inside [start, end]. */
export function bucketStarts(g: Grid, width: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(g.start / width); k * width <= g.end; k++) out.push(k * width);
  return out;
}

/** "leftOpen" = (a, b]  (PromQL range); "rightOpen" = [a, b)  (Datadog bucket). */
function valuesIn(s: Series, a: number, b: number, kind: "leftOpen" | "rightOpen"): number[] {
  const inside = kind === "leftOpen" ? (t: number) => t > a && t <= b : (t: number) => t >= a && t < b;
  return s.samples.filter((x) => inside(x.t)).map((x) => x.v);
}

function lastIn(s: Series, a: number, b: number): number | undefined {
  let v: number | undefined;
  for (const x of s.samples) if (x.t > a && x.t <= b) v = x.v;
  return v;
}

function reduceTime(fn: TimeFn, vs: number[]): number | undefined {
  if (vs.length === 0) return undefined;
  switch (fn) {
    case "sum": return sum(vs);
    case "avg": return sum(vs) / vs.length;
    case "min": return Math.min(...vs);
    case "max": return Math.max(...vs);
    case "count": return vs.length;
    case "last": return vs[vs.length - 1];
  }
}

/** Sequential left-to-right sum: a fixed order keeps results reproducible. */
function sum(vs: readonly number[]): number {
  let acc = 0;
  for (const v of vs) acc += v;
  return acc;
}

// ---------- counters (Prometheus promql/functions.go extrapolatedRate; maths.md §3-4) ----------

/** Prometheus `increase` with extrapolation over (start, end]. Undefined when there are fewer than 2 samples. */
export function extrapolatedIncrease(s: Series, rangeStart: number, rangeEnd: number): number | undefined {
  const xs = s.samples.filter((x) => x.t > rangeStart && x.t <= rangeEnd);
  if (xs.length < 2) return undefined;
  const first = xs[0]!, last = xs[xs.length - 1]!;
  let result = last.v - first.v;
  for (let i = 1; i < xs.length; i++) if (xs[i]!.v < xs[i - 1]!.v) result += xs[i - 1]!.v; // counter resets
  const sampled = last.t - first.t;
  const avgGap = sampled / (xs.length - 1);
  let dStart = first.t - rangeStart;
  let dEnd = rangeEnd - last.t;
  if (dStart >= 1.1 * avgGap) dStart = avgGap / 2;
  if (dEnd >= 1.1 * avgGap) dEnd = avgGap / 2;
  if (result > 0 && first.v >= 0) {
    const dZero = sampled * (first.v / result); // never extrapolate below zero
    if (dZero < dStart) dStart = dZero;
  }
  return (result * (sampled + dStart + dEnd)) / sampled;
}

/**
 * `increase(x[W] anchored)`: baseline = latest sample at or before rangeStart (within the lookback), end = latest
 * sample in (rangeStart, rangeEnd], no extrapolation, resets add the post-reset value.
 * MODEL: behaviour when no baseline exists is not documented. Here it returns undefined; check against promtool.
 */
export function anchoredIncrease(s: Series, rangeStart: number, rangeEnd: number, lookback = DEFAULT_LOOKBACK): number | undefined {
  const before = s.samples.filter((x) => x.t <= rangeStart && x.t > rangeStart - lookback);
  const inside = s.samples.filter((x) => x.t > rangeStart && x.t <= rangeEnd);
  if (before.length === 0 || inside.length === 0) return undefined;
  const pts = [before[before.length - 1]!, ...inside];
  let inc = 0;
  for (let i = 1; i < pts.length; i++) inc += pts[i]!.v >= pts[i - 1]!.v ? pts[i]!.v - pts[i - 1]!.v : pts[i]!.v;
  return inc;
}

// ---------- space aggregation and binary operators ----------

function spaceAgg(fn: SpaceFn, by: readonly string[], input: Series[]): Series[] {
  const groups = new Map<string, { labels: Labels; members: Series[] }>();
  for (const s of input) {
    const labels = pick(s.labels, by);
    const key = labelKey(labels);
    const g = groups.get(key) ?? { labels, members: [] };
    g.members.push(s);
    groups.set(key, g);
  }
  const out: Series[] = [];
  for (const { labels, members } of groups.values()) {
    const byT = new Map<number, number[]>();
    for (const m of canonical(members)) for (const x of m.samples) (byT.get(x.t) ?? byT.set(x.t, []).get(x.t)!).push(x.v);
    const samples = [...byT.keys()].sort((a, b) => a - b).map((t) => ({ t, v: reduceSpace(fn, byT.get(t)!) }));
    out.push({ labels, samples });
  }
  return out;
}

function reduceSpace(fn: SpaceFn, vs: number[]): number {
  switch (fn) {
    case "sum": return sum(vs);
    case "avg": return sum(vs) / vs.length;
    case "min": return Math.min(...vs);
    case "max": return Math.max(...vs);
    case "count": return vs.length;
  }
}

function binary(p: Extract<Plan, { op: "binary" }>, store: Store, grid: Grid, opts: EvalOptions): Series[] {
  const f = arith(p.operator);
  const L = aligned(p.left, store, grid, opts);
  const R = aligned(p.right, store, grid, opts);
  const isConst = (q: Plan) => q.op === "const";
  if (isConst(p.right) || isConst(p.left)) {
    const scalar = isConst(p.left) ? (p.left as { value: number }).value : (p.right as { value: number }).value;
    const vec = isConst(p.left) ? R : L;
    return vec.map((s) => ({
      labels: dropName(s.labels),
      samples: s.samples.map((x) => ({ t: x.t, v: isConst(p.left) ? f(scalar, x.v) : f(x.v, scalar) })),
    }));
  }
  const key = (l: Labels) => labelKey(p.on ? pick(l, p.on) : dropName(l));
  const right = new Map<string, Series>();
  for (const s of R) {
    const k = key(s.labels);
    if (right.has(k)) throw new PlanError(`many-to-one match on ${k}: needs group_left, not modelled`);
    right.set(k, s);
  }
  const seen = new Set<string>();
  const out: Series[] = [];
  for (const s of L) {
    const k = key(s.labels);
    if (seen.has(k)) throw new PlanError(`duplicate left-side series for ${k}`);
    seen.add(k);
    const r = right.get(k);
    if (!r) continue; // unmatched series vanish (PromQL; Datadog INFERRED, maths.md §11 probe 3)
    const rv = new Map(r.samples.map((x) => [x.t, x.v] as const));
    const samples = s.samples.filter((x) => rv.has(x.t)).map((x) => ({ t: x.t, v: f(x.v, rv.get(x.t)!) }));
    if (samples.length) out.push({ labels: dropName(s.labels), samples });
  }
  return out;
}

function arith(op: "+" | "-" | "*" | "/"): (a: number, b: number) => number {
  switch (op) {
    case "+": return (a, b) => a + b;
    case "-": return (a, b) => a - b;
    case "*": return (a, b) => a * b;
    case "/": return (a, b) => a / b; // IEEE: x/0 = ±Inf, 0/0 = NaN, as in PromQL
  }
}

function compareFn(op: ">" | ">=" | "<" | "<=", th: number): (v: number) => boolean {
  switch (op) {
    case ">": return (v) => v > th;
    case ">=": return (v) => v >= th;
    case "<": return (v) => v < th;
    case "<=": return (v) => v <= th;
  }
}

// ---------- subquery / monitor window ----------

function subquery(p: Extract<Plan, { op: "subquery" }>, store: Store, grid: Grid, opts: EvalOptions): Series[] {
  const times = gridTimes(grid);
  const res = p.resolution;
  // Evaluate the inner expression once, over every inner timestamp any outer point needs.
  const innerGrid: Grid = { start: Math.floor((grid.start - p.range) / res) * res, end: times[times.length - 1] ?? grid.start, step: res };
  const inner = aligned(p.input, store, innerGrid, opts);
  return inner
    .map((s) => {
      const samples: Sample[] = [];
      for (const t of times) {
        const vs =
          p.mode === "window"
            ? s.samples.filter((x) => x.t > t - p.range && x.t <= t && x.t % res === 0).map((x) => x.v)
            : s.samples.filter((x) => x.t >= t - p.range && x.t + res <= t).map((x) => x.v); // buckets inside [t-range, t)
        const v = reduceTime(p.fn, vs);
        if (v !== undefined) samples.push({ t, v });
      }
      return { labels: dropName(s.labels), samples };
    })
    .filter((s) => s.samples.length > 0);
}

// ---------- labels ----------

function matchAll(labels: Labels, ms: readonly Matcher[], opts: EvalOptions): boolean {
  return ms.every((m) => {
    const v = labels[m.label] ?? "";
    const re = () => new RegExp(opts.regex === "unanchored" ? m.value : `^(?:${m.value})$`);
    switch (m.type) {
      case "=": return v === m.value;
      case "!=": return v !== m.value;
      case "=~": return re().test(v);
      case "!~": return !re().test(v);
    }
  });
}

function pick(l: Labels, keys: readonly string[]): Labels {
  const out: Record<string, string> = {};
  for (const k of [...keys].sort()) if (l[k] !== undefined) out[k] = l[k]!;
  return out;
}

function dropName(l: Labels): Labels {
  const { __name__: _drop, ...rest } = l;
  return rest;
}

export function labelKey(l: Labels): string {
  return Object.keys(l)
    .sort()
    .map((k) => `${k}=${JSON.stringify(l[k])}`)
    .join(",");
}

/** Deterministic order: series by label key, samples by time. */
export function canonical(series: readonly Series[]): Series[] {
  return [...series]
    .map((s) => ({ labels: s.labels, samples: [...s.samples].sort((a, b) => a.t - b.t) }))
    .sort((a, b) => (labelKey(a.labels) < labelKey(b.labels) ? -1 : labelKey(a.labels) > labelKey(b.labels) ? 1 : 0));
}
