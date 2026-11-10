// Unit tests with hand-computed values for each operator of the reference evaluator.
import { describe, it, expect } from "vitest";
import { evaluate, compareResults, extrapolatedIncrease, anchoredIncrease, datadogRatePoints, PlanError } from "../../src/semantics/index.js";
import type { Plan, Series } from "../../src/semantics/index.js";

const ser = (name: string, labels: Record<string, string>, pts: [number, number][]): Series => ({
  labels: { __name__: name, ...labels },
  samples: pts.map(([t, v]) => ({ t, v })),
});
const sel = (metric: string, matchers?: Plan & { op: "select" } extends never ? never : any): Plan => ({ op: "select", metric, matchers });
const pts = (s: Series[]) => s.map((x) => ({ labels: x.labels, p: x.samples.map((y) => [y.t, y.v]) }));

describe("select and matchers", () => {
  const store = [ser("m", { svc: "api" }, [[10, 1]]), ser("m", { svc: "api-gw" }, [[10, 2]]), ser("other", { svc: "api" }, [[10, 3]])];
  const plan = (value: string): Plan => ({ op: "instant", input: sel("m", [{ label: "svc", type: "=~", value }]) });
  const g = { start: 10, end: 10, step: 10 };
  it("Prometheus anchors regex: 'api' matches only api", () => expect(evaluate(plan("api"), store, g)).toHaveLength(1));
  it("Dash0 does not anchor: 'api' also matches api-gw", () => expect(evaluate(plan("api"), store, g, { regex: "unanchored" })).toHaveLength(2));
  it("explicit ^...$ restores exact matching under Dash0", () => expect(evaluate(plan("^api$"), store, g, { regex: "unanchored" })).toHaveLength(1));
});

describe("time aggregation", () => {
  const store = [ser("g", {}, [[5, 1], [25, 3], [59, 5], [60, 100], [75, 7]])];
  it("Datadog bucket [0,60) labelled 0, [60,120) labelled 60", () => {
    const r = evaluate({ op: "timeAgg", fn: "avg", width: 60, mode: "bucket", input: sel("g") }, store, { start: 0, end: 60, step: 60 });
    expect(pts(r)[0]!.p).toEqual([[0, 3], [60, 53.5]]);
  });
  it("PromQL window (0,60] at t=60 and (60,120] at t=120: the boundary sample 60 lands in the earlier window", () => {
    const r = evaluate({ op: "timeAgg", fn: "avg", width: 60, mode: "window", input: sel("g") }, store, { start: 60, end: 120, step: 60 });
    expect(pts(r)[0]!.p).toEqual([[60, (1 + 3 + 5 + 100) / 4], [120, 7]]);
  });
  it("instant selector takes the last sample in (t-300, t], and returns nothing once the newest sample is over 300 s old", () => {
    const r = evaluate({ op: "instant", input: sel("g") }, store, { start: 70, end: 400, step: 300 });
    expect(pts(r)[0]!.p).toEqual([[70, 100], [370, 7]]); // t=370: sample 75 is 295 s old
    const stale = evaluate({ op: "instant", input: sel("g") }, store, { start: 400, end: 400, step: 1 });
    expect(stale).toEqual([]); // t=400: newest sample (75) is 325 s old
  });
});

describe("counters (maths.md P1: the minimal counterexample)", () => {
  const c = ser("c", {}, [[1, 5], [11, 5], [21, 5], [31, 6]]);
  it("extrapolated increase over (1,31] = 1.5", () => expect(extrapolatedIncrease(c, 1, 31)).toBe(1.5));
  it("anchored increase over (1,31] = 1, the true count", () => expect(anchoredIncrease(c, 1, 31)).toBe(1));
  it("counter reset: anchored adds the post-reset value", () => {
    const r = ser("c", {}, [[0, 10], [10, 12], [20, 3], [30, 5]]);
    expect(anchoredIncrease(r, 0, 30)).toBe(2 + 3 + 2);
  });
  it("rate = increase / W", () => {
    const r = evaluate({ op: "counter", fn: "rate", width: 30, anchored: true, input: sel("c") }, [c], { start: 31, end: 31, step: 1 });
    expect(r[0]!.samples[0]!.v).toBeCloseTo(1 / 30, 15);
  });
  it("Datadog RATE points are per-second deltas", () => {
    expect(datadogRatePoints(c, "c.rate").samples.map((x) => x.v)).toEqual([0, 0, 0.1]);
  });
});

describe("space aggregation, arithmetic, comparison", () => {
  const store = [
    ser("m", { host: "a", db: "0" }, [[60, 2]]),
    ser("m", { host: "a", db: "1" }, [[60, 4]]),
    ser("m", { host: "b", db: "0" }, [[60, 10]]),
    ser("max", { host: "a" }, [[60, 8]]),
    ser("max", { host: "b" }, [[60, 20]]),
  ];
  const g = { start: 60, end: 60, step: 60 };
  const used: Plan = { op: "spaceAgg", fn: "sum", by: ["host"], input: { op: "instant", input: sel("m") } };
  it("sum by (host)", () => expect(pts(evaluate(used, store, g)).map((x) => x.p[0]![1])).toEqual([6, 10]));
  it("100 * used / max, matched on host", () => {
    const plan: Plan = {
      op: "binary", operator: "*", left: { op: "const", value: 100 },
      right: { op: "binary", operator: "/", left: used, right: { op: "instant", input: sel("max") } },
    };
    expect(pts(evaluate(plan, store, g)).map((x) => x.p[0]![1])).toEqual([75, 50]);
  });
  it("unmatched series vanish", () => {
    const plan: Plan = { op: "binary", operator: "/", left: used, right: { op: "instant", input: sel("max", [{ label: "host", type: "=", value: "a" }]) } };
    expect(evaluate(plan, store, g)).toHaveLength(1);
  });
  it("compare filters points; neg flips the sign", () => {
    const plan: Plan = { op: "compare", operator: ">", threshold: -7, input: { op: "neg", input: used } };
    expect(pts(evaluate(plan, store, g)).map((x) => x.p[0]![1])).toEqual([-6]);
  });
  it("rejects aggregating raw samples without alignment", () => {
    expect(() => evaluate({ op: "spaceAgg", fn: "sum", by: [], input: sel("m") }, store, g)).toThrow(PlanError);
  });
});

describe("subquery and monitor windows", () => {
  const store = [ser("g", {}, Array.from({ length: 60 }, (_, i) => [i * 10 + 5, i] as [number, number]))];
  it("window mode: avg of the inner values at multiples of 60 in (t-300, t]", () => {
    const plan: Plan = { op: "subquery", fn: "avg", range: 300, resolution: 60, mode: "window", input: { op: "instant", input: sel("g") } };
    // instant values at 300,360,...,540 -> last sample before each: t=295 (v29), 355 (35), 415 (41), 475 (47), 535 (53)
    expect(evaluate(plan, store, { start: 540, end: 540, step: 60 })[0]!.samples[0]!.v).toBe((29 + 35 + 41 + 47 + 53) / 5);
  });
  it("bucket mode: avg of the minute buckets inside [t-300, t)", () => {
    const plan: Plan = { op: "subquery", fn: "avg", range: 300, resolution: 60, mode: "bucket", input: { op: "timeAgg", fn: "avg", width: 60, mode: "bucket", input: sel("g") } };
    // buckets 240..480 hold samples 24..53, whose overall mean is 38.5 (equal-sized buckets)
    expect(evaluate(plan, store, { start: 540, end: 540, step: 60 })[0]!.samples[0]!.v).toBe(38.5);
  });
});

describe("comparator", () => {
  const a = [ser("x", { h: "a" }, [[0, 1], [60, 2]])];
  it("exact when equal after the shift", () => {
    const b = [ser("y", { h: "a" }, [[60, 1], [120, 2]])];
    expect(compareResults(a, b, { shiftB: -60 }).exact).toBe(true);
  });
  it("reports missing points and series", () => {
    const b = [ser("y", { h: "b" }, [[0, 1]])];
    const c = compareResults(a, b);
    expect(c.exact).toBe(false);
    expect(c.onlyInA).toHaveLength(1);
    expect(c.onlyInB).toHaveLength(1);
  });
});

describe("determinism", () => {
  it("same input gives identical bytes", () => {
    const store = [ser("m", { host: "b" }, [[5, 1], [15, 2]]), ser("m", { host: "a" }, [[7, 3]])];
    const plan: Plan = { op: "spaceAgg", fn: "avg", by: ["host"], input: { op: "timeAgg", fn: "sum", width: 60, mode: "bucket", input: sel("m") } };
    const g = { start: 0, end: 60, step: 60 };
    expect(JSON.stringify(evaluate(plan, store, g))).toBe(JSON.stringify(evaluate(plan, [...store].reverse(), g)));
  });
});
