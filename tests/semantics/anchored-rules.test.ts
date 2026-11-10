// The dashboard counter rules emit `anchored` forms (rules time.*.anchored, maths.md T4, T4c, T10a). T4 (.as_count on a RATE
// metric) and T10a (rollup avg of RATE points) are pinned in properties.test.ts and rollup-rate.test.ts. This file pins the rest:
//   T4c   Datadog COUNT points d_i = v_i - v_{i-1}: the bucket SUM == increase(x[W] anchored)            (time.count.*.anchored)
//   T4d   .as_rate() on a COUNT metric: bucket SUM / W == rate(x[W] anchored) == increase(x[W] anchored) / W  (time.as_rate...)
//   T4e   rate(x[W] anchored) == increase(x[W] anchored) / W by construction of the reference evaluator, and Dash0 agrees (live)
//   both T4c and T4d hold for IRREGULAR sampling too: they need only the telescoping sum, not an even period
//   necessity: A.no-reset and A.boundary are needed (minimal counterexamples), A.same-samples is the model's premise
// The reference evaluator (src/semantics) equals Dash0's real `anchored` on a live Redis counter: 0 difference over 36 points
// (W = 60 s and 300 s), recorded in src/rules/probes.ts (probe:anchored).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { evaluate, compareResults, summationTolerance } from "../../src/semantics/index.js";
import type { Plan, Series, Store } from "../../src/semantics/index.js";

const RUNS = { numRuns: 500, seed: 20261108 };
const sel = (metric: string): Plan => ({ op: "select", metric });

/** Datadog COUNT points: one delta per consecutive pair of samples (AgentCheck.monotonic_count), reset steps dropped. */
function datadogCountPoints(c: Series, name: string): Series {
  const out = [];
  for (let i = 1; i < c.samples.length; i++) {
    const dv = c.samples[i]!.v - c.samples[i - 1]!.v;
    if (dv < 0) continue;
    out.push({ t: c.samples[i]!.t, v: dv });
  }
  return { labels: { ...c.labels, __name__: name }, samples: out };
}

/** Counter with IRREGULAR gaps (1..40 s), phase off every bucket boundary, non-negative integer increments, no reset. */
const irregularCounter = fc
  .record({
    W: fc.constantFrom(60, 120, 300),
    gaps: fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 80, maxLength: 220 }),
    incs: fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 80, maxLength: 220 }),
    start: fc.integer({ min: 0, max: 100 }),
  })
  .map(({ W, gaps, incs, start }) => {
    const n = Math.min(gaps.length, incs.length);
    let t = start;
    let v = 1_000;
    const samples = [];
    for (let i = 0; i < n; i++) {
      t += gaps[i]!;
      v += incs[i]!;
      samples.push({ t, v });
    }
    return { W, c: { labels: { __name__: "c", host: "a" }, samples } as Series };
  })
  // A.boundary: no sample sits exactly on a bucket boundary
  .filter(({ W, c }) => c.samples.every((x) => x.t % W !== 0));

/** Buckets that have a sample before them (the anchored baseline) and whose end is covered by data. */
function grids(c: Series, W: number) {
  const last = c.samples[c.samples.length - 1]!.t;
  const firstFull = Math.ceil((c.samples[0]!.t + W) / W) * W;
  const ddGrid = { start: firstFull, end: Math.floor(last / W) * W - W, step: W };
  return { ddGrid, promGrid: { start: ddGrid.start + W, end: ddGrid.end + W, step: W } };
}

const ddSum = (name: string, W: number): Plan => ({ op: "timeAgg", fn: "sum", width: W, mode: "bucket", input: sel(name) });
const anchoredInc = (W: number): Plan => ({ op: "counter", fn: "increase", width: W, anchored: true, input: sel("c") });
const anchoredRate = (W: number): Plan => ({ op: "counter", fn: "rate", width: W, anchored: true, input: sel("c") });
const div = (left: Plan, W: number): Plan => ({ op: "binary", operator: "/", left, right: { op: "const", value: W } });

describe("T4c: a Datadog COUNT metric's bucket sum == increase(x[W] anchored), for ANY sampling", () => {
  it("equal in every bucket that has a baseline (irregular gaps, window 60/120/300 s)", () => {
    fc.assert(
      fc.property(irregularCounter, ({ W, c }) => {
        const counts = datadogCountPoints(c, "c.count");
        const store: Store = [c, counts];
        const { ddGrid, promGrid } = grids(c, W);
        if (ddGrid.end < ddGrid.start) return true;
        const tol = summationTolerance(counts.samples.map((x) => x.v)) * 4 + 1e-9;
        const r = compareResults(evaluate(ddSum("c.count", W), store, ddGrid), evaluate(anchoredInc(W), store, promGrid), { shiftB: -W, absTol: tol });
        return r.exact;
      }),
      RUNS,
    );
  });
});

describe("T4d: .as_rate() on a COUNT metric (bucket sum / W) == rate(x[W] anchored), for ANY sampling", () => {
  it("equal in every bucket that has a baseline", () => {
    fc.assert(
      fc.property(irregularCounter, ({ W, c }) => {
        const counts = datadogCountPoints(c, "c.count");
        const store: Store = [c, counts];
        const { ddGrid, promGrid } = grids(c, W);
        if (ddGrid.end < ddGrid.start) return true;
        const tol = (summationTolerance(counts.samples.map((x) => x.v)) * 4 + 1e-9) / W + 1e-12;
        const r = compareResults(evaluate(div(ddSum("c.count", W), W), store, ddGrid), evaluate(anchoredRate(W), store, promGrid), { shiftB: -W, absTol: tol });
        return r.exact;
      }),
      RUNS,
    );
  });
});

describe("T4e: rate(x[W] anchored) == increase(x[W] anchored) / W", () => {
  it("holds at every evaluation step of the reference evaluator (and live: the ratio is exactly 60 for W = 60 s)", () => {
    fc.assert(
      fc.property(irregularCounter, ({ W, c }) => {
        const store: Store = [c];
        const { promGrid } = grids(c, W);
        if (promGrid.end < promGrid.start) return true;
        return compareResults(evaluate(anchoredRate(W), store, promGrid), evaluate(div(anchoredInc(W), W), store, promGrid), { absTol: 1e-9 }).exact;
      }),
      RUNS,
    );
  });
});

describe("the properties have power (they are not vacuous)", () => {
  const extrapolatedInc = (W: number): Plan => ({ op: "counter", fn: "increase", width: W, input: sel("c") });
  it("the OLD extrapolated increase(x[W]) fails T4c on irregular counters, so the equality above is a real check", () => {
    const res = fc.check(
      fc.property(irregularCounter, ({ W, c }) => {
        const counts = datadogCountPoints(c, "c.count");
        const store: Store = [c, counts];
        const { ddGrid, promGrid } = grids(c, W);
        if (ddGrid.end < ddGrid.start) return true;
        return compareResults(evaluate(ddSum("c.count", W), store, ddGrid), evaluate(extrapolatedInc(W), store, promGrid), { shiftB: -W, absTol: 1e-6 }).exact;
      }),
      { numRuns: 200, seed: 20261108 },
    );
    expect(res.failed).toBe(true);
  });
  it("the generated cases compare many buckets (at least 5 on average)", () => {
    let buckets = 0;
    let cases = 0;
    fc.assert(
      fc.property(irregularCounter, ({ W, c }) => {
        const counts = datadogCountPoints(c, "c.count");
        const { ddGrid, promGrid } = grids(c, W);
        if (ddGrid.end < ddGrid.start) return true;
        const pr = evaluate(anchoredInc(W), [c, counts], promGrid)[0]?.samples.length ?? 0;
        buckets += pr;
        cases++;
        return true;
      }),
      { numRuns: 200, seed: 20261108 },
    );
    expect(buckets / Math.max(1, cases)).toBeGreaterThan(5);
  });
});

describe("necessity: the assumptions are needed (minimal counterexamples)", () => {
  const W = 60;
  const ctr = (pts: [number, number][]): Series => ({ labels: { __name__: "c", host: "a" }, samples: pts.map(([t, v]) => ({ t, v })) });
  const run = (c: Series) => {
    const counts = datadogCountPoints(c, "c.count");
    const store: Store = [c, counts];
    const dd = evaluate(ddSum("c.count", W), store, { start: 60, end: 60, step: W })[0]?.samples[0]?.v;
    const pr = evaluate(anchoredInc(W), store, { start: 120, end: 120, step: W })[0]?.samples[0]?.v;
    return { dd, pr };
  };

  it("sanity: no reset, no boundary sample: equal", () => {
    // samples at 50 (baseline), 70, 100; bucket [60,120) holds 70 and 100: sum of deltas = 100 - 50's value
    const { dd, pr } = run(ctr([[50, 10], [70, 25], [100, 40]]));
    expect(dd).toBe(30);
    expect(pr).toBe(30);
  });

  it("A.no-reset: a reset inside the bucket splits the two (anchored adds the post-reset value; the model's Datadog drops the step)", () => {
    // 50:10, 70:25, 90:3 (reset), 110:8. Datadog model: deltas 15, (reset dropped), 5 = 20. Anchored: 15 + 3 + 5 = 23.
    const { dd, pr } = run(ctr([[50, 10], [70, 25], [90, 3], [110, 8]]));
    expect(dd).toBe(20);
    expect(pr).toBe(23);
  });

  it("A.boundary: a sample exactly on the bucket start belongs to Datadog's bucket but not to the PromQL window", () => {
    // 60 sits on the boundary: Datadog bucket [60,120) includes it; PromQL window (60,120] does not.
    const { dd, pr } = run(ctr([[40, 10], [60, 22], [90, 30], [110, 41]]));
    expect(dd).toBe(12 + 8 + 11);
    expect(pr).toBe(8 + 11);
  });
});
