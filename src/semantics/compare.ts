// Compares two evaluation results point by point (translation validation, maths.md §9).
// "exact" means: the same series (by labels, ignoring __name__), the same timestamps after an optional shift,
// and values that are identical. Identical means bit-equal, or within the IEEE summation bound when one is given.
import type { Series } from "./types.js";
import { labelKey } from "./evaluate.js";

export interface CompareOptions {
  /** Added to every timestamp of `b` before matching, e.g. -W: PromQL labels a window by its end, Datadog a bucket by its start. */
  readonly shiftB?: number;
  /** Absolute tolerance per point. Default 0: bit-exact. */
  readonly absTol?: number;
}

export interface Mismatch {
  readonly series: string;
  readonly t: number;
  readonly a: number | undefined;
  readonly b: number | undefined;
}

export interface Comparison {
  readonly exact: boolean;
  readonly pointsCompared: number;
  readonly maxAbsErr: number;
  readonly onlyInA: string[];
  readonly onlyInB: string[];
  readonly mismatches: Mismatch[]; // first 20, for the report
}

export function compareResults(a: readonly Series[], b: readonly Series[], opts: CompareOptions = {}): Comparison {
  const shift = opts.shiftB ?? 0;
  const tol = opts.absTol ?? 0;
  const key = (s: Series) => {
    const { __name__: _n, ...rest } = s.labels;
    return labelKey(rest);
  };
  const A = new Map(a.map((s) => [key(s), s] as const));
  const B = new Map(b.map((s) => [key(s), s] as const));
  const onlyInA = [...A.keys()].filter((k) => !B.has(k)).sort();
  const onlyInB = [...B.keys()].filter((k) => !A.has(k)).sort();
  const mismatches: Mismatch[] = [];
  let points = 0;
  let maxAbsErr = 0;
  let bad = 0;
  for (const [k, sa] of [...A.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const sb = B.get(k);
    if (!sb) continue;
    const av = new Map(sa.samples.map((x) => [x.t, x.v] as const));
    const bv = new Map(sb.samples.map((x) => [x.t + shift, x.v] as const));
    const ts = [...new Set([...av.keys(), ...bv.keys()])].sort((x, y) => x - y);
    for (const t of ts) {
      points++;
      const x = av.get(t), y = bv.get(t);
      const same =
        x !== undefined && y !== undefined && (Object.is(x, y) || x === y || (Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) <= tol);
      if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) maxAbsErr = Math.max(maxAbsErr, Math.abs(x - y));
      if (!same) {
        bad++;
        if (mismatches.length < 20) mismatches.push({ series: k, t, a: x, b: y });
      }
    }
  }
  return { exact: bad === 0 && onlyInA.length === 0 && onlyInB.length === 0, pointsCompared: points, maxAbsErr, onlyInA, onlyInB, mismatches };
}

/** Higham's bound for reordering a sum of n floats: 2 * gamma_{n-1} * sum|x| (maths.md T9). */
export function summationTolerance(values: readonly number[]): number {
  const u = 2 ** -53;
  const n = values.length;
  if (n < 2) return 0;
  const g = ((n - 1) * u) / (1 - (n - 1) * u);
  let abs = 0;
  for (const v of values) abs += Math.abs(v);
  return 2 * g * abs;
}
