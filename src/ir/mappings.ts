// Metric and tag mapping tables (CONTRACT-001, HOT: mappings/** format).
// parseMetricTable / parseTagTable are pure: text in, validated table out, and they fail loudly on any unknown
// field or bad value, so a typo in a YAML file can't silently change a translation. loadMappings() is the only
// function here that does I/O.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Status } from "./finding.js";

/** How Datadog stores the metric (from the integration's check source and metadata.csv). */
export type DatadogKind = "gauge" | "rate" | "count" | "distribution";
/**
 * How the OTel receiver emits it: gauge; counter = monotonic cumulative sum; updowncounter = non-monotonic sum;
 * histogram.
 */
export type OtelKind = "gauge" | "counter" | "updowncounter" | "histogram";

export interface MetricMapping {
  /** Datadog metric name. */
  datadog: string;
  /** OTel metric name, selected in Dash0 as {otel_metric_name="..."}. null when there is no single equivalent. */
  otel: string | null;
  /** Extra label matchers that pick the right series, e.g. {state: "sys"} for redis.cpu.time. */
  labels: Record<string, string>;
  /** Labels the OTel metric has but Datadog doesn't; summed away, e.g. ["db"] for redis.db.keys. */
  sumBy: string[];
  ddKind: DatadogKind;
  otelKind: OtelKind | null;
  unit?: string;
  /** Multiply the OTel value by this to get Datadog's unit. */
  scale?: number;
  /** How faithful the name mapping is. "none" = no equivalent metric. */
  status: "exact" | "approximate" | "none";
  /** When the equivalent is an expression over several OTel metrics (not translated yet). */
  derived?: string;
  note?: string;
}

export interface MetricTable {
  integration: string;
  sources: Record<string, string>;
  metrics: Map<string, MetricMapping>;
}

export interface TagMapping {
  datadog: string;
  /** Dash0 PromQL label name (OTel attribute with dots replaced by underscores). */
  label: string;
  status: "exact" | "approximate";
  note?: string;
}

export class MappingError extends Error {}

const DD_KINDS: readonly DatadogKind[] = ["gauge", "rate", "count", "distribution"];
const OTEL_KINDS: readonly OtelKind[] = ["gauge", "counter", "updowncounter", "histogram"];
const METRIC_FIELDS = new Set(["otel", "labels", "sumBy", "ddKind", "otelKind", "unit", "scale", "status", "derived", "note"]);

export function parseMetricTable(text: string, file = "<metrics>"): MetricTable {
  const doc = parseYaml(text) as unknown;
  const fail = (msg: string): never => {
    throw new MappingError(`${file}: ${msg}`);
  };
  if (!isObj(doc)) return fail("expected a mapping at the top level");
  if (doc.version !== 1) fail(`unsupported version ${String(doc.version)} (expected 1)`);
  if (typeof doc.integration !== "string") fail("missing 'integration'");
  if (!isObj(doc.metrics)) return fail("missing 'metrics'");
  const metrics = new Map<string, MetricMapping>();
  for (const [name, raw] of Object.entries(doc.metrics)) {
    const at = (msg: string) => fail(`metrics.${name}: ${msg}`);
    if (!isObj(raw)) return at("expected a mapping");
    for (const k of Object.keys(raw)) if (!METRIC_FIELDS.has(k)) at(`unknown field '${k}'`);
    const status = raw.status;
    if (status !== "exact" && status !== "approximate" && status !== "none") at("status must be exact | approximate | none");
    const otel = raw.otel ?? null;
    if (otel !== null && typeof otel !== "string") at("otel must be a string or null");
    if (status === "none" && otel !== null) at("status none requires otel: null");
    if (status !== "none" && otel === null && raw.derived === undefined) at("otel is null but status is not none and no 'derived' is given");
    if (!DD_KINDS.includes(raw.ddKind as DatadogKind)) at(`ddKind must be one of ${DD_KINDS.join(" | ")}`);
    const otelKind = raw.otelKind ?? null;
    if (otelKind !== null && !OTEL_KINDS.includes(otelKind as OtelKind)) at(`otelKind must be one of ${OTEL_KINDS.join(" | ")} or null`);
    if (otel !== null && otelKind === null) at("otelKind is required when otel is set");
    const labels = raw.labels ?? {};
    if (!isObj(labels) || !Object.values(labels).every((v) => typeof v === "string")) at("labels must map strings to strings");
    const sumBy = raw.sumBy ?? [];
    if (!Array.isArray(sumBy) || !sumBy.every((v) => typeof v === "string")) at("sumBy must be a list of strings");
    if (raw.scale !== undefined && (typeof raw.scale !== "number" || !Number.isFinite(raw.scale) || raw.scale === 0)) at("scale must be a non-zero number");
    for (const k of ["unit", "derived", "note"] as const) if (raw[k] !== undefined && typeof raw[k] !== "string") at(`${k} must be a string`);
    metrics.set(name, {
      datadog: name,
      otel: otel as string | null,
      labels: labels as Record<string, string>,
      sumBy: sumBy as string[],
      ddKind: raw.ddKind as DatadogKind,
      otelKind: otelKind as OtelKind | null,
      ...(raw.unit !== undefined && { unit: raw.unit as string }),
      ...(raw.scale !== undefined && { scale: raw.scale as number }),
      status: status as MetricMapping["status"],
      ...(raw.derived !== undefined && { derived: raw.derived as string }),
      ...(raw.note !== undefined && { note: raw.note as string }),
    });
  }
  const sources = isObj(doc.sources) ? (Object.fromEntries(Object.entries(doc.sources).map(([k, v]) => [k, String(v)])) as Record<string, string>) : {};
  return { integration: doc.integration as string, sources, metrics };
}

export function parseTagTable(text: string, file = "<tags>"): Map<string, TagMapping> {
  const doc = parseYaml(text) as unknown;
  const fail = (msg: string): never => {
    throw new MappingError(`${file}: ${msg}`);
  };
  if (!isObj(doc) || doc.version !== 1 || !isObj(doc.tags)) return fail("expected {version: 1, tags: {...}}");
  const out = new Map<string, TagMapping>();
  for (const [tag, raw] of Object.entries(doc.tags)) {
    if (!isObj(raw)) return fail(`tags.${tag}: expected a mapping`);
    for (const k of Object.keys(raw)) if (!["label", "status", "note"].includes(k)) fail(`tags.${tag}: unknown field '${k}'`);
    if (typeof raw.label !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw.label)) fail(`tags.${tag}: label must be a valid PromQL label name`);
    if (raw.status !== "exact" && raw.status !== "approximate") fail(`tags.${tag}: status must be exact | approximate`);
    out.set(tag, { datadog: tag, label: raw.label as string, status: raw.status as TagMapping["status"], ...(typeof raw.note === "string" && { note: raw.note }) });
  }
  return out;
}

export interface Mappings {
  metrics: Map<string, MetricMapping>;
  tags: Map<string, TagMapping>;
  /** Which file each metric came from, for the report. */
  origin: Map<string, string>;
}

/**
 * Datadog's declared metric kinds from the GENERATED mappings/datadog/_kinds.json (scripts/build-dd-kinds.mjs,
 * from integrations-core metadata.csv). For metrics without a curated entry only: curated tables always win.
 * Returns an empty table if the file is absent.
 */
export function loadDdKinds(dir: string): Record<string, DatadogKind> {
  let doc: { version?: number; kinds?: Record<string, string> };
  try {
    doc = JSON.parse(readFileSync(join(dir, "datadog", "_kinds.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new MappingError(`datadog/_kinds.json: ${(e as Error).message}`);
  }
  if (doc.version !== 1 || typeof doc.kinds !== "object" || doc.kinds === null) throw new MappingError("datadog/_kinds.json: expected {version: 1, kinds: {...}}");
  const out: Record<string, DatadogKind> = {};
  for (const [k, v] of Object.entries(doc.kinds)) {
    if (!DD_KINDS.includes(v as DatadogKind)) throw new MappingError(`datadog/_kinds.json: ${k}: unknown kind '${v}'`);
    out[k] = v as DatadogKind;
  }
  return out;
}

/** Reads mappings/tags.yaml and every mappings/datadog/*.yaml. Duplicate metric names across files are an error. */
export function loadMappings(dir: string): Mappings {
  const metrics = new Map<string, MetricMapping>();
  const origin = new Map<string, string>();
  const ddDir = join(dir, "datadog");
  for (const f of readdirSync(ddDir).filter((x) => x.endsWith(".yaml")).sort()) {
    const file = join(ddDir, f);
    const table = parseMetricTable(readFileSync(file, "utf8"), file);
    for (const [name, m] of table.metrics) {
      if (metrics.has(name)) throw new MappingError(`${file}: metric ${name} already defined in ${origin.get(name)}`);
      metrics.set(name, m);
      origin.set(name, file);
    }
  }
  const tagsFile = join(dir, "tags.yaml");
  return { metrics, tags: parseTagTable(readFileSync(tagsFile, "utf8"), tagsFile), origin };
}

/**
 * The type rule from plan 03 §3: what a translation must do so the OTel value means what Datadog stored.
 * - rate on counter: Datadog stores per-second rates of a counter (Redis RATE_KEYS), OTel the running total,
 *   so the translator must wrap the selector in rate(). Status approximate (D-18).
 * - same kind (or a Datadog gauge reading a running total, D-19): use the value as it is.
 * - anything else: manual until someone writes and tests a rule for it.
 */
export function kindTransform(m: MetricMapping): { transform: "none" | "rate" | "increase"; status: Status; reason?: string } {
  if (m.otel === null || m.otelKind === null) return { transform: "none", status: "manual", reason: m.derived ? `derived: ${m.derived}` : "no equivalent metric" };
  const base: Status = m.status === "exact" ? "exact" : "bounded";
  if (m.ddKind === "rate" && m.otelKind === "counter") return { transform: "rate", status: "bounded", reason: "Datadog stores a per-second rate; OTel a cumulative counter" };
  if (m.ddKind === "gauge" && (m.otelKind === "gauge" || m.otelKind === "counter" || m.otelKind === "updowncounter")) return { transform: "none", status: base };
  if (m.ddKind === "count" && m.otelKind === "counter") return { transform: "increase", status: "bounded", reason: "Datadog count (per-interval deltas) on an OTel cumulative counter: increase() over the bucket (maths.md T4c)" };
  return { transform: "none", status: "manual", reason: `no rule for ${m.ddKind} -> ${m.otelKind}` };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
