// Adapters from the mapping tables to the lookups T4's TranslateContext expects:
//   ctx.metric(dd) -> { otel, kind }   and   ctx.tag(dd) -> label   (Ali, hub #104).
// The metric lookup returns T4's shape plus two fields T4 should honour (CONTRACT-001 asks):
//   labels  extra matchers that select the right series, e.g. redis.cpu.sys -> redis.cpu.time{state="sys"}
//   ddKind  how Datadog stores the metric. ddKind "rate" on an OTel counter means a PLAIN Datadog query already
//           shows a per-second rate, so it translates to rate(...) (D-18), not to "counter needs .as_count()".
import type { DatadogKind, Mappings } from "./mappings.js";
import { kindTransform } from "./mappings.js";

/** T4's MetricKind. updowncounter is read like a gauge in PromQL (no rate), so it maps to "gauge". */
export type TranslatorKind = "gauge" | "counter" | "delta" | "histogram";

export interface MetricLookup {
  otel: string;
  kind: TranslatorKind;
  labels: Record<string, string>;
  ddKind: DatadogKind;
  /** "rate" when the translator must wrap the selector in rate() to match what Datadog stores. */
  transform: "none" | "rate" | "increase";
  status: "exact" | "approximate";
  note?: string;
  /** Datadog value = scale × OTel value. T4 applies it (select.metric.transform) or fails closed. */
  scale?: number;
  /** OTel labels Datadog doesn't have: T4 sums them away first (select.metric.transform) or fails closed. */
  sumBy?: string[];
}

/**
 * Why a metric has no lookup, so the caller can emit the right finding code.
 * needs_transform: kept in the union for contexts that can't pass scale/sumBy to T4 (which then fails closed). T1 no
 * longer returns it: entries with `scale` or `sumBy` are "mapped", and metricLookup carries both fields so T4 applies
 * them (rule select.metric.transform) or fails closed with metric.needs_transform (Ali's review of PR #4).
 */
export type MetricAvailability = "mapped" | "unmapped" | "no_equivalent" | "derived" | "needs_transform";

export function metricAvailability(m: Mappings, dd: string): MetricAvailability {
  const e = m.metrics.get(dd);
  if (!e) return "unmapped";
  if (e.otel === null) return e.derived ? "derived" : "no_equivalent";
  return "mapped";
}

/** ctx.metric for T4. undefined unless availability is "mapped" (check metricAvailability for the reason). */
export function metricLookup(m: Mappings): (dd: string) => MetricLookup | undefined {
  return (dd) => {
    if (metricAvailability(m, dd) !== "mapped") return undefined;
    const e = m.metrics.get(dd)!;
    if (e.otel === null || e.otelKind === null || e.status === "none") return undefined;
    const kind: TranslatorKind = e.otelKind === "counter" ? "counter" : e.otelKind === "histogram" ? "histogram" : "gauge";
    return {
      otel: e.otel,
      kind,
      labels: e.labels,
      ddKind: e.ddKind,
      transform: kindTransform(e).transform,
      status: e.status,
      ...(e.note !== undefined && { note: e.note }),
      ...(e.scale !== undefined && { scale: e.scale }),
      ...(e.sumBy.length > 0 && { sumBy: [...e.sumBy] }),
    };
  };
}

/**
 * ctx.ddKind for T4: Datadog's declared kind for a metric WITHOUT a curated entry (curated entries win; T4 only
 * consults it when ctx.metric has no mapping). Build it from loadDdKinds(mappingsDir).
 */
export function ddKindLookup(kinds: Record<string, DatadogKind>, m?: Mappings): (dd: string) => DatadogKind | undefined {
  return (dd) => (m?.metrics.has(dd) ? undefined : kinds[dd]);
}

/** ctx.tag for T4. undefined for unmapped tags (T4 then replaces dots with underscores and emits tag.unmapped). */
export function tagLookup(m: Mappings): (dd: string) => string | undefined {
  return (dd) => m.tags.get(dd)?.label;
}
