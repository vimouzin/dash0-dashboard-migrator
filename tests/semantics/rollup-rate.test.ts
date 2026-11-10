// T10 (docs/research/maths.md): `.rollup(avg, Δ)` on a Datadog RATE metric read from an OTel counter.
// Datadog stores one per-second rate per sampling interval, r_i = (v_i − v_{i−1}) / s, and rollup(avg, Δ) averages
// the n = Δ/s points in each bucket. These properties pin down how the PromQL forms relate to that:
//   (a) increase(x[Δ] anchored) / Δ  == Datadog's value (exact, under regular sampling and no boundary samples)
//   (b) rate(x[Δ]) (extrapolated) differs by at most (s/Δ)·(max r_i − min r_i) over the bucket's n points
//   (c) both assumptions are necessary: minimal counterexamples break (a) without them
// T4 (Ali, rule time.rollup.counter) emits form (b) today; (a) is the upgrade once Dash0 accepts `anchored`.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { evaluate, compareResults, datadogRatePoints, summationTolerance } from "../../src/semantics/index.js";
import type { Plan, Series, Store } from "../../src/semantics/index.js";

const RUNS = { numRuns: 400, seed: 20261107 };
const sel = (metric: string): Plan => ({ op: "select", metric });

/** Counter sampled every s seconds (s divides Δ), phase off the bucket boundaries, non-negative integer increments. */
const regularCounter = fc
  .record({
    s: fc.constantFrom(5, 10, 15, 20, 30),
    W: fc.constantFrom(60, 120),
    phaseFrac: fc.integer({ min: 1, max: 999 }),
    incs: fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 40, maxLength: 160 }),
  })
  .filter(({ s, W }) => W % s === 0)
  .map(({ s, W, phaseFrac, incs }) => {
    const phase = Math.max(1, Math.floor((phaseFrac / 1000) * s)); // in [1, s-1]: never on a multiple of s
    let v = 10_000;
    const c: Series = { labels: { __name__: "c", host: "a" }, samples: incs.map((d, i) => ({ t: phase + s * i, v: (v += d) })) };
    return { s, W, c };
  });

function plans(W: number) {
  const dd: Plan = { op: "timeAgg", fn: "avg", width: W, mode: "bucket", input: sel("c.rate") };
  const anchored: Plan = { op: "binary", operator: "/", left: { op: "counter", fn: "increase", width: W, anchored: true, input: sel("c") }, right: { op: "const", value: W } };
  const extrapolated: Plan = { op: "counter", fn: "rate", width: W, input: sel("c") };
  return { dd, anchored, extrapolated };
}

function grids(c: Series, W: number) {
  const last = c.samples[c.samples.length - 1]!.t;
  const firstFull = Math.ceil((c.samples[0]!.t + W) / W) * W; // first bucket with a sample before it (anchored baseline)
  const ddGrid = { start: firstFull, end: Math.floor(last / W) * W - W, step: W };
  return { ddGrid, promGrid: { start: ddGrid.start + W, end: ddGrid.end + W, step: W } };
}

describe("T10a: rollup(avg, Δ) of Datadog rate points == increase(x[Δ] anchored) / Δ", () => {
  it("exact over the reals (equal within the IEEE bound in float64) for every regular sampling period dividing Δ", () => {
    fc.assert(
      fc.property(regularCounter, ({ W, c }) => {
        const rates = datadogRatePoints(c, "c.rate");
        const store: Store = [c, rates];
        const { ddGrid, promGrid } = grids(c, W);
        if (ddGrid.end < ddGrid.start) return true;
        const { dd, anchored } = plans(W);
        const tol = summationTolerance(rates.samples.map((x) => x.v)) * 4 + 1e-9;
        return compareResults(evaluate(dd, store, ddGrid), evaluate(anchored, store, promGrid), { shiftB: -W, absTol: tol }).exact;
      }),
      RUNS,
    );
  });
});

describe("T10b: extrapolated rate(x[Δ]) is within (s/Δ)·Δr of Datadog's value", () => {
  it("holds on every generated counter, and the bound is tight (attained within 1%)", () => {
    let worst = 0;
    fc.assert(
      fc.property(regularCounter, ({ s, W, c }) => {
        const rates = datadogRatePoints(c, "c.rate");
        const store: Store = [c, rates];
        const { ddGrid, promGrid } = grids(c, W);
        if (ddGrid.end < ddGrid.start) return true;
        const { dd, extrapolated } = plans(W);
        const a = evaluate(dd, store, ddGrid)[0]?.samples ?? [];
        const b = new Map((evaluate(extrapolated, store, promGrid)[0]?.samples ?? []).map((x) => [x.t - W, x.v] as const));
        for (const p of a) {
          const q = b.get(p.t);
          if (q === undefined) return false;
          const inBucket = rates.samples.filter((x) => x.t >= p.t && x.t < p.t + W).map((x) => x.v);
          const dr = Math.max(...inBucket) - Math.min(...inBucket);
          const bound = (s / W) * dr + 1e-9;
          if (Math.abs(p.v - q) > bound) return false;
          if (dr > 0) worst = Math.max(worst, Math.abs(p.v - q) / ((s / W) * dr));
        }
        return true;
      }),
      RUNS,
    );
    expect(worst).toBeGreaterThan(0.99); // the bound is attained, so it can't be tightened in general
  });
});

describe("T10c: the assumptions are necessary (minimal counterexamples)", () => {
  const W = 60;
  it("irregular sampling breaks the exact form: Datadog weights intervals equally, increase/Δ weights them by length", () => {
    // samples 10 s, then 30 s, then 10 s ... apart: rates 1/s over the short gaps, 0 over the long one
    const c: Series = { labels: { __name__: "c" }, samples: [{ t: 55, v: 0 }, { t: 65, v: 10 }, { t: 95, v: 10 }, { t: 105, v: 20 }] };
    const store: Store = [c, datadogRatePoints(c, "c.rate")];
    const { dd, anchored } = plans(W);
    const a = evaluate(dd, store, { start: 60, end: 60, step: 60 })[0]!.samples[0]!.v; // mean of 1, 0, 1 = 2/3
    const b = evaluate(anchored, store, { start: 120, end: 120, step: 60 })[0]!.samples[0]!.v; // 20 / 60 = 1/3
    expect([a, b]).toEqual([2 / 3, 1 / 3]);
  });
  it("a sample on a bucket boundary breaks it (assumption A.boundary)", () => {
    const c: Series = { labels: { __name__: "c" }, samples: [50, 60, 70, 80, 90, 100, 110, 120, 130].map((t, i) => ({ t, v: i * i })) };
    const store: Store = [c, datadogRatePoints(c, "c.rate")];
    const { dd, anchored } = plans(W);
    const r = compareResults(evaluate(dd, store, { start: 60, end: 60, step: 60 }), evaluate(anchored, store, { start: 120, end: 120, step: 60 }), { shiftB: -W, absTol: 1e-9 });
    expect(r.exact).toBe(false);
  });
});
