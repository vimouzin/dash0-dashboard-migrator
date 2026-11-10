// How Datadog stores a check's RATE metric (Redis RATE_KEYS, knowledge base D-18), modelled from the docs:
// each check run submits the per-second rate since the previous run, (v_i - v_{i-1}) / (t_i - t_{i-1}), at t_i.
// MODEL: how Datadog handles a counter reset (a negative delta) is UNVERIFIED. Here the point is dropped
// (maths.md §11 probe 4).
import type { Series } from "./types.js";

export function datadogRatePoints(counter: Series, metricName: string): Series {
  const samples = [];
  const xs = counter.samples;
  for (let i = 1; i < xs.length; i++) {
    const dv = xs[i]!.v - xs[i - 1]!.v;
    if (dv < 0) continue;
    samples.push({ t: xs[i]!.t, v: dv / (xs[i]!.t - xs[i - 1]!.t) });
  }
  return { labels: { ...counter.labels, __name__: metricName }, samples };
}
