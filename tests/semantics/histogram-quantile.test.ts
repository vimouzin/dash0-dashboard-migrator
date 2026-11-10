// Theorem T11 (maths.md §12): Datadog pXX on a distribution vs histogram_quantile over the OTel histogram's buckets.
// Pure reference implementations, no translator code: Prometheus's bucketQuantile (promql/quantile.go) and a
// DDSketch with relative accuracy alpha (Masson et al., VLDB 2019). Property tests over generated samples and
// bucket layouts check the bound and reproduce the minimal counterexamples that make each condition necessary.
import { describe, expect, it } from "vitest";
import fc from "fast-check";

const ALPHA = 0.01; // Datadog distributions: DDSketch, 1% relative accuracy

/** Prometheus histogram_quantile on one histogram: finite upper bounds (ascending) + cumulative counts incl. +Inf. */
function promQuantile(q: number, uppers: number[], cum: number[]): number {
  const total = cum[cum.length - 1]!;
  const rank = q * total;
  let b = cum.findIndex((c) => c >= rank);
  if (b === uppers.length) return uppers[uppers.length - 1]!; // rank in the +Inf bucket: the highest finite bound
  const start = b === 0 ? 0 : uppers[b - 1]!; // first bucket's lower bound is 0 for positive values
  const end = uppers[b]!;
  let count = cum[b]!;
  let r = rank;
  if (b > 0) {
    count -= cum[b - 1]!;
    r -= cum[b - 1]!;
  }
  return start + (end - start) * (r / count);
}

/** DDSketch quantile: the bucket of the sample at rank floor(q·(n−1)) (0-based), represented by its relative midpoint. */
function ddQuantile(q: number, sorted: number[], alpha = ALPHA): { value: number; target: number } {
  const target = sorted[Math.floor(q * (sorted.length - 1))]!;
  const gamma = (1 + alpha) / (1 - alpha);
  const i = Math.ceil(Math.log(target) / Math.log(gamma));
  return { value: (2 * Math.pow(gamma, i)) / (gamma + 1), target };
}

function histogram(samples: number[], uppers: number[]): number[] {
  const cum = uppers.map((u) => samples.filter((x) => x <= u).length);
  cum.push(samples.length);
  return cum;
}

/** Index of the bucket a value falls in (uppers.length = +Inf). */
const bucketOf = (x: number, uppers: number[]) => {
  const i = uppers.findIndex((u) => x <= u);
  return i === -1 ? uppers.length : i;
};
const lower = (i: number, uppers: number[]) => (i === 0 ? 0 : uppers[i - 1]!);

// Generators: positive samples and an ascending finite bucket layout that covers them (the condition of T11).
const layout = fc
  .uniqueArray(fc.double({ min: 0.5, max: 1000, noNaN: true }), { minLength: 2, maxLength: 12 })
  .map((xs) => [...xs].sort((a, b) => a - b));
const caseArb = layout.chain((uppers) =>
  fc.record({
    uppers: fc.constant(uppers),
    samples: fc.array(fc.double({ min: 0.01, max: uppers[uppers.length - 1]!, noNaN: true }), { minLength: 1, maxLength: 60 }),
    q: fc.constantFrom(0.5, 0.75, 0.9, 0.95, 0.99, 0.999),
  }),
);

describe("T11 histogram_quantile vs Datadog pXX (maths.md §12)", () => {
  it("T11a scale invariance: multiplying every bucket count by c > 0 leaves histogram_quantile unchanged", () => {
    // Why rate()/increase() over the buckets is the same population: all bucket series of one histogram are scraped
    // together, so rate()'s extrapolation multiplies every bucket by the same factor.
    fc.assert(
      fc.property(caseArb, fc.double({ min: 0.001, max: 1000, noNaN: true }), ({ uppers, samples, q }, c) => {
        const cum = histogram(samples, uppers);
        // Exact ties (q·n equal to a bucket's cumulative count) are where floating point, not the maths, breaks
        // invariance: q·(n·c) and cum·c can round apart by one step and pick the neighbouring bucket. Skip them
        // (Ali's review of #46, seed 1767545266). A tie is also exactly where the two rank rules disagree (g in T11b).
        const n = samples.length;
        fc.pre(cum.every((x) => Math.abs(q * n - x) > 1e-9 * n));
        const a = promQuantile(q, uppers, cum);
        const b = promQuantile(q, uppers, cum.map((x) => x * c));
        expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(a)));
      }),
      { numRuns: 400 },
    );
  });

  it("T11b the bound: |PromQL − Datadog| ≤ width of the quantile's bucket + g + α·value (g = rank-rule gap)", () => {
    // Prometheus's target is the sample at rank ⌈q·n⌉, DDSketch's the one at ⌊q·(n−1)⌋+1: at most one rank apart.
    // g = |x_P − x_D| is the gap between those two order statistics; it is 0 when the ranks agree and shrinks with
    // dense data, but it is NOT bounded by bucket widths (empty buckets can sit between them: see T11d).
    let worst = 0;
    fc.assert(
      fc.property(caseArb, ({ uppers, samples, q }) => {
        const sorted = [...samples].sort((a, b) => a - b);
        const p = promQuantile(q, uppers, histogram(samples, uppers));
        const d = ddQuantile(q, sorted);
        const xP = sorted[Math.ceil(q * sorted.length) - 1]!;
        const b = bucketOf(xP, uppers);
        expect(p).toBeGreaterThanOrEqual(lower(b, uppers) - 1e-9); // histogram_quantile stays in x_P's bucket
        expect(p).toBeLessThanOrEqual(uppers[b]! + 1e-9);
        const eps = uppers[b]! - lower(b, uppers) + Math.abs(xP - d.target) + ALPHA * d.target;
        const err = Math.abs(p - d.value);
        worst = Math.max(worst, err / eps);
        expect(err).toBeLessThanOrEqual(eps * (1 + 1e-9) + 1e-9);
      }),
      { numRuns: 2000 },
    );
    expect(worst).toBeGreaterThan(0.5); // the bound is not loose by orders of magnitude
  });

  it("T11c the tight case: when Datadog's sample lies in the same bucket, ε = that bucket's width + α·value", () => {
    fc.assert(
      fc.property(caseArb, ({ uppers, samples, q }) => {
        const sorted = [...samples].sort((a, b) => a - b);
        const p = promQuantile(q, uppers, histogram(samples, uppers));
        const d = ddQuantile(q, sorted);
        const b = bucketOf(p, uppers);
        fc.pre(bucketOf(d.target, uppers) === b);
        const eps = uppers[b]! - lower(b, uppers) + ALPHA * d.target;
        expect(Math.abs(p - d.value)).toBeLessThanOrEqual(eps * (1 + 1e-12));
      }),
      { numRuns: 1000 },
    );
  });

  describe("T11d necessity (minimal counterexamples)", () => {
    it("the catalog's one-bucket ε is too small when the two rank rules land in neighbouring buckets", () => {
      // n = 2, p90: Prometheus targets rank 0.9·2 = 1.8 (bucket (2,3]); DDSketch targets floor(0.9·1) = 0, i.e. the 1.
      const uppers = [2, 3];
      const samples = [1, 2.5];
      const p = promQuantile(0.9, uppers, histogram(samples, uppers));
      const d = ddQuantile(0.9, [...samples].sort((a, b) => a - b));
      expect(p).toBeCloseTo(2.8, 12);
      expect(d.target).toBe(1);
      const oneBucket = 3 - 2 + ALPHA * d.target; // 1.01
      expect(Math.abs(p - d.value)).toBeGreaterThan(oneBucket); // ≈ 1.8 > 1.01
      expect(Math.abs(p - d.value)).toBeLessThanOrEqual(3 - 0 + ALPHA * d.target); // the neighbour span holds
    });

    it("the rank-rule gap g is not bounded by bucket widths: empty buckets can sit between the two picks", () => {
      // Found by fast-check while writing T11 (it broke a 'neighbouring buckets' version of the bound).
      const uppers = [0.5, 26.9, 158.9, 174.0];
      const samples = [0.01, 160];
      const p = promQuantile(0.95, uppers, histogram(samples, uppers)); // rank 1.9 -> the 160, bucket (158.9, 174]
      const d = ddQuantile(0.95, [...samples].sort((a, b) => a - b)); // floor(0.95·1) = 0 -> the 0.01
      expect(d.target).toBe(0.01);
      expect(Math.abs(p - d.value)).toBeGreaterThan(174.0 - 26.9); // beyond the quantile bucket + both neighbours
    });

    it("no bound at all when the quantile falls in the +Inf bucket", () => {
      // histogram_quantile returns the highest finite bound (2); Datadog sees the real value. Scale the samples up
      // and the error grows without limit, so 'the quantile lies in a finite bucket' is a necessary condition.
      for (const v of [100, 1e4, 1e6]) {
        const uppers = [2];
        const samples = [v, v];
        expect(promQuantile(0.99, uppers, histogram(samples, uppers))).toBe(2);
        expect(Math.abs(2 - ddQuantile(0.99, samples).value)).toBeGreaterThan(v * 0.9);
      }
    });
  });

  it("DDSketch reference: the returned value is within α of the target sample (sanity of the model)", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0.001, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 50 }), fc.constantFrom(0.5, 0.9, 0.99), (xs, q) => {
        const d = ddQuantile(q, [...xs].sort((a, b) => a - b));
        expect(Math.abs(d.value - d.target)).toBeLessThanOrEqual(ALPHA * d.target * (1 + 1e-9));
      }),
      { numRuns: 400 },
    );
  });
});
