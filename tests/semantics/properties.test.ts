// Property tests: every translation claim from docs/research/maths.md, checked on random data under BOTH semantics.
// A Datadog-semantics plan (bucket mode) and our PromQL plan (window mode) are evaluated on the same store, and
// the comparator must report `exact` (bit-equal, after the documented timestamp shift).
// fast-check shrinks any failure to a minimal counterexample. Fixed seeds keep runs reproducible.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { evaluate, compareResults, datadogRatePoints, summationTolerance } from "../../src/semantics/index.js";
import type { Plan, Series, Store } from "../../src/semantics/index.js";

const RUNS = { numRuns: 300, seed: 20261107 };
const W = 60;
const sel = (metric: string): Plan => ({ op: "select", metric });

/** Samples with integer values at integer times that never fall on a multiple of W (assumption A3). */
const offBoundaryTimes = fc
  .uniqueArray(fc.integer({ min: 1, max: 1199 }), { minLength: 1, maxLength: 60 })
  .map((ts) => ts.filter((t) => t % W !== 0).sort((a, b) => a - b))
  .filter((ts) => ts.length > 0);
const gaugeSeries = (name: string, host: string) =>
  offBoundaryTimes.chain((ts) =>
    fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: ts.length, maxLength: ts.length }).map(
      (vs): Series => ({ labels: { __name__: name, host }, samples: ts.map((t, i) => ({ t, v: vs[i]! })) }),
    ),
  );
const multiStore = fc.array(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 4 }).chain((hosts) =>
  fc.tuple(...[...new Set(hosts)].map((h) => gaugeSeries("m", h))),
);
const DD_GRID = { start: 0, end: 1140, step: W }; // bucket starts 0..1140
const PROM_GRID = { start: W, end: 1200, step: W }; // window ends 60..1200

describe("T8: rollup(f, 60) == f_over_time[60s], shifted by 60 s", () => {
  for (const fn of ["avg", "sum", "min", "max", "count", "last"] as const) {
    it(`${fn}: exact for every off-boundary layout`, () => {
      fc.assert(
        fc.property(gaugeSeries("m", "a"), (s) => {
          const dd = evaluate({ op: "timeAgg", fn, width: W, mode: "bucket", input: sel("m") }, [s], DD_GRID);
          const pq = evaluate({ op: "timeAgg", fn, width: W, mode: "window", input: sel("m") }, [s], PROM_GRID);
          return compareResults(dd, pq, { shiftB: -W }).exact;
        }),
        RUNS,
      );
    });
  }
  it("P2: a sample exactly on a boundary breaks it (the assumption is necessary)", () => {
    const s: Series = { labels: { __name__: "m" }, samples: [{ t: 30, v: 1 }, { t: 60, v: 9 }] };
    const dd = evaluate({ op: "timeAgg", fn: "sum", width: W, mode: "bucket", input: sel("m") }, [s], DD_GRID);
    const pq = evaluate({ op: "timeAgg", fn: "sum", width: W, mode: "window", input: sel("m") }, [s], PROM_GRID);
    expect(compareResults(dd, pq, { shiftB: -W }).exact).toBe(false);
  });
});

describe("T5: Datadog's time-then-space order, mirrored in PromQL, is exact (even on unbalanced data)", () => {
  for (const [tf, sf] of [["sum", "sum"], ["avg", "avg"], ["max", "avg"], ["avg", "max"], ["count", "sum"]] as const) {
    it(`${sf} by (host) of ${tf} rollup`, () => {
      fc.assert(
        fc.property(multiStore, (store) => {
          const p = (mode: "bucket" | "window"): Plan => ({ op: "spaceAgg", fn: sf, by: [], input: { op: "timeAgg", fn: tf, width: W, mode, input: sel("m") } });
          return compareResults(evaluate(p("bucket"), store, DD_GRID), evaluate(p("window"), store, PROM_GRID), { shiftB: -W }).exact;
        }),
        RUNS,
      );
    });
  }
});

/** Counter with non-negative integer increments, sampled every 10 s at a phase that is not a multiple of 60. */
const counterStore = fc
  .tuple(fc.integer({ min: 1, max: 9 }), fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 30, maxLength: 120 }))
  .map(([phase, incs]): Series => {
    let v = 1000;
    return { labels: { __name__: "c", host: "a" }, samples: incs.map((d, i) => ({ t: phase + 10 * i, v: (v += d) })) };
  });

describe("T4: .as_count() on a Datadog RATE metric == increase(x[60s] anchored)", () => {
  it("equal in exact arithmetic; equal within the IEEE rounding bound in float64 (Datadog stores dv/s, which is not an integer)", () => {
    fc.assert(
      fc.property(counterStore, (c) => {
        const rates = datadogRatePoints(c, "c.rate");
        const store: Store = [c, rates];
        // T9 bound: re-summing the n terms r_i*s (Higham, 2*gamma_{n-1}*sum|x|), plus one rounding per divide and per multiply
        const terms = rates.samples.map((x) => x.v * 10);
        const total = terms.reduce((a, b) => a + Math.abs(b), 0);
        const absTol = summationTolerance(terms) + 4 * 2 ** -53 * total;
        const end = c.samples[c.samples.length - 1]!.t;
        const ddGrid = { start: 60, end: Math.floor(end / W) * W - W, step: W };
        const promGrid = { start: ddGrid.start + W, end: ddGrid.end + W, step: W };
        // Datadog: sum of the per-second points in the bucket, times the 10 s interval
        const dd: Plan = { op: "binary", operator: "*", left: { op: "timeAgg", fn: "sum", width: W, mode: "bucket", input: sel("c.rate") }, right: { op: "const", value: 10 } };
        const pq: Plan = { op: "counter", fn: "increase", width: W, anchored: true, input: sel("c") };
        return compareResults(evaluate(dd, store, ddGrid), evaluate(pq, store, promGrid), { shiftB: -W, absTol }).exact;
      }),
      RUNS,
    );
  });
  it("the PromQL side alone stays in the integers: anchored increase of an integer counter is an integer", () => {
    fc.assert(
      fc.property(counterStore, (c) => {
        const end = c.samples[c.samples.length - 1]!.t;
        const r = evaluate({ op: "counter", fn: "increase", width: W, anchored: true, input: sel("c") }, [c], { start: 120, end: Math.floor(end / W) * W, step: W });
        return r.every((s) => s.samples.every((x) => Number.isInteger(x.v)));
      }),
      RUNS,
    );
  });
  it("plain (extrapolated) increase is NOT exact; T3b bounds its error by 10 s x max increment rate", () => {
    let inexact = 0;
    fc.assert(
      fc.property(counterStore, (c) => {
        const store: Store = [c];
        const end = c.samples[c.samples.length - 1]!.t;
        const g = { start: 120, end: Math.floor(end / W) * W, step: W };
        const anc = evaluate({ op: "counter", fn: "increase", width: W, anchored: true, input: sel("c") }, store, g);
        const ext = evaluate({ op: "counter", fn: "increase", width: W, input: sel("c") }, store, g);
        const cmp = compareResults(anc, ext);
        if (!cmp.exact) inexact++;
        // discrete counter: the per-interval rate lies in [0, 50/10], and the uncovered edge time g <= 10 s
        return cmp.maxAbsErr <= 10 * 5 + 1e-9;
      }),
      RUNS,
    );
    expect(inexact).toBeGreaterThan(RUNS.numRuns / 2); // the trap is real, not a corner case
  });
});

describe("T6 and knowledge base D-28: the Redis high-memory monitor", () => {
  // avg(last_5m): 100 * avg:redis.mem.used{*} / avg:redis.mem.maxmemory{*} > 90
  const memStore = fc
    .tuple(gaugeSeries("redis.memory.used", "a"), fc.integer({ min: 1, max: 9 }), fc.boolean())
    .map(([used, phase, constantMax]): Store => {
      const maxSamples = Array.from({ length: 120 }, (_, i) => ({ t: phase + 10 * i, v: constantMax ? 4096 : 4000 + ((i * 37) % 200) }));
      return [used, { labels: { __name__: "redis.maxmemory", host: "a" }, samples: maxSamples }];
    });
  const ratio = (inner: (m: string) => Plan): Plan => ({
    op: "binary", operator: "*", left: { op: "const", value: 100 },
    right: { op: "binary", operator: "/", left: { op: "spaceAgg", fn: "avg", by: [], input: inner("redis.memory.used") }, right: { op: "spaceAgg", fn: "avg", by: [], input: inner("redis.maxmemory") } },
  });
  const datadog: Plan = { op: "subquery", fn: "avg", range: 300, resolution: W, mode: "bucket", input: ratio((m) => ({ op: "timeAgg", fn: "avg", width: W, mode: "bucket", input: sel(m) })) };
  const kbCandidate: Plan = { op: "subquery", fn: "avg", range: 300, resolution: W, mode: "window", input: ratio((m) => ({ op: "instant", input: sel(m) })) };
  const corrected: Plan = { op: "subquery", fn: "avg", range: 300, resolution: W, mode: "window", input: ratio((m) => ({ op: "timeAgg", fn: "avg", width: W, mode: "window", input: sel(m) })) };
  const grid = { start: 600, end: 1140, step: W };

  it("corrected form avg_over_time((100*avg(avg_over_time(used[1m]))/avg(avg_over_time(max[1m])))[5m:1m]) is exact", () => {
    fc.assert(fc.property(memStore, (store) => compareResults(evaluate(datadog, store, grid), evaluate(corrected, store, grid)).exact), RUNS);
  });
  it("the knowledge base's candidate (instant selectors inside the subquery) is NOT exact", () => {
    const counterexample = fc.check(
      fc.property(memStore, (store) => compareResults(evaluate(datadog, store, grid), evaluate(kbCandidate, store, grid)).exact),
      RUNS,
    );
    expect(counterexample.failed).toBe(true);
  });
});

describe("T7: '<' monitors via negation under Dash0's 'higher threshold is critical' rule", () => {
  it("identical severities for every value and threshold pair", () => {
    fc.assert(
      fc.property(gaugeSeries("m", "a"), fc.integer({ min: -500, max: 400 }), fc.integer({ min: 1, max: 300 }), (s, crit, gap) => {
        const warn = crit + gap; // Datadog: value < crit is critical, value < warn is warning
        const g = { start: 0, end: 1140, step: W };
        const v: Plan = { op: "timeAgg", fn: "avg", width: W, mode: "bucket", input: sel("m") };
        const times = (p: Plan) => evaluate(p, [s], g).flatMap((x) => x.samples.map((y) => y.t));
        const ddCrit = times({ op: "compare", operator: "<", threshold: crit, input: v });
        const ddWarn = times({ op: "compare", operator: "<", threshold: warn, input: v });
        // Dash0: -(v) > $__threshold, run once per threshold; the higher of {-crit, -warn} is critical
        const hi = Math.max(-crit, -warn), lo = Math.min(-crit, -warn);
        const d0Crit = times({ op: "compare", operator: ">", threshold: hi, input: { op: "neg", input: v } });
        const d0Warn = times({ op: "compare", operator: ">", threshold: lo, input: { op: "neg", input: v } });
        return hi === -crit && JSON.stringify(ddCrit) === JSON.stringify(d0Crit) && JSON.stringify(ddWarn) === JSON.stringify(d0Warn);
      }),
      RUNS,
    );
  });
});
