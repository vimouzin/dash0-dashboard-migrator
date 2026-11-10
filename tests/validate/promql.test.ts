import { describe, expect, it } from "vitest";
import { substitutePlaceholders, validatePromQL } from "../../src/validate/promql.js";

describe("validatePromQL", () => {
  it("accepts valid PromQL, including Dash0/Perses placeholders", () => {
    for (const q of [
      'avg by (host_name) (avg_over_time({otel_metric_name="redis.memory.used", host_name=~"$host"}[$__interval]))',
      'avg_over_time((100 * avg (avg_over_time({otel_metric_name="a"}[1m])))[5m:1m]) > $__threshold',
      '-min_over_time((avg (avg_over_time({otel_metric_name="a"}[1m])))[15m:1m]) > $__threshold',
      'avg (avg_over_time({otel_metric_name="a"}[$__interval] offset 1h))',
    ])
      expect(validatePromQL(q), q).toEqual({ ok: true, errors: [] });
  });

  it("rejects broken PromQL with a position", () => {
    for (const q of ["avg by (h) (x[5m]", "sum(rate(x[5m])", "system.cpu.user{*}", "", "a +"]) {
      const r = validatePromQL(q);
      expect(r.ok, q).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it("substitutes only placeholders outside strings", () => {
    expect(substitutePlaceholders('x{a=~"$host"}[$__interval] > $__threshold')).toBe('x{a=~"$host"}[1m] > 0');
  });
});
